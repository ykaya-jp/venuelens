"use server";

import { z } from "zod";
import { prisma } from "@/server/db";
import { requireUser, requireProjectMembership, requireVenueAccess } from "@/server/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { isClaudeAvailable } from "@/lib/claude";
import { uploadEstimatePdf } from "@/lib/supabase/storage";
import { extractEstimateItems } from "@/server/actions/estimate-ai";
import {
  checkRateLimit,
  rateLimitErrorMessage,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const estimateSchema = z.object({
  venueId: z.string().uuid(),
  total: z.coerce.number().int().positive("総額は1以上で入力してください"),
  items: z
    .array(
      z.object({
        category: z.enum([
          "attire",
          "cuisine",
          "photo_video",
          "flowers",
          "performance",
          "av_equipment",
          "venue_fee",
          "other",
        ]),
        itemName: z.string().min(1),
        amount: z.coerce.number().int().nonnegative(),
      }),
    )
    .optional(),
});

export async function createEstimate(input: z.input<typeof estimateSchema>) {
  const validation = estimateSchema.safeParse(input);
  if (!validation.success) {
    return { error: validation.error.flatten().fieldErrors };
  }

  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);
  await requireVenueAccess(user.id, validation.data.venueId);

  // Get current version count
  const count = await prisma.estimate.count({
    where: { venueId: validation.data.venueId, projectId },
  });

  const estimate = await prisma.estimate.create({
    data: {
      venueId: validation.data.venueId,
      projectId,
      // Audit P2-29: track the author so the UI can show "妻が作成"
      // / "夫が作成" on each version. Project-shared row remains
      // shared; this only labels who originally entered it.
      createdBy: user.id,
      version: count + 1,
      total: validation.data.total,
      sourceType: "manual",
      items: validation.data.items
        ? {
            create: validation.data.items.map((item) => ({
              category: item.category,
              itemName: item.itemName,
              amount: item.amount,
            })),
          }
        : undefined,
    },
    include: { items: true },
  });

  revalidateTag(`project:${projectId}`, { expire: 0 });
  revalidatePath(`/venues/${validation.data.venueId}`);
  revalidatePath("/candidates");
  return { estimate };
}

export async function getEstimatesForVenue(venueId: string) {
  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);

  return prisma.estimate.findMany({
    where: { venueId, projectId },
    include: { items: true },
    orderBy: { version: "desc" },
  });
}

// --- PDF Estimate Analysis ---
//
// Pipeline: FormData → validate → upload to Supabase Storage → signed URL
// → Claude document-block extraction (sonnet-4-6) → parsed JSON.
//
// Previously we ran pdf-parse locally and shipped the flattened text to
// Claude Haiku. That collapsed on scan-only PDFs (empty text) and lost
// the columnar structure a venue estimate relies on. Document-block lets
// Claude read the PDF natively — layout intact — so per-line unit/quantity
// recovery works and scans go through vision instead of dying silently.

// Round 12 (2026-05-02) — bumped from 10MB to 32MB after migrating the
// extraction path from base64 inline upload to the Anthropic Files API.
// The Supabase `estimates` bucket also caps at 32MB (raised in the same
// PR via storage helper), so this is the binding ceiling.
const PDF_MAX_SIZE = 32 * 1024 * 1024;
const PDF_MAX_SIZE_MB_LABEL = "32MB";

export async function analyzeEstimatePdf(venueId: string, formData: FormData) {
  // Auth check
  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);
  await requireVenueAccess(user.id, venueId);

  // Per-user rate limit — 3 PDF analyses / 60s. Each call holds Claude
  // up to 55s (document-block extraction); 3/min keeps a function
  // instance from queuing up >3 long-running requests in parallel.
  const rl = await checkRateLimit(`pdf-analyze:${user.id}`, RATE_LIMITS.PDF_ANALYZE);
  const rlError = rateLimitErrorMessage(rl, "PDF 解析");
  if (rlError) {
    return { error: rlError };
  }

  // Check Claude availability
  if (!isClaudeAvailable()) {
    return {
      error:
        "AI分析を利用するにはAPIキーを設定してください（ANTHROPIC_API_KEY）",
    };
  }

  // Validate file
  const file = formData.get("pdf") as File | null;
  if (!file) {
    return { error: "PDFファイルを選択してください" };
  }

  if (file.type !== "application/pdf") {
    return { error: "PDF形式のファイルのみアップロードできます" };
  }

  if (file.size > PDF_MAX_SIZE) {
    return { error: `ファイルサイズは${PDF_MAX_SIZE_MB_LABEL}以下にしてください` };
  }

  try {
    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to Supabase Storage. ensureBucket() inside handles the
    // "estimates" bucket's first-run creation (private, 32 MB cap,
    // application/pdf only) so the pipeline self-heals on fresh envs.
    // We store the PDF independently of the AI extraction so the user
    // can revisit + edit the source later, even if the AI step failed.
    const fileName = `${Date.now()}-${file.name}`;
    const pdfUrl = await uploadEstimatePdf(buffer, fileName, projectId, venueId);

    // Round 12: hand the buffer + filename directly to extractEstimateItems
    // so it uploads via the Anthropic Files API rather than re-fetching the
    // PDF over a signed URL. Cuts one round-trip + lifts the practical PDF
    // cap from base64-inline-friendly (~5MB) to the Files API limit.
    //
    // Round 14: also pass `fallbackPdfUrl` so the extractor can transparently
    // fall through to the signed-URL path if the Files API upload itself
    // errors (a transient Anthropic-side 5xx, etc.). The 3-tier order is:
    //   cache hit → Files API → signed URL → ok:false
    const result = await extractEstimateItems({
      buffer,
      filename: file.name,
      fallbackPdfUrl: pdfUrl,
    });
    if (!result.ok) {
      return { error: result.error };
    }

    if (result.tier !== "files-api") {
      // Telemetry: which tier won this extraction? Used by ops to spot a
      // regression (e.g. Files API silently routing to URL fallback for
      // every call) without scraping logs by hand.
      console.info(
        JSON.stringify({
          event: "estimate_extract_tier",
          tier: result.tier,
          venueId,
          projectId,
        }),
      );
    }

    return {
      analysis: result.data,
      pdfUrl,
      venueId,
      projectId,
      // Round 3 (2026-05-02) — non-fatal sanity-check warnings (e.g.
      // items-sum vs total drift > 10%). UI surfaces these as a
      // "要確認" badge so the couple double-checks the extraction
      // before saving. Empty array when extraction is internally
      // consistent. Round 14: also persisted on saveAnalyzedEstimate
      // so the venue-detail card shows the badge after save too.
      warnings: result.warnings,
      tier: result.tier,
    };
  } catch (error) {
    console.error("PDF analysis error:", error);
    return {
      error:
        error instanceof Error
          ? error.message
          : "見積もり PDF をうまく読めませんでした",
    };
  }
}

const VALID_CATEGORIES = [
  "attire",
  "cuisine",
  "photo_video",
  "flowers",
  "performance",
  "av_equipment",
  "venue_fee",
  "other",
] as const;

type ValidCategory = (typeof VALID_CATEGORIES)[number];

function isValidCategory(value: string): value is ValidCategory {
  return VALID_CATEGORIES.includes(value as ValidCategory);
}

const VALID_TIERS = ["minimum", "standard", "premium", "unknown"] as const;

type ValidTier = (typeof VALID_TIERS)[number];

function isValidTier(value: string): value is ValidTier {
  return VALID_TIERS.includes(value as ValidTier);
}

export async function saveAnalyzedEstimate(input: {
  venueId: string;
  pdfUrl: string;
  total: number;
  predictedFinal: number;
  items: Array<{
    category: string;
    itemName: string;
    amount: number;
    tier: string;
  }>;
  /** Round 14: persisted server-side sanity warnings (sum-vs-total drift
   *  > 10% etc.) so the venue-detail Estimate card can render the
   *  "要確認" badge after save, not just during the upload modal.
   *  Filtered + length-clamped to keep DB writes bounded. */
  warnings?: string[];
}) {
  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);
  await requireVenueAccess(user.id, input.venueId);

  // Get current version count
  const count = await prisma.estimate.count({
    where: { venueId: input.venueId, projectId },
  });

  // Sanitize the optional warnings: drop non-strings, clamp per-item to
  // 240 chars (drift messages are ~80 chars), and cap the array at 8 so
  // a malformed payload can't bloat the row.
  const sanitizedWarnings = (input.warnings ?? [])
    .filter((w): w is string => typeof w === "string" && w.length > 0)
    .map((w) => w.slice(0, 240))
    .slice(0, 8);

  const estimate = await prisma.estimate.create({
    data: {
      venueId: input.venueId,
      projectId,
      // Audit P2-29: AI-extracted estimates also carry the uploader's
      // user.id as the author, so the UI shows "妻が PDF 解析" /
      // "夫が PDF 解析" the same way as manual entries.
      createdBy: user.id,
      version: count + 1,
      total: input.total,
      predictedFinal: input.predictedFinal,
      sourceType: "ai_extracted",
      pdfUrl: input.pdfUrl,
      warnings: sanitizedWarnings,
      items: {
        create: input.items.map((item) => ({
          category: isValidCategory(item.category) ? item.category : "other",
          itemName: item.itemName,
          amount: item.amount,
          tier: isValidTier(item.tier) ? item.tier : "unknown",
        })),
      },
    },
    include: { items: true },
  });

  revalidateTag(`project:${projectId}`, { expire: 0 });
  revalidatePath(`/venues/${input.venueId}`);
  revalidatePath("/candidates");
  return { estimate };
}
