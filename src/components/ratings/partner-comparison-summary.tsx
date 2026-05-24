"use client";

import { useState, useEffect } from "react";
import { MessageCircle, Check } from "lucide-react";
import { TIER1_DIMENSIONS, DIMENSION_LABELS } from "@/lib/constants";
import { generateRatingComparison } from "@/server/actions/rating-comparison";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

/**
 * Partner Level 2 — Wave 1.3 polish.
 *
 * The component itself was role-agnostic from Level 1 (it only needs the
 * ratings dictionaries, not the role of the current viewer), so this pass
 * doesn't add a viewer-aware branch. Instead it tightens the visual
 * grammar so a couple opening the surface can read three things at a
 * glance:
 *
 *   1. Whose column is whose — sticky column headers with the actual
 *      member names (or "あなた" / "パートナー" fallback when no name
 *      has been set yet, per the Open Question note in the partner-L2
 *      design doc).
 *   2. Where they agree — gentle border-l in `var(--gold-subtle)` so
 *      agreements still register but don't shout.
 *   3. Where they disagree — the gold-warm hairline divergence
 *      treatment the brief asked for: a 1px gold-fade gradient ABOVE
 *      the row plus a thicker gold-warm border-l, both keyed off
 *      `var(--gold-warm)` so the brand palette is the single source.
 *
 * The `--success` token-driven agreement border was a Level 1 hold-over
 * that read green — a colour that doesn't exist anywhere else on this
 * surface. Switching it to gold-subtle keeps the brand language
 * editorial-warm rather than dashboard-status. (No design-token changes
 * here; the swap is just at the consumer side.)
 */

interface PartnerComparisonSummaryProps {
  venueId: string;
  myRatings: Record<string, number>;
  partnerRatings: Record<string, number>;
  /** Display name for the current viewer's column. Optional —
   *  falls back to "あなた" so the existing callsite doesn't break.
   *  When passed, the column reads as a real name and the hint /
   *  comparison surface stop feeling depersonal. */
  myName?: string | null;
  /** Display name for the partner column. Same fallback contract;
   *  defaults to "パートナー". */
  partnerName?: string | null;
}

export function PartnerComparisonSummary({
  venueId,
  myRatings,
  partnerRatings,
  myName,
  partnerName,
}: PartnerComparisonSummaryProps) {
  const [aiComment, setAiComment] = useState<string | null>(null);

  useEffect(() => {
    // Phase 3 wave 1.5 analytics — fire couple_comparison_viewed when
    // a couple actually opens the side-by-side surface. Deferred via
    // requestAnimationFrame to satisfy React Compiler's purity rule
    // (`set-state-in-effect` would also flag this if we set state in
    // the same tick — keeping the same pattern as
    // OnboardingPartnerHint and PartnerCanRateHint so the codebase
    // has one canonical defer recipe rather than three variants).
    const raf = requestAnimationFrame(() => {
      track("couple_comparison_viewed", { venueId });
    });
    generateRatingComparison(venueId).then(({ comment }) =>
      setAiComment(comment),
    );
    return () => cancelAnimationFrame(raf);
  }, [venueId]);

  const dimensions = TIER1_DIMENSIONS.filter(
    (dim) => myRatings[dim] !== undefined || partnerRatings[dim] !== undefined,
  );

  if (dimensions.length === 0) return null;

  const agreementCount = dimensions.filter((dim) => {
    const my = myRatings[dim] ?? 0;
    const partner = partnerRatings[dim] ?? 0;
    return my > 0 && partner > 0 && Math.abs(my - partner) <= 1;
  }).length;

  const ratedDimensions = dimensions.filter(
    (dim) => (myRatings[dim] ?? 0) > 0 && (partnerRatings[dim] ?? 0) > 0,
  );
  const agreementPct =
    ratedDimensions.length > 0
      ? Math.round((agreementCount / ratedDimensions.length) * 100)
      : 0;

  const myColumnLabel = myName?.trim() || "あなた";
  const partnerColumnLabel = partnerName?.trim() || "パートナー";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">二人の評価比較</h3>
        {ratedDimensions.length > 0 && (
          <span className="text-xs text-muted-foreground">
            一致度{" "}
            <span className="tabular-nums">{agreementPct}%</span>
          </span>
        )}
      </div>

      {/* Column headers — sticky-feel rail above the rows so a couple
          immediately knows which bar belongs to whom. The dimension
          column stays unlabelled since the row itself names the
          dimension. */}
      <div className="flex items-center gap-3 px-3 text-eyebrow text-muted-foreground">
        <div className="w-20" aria-hidden="true" />
        <div className="flex-1 truncate text-left">{myColumnLabel}</div>
        <div className="flex-1 truncate text-left">{partnerColumnLabel}</div>
        <div className="w-4" aria-hidden="true" />
      </div>

      <div className="space-y-2">
        {dimensions.map((dim) => {
          const my = myRatings[dim] ?? 0;
          const partner = partnerRatings[dim] ?? 0;
          const diff = Math.abs(my - partner);
          const isAgreed = my > 0 && partner > 0 && diff <= 1;
          const isDisagreed = my > 0 && partner > 0 && diff >= 2;

          return (
            <div
              key={dim}
              className={cn(
                "relative flex items-center gap-3 rounded-lg px-3 py-2",
                // Dark-mode parity (round-22): the `transparent` anchor
                // on the bg color-mix collapsed into whatever sat behind
                // the row, which under the dark palette left the agreed
                // and disagreed rows visually indistinguishable. Anchor
                // the wash to var(--card) — the surface the comparison
                // summary actually renders on — so the warm tint holds
                // a fixed mix in either theme. Same recipe W21-5 used
                // for the notification + checklist fix. Border-l keeps
                // its `transparent` anchor on the agreement row because
                // a 1-2px hairline is tinted by alpha, not by surface
                // colour, and reads consistently regardless of theme.
                isAgreed &&
                  "border-l-2 border-l-[color-mix(in_oklab,var(--gold-warm)_45%,transparent)] bg-[color-mix(in_oklab,var(--gold-subtle)_55%,var(--card))]",
                isDisagreed &&
                  "border-l-[3px] border-l-[var(--gold-warm)] bg-[color-mix(in_oklab,var(--gold-warm)_8%,var(--card))]",
              )}
              aria-label={
                isDisagreed
                  ? `${DIMENSION_LABELS[dim] ?? dim}: 評価が分かれています`
                  : isAgreed
                    ? `${DIMENSION_LABELS[dim] ?? dim}: 評価が一致しています`
                    : DIMENSION_LABELS[dim] ?? dim
              }
            >
              {/* Divergence hairline — gold-warm gradient drawn ABOVE
                  the row when own ≠ partner so the eye lands on the
                  rows that need conversation. The pseudo-element
                  approach keeps the row chrome (border-l + bg) in
                  charge of the in-line emphasis. */}
              {isDisagreed && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-[var(--gold-warm)] to-transparent"
                />
              )}
              <div className="w-20 text-xs">{DIMENSION_LABELS[dim]}</div>
              {/* Audit P1-16: 自分 = Rose (--primary), 相手 = Brown
                  (--secondary), 合意 = Gold (--gold-warm). Was 自分 =
                  Gold which collided with DESIGN.md's "Gold = AI /
                  consensus" role and made the partner card and the
                  detail rating bars disagree on color semantics. */}
              <div className="flex flex-1 items-center gap-2">
                <div className="flex-1">
                  <div
                    className="h-2 rounded-full bg-[var(--primary)]"
                    style={{ width: `${(my / 5) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-right text-xs tabular-nums">
                  {my || "-"}
                </span>
              </div>
              <div className="flex flex-1 items-center gap-2">
                <div className="flex-1">
                  <div
                    className="h-2 rounded-full bg-secondary"
                    style={{ width: `${(partner / 5) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-right text-xs tabular-nums">
                  {partner || "-"}
                </span>
              </div>
              {isAgreed && (
                <Check
                  className="h-4 w-4 text-[var(--gold-warm)]"
                  aria-hidden="true"
                />
              )}
              {isDisagreed && (
                <MessageCircle
                  className="h-4 w-4 text-[var(--gold-warm)]"
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <div
            className="h-2 w-4 rounded-full bg-[var(--gold-warm)]"
            aria-hidden="true"
          />
          {myColumnLabel}
        </span>
        <span className="flex items-center gap-1">
          <div className="h-2 w-4 rounded-full bg-secondary" aria-hidden="true" />
          {partnerColumnLabel}
        </span>
      </div>

      {/* AI comment */}
      {aiComment && (
        <div className="rounded-lg bg-[var(--gold-subtle)] p-3 text-sm">
          <p>{aiComment}</p>
        </div>
      )}
    </div>
  );
}
