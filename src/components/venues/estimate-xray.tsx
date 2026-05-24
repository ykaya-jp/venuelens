import type { ComponentType } from "react";
import {
  Shirt,
  UtensilsCrossed,
  Camera,
  Flower2,
  Music,
  Speaker,
  Building2,
  ClipboardList,
  Lightbulb,
  AlertTriangle,
  Sparkles,
  Info,
} from "lucide-react";
import {
  generateEstimateWarnings,
  type EstimateWarning,
} from "@/server/actions/estimate-warnings";

interface EstimateXRayProps {
  venueId: string;
  items: Array<{
    category: string;
    itemName: string;
    amount: number;
    tier: string;
    predictedUpgrade: number | null;
    upgradeProbability: number | null;
  }>;
  totalEstimate: number;
  predictedFinal: number | null;
  /** Audit P2-29: human-readable label for who created this estimate row.
   *  Null when the row was created before Estimate.createdBy was added
   *  (= legacy data) or when the original author has left the project.
   *  Caller resolves "自分" vs "{partnerName} さん" — this component
   *  just renders whatever string lands here. */
  authorLabel?: string | null;
}

const CATEGORY_ICONS: Record<string, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  attire: Shirt,
  cuisine: UtensilsCrossed,
  photo_video: Camera,
  flowers: Flower2,
  performance: Music,
  av_equipment: Speaker,
  venue_fee: Building2,
  other: ClipboardList,
};

/**
 * Async Server Component — fetches AI warnings inline so the venue page
 * stays a single Server-Component tree (no client boundary, no Suspense
 * fan-out for this small subtree). On AI failure / Claude unavailable
 * the action returns an empty array and the AI section silently hides.
 */
export async function EstimateXRay({
  venueId,
  items,
  totalEstimate,
  predictedFinal,
  authorLabel = null,
}: EstimateXRayProps) {
  const riskyItems = items
    .filter(
      (item) =>
        (item.tier === "minimum" || item.tier === "unknown") &&
        item.upgradeProbability != null &&
        Number(item.upgradeProbability) > 0.3
    )
    .sort((a, b) => Number(b.upgradeProbability ?? 0) - Number(a.upgradeProbability ?? 0));

  const finalAmount = predictedFinal ?? totalEstimate;
  const difference = finalAmount - totalEstimate;

  // Best-effort fetch — never throw out of this component because the
  // statistical X-Ray below should keep rendering even if Claude fails.
  let aiWarnings: EstimateWarning[] = [];
  try {
    const result = await generateEstimateWarnings(venueId);
    aiWarnings = result.warnings;
  } catch {
    aiWarnings = [];
  }

  return (
    <div className="space-y-4 rounded-xl border-l-[3px] border-l-[var(--gold-warm)] bg-[var(--gold-subtle)] p-4">
      {/* Header — gold dot eyebrow + title (V-3) */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--gold-warm)]" aria-hidden="true" />
          <span className="text-eyebrow text-[var(--gold-warm)] uppercase">Estimate X-Ray</span>
        </span>
        <Lightbulb className="h-4 w-4 text-[var(--gold-warm)]" strokeWidth={1.6} />
      </div>
      <p className="text-[13px] font-light text-muted-foreground leading-relaxed">
        見積もりの差分を、項目ごとに把握できます
      </p>
      {authorLabel && (
        <p className="text-[11.5px] text-muted-foreground/85">
          <span className="font-medium text-[var(--gold-warm)]">入力者</span>
          <span className="mx-1.5 opacity-40">·</span>
          {authorLabel}
        </p>
      )}

      {/* Summary — display-scale numerals for main amounts */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">初期見積もり</span>
          <span className="flex items-baseline gap-0.5">
            <span className="text-[11px] text-muted-foreground">¥</span>
            <span className="text-section-numeral text-foreground">
              {(totalEstimate / 10000).toFixed(0)}
            </span>
            <span className="text-[11px] text-muted-foreground">万</span>
          </span>
        </div>
        {predictedFinal && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">予測最終額</span>
            <span className="flex items-baseline gap-0.5">
              <span className="text-[11px] text-muted-foreground">¥</span>
              <span className="text-section-numeral text-foreground">
                {(predictedFinal / 10000).toFixed(0)}
              </span>
              <span className="text-[11px] text-muted-foreground">万</span>
            </span>
          </div>
        )}
        {difference > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-tone-gold">予測上昇額</span>
            <span className="flex items-baseline gap-0.5 text-tone-gold">
              <span className="text-[11px]">+¥</span>
              <span className="text-section-numeral">
                {(difference / 10000).toFixed(0)}
              </span>
              <span className="text-[11px]">万</span>
            </span>
          </div>
        )}
      </div>

      {/* Risky items (statistical) */}
      {riskyItems.length > 0 && (
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-tone-gold" strokeWidth={1.6} />
            上がりやすい項目
          </p>
          {riskyItems.map((item) => {
            const prob = Number(item.upgradeProbability ?? 0) * 100;
            const Icon = CATEGORY_ICONS[item.category] ?? ClipboardList;
            return (
              <div key={item.itemName} className="space-y-1.5 rounded-lg bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.6} />
                    {item.itemName}
                  </span>
                  <span className="tabular-nums text-sm shrink-0">&yen;{item.amount.toLocaleString()}</span>
                </div>
                {item.tier === "minimum" && (
                  <p className="text-xs text-tone-gold">
                    最低ランク &rarr; +&yen;{(item.predictedUpgrade ?? 0).toLocaleString()}想定
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-full bg-muted">
                    <div
                      className="h-1.5 rounded-full bg-[var(--gold-warm)]"
                      style={{ width: `${Math.min(prob, 100)}%` }}
                    />
                  </div>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {prob.toFixed(0)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AI-generated personalised warnings.
          Hidden entirely when Claude failed (silent skip per spec). When
          Claude reviewed and found nothing, show a single reassurance
          line instead of empty space. */}
      {aiWarnings.length > 0 ? (
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4 text-[var(--gold-warm)]" strokeWidth={1.6} />
            AI が見つけた注意点
          </p>
          {aiWarnings.map((w, idx) => (
            <AIWarningCard key={`${w.title}-${idx}`} warning={w} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AIWarningCard({ warning }: { warning: EstimateWarning }) {
  const { severity, title, message, relatedItem } = warning;
  // Token mapping — alert leans on text-destructive (existing token), warn
  // on the gold-warm family already used for the statistical block, info
  // on muted-foreground. No raw red-* / amber-* utility classes per
  // CLAUDE.md design rules.
  const tokens =
    severity === "alert"
      ? {
          Icon: AlertTriangle,
          border: "border-l-[3px] border-l-[color:color-mix(in_oklab,var(--destructive)_60%,transparent)]",
          iconClass: "text-destructive",
          titleClass: "text-tone-destructive",
        }
      : severity === "warn"
        ? {
            Icon: AlertTriangle,
            border: "border-l-[3px] border-l-[var(--gold-warm)]",
            iconClass: "text-[var(--gold-warm)]",
            titleClass: "text-tone-gold",
          }
        : {
            Icon: Info,
            border: "border-l-[3px] border-l-[color:var(--muted-foreground)]",
            iconClass: "text-muted-foreground",
            titleClass: "text-foreground",
          };
  const { Icon, border, iconClass, titleClass } = tokens;

  return (
    <div className={`space-y-1.5 rounded-lg bg-card p-3 ${border}`}>
      <div className="flex items-start gap-2">
        <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${iconClass}`} strokeWidth={1.6} />
        <div className="space-y-1 min-w-0 flex-1">
          <p className={`text-sm font-medium leading-snug ${titleClass}`}>
            {title}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-line">
            {message}
          </p>
          {relatedItem && (
            <p className="text-[11px] text-muted-foreground/80">
              関連項目: {relatedItem}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
