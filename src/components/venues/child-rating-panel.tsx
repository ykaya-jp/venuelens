"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TIER1_DIMENSIONS, type Tier1Dimension } from "@/lib/constants";
import {
  aggregateChildScoresToDimensions,
  type CustomDimensionLookup,
} from "@/lib/checklist-rating-aggregator";
import { saveChildRating } from "@/server/actions/checklist-ratings";

const DIMENSION_LABELS: Record<Tier1Dimension, string> = {
  ceremony_space: "挙式会場",
  banquet_space: "披露宴会場",
  cuisine: "料理・飲み物",
  attire_items: "衣裳・アイテム",
  hospitality: "スタッフ・対応",
  cost_contract: "費用・契約",
  logistics: "利便性・設備",
  overall: "総合印象",
};

const HALF_STEPS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0] as const;

export interface ChildRatingItem {
  /** ProjectChecklist.itemId — preset id or CustomChecklistItem cuid */
  itemId: string;
  /** Resolved Tier1 dimension (preset map or custom.category mapping) */
  dimension: Tier1Dimension;
  /** Human-readable label (preset.question or custom.label) */
  label: string;
  /** Optional subcategory header for grouping inside a dimension */
  subcategory?: string | null;
  /** Stored numericScore for this (venue, item) or null */
  initialScore: number | null;
}

interface ChildRatingPanelProps {
  venueId: string;
  items: ChildRatingItem[];
  /** Custom item id → Tier1 dimension. Forwarded to aggregator so the
   *  header score under each dim mirrors what /compare displays. */
  customLookup: CustomDimensionLookup;
  /** Partner's own child scores (itemId → 0.5–5 or null). Null when the
   *  project has no accepted partner yet — the panel then renders only
   *  the viewer's chips with no overlay. */
  partnerScoreByItemId?: Record<string, number | null> | null;
  /** Display label for the partner (= name or email fallback). Used in
   *  the quiet overlay row beneath each child chip group. */
  partnerName?: string | null;
}

/**
 * /venues/[id]/impression の親 8 次元スライダー (= RatingSection) の **下** に
 * 配置する子項目評価パネル。
 *
 * ユーザ報告 ("子項目自体の評価ができる画面がない") を解消するための
 * 単一の入力面。各親次元を tap で開閉し、 中に /checklist で active 化した
 * preset + custom 子項目を並べる。子項目ごとに 0.5–5 のチップで評価、
 * `saveChildRating` で永続化、 同次元の他子の平均が `aggregateChildScores
 * ToDimensions` 経由でヘッダに即時反映される (= 親 RatingSection の表示と
 * 一致)。
 *
 * 設計判断 (なぜ slider ではなく 10 chip):
 *   - 親次元 (= RatingSection) は連続 drag slider で「ざっくり感覚」 を残す
 *   - 子項目は 細かく評価 → 10 段階離散 chip でタップ 1 発、 親より精度高
 *   - スライダーを増殖させると画面が縦に伸び、 12+ 子項目あると操作疲労が
 *     大きい。 chip なら 1 行に収まる。
 *
 * 設計判断 (折り畳み):
 *   - 8 次元 × 平均 5 項目 = 40 行展開は初見でスクロール疲労を産む
 *   - default = 全て collapsed。 各 dimension header に「未評価 X / N」 を
 *     出し、 タップで該当ブロックだけ展開
 */
export function ChildRatingPanel({
  venueId,
  items,
  customLookup,
  partnerScoreByItemId,
  partnerName,
}: ChildRatingPanelProps) {
  const [scores, setScores] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(items.map((i) => [i.itemId, i.initialScore])),
  );
  const [open, setOpen] = useState<Record<Tier1Dimension, boolean>>(() => {
    const o = {} as Record<Tier1Dimension, boolean>;
    for (const dim of TIER1_DIMENSIONS) o[dim] = false;
    return o;
  });
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Group items by dimension. Iterating TIER1_DIMENSIONS preserves the
  // same visual order users see in the comparison view and the parent
  // RatingSection above this panel.
  const grouped = useMemo(() => {
    const map = new Map<Tier1Dimension, ChildRatingItem[]>();
    for (const dim of TIER1_DIMENSIONS) map.set(dim, []);
    for (const item of items) map.get(item.dimension)?.push(item);
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0);
  }, [items]);

  // Live per-dimension aggregate so each header label always reflects
  // the very latest tap — same algorithm as the read path so users
  // never see a value here that's different from /compare.
  const aggregates = useMemo(() => {
    const answers = Object.entries(scores).map(([itemId, score]) => ({
      itemId,
      numericScore: score,
    }));
    return aggregateChildScoresToDimensions(answers, customLookup);
  }, [scores, customLookup]);

  const handleSetScore = useCallback(
    (itemId: string, nextScore: number | null) => {
      // Optimistic: paint immediately so the slider feels responsive.
      // saveChildRating is debounce-free because the input is a chip tap
      // (= one discrete event); a rapid retap on a different chip
      // supersedes via the latest call's revalidateTag.
      setScores((prev) => ({ ...prev, [itemId]: nextScore }));
      setPendingItemId(itemId);
      startTransition(async () => {
        // try/catch is mandatory here — a server-action throw inside a
        // startTransition callback bubbles to the page error boundary and
        // the user gets bounced to (app)/venues/[id]/error.tsx with an
        // opaque "エラーID" overlay. The server action now returns
        // `{ success: false, error }` for known failures (= P2003 partner
        // sync, P2002, validation), but a network drop or unexpected
        // runtime error can still throw, so we defend in depth.
        const rollback = () => {
          setScores((prev) => ({
            ...prev,
            [itemId]: items.find((i) => i.itemId === itemId)?.initialScore ?? null,
          }));
        };
        try {
          const result = await saveChildRating({
            venueId,
            itemId,
            score: nextScore,
          });
          setPendingItemId((cur) => (cur === itemId ? null : cur));
          if (!result.success) {
            console.error("[ChildRatingPanel] saveChildRating returned failure", result.error);
            const msg =
              result.error?.formErrors?.[0] ?? "評価を残せませんでした";
            // Intentional: no inline "もう一度" retry button to avoid a
            // self-recursive useCallback dependency (react-hooks/immutability).
            // Users can simply re-tap a chip to retry — the chip itself is
            // the action surface, so a separate retry CTA is redundant.
            toast.error(msg, { duration: 6000 });
            rollback();
          }
        } catch (e) {
          // Surface redirects (e.g. session expired → /login) untouched —
          // these are not bugs, they're React/Next telling us to navigate.
          if (
            e instanceof Error &&
            typeof (e as { digest?: unknown }).digest === "string" &&
            (e as unknown as { digest: string }).digest.startsWith("NEXT_REDIRECT")
          ) {
            throw e;
          }
          setPendingItemId((cur) => (cur === itemId ? null : cur));
          console.error("[ChildRatingPanel] saveChildRating threw", e);
          toast.error("通信エラーで評価を残せませんでした", { duration: 6000 });
          rollback();
        }
      });
    },
    [venueId, items],
  );

  if (items.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border/60 bg-card/30 p-4 text-center">
        <p className="text-xs text-muted-foreground">
          チェックリスト項目がまだ選ばれていません
        </p>
        <a
          href="/checklist"
          className="mt-2 inline-block text-xs text-[var(--gold-warm)] underline-offset-2 active:underline"
        >
          チェックリストを設定する →
        </a>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <p className="text-fluid-xs uppercase tracking-[0.2em] text-muted-foreground">
          Detail
        </p>
        <h2 className="mt-0.5 font-[family-name:var(--font-display)] text-fluid-base font-light tracking-[-0.005em]">
          細かく評価する
        </h2>
        <p className="mt-1 text-fluid-xs leading-relaxed text-muted-foreground">
          項目ごとに 0.5–5 で残せます。残した点は次元ごとの平均となり、
          比較表 (/compare) でそのまま見比べられます。
        </p>
      </div>

      <div className="space-y-2">
        {grouped.map(([dim, rows]) => {
          const isOpen = open[dim];
          const agg = aggregates[dim];
          const rated = agg.ratedCount;
          const total = rows.length;
          return (
            <div
              key={dim}
              className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
            >
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [dim]: !o[dim] }))}
                className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors active:bg-muted/60"
                aria-expanded={isOpen}
              >
                <span className="flex flex-col">
                  <span className="font-[family-name:var(--font-display)] text-fluid-base font-light tracking-tight">
                    {DIMENSION_LABELS[dim]}
                  </span>
                  <span className="text-fluid-xs text-muted-foreground">
                    {rated > 0
                      ? `平均 ${agg.score?.toFixed(1) ?? "—"} · ${rated} / ${total} 件残した`
                      : `${total} 件未評価`}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    isOpen && "rotate-180",
                  )}
                  aria-hidden
                />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    key="content"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden border-t border-border/40"
                  >
                    <div className="space-y-3 px-4 py-3">
                      {rows.map((row) => (
                        <ChildRow
                          key={row.itemId}
                          item={row}
                          score={scores[row.itemId] ?? null}
                          pending={pendingItemId === row.itemId}
                          onChange={(s) => handleSetScore(row.itemId, s)}
                          partnerScore={
                            partnerScoreByItemId?.[row.itemId] ?? null
                          }
                          partnerName={partnerName ?? null}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ChildRow({
  item,
  score,
  pending,
  onChange,
  partnerScore,
  partnerName,
}: {
  item: ChildRatingItem;
  score: number | null;
  pending: boolean;
  onChange: (next: number | null) => void;
  partnerScore: number | null;
  partnerName: string | null;
}) {
  // Show the partner row when they've actually graded this item. A null
  // here means "partner has not scored yet" — render nothing rather than
  // a "—" to keep the panel quiet on items the spouse hasn't visited.
  const showPartner = partnerScore !== null && partnerName !== null;
  const aligned =
    showPartner && score !== null && Math.abs(score - partnerScore) <= 0.5;

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-fluid-sm leading-snug">{item.label}</p>
        {pending ? (
          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : score !== null ? (
          <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--gold-warm)_12%,transparent)] px-2 py-0.5 text-fluid-xs font-medium tabular-nums text-[var(--gold-warm)]">
            <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
            {score.toFixed(1)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {HALF_STEPS.map((step) => {
          const active = score === step;
          return (
            <button
              key={step}
              type="button"
              // Audit P1-18: tapping an already-active chip used to clear
              // the score silently — a stray retap on the same value
              // (common on the 11-chip grid at 375px) erased a 30-second
              // judgement without a way back. Now active retap is a
              // no-op; explicit clear is the trailing × button below.
              onClick={() => {
                if (!active) onChange(step);
              }}
              aria-pressed={active}
              aria-label={`${step} 点`}
              className={cn(
                "min-h-11 min-w-11 rounded-full border px-2 text-fluid-xs tabular-nums transition-colors active:scale-[0.96]",
                active
                  ? "border-[var(--gold-warm)] bg-[var(--gold-warm)] text-[var(--gold-foreground,white)]"
                  : "border-border bg-background text-muted-foreground active:bg-muted",
              )}
            >
              {step.toFixed(1)}
            </button>
          );
        })}
        {score !== null && (
          <button
            type="button"
            onClick={() => {
              if (
                typeof window !== "undefined" &&
                !window.confirm("この項目の評価を消しますか？")
              ) {
                return;
              }
              onChange(null);
            }}
            aria-label="評価をクリア"
            className="min-h-11 min-w-11 rounded-full border border-dashed border-border bg-background px-2 text-fluid-xs text-muted-foreground active:scale-[0.96] active:bg-muted"
          >
            ×
          </button>
        )}
      </div>
      {showPartner ? (
        <div
          className={cn(
            "flex items-center gap-2 pl-0.5 pt-0.5 text-fluid-xs text-muted-foreground",
            aligned && "text-[var(--gold-warm)]",
          )}
          aria-label={`${partnerName} の評価 ${partnerScore.toFixed(1)} 点`}
        >
          <span className="truncate">{partnerName}</span>
          <span className="h-px flex-1 bg-border/40" aria-hidden />
          <span className="tabular-nums">{partnerScore.toFixed(1)}</span>
        </div>
      ) : null}
    </div>
  );
}
