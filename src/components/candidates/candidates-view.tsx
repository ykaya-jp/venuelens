"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import dynamic from "next/dynamic";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { SegmentedControl } from "@/components/candidates/segmented-control";
import { FavoriteFilter } from "@/components/candidates/favorite-filter";
import { VenueCard } from "@/components/venues/venue-card";
import { DecisionSummaryCard } from "@/components/candidates/decision-summary-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Heart, BarChart3, Trophy, PartyPopper, Loader2, Sparkles, Info, User, Users } from "lucide-react";
import { getFavorites } from "@/server/actions/favorites";
import { makeDecision, cancelDecision } from "@/server/actions/decisions";
import { toast } from "sonner";
import type { VenueStatus } from "@/generated/prisma/client";
import { buildDecisionSummary, type SummaryVenueInput } from "@/lib/decision-summary";
import type { DimensionWeights } from "@/lib/scoring";
import { WeightModeToggle, type WeightMode } from "@/components/candidates/weight-mode-toggle";
import { AlignmentBadge } from "@/components/candidates/alignment-badge";

/* ── Tab content split via next/dynamic ───────────────────────────────────
   Shortlist is the default tab (99% of first-paint traffic). The other 4
   tabs + SwipeCompare pull in heavy transitive deps (charts, canvas-
   confetti, complex comparison tables). Lazy-loading them cuts the
   /candidates initial JS by ~30-40% and makes tab-switching perceptually
   snappier on 3G networks (B-11).                                         */

const TabFallback = () => (
  <div className="flex justify-center py-16">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
);

const CompareRedesigned = dynamic(
  () =>
    import("@/components/comparison/compare-redesigned").then(
      (m) => m.CompareRedesigned,
    ),
  { loading: TabFallback },
);
const PriorityWeights = dynamic(
  () => import("@/components/comparison/priority-weights").then((m) => m.PriorityWeights),
  { loading: TabFallback },
);
const SwipeCompare = dynamic(
  () => import("@/components/candidates/swipe-compare").then((m) => m.SwipeCompare),
  { loading: TabFallback },
);
const DecisionCeremony = dynamic(
  () => import("@/components/decision/decision-ceremony").then((m) => m.DecisionCeremony),
  { loading: TabFallback },
);

type Tab = "shortlist" | "compare" | "decision";

/* P2.D virtual-scroll thresholds.
   Below the threshold, the existing AnimatePresence + motion.div path
   renders so the slide-out exit animation on un-favoriting stays
   visible. At or above it, useWindowVirtualizer takes over — the
   exit animation is sacrificed (item not in DOM = no exit), which is
   acceptable for the rare 30+ favorites edge case where scroll
   smoothness is the dominant concern.
   FAVORITE_ITEM_ESTIMATE_HEIGHT_PX = VenueCard (~280-320px) plus the
   optional DecisionSummaryCard (~80px) plus the space-y-4 (16px) gap.
   Slight overestimate is preferable: virtualizer will measure actual
   height after mount via measureElement and re-layout. */
const FAVORITES_VIRTUALIZE_THRESHOLD = 30;
const FAVORITE_ITEM_ESTIMATE_HEIGHT_PX = 360;

interface FavoriteVenue {
  venue: {
    id: string;
    name: string;
    location: string | null;
    photoUrls: string[];
    status: VenueStatus;
    costMin: number | null;
    costMax: number | null;
    capacityMin: number | null;
    capacityMax: number | null;
    scores: Array<{ dimension: string; score: number; source: string }>;
  };
  favoritedBy: string[];
}

interface DecisionData {
  venueName: string;
  rationale: string | null;
  projectId?: string;
}

interface CandidatesViewProps {
  initialFavorites: FavoriteVenue[];
  venueOptions: Array<{ id: string; name: string; photoUrl?: string | null }>;
  initialDecision?: DecisionData | null;
  userName?: string;
  initialTab?: "shortlist" | "compare" | "decision";
  /**
   * Viewer's user.id from `requireUser()`. Needed so the shortlist can
   * tell "the venue is my favorite" apart from "the venue is my
   * partner's favorite I happen to be viewing" — the previous code
   * hard-coded `isFavorite={true}` for every row and the partner-only
   * filter painted hearts filled, breaking the heart-to-toggle flow
   * (= the canonical 2026-05-24 incident).
   */
  currentUserId: string;
  /**
   * W12-1: viewer's per-dimension weights. Used to recompute each venue
   * card's ★ badge with the couple's individual priorities. Null / omitted
   * → defaults to equal weights (legacy unweighted average) so the call
   * site can opt in incrementally.
   */
  weights?: DimensionWeights | null;
  /**
   * W13-1: optional couple mix + alignment. Null when no partner exists
   * on the project — in that case the mode toggle stays hidden and the
   * shortlist ranks by `weights` (mine) alone, matching W12-1 behaviour.
   */
  coupleWeights?: {
    mine: DimensionWeights;
    couple: DimensionWeights;
    alignment: number | null;
    hasPartner: boolean;
    partnerHasWeights: boolean;
    partnerName: string | null;
  } | null;
}

export function CandidatesView({
  initialFavorites,
  venueOptions,
  initialDecision,
  userName,
  initialTab,
  weights = null,
  coupleWeights = null,
  currentUserId,
}: CandidatesViewProps) {
  // Derive the "me"/"partner" badge set for a favorite row. `favoritedBy`
  // arrives as a list of raw userIds; the VenueCard prop expects a
  // narrowed enum so it can render the dual-heart pip without leaking
  // identifiers into the DOM.
  const labelsFor = (fav: FavoriteVenue): ("me" | "partner")[] => {
    const labels: ("me" | "partner")[] = [];
    if (fav.favoritedBy.includes(currentUserId)) labels.push("me");
    if (fav.favoritedBy.some((id) => id !== currentUserId)) labels.push("partner");
    return labels;
  };
  const isMine = (fav: FavoriteVenue): boolean =>
    fav.favoritedBy.includes(currentUserId);
  const [tab, setTab] = useState<Tab>(initialTab ?? "shortlist");
  const [filter, setFilter] = useState<"mine" | "partner" | "both">("mine");
  // W13-1: "自分" vs "二人の合成". Default is "mine" per product stance —
  // the user's own perspective is the least surprising starting point,
  // and couple mode is opt-in. Only rendered when hasPartner is true.
  const [weightMode, setWeightMode] = useState<WeightMode>("mine");
  const hasPartner = Boolean(coupleWeights?.hasPartner);
  const activeWeights: DimensionWeights | null =
    weightMode === "couple" && coupleWeights
      ? coupleWeights.couple
      : weights;
  const [favorites, setFavorites] = useState(initialFavorites);
  const [showSwipe, setShowSwipe] = useState(false);
  const [showCeremony, setShowCeremony] = useState(false);
  const [ceremonyVenueName, setCeremonyVenueName] = useState("");
  const [ceremonyProjectId, setCeremonyProjectId] = useState<string | undefined>(undefined);
  // Photo used as the atmospheric backdrop inside the ceremony hero card.
  // Null when the chosen venue has no photo — ceremony falls back to the
  // gold-gradient card layout.
  const [ceremonyPhotoUrl, setCeremonyPhotoUrl] = useState<string | null>(null);
  const [decision, setDecision] = useState(initialDecision ?? null);
  const [isDeciding, setIsDeciding] = useState(false);
  const router = useRouter();

  // Compare-mode UI (shortlist tab → tap-to-toggle → sticky CTA → /compare)
  // was removed in favour of the "比べる" sub-tab, which now owns venue
  // selection via CompareRedesigned's chip picker. Keeping two selection
  // surfaces forced couples to learn both paths; consolidating on one
  // matches the user's mental model ("tap 比べる, pick venues, see matrix").

  useEffect(() => {
    // Refetch when filter changes
    getFavorites(filter).then(setFavorites);
  }, [filter]);

  const canCompare = venueOptions.length >= 2;
  const canDecide = venueOptions.length >= 1;

  /* W11-2: memoized per-venue summaries keyed by venueId.
     Rebuilt whenever the favorites array (or its scores/costs) change. */
  const summariesByVenueId = useMemo(() => {
    if (favorites.length < 2) return {};
    const shortlist: SummaryVenueInput[] = favorites.map((f) => ({
      id: f.venue.id,
      name: f.venue.name,
      costMin: f.venue.costMin,
      costMax: f.venue.costMax,
      scores: f.venue.scores,
    }));
    const result: Record<string, ReturnType<typeof buildDecisionSummary>> = {};
    for (const v of shortlist) {
      result[v.id] = buildDecisionSummary(v.id, shortlist);
    }
    return result;
  }, [favorites]);

  const SEGMENTS = [
    { id: "shortlist" as const, label: "候補" },
    {
      id: "compare" as const,
      label: "比べる",
      disabled: !canCompare,
      disabledHint: "候補を2件以上追加すると比べられます",
    },
    {
      id: "decision" as const,
      label: "決める",
      disabled: !canDecide,
      disabledHint: "候補を1件以上追加すると使えます",
    },
  ];

  const handleDecide = async (venueId: string) => {
    if (isDeciding) return; // sync guard against double-submit
    const venue = venueOptions.find((v) => v.id === venueId);
    if (!venue) return;

    // Guard against re-deciding when a decision already exists. The DB upsert
    // would silently overwrite, which is surprising — require an explicit
    // confirmation.
    if (decision) {
      const ok =
        typeof window !== "undefined" &&
        window.confirm(
          `すでに「${decision.venueName}」に決まっています。「${venue.name}」に変更しますか？`,
        );
      if (!ok) return;
    }

    setIsDeciding(true);
    try {
      const result = await makeDecision({
        selectedVenueId: venueId,
      });

      if ("error" in result) {
        toast.error("うまく記録できませんでした");
        return;
      }

      setCeremonyVenueName(venue.name);
      setCeremonyProjectId("decision" in result ? result.decision.projectId : undefined);
      setCeremonyPhotoUrl(venue.photoUrl ?? null);
      setShowCeremony(true);
      setTab("decision");
    } finally {
      setIsDeciding(false);
    }
  };

  const handleCeremonyComplete = async (_tags: string[], _text: string) => {
    setShowCeremony(false);
    setDecision({ venueName: ceremonyVenueName, rationale: _text || null });
    router.refresh();
  };

  return (
    <div className="space-y-5">
      {/* C-3: editorial リード文 — Shippori 2 段 */}
      <div className="space-y-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Three steps, gently
        </p>
        <p className="font-[family-name:var(--font-display)] text-[15px] font-light leading-relaxed tracking-[0.01em] text-muted-foreground">
          集める → 並べる → 決める
        </p>
      </div>
      <SegmentedControl
        segments={SEGMENTS}
        activeId={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      <AnimatePresence mode="popLayout">
        {tab === "shortlist" && (
          <motion.div
            key="shortlist"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, pointerEvents: "none" as const }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <FavoriteFilter active={filter} onChange={setFilter} />

            {/* W13-1: couple ranking mode toggle.
                Hidden for solo projects (hasPartner=false) and when the
                shortlist is empty — there's nothing to rank yet, the
                toggle would be cognitive noise. */}
            {hasPartner && favorites.length > 0 && (
              <div className="mt-3 space-y-2">
                <WeightModeToggle
                  value={weightMode}
                  onChange={setWeightMode}
                  partnerName={coupleWeights?.partnerName ?? null}
                />
                {weightMode === "couple" && (
                  <div className="flex flex-wrap items-center gap-2">
                    {coupleWeights?.alignment !== null &&
                      coupleWeights?.alignment !== undefined && (
                        <AlignmentBadge score={coupleWeights.alignment} />
                      )}
                    {coupleWeights && !coupleWeights.partnerHasWeights && (
                      <span
                        role="note"
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground"
                      >
                        <Info
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0"
                          strokeWidth={1.8}
                        />
                        パートナーはまだ重みを設定していません
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {favorites.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1, duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                className="mt-4"
              >
                <EmptyState
                  icon={Heart}
                  imageUrl="/images/empty-candidates.png"
                  imageAlt="候補を集める"
                  title="これから、ふたりの輪郭を描いていきましょう"
                  description="式場カードの♡をそっとタップすると、ここに集まります。2件並んだら、比較してみてください。"
                  action={
                    venueOptions.length === 0
                      ? { label: "最初の式場を追加", href: "/explore?addVenue=1" }
                      : { label: "式場を見てみる", href: "/explore" }
                  }
                />
              </motion.div>
            ) : (
              <div className="mt-4 space-y-4">
                {favorites.length === 2 && !showSwipe && (
                  <Link
                    href={`/candidates/duel?a=${favorites[0].venue.id}&b=${favorites[1].venue.id}`}
                    className="block w-full rounded-2xl border-l-[3px] border-y border-r border-border/40 p-4 transition-colors active:opacity-90"
                    style={{
                      borderLeftColor: "var(--gold-warm)",
                      background: "var(--gold-subtle)",
                    }}
                  >
                    <div className="flex items-start gap-2.5">
                      <Sparkles
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--gold-warm)]"
                        strokeWidth={1.6}
                      />
                      <div className="flex-1">
                        <p className="text-eyebrow text-[var(--gold-warm)]">
                          For Two
                        </p>
                        <p className="mt-0.5 font-[family-name:var(--font-display)] text-[15px] font-light leading-snug tracking-[0.01em] text-foreground">
                          情景で決める
                        </p>
                        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                          2 件で迷ったとき、ふたりの心がどちらに寄っているか、静かに知る方法があります。
                        </p>
                      </div>
                      <span
                        aria-hidden="true"
                        className="mt-1 shrink-0 text-[11px] text-muted-foreground"
                      >
                        →
                      </span>
                    </div>
                  </Link>
                )}

                {favorites.length >= 5 && !showSwipe && (
                  <motion.button
                    type="button"
                    onClick={() => setShowSwipe(true)}
                    whileTap={{ scale: 0.97, transition: { type: "spring", stiffness: 250, damping: 25 } }}
                    className="w-full rounded-2xl border border-border bg-card px-4 py-3.5 text-sm text-center shadow-[var(--shadow-card)] transition-colors active:bg-muted"
                  >
                    スワイプで選ぶ ({favorites.length}件)
                  </motion.button>
                )}

                {showSwipe && (
                  <SwipeCompare
                    venues={favorites.map(f => ({
                      id: f.venue.id,
                      name: f.venue.name,
                      location: f.venue.location,
                      photoUrls: f.venue.photoUrls,
                      totalScore: 0,
                      topStrengths: [],
                      latestEstimate: null,
                    }))}
                    onComplete={(_kept, compareIds) => {
                      setShowSwipe(false);
                      router.refresh();
                      // If the user up-swiped 2+ venues, jump straight to the
                      // compare board — otherwise just re-render the shortlist
                      // with left-swiped venues now removed.
                      if (compareIds.length >= 2 && canCompare) {
                        setTab("compare");
                      }
                    }}
                  />
                )}

                {!showSwipe &&
                  (favorites.length < FAVORITES_VIRTUALIZE_THRESHOLD ? (
                    <AnimatePresence>
                      {favorites.map((fav, index) => (
                        <motion.div
                          key={fav.venue.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, x: -100, transition: { duration: 0.4 } }}
                          transition={{ delay: Math.min(index, 4) * 0.06, duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                          className="relative"
                        >
                          <VenueCard
                            venue={fav.venue}
                            isFavorite={isMine(fav)}
                            favoritedBy={labelsFor(fav)}
                            weights={activeWeights}
                          />
                          {/* Audit P0-6: surface which weighting mode the
                              ★ badge currently uses. Without this, the
                              ranked number on each card silently swaps
                              meaning when the WeightModeToggle flips —
                              users said they remembered "A=4.6" in
                              "自分" mode, returned in "ふたり" mode,
                              and felt the app lied to them. The pill is
                              ornamental + pointer-events-none so it
                              doesn't catch taps meant for the card. */}
                          {hasPartner && (
                            <span
                              aria-label={
                                weightMode === "couple"
                                  ? "ふたりの合成スコアでの順位"
                                  : "自分の優先度でのスコア"
                              }
                              className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-card/85 px-1.5 py-0.5 text-[9.5px] tracking-[0.04em] text-muted-foreground shadow-sm backdrop-blur-sm"
                            >
                              {weightMode === "couple" ? (
                                <>
                                  <Users className="h-2.5 w-2.5" aria-hidden />
                                  ふたり
                                </>
                              ) : (
                                <>
                                  <User className="h-2.5 w-2.5" aria-hidden />
                                  自分
                                </>
                              )}
                            </span>
                          )}
                          {/* W11-2: per-venue "この式場を選ぶなら" summary card.
                              Rendered under the venue card as a folded
                              disclosure — client-side math on the already-
                              loaded favorites list, no extra round-trip. */}
                          {favorites.length >= 2 && (
                            <DecisionSummaryCard
                              summary={summariesByVenueId[fav.venue.id] ?? null}
                              venueName={fav.venue.name}
                            />
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  ) : (
                    <VirtualFavoritesList
                      favorites={favorites}
                      activeWeights={activeWeights}
                      summariesByVenueId={summariesByVenueId}
                      currentUserId={currentUserId}
                    />
                  ))}
              </div>
            )}
          </motion.div>
        )}

        {tab === "compare" && (
          <motion.div
            key="compare"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, pointerEvents: "none" as const }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {canCompare ? (
              <CompareRedesigned />
            ) : (
              <EmptyState
                icon={BarChart3}
                title="候補を2件以上集めると比べられます"
                description="式場を候補に入れると、ここで並べて見比べられます。"
                action={{ label: "式場を探す", href: "/explore" }}
              />
            )}
          </motion.div>
        )}

        {tab === "decision" && (
          <motion.div
            key="decision"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, pointerEvents: "none" as const }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {!canDecide ? (
              <EmptyState
                icon={Trophy}
                title="まずは式場を1件候補に入れてください"
                description="候補の式場から、最終決定を行えます。"
                action={{ label: "式場を探す", href: "/explore" }}
              />
            ) : showCeremony ? (
              <DecisionCeremony
                venueName={ceremonyVenueName}
                userName={userName ?? ""}
                projectId={ceremonyProjectId ?? decision?.projectId}
                photoUrl={ceremonyPhotoUrl}
                journeyStats={{
                  totalVenues: venueOptions.length,
                  shortlisted: favorites.length,
                  compared: Math.min(venueOptions.length, 2),
                }}
                onRecordReason={handleCeremonyComplete}
              />
            ) : decision ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                className="space-y-5 rounded-2xl bg-card p-8 text-center shadow-[var(--shadow-card)]"
              >
                <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[var(--gold-subtle)]">
                  <PartyPopper className="h-9 w-9 text-[var(--gold-warm)]" aria-hidden />
                </div>
                <h3 className="font-[family-name:var(--font-display)] text-xl font-light tracking-wide">{decision.venueName}</h3>
                <p className="text-sm text-muted-foreground">に決まりました</p>
                {decision.rationale && (
                  <p className="rounded-xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                    決めた理由: {decision.rationale}
                  </p>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      typeof window !== "undefined" &&
                      !window.confirm("「" + decision.venueName + "」の決定を取り消しますか？候補に戻ります。")
                    ) {
                      return;
                    }
                    const res = await cancelDecision();
                    if (res.cancelled) {
                      setDecision(null);
                      toast.success("決定を取り消しました");
                      router.refresh();
                    } else {
                      toast.error("取り消せませんでした");
                    }
                  }}
                  className="mx-auto inline-flex min-h-11 items-center justify-center rounded-full border border-border px-5 text-xs text-muted-foreground transition-colors active:bg-muted"
                >
                  この決定を取り消す
                </button>
              </motion.div>
            ) : (
              <PriorityWeights onDecide={handleDecide} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

/**
 * Virtualized variant of the favorites list, kicked in once the count
 * crosses {@link FAVORITES_VIRTUALIZE_THRESHOLD}. Mirrors the
 * VirtualVenueList pattern in src/components/explore/explore-content.tsx
 * so future maintenance only has to learn the shape once: window
 * virtualizer + scrollMargin pinned post-mount + measureElement so
 * variable-height rows (DecisionSummaryCard appears only when 2+
 * favorites exist) settle to their real height after first paint.
 */
function VirtualFavoritesList({
  favorites,
  activeWeights,
  summariesByVenueId,
  currentUserId,
}: {
  favorites: FavoriteVenue[];
  activeWeights: DimensionWeights | null;
  summariesByVenueId: Record<string, ReturnType<typeof buildDecisionSummary> | null>;
  currentUserId: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // scrollMargin must be a plain value (not a ref read) during render —
  // React 19 flags ref-access-in-render as a purity violation. Pin it
  // post-mount in a layout effect; the virtualizer reruns once with
  // the correct offset, which is invisible to the user.
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const offset = listRef.current?.offsetTop ?? 0;
    setScrollMargin(offset);
  }, []);

  const showSummary = favorites.length >= 2;

  const virtualizer = useWindowVirtualizer({
    count: favorites.length,
    estimateSize: () => FAVORITE_ITEM_ESTIMATE_HEIGHT_PX,
    overscan: 4,
    // Match the `space-y-4` (16px) gap of the non-virtualized branch
    // so the visual rhythm is identical at the threshold boundary.
    gap: 16,
    scrollMargin,
    getItemKey: (i) => favorites[i]?.venue.id ?? i,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={listRef}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {items.map((vi) => {
          const fav = favorites[vi.index];
          if (!fav) return null;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <VenueCard
                venue={fav.venue}
                isFavorite={fav.favoritedBy.includes(currentUserId)}
                favoritedBy={(() => {
                  const labels: ("me" | "partner")[] = [];
                  if (fav.favoritedBy.includes(currentUserId)) labels.push("me");
                  if (fav.favoritedBy.some((id) => id !== currentUserId)) labels.push("partner");
                  return labels;
                })()}
                weights={activeWeights}
              />
              {showSummary && (
                <DecisionSummaryCard
                  summary={summariesByVenueId[fav.venue.id] ?? null}
                  venueName={fav.venue.name}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
