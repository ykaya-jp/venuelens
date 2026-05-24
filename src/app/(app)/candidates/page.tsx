import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SlidersHorizontal } from "lucide-react";
import { getFavorites } from "@/server/actions/favorites";
import { getVenues } from "@/server/actions/venues";
import { getDecision } from "@/server/actions/decisions";
import { getCurrentUserName } from "@/server/actions/home";
import { getCoupleWeights } from "@/server/actions/weights";
import { requireUser } from "@/server/auth";
import { CandidatesView } from "@/components/candidates/candidates-view";
import { CoupleGapSection } from "@/components/candidates/couple-gap-section";

export const metadata: Metadata = {
  title: "候補",
  description: "候補の式場を比較し、最終決定まで並べて検討できます。",
};

interface CandidatesPageProps {
  searchParams: Promise<{ view?: string; tab?: string }>;
}

export default async function CandidatesPage({ searchParams }: CandidatesPageProps) {
  const params = await searchParams;

  // ?view=recent: surface a note that "最近見た" is in the list below.
  const isRecentView = params.view === "recent";
  // Tab compatibility mapping for old URLs
  const TAB_COMPAT: Record<string, string> = {
    matrix: "compare",
    focus: "compare",
    checklist: "compare",
  };
  const rawTab = params.tab;
  const resolvedTab = rawTab ? (TAB_COMPAT[rawTab] ?? rawTab) : undefined;
  const initialTab = resolvedTab as "shortlist" | "compare" | "decision" | undefined;

  return (
    <div className="space-y-10">
      <div>
        <p className="flex flex-wrap items-center gap-2 text-[11.5px] tracking-[0.2em] uppercase text-muted-foreground">
          <span className="font-medium text-[var(--gold-warm)]">HARETOKI</span>
          <span aria-hidden="true" className="opacity-30">·</span>
          <span>{isRecentView ? "Recent" : "Candidates"}</span>
        </p>
        <h1 className="mt-2 text-h1 font-[family-name:var(--font-display)] font-light tracking-[-0.01em]">
          {isRecentView ? "最近見た式場" : "候補"}
        </h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
          {isRecentView
            ? "先日ご覧になった式場を、そっとまとめました。"
            : "集めて、並べて、ふたりの輪郭を描く。"}
        </p>
      </div>
      {/* Gradient hairline separator */}
      <div
        aria-hidden="true"
        className="h-px w-full"
        style={{
          background:
            "linear-gradient(to right, transparent 0%, color-mix(in oklab, var(--gold-warm) 30%, transparent) 35%, color-mix(in oklab, var(--gold-warm) 30%, transparent) 65%, transparent 100%)",
        }}
      />
      <CoupleGapSection />
      {/* Ghost pill — audit C-5 upgrade from bare text link. The previous
          inline underline was too quiet and blended into CoupleGap copy;
          a hairline pill with a 16px icon keeps it secondary without
          disappearing on users who want to tune the checklist. */}
      <div className="flex justify-end">
        <Link
          href="/checklist"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border/60 bg-surface-raised px-4 text-[12px] text-muted-foreground transition-colors duration-200 hover:border-[var(--gold-warm)]/60 hover:text-[var(--gold-warm)]"
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          チェック項目を編集
        </Link>
      </div>

      {/* Candidates list + compare + decision — chrome above paints first,
          the heavier 4-call Promise.all streams in behind a shape-aware
          skeleton (R4). */}
      <Suspense fallback={<CandidatesViewSkeleton />}>
        <CandidatesContent initialTab={initialTab} />
      </Suspense>
    </div>
  );
}

async function CandidatesContent({
  initialTab,
}: {
  initialTab: "shortlist" | "compare" | "decision" | undefined;
}) {
  const [favorites, venues, decision, userName, coupleWeights, currentUser] = await Promise.all([
    getFavorites("mine"),
    getVenues(),
    getDecision(),
    getCurrentUserName(),
    // W12-1 → W13-1: fetch both the viewer's weights AND the couple mix
    // in a single round-trip so the候補 tab can offer a "自分 / 二人の合成"
    // toggle without a second fetch after hydrate. If this fails (e.g. no
    // project yet — shouldn't happen past requireProjectMembership, but
    // stays defensive) we fall back to null → the view behaves exactly as
    // W11 did (equal weights, no couple toggle).
    getCoupleWeights().catch(() => null),
    // CurrentUser is needed to distinguish "me" vs "partner" in the
    // favorite filter. Hard-coding `isFavorite={true}` for partner-only
    // venues paints the heart filled even when the viewer hasn't added
    // it, which the user then mistakes for an already-added card —
    // root cause of "ハートを押しても何も起きない" (incident 2026-05-24).
    requireUser(),
  ]);
  const currentUserId = currentUser.id;

  // venueOptions carries the minimum fields the view + ceremony need: id/name
  // for selection, photoUrls[0] so the DecisionCeremony hero card can paint
  // the chosen venue's photo as its atmospheric backdrop.
  const venueOptions = venues.map((v) => ({
    id: v.id,
    name: v.name,
    photoUrl: v.photoUrls?.[0] ?? null,
  }));

  return (
    <CandidatesView
      initialFavorites={favorites}
      venueOptions={venueOptions}
      initialDecision={
        decision
          ? { venueName: decision.venue.name, rationale: decision.rationale, projectId: decision.projectId }
          : null
      }
      userName={userName}
      initialTab={initialTab}
      weights={coupleWeights?.mine ?? null}
      coupleWeights={coupleWeights}
      currentUserId={currentUserId}
    />
  );
}

function CandidatesViewSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      {/* Segmented control (3 primary tabs) */}
      <div className="flex gap-1 rounded-2xl bg-muted/60 p-1.5">
        <div className="h-11 flex-1 animate-pulse rounded-xl bg-muted/80" />
        <div className="h-11 flex-1 animate-pulse rounded-xl bg-muted/80" />
        <div className="h-11 flex-1 animate-pulse rounded-xl bg-muted/80" />
      </div>
      {/* Venue cards (3) */}
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="space-y-3 rounded-2xl bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.06)]"
        >
          <div className="aspect-[3/2] w-full animate-pulse rounded-xl bg-muted/60" />
          <div className="h-5 w-3/4 animate-pulse rounded bg-muted/60" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted/60" />
        </div>
      ))}
    </div>
  );
}
