"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Loader2,
  MessageSquareHeart,
  Sparkles,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  getUnifiedComparisonData,
  type UnifiedComparisonData,
  type FavoritedByMap,
} from "@/server/actions/unified-comparison";
import {
  getMatrixInsight,
  type MatrixInsight,
} from "@/server/actions/matrix-insight";
import { getCoupleRatings } from "@/server/actions/ratings";
import { AIInsightCard } from "@/components/ai/insight-card";
import { ShareButton } from "@/components/ui/share-button";
import { cn } from "@/lib/utils";
import { LUXURY_EASE } from "@/lib/motion-variants";
import {
  aggregatePartnerDiffAcrossVenues,
  classifyAdvantage,
  computePartnerOpinionDiff,
  type Advantage,
  type PartnerOpinionDiff,
} from "@/lib/comparison-advantage";

/**
 * CompareRedesigned — horizontal multi-select comparison table.
 *
 * The wife-review session landed on two firm requirements:
 *   1. Pick *any* N venues from the project (owner filter acts as a
 *      source-pool chip, not as a gate — users can pick across pools)
 *   2. See them **side-by-side horizontally** with compact per-dimension
 *      bars so the whole matrix reads as a spreadsheet at a glance
 *
 * The earlier iteration tried to dodge the mobile-width problem by
 * offering Duel (pairs) + Stack (vertical) modes and skipping the
 * matrix altogether. User explicitly rejected that ("横並びで比較
 * できるようにしたい") — so the matrix is back, done right this time:
 *
 *   - ALL rows (header, total, every dimension) share a single grid
 *     template via the `--cmp-grid` CSS custom property on the outer
 *     scroll container. No more DimensionRow drift.
 *   - Fixed column widths (120px label + 112px per venue). On mobile
 *     375px this means 2 venues fit exactly; 3+ venues scroll
 *     horizontally while the label column stays sticky-left.
 *   - Stars replaced with a compact 80px horizontal bar + tabular
 *     numeric score. 5 bars in a row are legible at 112px; 5 stars
 *     weren't.
 *   - Winner highlighting = subtle gold background + bold score,
 *     NOT a full-cell gold fill. Previous version saturated columns
 *     in gold which made 4-column matrices feel like a trophy shelf.
 */

type OwnerFilter = "mine" | "partner" | "both";

// Audit P1-17: dropped the "すべて" tab so this control matches
// `<FavoriteFilter>` on /candidates (3 cells, in the same "自分 →
// パートナー → おふたり" sequence). Two screens that look like the
// same segmented control used to differ by one cell, which broke the
// couple's mental model when jumping from /candidates into /compare.
const OWNER_FILTERS: { id: OwnerFilter; label: string }[] = [
  { id: "mine", label: "自分" },
  { id: "partner", label: "パートナー" },
  { id: "both", label: "おふたり" },
];

// Scale ceiling — users reported wanting to compare 20+ venues at once.
// Raising to 20 still performs cleanly because each cell is a bar +
// number (no heavy per-cell framer animation). 20 × 112 = 2240px of
// horizontal content, which feels right as a deliberate scrolling
// exploration rather than a cramped fit.
const MAX_SELECTED = 20;
const LABEL_COL_PX = 120;
const VENUE_COL_PX = 112;

export function CompareRedesigned() {
  const searchParams = useSearchParams();
  // `?venueIds=a,b,c` preseeds the selection — used by the venue detail
  // page's "比べる" CTA so a couple taps once and lands on the compare
  // matrix with the current venue already picked. Safe to parse
  // lazily; we fall back to the auto-seed below when the param is
  // missing or all ids get filtered out by the owner pool.
  const initialVenueIds = useMemo(() => {
    const raw = searchParams?.get("venueIds") ?? "";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [searchParams]);

  const [data, setData] = useState<UnifiedComparisonData | null>(null);
  const [insight, setInsight] = useState<MatrixInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("mine");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialVenueIds),
  );
  const [diffOnly, setDiffOnly] = useState(false);
  // 「細かく見る」 トグル — 親 8 次元行の下に、 該当次元配下の子項目
  // (= /checklist で active 化したもの) を サブ行として展開する。 PR #51 の
  // ChildRatingPanel で入れた score がこのトグルで見比べられる。 OFF 既定:
  // 8 行 + N 子行 (大抵 40+) はモバイルで縦に長すぎるため、 開きたいとき
  // だけ開く形にする。
  const [showChildren, setShowChildren] = useState(false);
  // W11-1 Feature B: "意見差を上に" toggle. When on, dimension rows are
  // re-ordered by the couple's |owner − partner| magnitude so the
  // most-split rows surface first and the top 1-2 get a "話し合いましょう"
  // chip. Off by default — the natural Tier-1 order is still the best
  // first read for most couples.
  const [sortByPartnerDiff, setSortByPartnerDiff] = useState(false);
  // venueId → { own, other } map (viewer-aware shape). Populated lazily
  // the first time the couple flips the partner-diff sort on, keyed by
  // the currently-selected venues. Round 24: migrated from the
  // role-keyed `getPartnerRatings` to viewer-aware `getCoupleRatings`
  // — the "意見差を上に" feature reads more naturally as
  // "あなた vs 相手" than as "owner vs partner" since the partner
  // viewer was previously seeing their own scores in the "owner" slot
  // (the same double-count bug round 23 fixed for rating-section).
  // The diff magnitude itself is symmetric (|own − other|) so the
  // ranking is unaffected by which side gets which slot — but the
  // per-venue cache and downstream consumers now use the viewer-aware
  // names too, keeping the mental model consistent.
  const [partnerMap, setPartnerMap] = useState<
    Record<string, { own: Record<string, number> | null; other: Record<string, number> | null }>
  >({});
  const [partnerLoading, setPartnerLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [compData, insightData] = await Promise.all([
          getUnifiedComparisonData(),
          getMatrixInsight(),
        ]);
        if (!cancelled) {
          setData(compData);
          setInsight(insightData);
        }
      } catch {
        // fall through to the "< 2" empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stable join of the currently-selected venue ids so the effect
  // below only re-fires when the *set* actually changes. The Set
  // identity itself changes on every toggle, which would otherwise
  // thrash the fetch.
  const selectedKey = useMemo(
    () => Array.from(selected).sort().join(","),
    [selected],
  );

  // Lazily fetch per-venue partner ratings the first time the user
  // enables the "意見差を上に" sort (and any time the selection
  // changes while it's on). Skips venues already cached in
  // `partnerMap` so toggling off/on is free after the first fetch.
  //
  // Every setState is deferred through `queueMicrotask` so we don't
  // trip React 19's `set-state-in-effect` guard. The fetch is async
  // anyway — the body just kicks it off, the awaited `.then()` runs
  // after the current render cycle.
  useEffect(() => {
    if (!sortByPartnerDiff) return;
    const ids = selectedKey ? selectedKey.split(",").filter(Boolean) : [];
    const missing = ids.filter((id) => !(id in partnerMap));
    if (missing.length === 0) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setPartnerLoading(true);
    });
    void Promise.all(
      missing.map((id) =>
        getCoupleRatings(id)
          .then((r) => ({
            id,
            own: r.ownRatings?.ratings ?? null,
            other: r.otherRatings?.ratings ?? null,
          }))
          .catch(() => ({ id, own: null, other: null })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setPartnerMap((prev) => {
        const next = { ...prev };
        for (const r of results) {
          next[r.id] = { own: r.own, other: r.other };
        }
        return next;
      });
      setPartnerLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // partnerMap intentionally omitted — including it would re-trigger
    // the effect every time we set it, creating an infinite loop. The
    // `missing` guard above handles cache invalidation on selection
    // change explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortByPartnerDiff, selectedKey]);

  // Pool defines which venues are eligible for the chip picker. The
  // owner filter narrows the pool; selected venues that fall outside
  // the new pool are dropped (render-phase reset, no effect cascade).
  const pool = useMemo(() => {
    if (!data) return [];
    return data.venues.filter((v) => {
      const owners: FavoritedByMap[string] = data.favoritedBy[v.id] ?? [];
      if (ownerFilter === "mine") return owners.includes("me");
      if (ownerFilter === "partner") return owners.includes("partner");
      return owners.includes("me") && owners.includes("partner");
    });
  }, [data, ownerFilter]);

  // Auto-seed the initial selection from the first 3 pool entries.
  // React 19 sanctions render-phase resets over useEffect setState.
  const [prevOwnerFilter, setPrevOwnerFilter] = useState(ownerFilter);
  if (prevOwnerFilter !== ownerFilter) {
    setPrevOwnerFilter(ownerFilter);
    if (pool.length === 0) {
      setSelected(new Set());
    } else {
      const kept = new Set<string>();
      for (const v of pool) if (selected.has(v.id)) kept.add(v.id);
      if (kept.size >= 2) {
        setSelected(kept);
      } else {
        setSelected(
          new Set(pool.slice(0, Math.min(3, pool.length)).map((v) => v.id)),
        );
      }
    }
  } else if (
    !loading &&
    data &&
    selected.size === 0 &&
    pool.length >= 2
  ) {
    // First paint: seed selection. Guarded on `!loading` so we don't
    // fight the initial `setData` setState.
    setSelected(
      new Set(pool.slice(0, Math.min(3, pool.length)).map((v) => v.id)),
    );
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      if (next.size >= MAX_SELECTED) return prev;
      next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.venues.length < 2) {
    return (
      <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          並べて見比べるには、式場を 2 件以上
          <br />
          候補にしてください。
        </p>
        <Link
          href="/explore"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground active:scale-[0.98]"
        >
          式場を探す
        </Link>
      </div>
    );
  }

  const selectedVenues = data.venues.filter((v) => selected.has(v.id));
  const venueIds = selectedVenues.map((v) => v.id);
  const canRender = venueIds.length >= 2;

  // Exactly-2 mode unlocks the head-to-head arrow cue: when the couple
  // is deciding between two venues, the matrix stops being a table and
  // starts being a "左 vs 右" read. Arrows only render in this mode;
  // 3+ venues fall back to the existing winner tint.
  const isHeadToHead = venueIds.length === 2;

  // Build matrix rows with per-dimension winner detection. "Winner"
  // semantics reused from the server payload; we only compute the
  // "ほぼ同じ (|Δ| < 0.5)" tie flag locally so the UI can tint
  // less aggressively when the gap is not meaningful.
  const rows = data.dimensions.map((d) => {
    const scores = venueIds.map((id) => d.scores[id] ?? null);
    const numeric = scores.filter((s): s is number => s !== null);
    const max = numeric.length > 0 ? Math.max(...numeric) : null;
    const min = numeric.length > 0 ? Math.min(...numeric) : null;
    const spread = max !== null && min !== null ? max - min : 0;
    const hasMeaningfulDiff = spread >= 0.5;
    const winnerId =
      max !== null && hasMeaningfulDiff
        ? venueIds[scores.findIndex((s) => s === max)] ?? null
        : null;
    // W11-1 Feature A: classify head-to-head advantage. Null when
    // more than 2 venues are selected so the cell renderer can skip
    // the arrow entirely.
    const advantage: Advantage | null = isHeadToHead
      ? classifyAdvantage(scores[0], scores[1])
      : null;
    return { dim: d, scores, winnerId, hasMeaningfulDiff, spread, advantage };
  });

  // W11-1 Feature B: when the partner-diff sort is on, re-order rows
  // by MAX |owner - partner| across selected venues (desc). Ties keep
  // the original Tier-1 order — stable sort via index tie-breaker.
  const partnerDiffByDim: Record<string, number> = {};
  if (sortByPartnerDiff) {
    const perVenueDiffs: PartnerOpinionDiff[][] = venueIds.map((id) => {
      const cached = partnerMap[id];
      // computePartnerOpinionDiff is symmetric in its two ratings args
      // (it computes |a − b|), so we can pass {own, other} into the
      // {owner, partner} parameter slots without changing the magnitude
      // result. The function name still says "partner" because the
      // ranking semantics — "where do the two of you disagree most" —
      // are identical regardless of which side gets which slot.
      return computePartnerOpinionDiff(
        data.dimensions.map((d) => d.id),
        cached?.own ?? null,
        cached?.other ?? null,
      );
    });
    for (const d of data.dimensions) {
      partnerDiffByDim[d.id] = aggregatePartnerDiffAcrossVenues(
        perVenueDiffs,
        d.id,
      );
    }
  }
  const sortedRows = sortByPartnerDiff
    ? [...rows]
        .map((row, idx) => ({ row, idx }))
        .sort((a, b) => {
          const da = partnerDiffByDim[a.row.dim.id] ?? 0;
          const db = partnerDiffByDim[b.row.dim.id] ?? 0;
          if (db !== da) return db - da;
          return a.idx - b.idx;
        })
        .map(({ row }) => row)
    : rows;

  // 「差がある項目だけ」 と 「細かく見る」 の併用ロジック:
  //
  // diffOnly のみ ON: 親 dim の hasMeaningfulDiff のみで判定 (従来通り)
  //
  // diffOnly + showChildren 両 ON: 親平均が ほぼ同じでも、 配下の子に
  // hasDifference が 1 件以上あれば親行を残す。 そうしないと「料理 4.0
  // / 4.0 / 4.0 だけど "味" 4.5 vs 2.0 の差がある」 ようなケースが
  // 親レベルで間引かれて子も完全に消える (= 「差を探したい」 主旨に逆らう)。
  // 子側の filter (ChildItemRows 内) で hasDifference の子だけ残るので、
  // 親 + diff 子の対だけが表示される結果になる。
  const visibleRows = diffOnly
    ? sortedRows.filter((r) => {
        if (r.hasMeaningfulDiff) return true;
        if (showChildren && r.dim.checklistItems.some((c) => c.hasDifference))
          return true;
        return false;
      })
    : sortedRows;

  // diffCount は chip 上に出る「差のある項目 N」 表示の根拠。 細かく見る
  // ON 時は子の diff も足して、 トグル前後で「差は何件あるのか」 の数字
  // が一致するようにする。
  const diffCount = rows.reduce(
    (acc, r) =>
      acc +
      (r.hasMeaningfulDiff ? 1 : 0) +
      (showChildren
        ? r.dim.checklistItems.filter((c) => c.hasDifference).length
        : 0),
    0,
  );

  // Top-2 "話し合いましょう" chip eligibility — only meaningful while
  // the partner-diff sort is on, partner data has loaded for at least
  // one venue, and the magnitude itself is non-trivial (>= 1.0 on the
  // 5-point scale means a full-star gap, which is a real conversation
  // trigger, not just noise).
  const discussDimIds = new Set<string>();
  if (sortByPartnerDiff) {
    const ranked = Object.entries(partnerDiffByDim)
      .filter(([, v]) => v >= 1.0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([id]) => id);
    for (const id of ranked) discussDimIds.add(id);
  }

  // One CSS variable drives every grid row — no more template drift.
  // Using inline style since Tailwind arbitrary values don't compose
  // cleanly with variable column counts.
  const gridStyle = {
    "--cmp-grid": `${LABEL_COL_PX}px repeat(${venueIds.length}, ${VENUE_COL_PX}px)`,
  } as React.CSSProperties;

  const atLimit = selected.size >= MAX_SELECTED;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Sticky filter bar: owner scope + selection counter + diff toggle */}
      {/* z-30: this is the topmost sticky on the compare screen. The matrix
          header below also stickies but at z-10 so the venue thumbnails
          tuck UNDER the filter bar instead of poking through (audit P0-8 —
          previous z-20/z-20 collision made venue names half-disappear). */}
      <div className="sticky top-0 z-30 space-y-3 bg-background/80 px-3 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="flex items-center justify-between gap-2">
          <div
            className="inline-flex gap-1 rounded-full bg-muted p-1"
            role="tablist"
            aria-label="誰の候補から選ぶ"
          >
            {OWNER_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={ownerFilter === f.id}
                onClick={() => setOwnerFilter(f.id)}
                className={cn(
                  "min-h-9 rounded-full px-3 text-[12px] font-medium transition-colors active:scale-[0.97]",
                  ownerFilter === f.id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
              {selected.size} / {MAX_SELECTED}
            </span>
            <button
              type="button"
              onClick={() => {
                // Toggle "select all visible pool" ⇄ clear. When the
                // entire pool is already selected, a second tap clears.
                if (
                  pool.length > 0 &&
                  pool.every((v) => selected.has(v.id))
                ) {
                  setSelected(new Set());
                } else {
                  setSelected(
                    new Set(
                      pool.slice(0, MAX_SELECTED).map((v) => v.id),
                    ),
                  );
                }
              }}
              className="min-h-9 rounded-full border border-border bg-card px-3 text-[11px] font-medium text-muted-foreground transition-colors active:scale-[0.97]"
            >
              {pool.length > 0 && pool.every((v) => selected.has(v.id))
                ? "すべて外す"
                : "すべて選ぶ"}
            </button>
          </div>
        </div>
      </div>

      {/* Venue picker — "card chips" with thumbnail + name + selection
          indicator. Horizontally scrollable; each chip tap toggles a
          selection, but chips beyond MAX_SELECTED are disabled. */}
      {pool.length === 0 ? (
        <div className="mx-3 rounded-xl border border-dashed border-border bg-surface-sunken px-4 py-6 text-center">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {ownerFilter === "both"
              ? "おふたりが共通で候補にしている式場はまだありません。"
              : ownerFilter === "partner"
                ? "パートナーの候補はまだありません。"
                : "自分の候補はまだありません。"}
          </p>
        </div>
      ) : (
        <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 scrollbar-hide">
          {pool.map((v) => {
            const on = selected.has(v.id);
            const disabled = !on && atLimit;
            const owners = data.favoritedBy[v.id] ?? [];
            const byMe = owners.includes("me");
            const byPartner = owners.includes("partner");
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => toggle(v.id)}
                disabled={disabled}
                aria-pressed={on}
                className={cn(
                  "group relative flex min-h-11 shrink-0 flex-col gap-1 overflow-hidden rounded-2xl border p-2 text-left transition-all active:scale-[0.97] disabled:opacity-40",
                  on
                    ? "border-[color-mix(in_oklab,var(--gold-warm)_60%,transparent)] bg-[var(--gold-subtle)]"
                    : "border-border bg-card",
                )}
                style={{ width: 108 }}
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-muted">
                  {v.photoUrl ? (
                    <Image
                      src={v.photoUrl}
                      alt=""
                      fill
                      sizes="100px"
                      className="object-cover"
                    />
                  ) : null}
                  {on && (
                    <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--gold-warm)] text-white shadow-[0_1px_2px_rgba(0,0,0,0.15)]">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </div>
                  )}
                </div>
                <p className="truncate font-[family-name:var(--font-display)] text-[11.5px] font-light leading-tight">
                  {v.name}
                </p>
                <div className="flex items-center gap-1">
                  {byMe && (
                    <span className="rounded-full bg-foreground/10 px-1.5 text-[9px] text-foreground/70">
                      自分
                    </span>
                  )}
                  {byPartner && (
                    <span className="rounded-full bg-foreground/10 px-1.5 text-[9px] text-foreground/70">
                      P
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {canRender ? (
        <>
          {/* Toolbar: diff toggle + checklist-editor entry.
              The audit flagged that /checklist was buried on
              candidates-level only; couples who reached the matrix and
              wanted to tweak which dimensions mattered had to back out
              two screens first. Inlining the link keeps the editor one
              tap away from where the need arises. */}
          <div className="flex flex-col gap-2 px-3">
            <p className="text-[11px] text-muted-foreground">
              {selectedVenues.length} 件 比較中 · 差のある項目{" "}
              <span className="tabular-nums text-foreground/80">
                {diffCount}
              </span>
            </p>
            <div className="-mx-3 flex items-center gap-2 overflow-x-auto px-3 scrollbar-hide">
              <Link
                href="/checklist"
                className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-[11px] text-muted-foreground transition-colors active:scale-[0.97] hover:text-foreground"
              >
                項目を編集
              </Link>
              <button
                type="button"
                onClick={() => setDiffOnly((v) => !v)}
                aria-pressed={diffOnly}
                className={cn(
                  "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-[11px] transition-colors active:scale-[0.98]",
                  diffOnly
                    ? "border-[var(--gold-warm)] bg-[var(--gold-warm)] text-white"
                    : "border-border text-muted-foreground",
                )}
              >
                <ChevronsUpDown className="h-3 w-3" strokeWidth={2} />
                差がある項目だけ
              </button>
              <button
                type="button"
                onClick={() => setShowChildren((v) => !v)}
                aria-pressed={showChildren}
                className={cn(
                  "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-[11px] transition-colors active:scale-[0.98]",
                  showChildren
                    ? "border-[var(--gold-warm)] bg-[var(--gold-warm)] text-white"
                    : "border-border text-muted-foreground",
                )}
              >
                細かく見る
              </button>
              {/* W11-1 Feature B toggle. `active:scale-[0.98]` matches
                  the house tap-feedback rule. We intentionally surface
                  this even before partner data loads — the press is
                  what triggers the fetch. */}
              <button
                type="button"
                onClick={() => setSortByPartnerDiff((v) => !v)}
                aria-pressed={sortByPartnerDiff}
                className={cn(
                  "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-[11px] transition-colors active:scale-[0.98]",
                  sortByPartnerDiff
                    ? "border-[var(--gold-warm)] bg-[var(--gold-warm)] text-white"
                    : "border-border text-muted-foreground",
                )}
              >
                {partnerLoading && sortByPartnerDiff ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                ) : (
                  <MessageSquareHeart className="h-3 w-3" strokeWidth={2} />
                )}
                意見差を上に
              </button>
            </div>
          </div>

          {/* Matrix — horizontal scroll container. A gold-hint gradient
              on the right edge signals "there's more →" to users who
              might otherwise miss that the table scrolls. */}
          <div
            className={cn(
              "relative mx-3 rounded-2xl border border-border bg-card shadow-[var(--shadow-card-low)]",
              // Fade the right edge so the rightmost visible column
              // doesn't look hard-cut. pointer-events-none so it
              // doesn't block scroll.
              "before:pointer-events-none before:absolute before:inset-y-0 before:right-0 before:z-20 before:w-6 before:rounded-r-2xl before:bg-gradient-to-l before:from-card before:to-transparent",
            )}
            role="region"
            aria-label="式場比較マトリクス"
          >
            <div className="overflow-x-auto rounded-2xl" style={gridStyle}>
              {/* Header row — venue thumbnails + names. Sticky top so
                  vertical scrolling through many dimensions keeps the
                  venue identity visible. */}
              <div
                className="sticky top-0 z-10 grid items-end gap-0 border-b border-border bg-card"
                style={{ gridTemplateColumns: "var(--cmp-grid)" }}
              >
                <div
                  className="sticky left-0 z-20 bg-card px-3 py-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                  style={{ width: LABEL_COL_PX }}
                >
                  Venue
                </div>
                {selectedVenues.map((v) => (
                  <Link
                    key={v.id}
                    href={`/venues/${v.id}`}
                    className="flex flex-col items-center gap-1.5 px-2 py-2 transition-transform active:scale-95"
                  >
                    <div className="relative h-12 w-12 overflow-hidden rounded-full border border-border">
                      {v.photoUrl && (
                        <Image
                          src={v.photoUrl}
                          alt=""
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      )}
                    </div>
                    <p
                      className="w-full truncate text-center font-[family-name:var(--font-display)] text-[11.5px] leading-tight"
                      title={v.name}
                    >
                      {v.name}
                    </p>
                  </Link>
                ))}
              </div>

            {/* Total row */}
            <div
              className="grid items-center gap-0 border-b border-border bg-[color-mix(in_oklab,var(--gold-warm)_6%,transparent)]"
              style={{ gridTemplateColumns: "var(--cmp-grid)" }}
            >
              <div
                className="sticky left-0 z-10 bg-[color-mix(in_oklab,var(--gold-warm)_6%,var(--card))] px-3 py-2.5 text-[12px] font-medium text-foreground/85"
                style={{ width: LABEL_COL_PX }}
              >
                総合
              </div>
              {venueIds.map((id) => {
                const score = data.totalScore[id] ?? null;
                return (
                  <div
                    key={id}
                    className="flex items-center justify-center px-2 py-2.5"
                  >
                    {score !== null ? (
                      <span className="tabular-nums text-[18px] font-extralight text-[var(--gold-warm)]">
                        {score.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground/40">—</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Dimension rows — no framer `layout` animation at this scale
                (20 venues × N dims = 140+ cells); keep it light with a
                CSS-only transition on diffOnly toggle. */}
            {visibleRows.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">
                差のある項目はありません。
              </p>
            ) : (
              visibleRows.map((row, idx) => {
                const shouldDiscuss = discussDimIds.has(row.dim.id);
                const adv = row.advantage;
                return (
                  <div
                    key={row.dim.id}
                    className={cn(
                      "grid items-center gap-0",
                      idx !== visibleRows.length - 1 && "border-b border-border/60",
                      shouldDiscuss &&
                        "bg-[color-mix(in_oklab,var(--gold-warm)_6%,transparent)]",
                    )}
                    style={{ gridTemplateColumns: "var(--cmp-grid)" }}
                  >
                    <div
                      className={cn(
                        "sticky left-0 z-10 px-3 py-2.5 text-[12px] font-medium text-foreground/80",
                        shouldDiscuss
                          ? "bg-[color-mix(in_oklab,var(--gold-warm)_6%,var(--card))]"
                          : "bg-card",
                      )}
                      style={{ width: LABEL_COL_PX }}
                    >
                      <span className="block truncate">{row.dim.label}</span>
                      {shouldDiscuss && (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-[var(--gold-warm)]/15 px-1.5 py-[1px] text-[9.5px] font-medium text-[var(--gold-warm)]">
                          <MessageSquareHeart
                            className="h-2.5 w-2.5"
                            strokeWidth={2}
                          />
                          話し合いましょう
                        </span>
                      )}
                    </div>
                    {row.scores.map((score, colIdx) => {
                      const venueId = venueIds[colIdx];
                      const isWinner = row.winnerId === venueId;
                      // Highlight the winning side more strongly in
                      // head-to-head mode so the arrow + winner tint
                      // read together as "ここが優勢".
                      const advantageWinner =
                        isHeadToHead && adv
                          ? adv.kind === "left" || adv.kind === "left-strong"
                            ? colIdx === 0
                            : adv.kind === "right" || adv.kind === "right-strong"
                              ? colIdx === 1
                              : false
                          : isWinner;
                      const isStrong =
                        isHeadToHead &&
                        (adv?.kind === "left-strong" || adv?.kind === "right-strong") &&
                        advantageWinner;
                      return (
                        <DimensionCell
                          key={venueId}
                          score={score}
                          isWinner={advantageWinner}
                          strong={isStrong}
                        />
                      );
                    })}
                    {/* W11-1 Feature A: head-to-head advantage caption.
                        Spans the whole venue-cell block underneath via
                        grid-column full-span so the arrow is centered
                        between both scores. Only renders when exactly
                        2 venues are selected. */}
                    {isHeadToHead && adv && (
                      <AdvantageCaption
                        advantage={adv}
                        leftName={selectedVenues[0]?.name ?? ""}
                        rightName={selectedVenues[1]?.name ?? ""}
                      />
                    )}
                    {/* PR #51 follow-up: child item rows under each parent
                        dim — the "細かく見る" toggle reveals checklist
                        items (= /checklist で active 化したもの) as
                        sub-rows so couples can see how each venue scored
                        each individual item, not just the parent mean.
                        Inheriting diffOnly so the global filter still
                        works. */}
                    {showChildren && (
                      <ChildItemRows
                        items={row.dim.checklistItems}
                        venueIds={venueIds}
                        diffOnly={diffOnly}
                      />
                    )}
                  </div>
                );
              })
            )}
            </div>
          </div>

          {/* Share entry — pass the current matrix (with the exact
              venue selection) to a friend or family member via the OS
              share sheet, falling back to clipboard. The URL preserves
              `?venueIds=` so the recipient lands on the same view. */}
          <div className="flex justify-center px-3 pt-1">
            <ShareButton
              title="式場の比較"
              text="今、この式場たちを比べてみてるよ。見てみて。"
              url={(() => {
                if (typeof window === "undefined") return undefined;
                const ids = venueIds.join(",");
                return ids
                  ? `${window.location.origin}/compare?venueIds=${ids}`
                  : window.location.href;
              })()}
              analyticsKind="compare"
              variant="ghost"
              label="この比較を友だちに伝える"
            />
          </div>

          {/* AI insight */}
          {insight && (
            <div className="mx-3">
              <AIInsightCard
                type="comparison"
                title="AIコーチからのひとこと"
                body={insight.summary}
                actions={insight.nextActions.map((label) => ({
                  label,
                  href: "/coach",
                }))}
              />
            </div>
          )}

          {/* Audit P0-7: explicit "now decide" exit. Without this, couples
              who scroll to the end of compare have no on-screen route into
              the Decision tab — the SegmentedControl that owns "決める"
              is back at the top of the page, often several thousand pixels
              away after a long compare session. Show the CTA only when the
              compare has substance (>= 2 venues actually selected) so we
              don't push someone toward decision before they've finished
              comparing. */}
          {selected.size >= 2 && (
            <div className="mx-3">
              <div className="rounded-2xl border border-[var(--gold-warm)]/40 bg-[var(--gold-subtle)] p-5 text-center">
                <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--gold-warm)]">
                  Next
                </p>
                <p className="mt-1 font-[family-name:var(--font-display)] text-[15px] font-light leading-snug text-foreground/90">
                  {selected.size} 件、十分に比べました。
                  <br />
                  次は「決める」へ。
                </p>
                <Link
                  href="/candidates?tab=decision"
                  prefetch={true}
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition-transform active:scale-[0.98]"
                >
                  ふたりで決める
                </Link>
              </div>
            </div>
          )}
        </>
      ) : pool.length >= 2 ? (
        <div className="mx-3 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-surface-sunken py-10 text-center">
          <Sparkles
            className="h-6 w-6 text-[var(--gold-warm)]"
            strokeWidth={1.4}
          />
          <p className="text-[13px] text-muted-foreground">
            並べたい式場を 2 件以上えらんでください
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact per-cell renderer — a bar (80% fill for score 4/5) + the
 * numeric score underneath. Stars were replaced because 5 glyphs × N
 * columns wrap on 375px below ~80px per column; a bar + number stays
 * legible at 112px and reads as a "how close to full marks" signal.
 *
 * `strong` lifts the gold fill to a slightly deeper tint when the gap
 * against the opponent is >= 1.0 (W11-1 Feature A "明確に優勢").
 */
/**
 * 子項目スタンザ — editorial 2-row 構成。
 *
 * 親 dim 行 (120px label cell + venue score cells) の grid 上で
 * `col-span-full` の outer block として配置され、 内部で 2 行に分かれる:
 *
 *   Row 1 (label band):
 *     - position: sticky; left: 0; max-width: calc(100vw - 2rem)
 *       → モバイル横スクロール時もラベルが viewport 左端に貼り付く
 *     - font: Shippori Mincho (var(--font-display)) — editorial caption 美
 *     - leading-snug + py-2 で 1-2 行の自然な組版
 *     - 左端 2px gold hairline = 親への所属マーク (= editorial "stem rule")
 *
 *   Row 2 (score band):
 *     - 親と同じ --cmp-grid template で venue 列下に score を整列
 *     - col 1 (label 領域相当) は空セル — 「label は上の band にある」 を
 *       視覚的に伝える
 *     - score 描画 (bar + tabular-nums) は親 dim と同じ言語、 ただし
 *       サイズを 1 段絞って sub-row 感を出す
 *
 * 「差がある項目だけ」 ON 時は hasDifference === true の子だけ描画。
 * PR #53 で親側に「子に diff があれば親行を残す」 ロジックを入れたので、
 * このスタンザは確実にレンダリングされる。
 *
 * 設計判断:
 *   - 旧 1-row × 120px 内 truncate は brand 不適合だった (editorial 雑誌で
 *     captioned figure を 1 行に押し込む慣習はない)。 stanza 化は haretoki
 *     の「曇り→晴れ間→晴れの日 = 余白が美徳」 ブランドに直接対応。
 *   - 親 dim 行の grid と venue 列軸を共有するため、 子 score 列は親 score
 *     と venue 列下で完全に縦整列する (= 比較表として読みやすい)。
 *   - 子の編集導線は /venues/[id]/impression に集約。 比較画面は display
 *     only。
 */
function ChildItemRows({
  items,
  venueIds,
  diffOnly,
}: {
  items: Array<{
    itemId: string;
    question: string;
    answers: Record<
      string,
      { status: string | null; memo: string | null; numericScore: number | null }
    >;
    hasDifference: boolean;
  }>;
  venueIds: string[];
  diffOnly: boolean;
}) {
  const filtered = diffOnly ? items.filter((i) => i.hasDifference) : items;
  if (filtered.length === 0) return null;
  return (
    <>
      {filtered.map((item) => (
        <div
          key={item.itemId}
          className="col-span-full border-t border-border/30 bg-card/40"
        >
          {/* Row 1: editorial caption band — sticky-left, mincho serif,
              max-width clamped so the text stays inside the visible
              viewport while horizontal-scrolling the score columns. */}
          <div
            className="sticky left-0 z-10 max-w-[calc(100vw-2rem)] border-l-2 border-[var(--gold-warm)]/45 bg-card/95 px-4 pt-2 pb-1 text-[11px] font-light leading-snug text-foreground/80 font-[family-name:var(--font-display)] sm:max-w-md"
          >
            {item.question}
          </div>
          {/* Row 2: score band aligned with venue columns. col 1 is an
              intentional empty cell — the label sits in its own band
              above, so the score row only fills col 2+. */}
          <div
            className="grid items-center gap-0 pb-2"
            style={{ gridTemplateColumns: "var(--cmp-grid)" }}
          >
            <div
              className="sticky left-0 z-10 bg-card/40"
              style={{ width: LABEL_COL_PX }}
              aria-hidden
            />
            {venueIds.map((vid) => {
              const score = item.answers[vid]?.numericScore ?? null;
              const status = item.answers[vid]?.status ?? null;
              return (
                <div
                  key={vid}
                  className="flex flex-col items-center gap-0.5 px-2"
                >
                  {score !== null ? (
                    <>
                      <div
                        className="relative h-1 w-12 overflow-hidden rounded-full bg-muted"
                        aria-label={`${score} / 5`}
                      >
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-[var(--gold-warm)]"
                          style={{
                            width: `${Math.max(0, Math.min(100, (score / 5) * 100))}%`,
                          }}
                          aria-hidden
                        />
                      </div>
                      <span className="tabular-nums text-[10.5px] font-medium text-[var(--gold-warm)]">
                        {score.toFixed(1)}
                      </span>
                    </>
                  ) : status === "yes" ? (
                    <span className="text-[10px] text-[var(--gold-warm)]">○</span>
                  ) : status === "no" ? (
                    <span className="text-[10px] text-destructive/70">×</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground/40">—</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

function DimensionCell({
  score,
  isWinner,
  strong = false,
}: {
  score: number | null;
  isWinner: boolean;
  strong?: boolean;
}) {
  if (score === null) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1 px-2 py-2.5",
          isWinner && "bg-[color-mix(in_oklab,var(--gold-warm)_5%,transparent)]",
          strong && "bg-[color-mix(in_oklab,var(--gold-warm)_14%,transparent)]",
        )}
      >
        <div className="h-1.5 w-[70%] rounded-full bg-muted" />
        <span className="text-[11px] text-muted-foreground/50">—</span>
      </div>
    );
  }
  const pct = Math.max(6, (score / 5) * 100);
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 px-2 py-2.5",
        isWinner && "bg-[color-mix(in_oklab,var(--gold-warm)_8%,transparent)]",
        strong && "bg-[color-mix(in_oklab,var(--gold-warm)_14%,transparent)]",
      )}
    >
      <div
        className="relative h-1.5 w-[80%] overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: LUXURY_EASE }}
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            isWinner
              ? "bg-[var(--gold-warm)]"
              : "bg-foreground/60",
          )}
        />
      </div>
      <span
        className={cn(
          "tabular-nums text-[12.5px] leading-none",
          isWinner
            ? "font-medium text-[var(--gold-warm)]"
            : "font-normal text-foreground/85",
        )}
      >
        {score.toFixed(1)}
      </span>
    </div>
  );
}

/**
 * W11-1 Feature A — advantage caption under each head-to-head
 * dimension row. Spans the venue-cell columns (skips the sticky label
 * column) so the arrow sits visually between the two scores.
 *
 * Shape of the caption by advantage kind:
 *   - `tie`          → muted "ほぼ同じ" pill, no arrow
 *   - `left` / `right`          → single Chevron, gold-warm
 *   - `left-strong` / `right-strong` → double Chevron + "明確に優勢"
 *     pill, stronger gold
 *   - `unknown`      → nothing (one side lacks a score)
 */
function AdvantageCaption({
  advantage,
  leftName,
  rightName,
}: {
  advantage: Advantage;
  leftName: string;
  rightName: string;
}) {
  if (advantage.kind === "unknown") return null;

  // Grid column start = 2 (after the sticky label col), span both
  // venue cells. `min-w-0` because venue names may be long and we let
  // them truncate rather than push the row wider.
  const spanClass =
    "col-start-2 col-end-4 flex items-center justify-center gap-1 px-2 pb-2 pt-0 text-[10.5px] leading-none";

  if (advantage.kind === "tie") {
    return (
      <div className={spanClass} aria-hidden="true">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          ほぼ同じ
        </span>
      </div>
    );
  }

  const isLeft =
    advantage.kind === "left" || advantage.kind === "left-strong";
  const isStrong =
    advantage.kind === "left-strong" || advantage.kind === "right-strong";
  const winnerName = isLeft ? leftName : rightName;
  const Icon = isLeft ? ChevronLeft : ChevronRight;
  const absDelta = Math.abs(advantage.delta);

  return (
    <div
      className={cn(
        spanClass,
        "tabular-nums",
        isStrong ? "text-[var(--gold-warm)]" : "text-[var(--gold-warm)]/85",
      )}
      role="note"
      aria-label={`${winnerName} が ${absDelta.toFixed(1)} 点 ${
        isStrong ? "明確に優勢" : "優勢"
      }`}
    >
      {/* Left arrow cluster — renders only when the left side wins */}
      {isLeft && (
        <span className="inline-flex items-center">
          <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
          {isStrong && (
            <Icon
              className="-ml-2 h-3.5 w-3.5 opacity-80"
              strokeWidth={2.5}
            />
          )}
        </span>
      )}
      <span
        className={cn(
          "rounded-full px-2 py-0.5",
          isStrong
            ? "bg-[var(--gold-warm)] text-white"
            : "bg-[var(--gold-warm)]/15",
        )}
      >
        {isStrong ? "明確に優勢" : "優勢"} · {absDelta.toFixed(1)}
      </span>
      {/* Right arrow cluster */}
      {!isLeft && (
        <span className="inline-flex items-center">
          {isStrong && (
            <Icon
              className="-mr-2 h-3.5 w-3.5 opacity-80"
              strokeWidth={2.5}
            />
          )}
          <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}
