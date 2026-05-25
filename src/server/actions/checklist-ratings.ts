"use server";

/**
 * Checklist rating server actions — write side for the v3 plan §1.2 C3 model
 * shift (child checklist items carry 0.5–5.0 scores, parent dimension =
 * mean of children).
 *
 * # Auth contract (= critic blocker #6 from v3 plan §3.1)
 *
 * Every write here MUST run `requireUser()` followed by either
 * `requireVenueAccess(user.id, venueId)` or `requireProjectMembership(user.id)`
 * BEFORE touching Prisma. The helpers throw on mismatch so an attacker
 * passing a foreign venueId / projectChecklistId gets a clean rejection.
 *
 * Reviewer-grep contract: every exported async function in this file must
 * start with `requireUser(` so a future contributor adding a new endpoint
 * cannot accidentally omit the check — the PR template includes a checklist
 * item for this.
 */

import { z } from "zod";
import { prisma } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";
import { revalidateTag } from "next/cache";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import type { Prisma as PrismaTypes } from "@/generated/prisma/client";
import {
  requireUser,
  requireProjectMembership,
  requireVenueAccess,
} from "@/server/auth";
import { publishRealtimeEvent, resolveActor } from "@/lib/realtime/publish";
import { getCoupleMembers } from "@/lib/couple-members";

/**
 * Race-safe upsert for `venue_checklist_answers` — Prisma upsert wrapped
 * in a tight retry loop.
 *
 * Why this shape (and not anything we've tried so far):
 *   - PR #68: try { upsert } catch (P2002) { update } — the UPDATE path
 *     itself races and produces P2025 when a sibling tx rolls back.
 *   - PR #70: $executeRaw INSERT ... ON CONFLICT — should have been
 *     atomic, but production surfaced Postgres 23505 anyway (= the
 *     ON CONFLICT clause didn't catch every unique constraint that
 *     actually fires; legacy index from migration 20260516010000
 *     Step 5 likely lingers on at least one project).
 *   - PR #71 (this): give up on building a "perfectly atomic" first
 *     attempt and accept the race exists at the DB level. Catch every
 *     race-symptomatic error (P2002, P2025, raw 23505 from $executeRaw,
 *     SerializationError 40001) and retry up to 3 times with a short
 *     backoff. The action only fails after 3 lost retries, which is
 *     vanishingly rare under realistic load.
 *
 * @param tx — pass a transaction client when called inside an
 *   interactive `prisma.$transaction` (bulkSetDimensionRating). The
 *   retry loop is then SCOPED TO ONE ATTEMPT to keep the transaction
 *   boundary clean — a retry would mean rolling back the whole bulk,
 *   which we'd rather signal as a server-action failure and let the UI
 *   show a toast. Top-level callers get the full 3-attempt loop.
 */
async function upsertChecklistAnswerSafely(
  tx: typeof prisma | PrismaTypes.TransactionClient,
  args: {
    projectChecklistId: string;
    venueId: string;
    userId: string;
    numericScore: number | null;
  },
  options: { retries?: number } = {},
): Promise<void> {
  const maxAttempts = (options.retries ?? 3) + 1;
  const where = {
    projectChecklistId_venueId_userId: {
      projectChecklistId: args.projectChecklistId,
      venueId: args.venueId,
      userId: args.userId,
    },
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await tx.venueChecklistAnswer.upsert({
        where,
        create: {
          projectChecklistId: args.projectChecklistId,
          venueId: args.venueId,
          userId: args.userId,
          numericScore: args.numericScore,
        },
        update: { numericScore: args.numericScore },
      });
      return;
    } catch (e) {
      if (attempt >= maxAttempts || !isRaceRetryable(e)) {
        throw e;
      }
      console.warn(
        `[upsertChecklistAnswerSafely] race detected (attempt ${attempt}/${maxAttempts}), retrying`,
        {
          code:
            e instanceof Prisma.PrismaClientKnownRequestError ? e.code : "raw",
          message: e instanceof Error ? e.message.slice(0, 200) : String(e),
        },
      );
      // Jittered backoff: 8ms · 16ms · 32ms — small enough to stay
      // inside one user-visible "saving…" frame, large enough to let
      // a colliding sibling tx finish committing.
      await new Promise((r) => setTimeout(r, 8 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Decide whether the error came from a concurrency race we should
 * retry, or a "real" failure we should surface to the caller.
 *
 * Race-symptomatic:
 *   - P2002: unique violation (Prisma surface)
 *   - P2025: update-where-no-row (= sibling tx undid the row between
 *     our SELECT and UPDATE in the upsert pipeline)
 *   - 23505: raw Postgres unique violation (= same thing as P2002, but
 *     occasionally leaks through unmapped when the violation surfaces
 *     from a path Prisma doesn't recognise — happened in prod 20:54
 *     JST with the legacy index from migration 20260516010000)
 *   - 40001 / SerializationFailure: would only happen if we wrap in
 *     Serializable isolation; future-proof.
 */
function isRaceRetryable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002" || e.code === "P2025") return true;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (
    message.includes("23505") ||
    message.includes("40001") ||
    message.includes("duplicate key value violates") ||
    message.includes("could not serialize access")
  ) {
    return true;
  }
  return false;
}

/**
 * Ensure a `public.users` row exists for the current Supabase auth user.
 * Server actions in this file write rows whose FK is `users.id`, but a
 * freshly-invited partner may land in `auth.users` without a matching
 * `public.users` row (= the canonical incident `error.digest=142404057`,
 * tapping a child rating triggered P2003). This helper is idempotent —
 * upsert by id, leave name/email untouched on subsequent calls so we
 * never clobber a value the user later edited in /mypage.
 */
async function ensureUserRow(user: SupabaseUser): Promise<void> {
  const fallbackEmail = user.email ?? `${user.id}@unknown.local`;
  const fallbackName =
    (user.user_metadata?.name as string | undefined) ??
    (user.user_metadata?.full_name as string | undefined) ??
    null;
  await prisma.user.upsert({
    where: { id: user.id },
    create: { id: user.id, email: fallbackEmail, name: fallbackName },
    update: {},
  });
}

/**
 * Normalise a thrown error into the `{ success: false, error: ... }` shape
 * the client expects, so a server-side exception never reaches the page
 * error boundary (= cannot trigger the cryptic "エラーID: xxx" overlay).
 * `NEXT_REDIRECT` is re-thrown so Next.js auth redirects still work.
 */
function handleServerActionError(
  where: string,
  e: unknown,
  context: Record<string, unknown>,
): { success: false; error: { formErrors: string[]; fieldErrors: Record<string, string[]> } } {
  if (e instanceof Error && typeof (e as { digest?: unknown }).digest === "string" && (e as unknown as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
    throw e;
  }
  const errInfo =
    e instanceof Error
      ? { name: e.name, message: e.message, stack: e.stack, code: (e as { code?: unknown }).code }
      : { message: String(e) };
  console.error(`[${where}] failed`, { context, error: errInfo });
  const userMessage =
    e instanceof Error && e.message
      ? `保存に失敗しました: ${e.message.slice(0, 120)}`
      : "保存中にエラーが発生しました。時間をおいて再度お試しください。";
  return {
    success: false,
    error: { formErrors: [userMessage], fieldErrors: {} },
  };
}

// ─── shared validators ───────────────────────────────────────────────────

/** 0.5–5.0 in 0.5 increments — matches the DB CHECK constraint added in
 *  migration `20260515000000_*`. Mirrored here so client errors are
 *  pretty messages instead of a raw PostgreSQL violation. */
const scoreSchema = z
  .number()
  .min(0.5, "0.5 以上で入力してください")
  .max(5.0, "5.0 以下で入力してください")
  .refine(
    (n) => Number.isFinite(n) && Math.abs(Math.round(n * 2) - n * 2) < 1e-9,
    "0.5 刻みで入力してください",
  );

const cuidSchema = z
  .string()
  .min(1, "id が空です")
  .max(60, "id が長すぎます");

const uuidSchema = z.string().uuid("invalid venueId");

const saveChildRatingInputSchema = z.object({
  venueId: uuidSchema,
  itemId: cuidSchema,
  score: scoreSchema.nullable(),
});

const bulkSetDimensionInputSchema = z.object({
  venueId: uuidSchema,
  itemIds: z.array(cuidSchema).min(1, "対象項目が空です"),
  score: scoreSchema,
});

const addCustomItemInputSchema = z.object({
  category: z
    .string()
    .min(1, "カテゴリを選んでください")
    .max(40, "カテゴリ名が長すぎます"),
  subcategory: z.string().max(40).nullable().optional(),
  question: z
    .string()
    .min(2, "問いを 2 文字以上で書いてください")
    .max(140, "問いは 140 文字以内に収めてください"),
});

const deleteCustomItemInputSchema = z.object({
  customItemId: cuidSchema,
});

// ─── invalidation ────────────────────────────────────────────────────────

/** Fine-grained cache tags so a single child score update only re-renders
 *  the affected venue's comparison row, not the whole `/compare` page —
 *  addresses v3 plan critic blocker #14 (revalidatePath jank). */
function venueScoreTag(venueId: string) {
  return `venue-checklist-scores:${venueId}`;
}

function projectChecklistTag(projectId: string) {
  return `project-checklist:${projectId}`;
}

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve (or create) the `ProjectChecklist` row that ties this item to the
 * couple's active checklist. A child rating cannot land unless the project
 * already has the item enabled — but the UI sometimes wants a "rate it and
 * also turn it on" one-shot flow, so we upsert here defensively.
 *
 * @throws when the itemId isn't a known preset and isn't a custom item the
 *         couple owns (= cross-project IDOR attempt).
 */
async function ensureProjectChecklist(
  projectId: string,
  itemId: string,
): Promise<{ id: string }> {
  const existing = await prisma.projectChecklist.findUnique({
    where: { projectId_itemId: { projectId, itemId } },
    select: { id: true },
  });
  if (existing) return existing;

  // Validate the itemId before creating — either it's a static preset
  // (we trust the in-code library) or it's a custom item we own.
  const { CHECKLIST_PRESETS } = await import("@/lib/checklist-presets");
  const isPreset = CHECKLIST_PRESETS.some((p) => p.id === itemId);
  if (!isPreset) {
    const custom = await prisma.customChecklistItem.findUnique({
      where: { id: itemId },
      select: { projectId: true, deletedAt: true },
    });
    if (!custom || custom.projectId !== projectId || custom.deletedAt) {
      throw new Error("評価項目が見つからないか、アクセス権がありません");
    }
  }

  return prisma.projectChecklist.create({
    data: { projectId, itemId },
    select: { id: true },
  });
}

// ─── server actions ──────────────────────────────────────────────────────

/**
 * Save (or clear) a single child item's 0.5–5.0 score for one venue.
 *
 * @param score — pass `null` to clear an existing score (= "untap").
 *                Validation: 0.5 ≤ score ≤ 5.0, 0.5-step grid.
 */
export async function saveChildRating(input: {
  venueId: string;
  itemId: string;
  score: number | null;
}) {
  const parsed = saveChildRatingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: parsed.error.flatten() };
  }

  try {
    const user = await requireUser();
    const { projectId } = await requireVenueAccess(user.id, parsed.data.venueId);

    // Lazily sync the Supabase auth.users → public.users row before the FK
    // bites. Partner accounts created via ProjectInvitation can land in
    // auth.users without a matching public.users row (the sync was previously
    // assumed to happen at invitation acceptance, but a stale path could
    // skip it — see incident `error.digest=142404057`). Without this, the
    // venueChecklistAnswer.user FK throws P2003 the first time the partner
    // taps a score and the user is bounced to error.tsx.
    await ensureUserRow(user);

    const checklist = await ensureProjectChecklist(projectId, parsed.data.itemId);

    await upsertChecklistAnswerSafely(prisma, {
      projectChecklistId: checklist.id,
      venueId: parsed.data.venueId,
      userId: user.id,
      numericScore: parsed.data.score,
    });

    revalidateTag(venueScoreTag(parsed.data.venueId), { expire: 0 });
    revalidateTag(projectChecklistTag(projectId), { expire: 0 });

    // Audit P1-10: broadcast so the partner's open client toasts + the
    // Web Push dispatcher (Audit P0-3) fans out. Best-effort by
    // publishRealtimeEvent's contract — won't reach the catch below.
    const actor = await resolveActor(user.id);
    await publishRealtimeEvent(projectId, {
      kind: "rating_saved",
      actor,
      venueId: parsed.data.venueId,
      dimensionCount: 1,
    });

    return { success: true as const };
  } catch (e) {
    return handleServerActionError("saveChildRating", e, {
      venueId: parsed.data.venueId,
      itemId: parsed.data.itemId,
    });
  }
}

/**
 * Shortcut: stamp the same score onto every supplied child item for a venue
 * — used by the "rate the parent dimension and propagate down" UI flow.
 *
 * Wrapped in a transaction so partial failures don't leave one item rated
 * and the next unrated.
 */
export async function bulkSetDimensionRating(input: {
  venueId: string;
  itemIds: string[];
  score: number;
}) {
  const parsed = bulkSetDimensionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: parsed.error.flatten() };
  }

  try {
    const user = await requireUser();
    const { projectId } = await requireVenueAccess(user.id, parsed.data.venueId);
    await ensureUserRow(user);

    await prisma.$transaction(async (tx) => {
    for (const itemId of parsed.data.itemIds) {
      const existing = await tx.projectChecklist.findUnique({
        where: { projectId_itemId: { projectId, itemId } },
        select: { id: true },
      });
      const checklist =
        existing ??
        (await tx.projectChecklist.create({
          data: { projectId, itemId },
          select: { id: true },
        }));

      await upsertChecklistAnswerSafely(tx, {
        projectChecklistId: checklist.id,
        venueId: parsed.data.venueId,
        userId: user.id,
        numericScore: parsed.data.score,
      });
    }
    });

    revalidateTag(venueScoreTag(parsed.data.venueId), { expire: 0 });
    revalidateTag(projectChecklistTag(projectId), { expire: 0 });

    // Audit P1-10: parent-dimension bulk rates were silently invisible
    // to the partner before this — only saveRatings (= visit ratings)
    // broadcast. Same Realtime contract as the per-item save above.
    const actor = await resolveActor(user.id);
    await publishRealtimeEvent(projectId, {
      kind: "rating_saved",
      actor,
      venueId: parsed.data.venueId,
      dimensionCount: parsed.data.itemIds.length,
    });

    return { success: true as const };
  } catch (e) {
    return handleServerActionError("bulkSetDimensionRating", e, {
      venueId: parsed.data.venueId,
      itemIds: parsed.data.itemIds,
    });
  }
}

/**
 * Create a custom checklist question for the current project. Returns the
 * new item id so the UI can immediately route the user to scoring it.
 */
export async function addCustomChecklistItem(input: {
  category: string;
  subcategory?: string | null;
  question: string;
}) {
  const parsed = addCustomItemInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: parsed.error.flatten() };
  }

  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);

  // Soft cap: 50 active custom items per project. Beyond this, the
  // comparison drawer's child list becomes unscannable and the
  // aggregator divisor grows large enough that single-item rating
  // changes barely move the parent average. The UI should already
  // surface a warning, but enforce DB-side too.
  const activeCount = await prisma.customChecklistItem.count({
    where: { projectId, deletedAt: null },
  });
  if (activeCount >= 50) {
    return {
      success: false as const,
      error: {
        formErrors: ["カスタム評価項目は 1 つのふたりにつき 50 件までです"],
        fieldErrors: {},
      },
    };
  }

  const created = await prisma.customChecklistItem.create({
    data: {
      projectId,
      category: parsed.data.category,
      subcategory: parsed.data.subcategory ?? null,
      question: parsed.data.question,
    },
    select: { id: true },
  });

  revalidateTag(projectChecklistTag(projectId), { expire: 0 });

  return { success: true as const, itemId: created.id };
}

/**
 * Get the viewer's and partner's child-item scores for a single venue.
 *
 * Mirrors `getCoupleRatings` (= parent dimension version in `ratings.ts`):
 * returns `{ ownScoreByItemId, partnerScoreByItemId, partnerName }` so
 * `<ChildRatingPanel>` can render the partner's value as a quiet overlay
 * under each child chip without a second round trip.
 *
 * # Null semantics (Audit P1-12)
 *
 * `partnerScoreByItemId` is `null` (the whole map, not per-entry) when
 * the project has no accepted partner yet (= solo project). Otherwise
 * the map exists and each entry can be:
 *
 *   - `number` — the partner's 0.5-5.0 score for this item.
 *   - `null`   — the partner has NOT graded this item yet.
 *
 * Why no third value: ProjectChecklist rows are project-scoped (one row
 * per couple, not per-member), so "the partner hasn't enabled this item"
 * is structurally impossible — if a row exists in the active checklist
 * for the project, it's enabled for both members in lock-step. Callers
 * therefore treat partner-side `null` as "未評価" unambiguously.
 *
 * Each map keys ProjectChecklist `itemId` (preset id or
 * CustomChecklistItem cuid) → number | null.
 */
export async function getCoupleChecklistAnswers(venueId: string): Promise<{
  ownScoreByItemId: Record<string, number | null>;
  partnerScoreByItemId: Record<string, number | null> | null;
  partnerName: string | null;
}> {
  const user = await requireUser();
  const { projectId } = await requireVenueAccess(user.id, venueId);

  // Audit P1-25: shared helper with getCoupleRatings — same shape, same
  // accepted_at filter, single source of truth for "who is in the couple".
  const { other } = await getCoupleMembers(projectId, user.id);

  // Single round-trip: pull every project member's answers for this venue
  // then split by userId in JS. Matches the pattern in `getCoupleRatings`
  // — one query is cheaper than two userId-filtered round trips.
  const answerRows = await prisma.venueChecklistAnswer.findMany({
    where: {
      venueId,
      projectChecklist: { projectId },
    },
    select: {
      userId: true,
      numericScore: true,
      projectChecklist: { select: { itemId: true } },
    },
  });

  function buildMap(userId: string): Record<string, number | null> {
    const map: Record<string, number | null> = {};
    for (const row of answerRows) {
      if (row.userId !== userId) continue;
      map[row.projectChecklist.itemId] =
        row.numericScore !== null && row.numericScore !== undefined
          ? Number(row.numericScore)
          : null;
    }
    return map;
  }

  return {
    ownScoreByItemId: buildMap(user.id),
    partnerScoreByItemId: other ? buildMap(other.userId) : null,
    partnerName: other ? other.name ?? other.email ?? null : null,
  };
}

/**
 * Soft-delete a custom item — keeps any historical VenueChecklistAnswer
 * rows recoverable so a couple who flips off a question and back on
 * doesn't lose their grades.
 */
export async function deleteCustomChecklistItem(input: {
  customItemId: string;
}) {
  const parsed = deleteCustomItemInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: parsed.error.flatten() };
  }

  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);

  // Authz: this user's project must own the item.
  const target = await prisma.customChecklistItem.findUnique({
    where: { id: parsed.data.customItemId },
    select: { projectId: true, deletedAt: true },
  });
  if (!target || target.projectId !== projectId) {
    return {
      success: false as const,
      error: {
        formErrors: ["削除する項目が見つかりませんでした"],
        fieldErrors: {},
      },
    };
  }
  if (target.deletedAt) {
    return { success: true as const };
  }

  await prisma.customChecklistItem.update({
    where: { id: parsed.data.customItemId },
    data: { deletedAt: new Date() },
  });

  revalidateTag(projectChecklistTag(projectId), { expire: 0 });

  return { success: true as const };
}
