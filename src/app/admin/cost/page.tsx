import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/admin";
import { activeBackendName } from "@/lib/rate-limit";
import { recordAudit } from "@/server/audit";
import { forecastMonthlyCostUsd } from "@/lib/anthropic-usage";
import {
  aggregatePushThrottleStats,
  aggregateOptOutRates,
  pushEventLabel,
} from "@/lib/push-throttle-stats";

/**
 * /admin/cost — Anthropic spend dashboard skeleton.
 *
 * Reads the last 30 daily snapshots persisted by the
 * `/api/cron/ai-cost-summary` cron and renders a compact table the
 * developer can scan during a coffee break to confirm "we're nowhere
 * near the budget" or to triage a Sentry alert.
 *
 * Auth: `requireAdmin()` (404 for non-admins — see `src/server/admin.ts`).
 *
 * Style: deliberately not the marketing palette. The Editorial
 * brand surfaces are for couples, not the operator's internal tooling.
 * Plain HTML + Tailwind utility classes that read fine in dark / light
 * without theming customisation. Server-rendered, no client JS — this
 * is a read-only diagnostics view, not an interactive surface.
 */

export const metadata = {
  title: "Cost Dashboard",
  // Block crawlers from indexing the admin surface even if Vercel
  // accidentally exposes it. The notFound() guard in requireAdmin
  // handles unauthenticated access; this is defence in depth.
  robots: { index: false, follow: false },
};

interface SnapshotRow {
  snapshotDate: Date;
  dailyUsedUsd: number;
  dailyBudgetUsd: number;
  monthlyUsedUsd: number;
  monthlyBudgetUsd: number;
  shouldAlert: boolean;
  dailyByBucket: Record<string, { calls: number; estCostUsd: number }> | null;
  /** Round 22: per-action tier hit-rate snapshot. Null on rows from
   *  before the column existed; null too on quiet days (cron writes
   *  null when there's no estimate-pdf activity to report). */
  tierStats: Record<
    string,
    { calls: number; cacheHits: number; cacheWrites: number; hitRate: number }
  > | null;
}

function pct(used: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.round((used / budget) * 100);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtJstDate(d: Date): string {
  // Snapshot date is stored as Postgres DATE — Prisma returns it as a
  // Date with time set to 00:00 UTC. We display the YYYY-MM-DD portion
  // directly without further timezone math (the cron writes JST date,
  // see `jstDateOnly` in the cron route).
  return d.toISOString().slice(0, 10);
}

export default async function AdminCostPage() {
  const admin = await requireAdmin();

  // Record the admin view in the audit log so a later "who looked
  // at the cost dashboard around the time we noticed X" question
  // has an answer. Best-effort — never blocks the page render.
  await recordAudit({
    action: "admin.cost.viewed",
    actorId: admin.userId,
    actorRole: "admin",
  });

  // Round 15: in addition to snapshots, also pull a 24h estimate-vs-cache
  // tally so the dashboard can render an estimate-pdf cache-hit-rate
  // approximation without an AiCostSnapshot schema change. The recipe:
  //   - estimate_count_24h = AI-extracted Estimate rows in 24h
  //     (= number of analyzeEstimatePdf calls that succeeded)
  //   - aiCache_writes_24h = sonnet-tagged AiCache rows in 24h
  //     (= number of cache MISSES that ran through Files API or signed URL
  //     and persisted a new entry)
  // approximated_cache_hits = estimate_count_24h - aiCache_writes_24h.
  // It's an approximation (signed-URL fallback also writes to AiCache, so
  // we can't split files-api vs signed-url without log scraping) but
  // catches the first-order signal: "did the cache help us today".
  // React Compiler flags Date.now() as impure-during-render. For a
  // server-component dashboard we want "now at request time" exactly —
  // the per-request rebuild is the correct semantic, not a regression.
  // eslint-disable-next-line react-hooks/purity
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // eslint-disable-next-line react-hooks/purity
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [
    rows,
    estimateCount24h,
    aiCacheWrites24h,
    realtimePublishedRows,
    realtimeFailedCount,
    pushSendLogs7d,
    notificationPrefs,
  ] = await Promise.all([
    prisma.aiCostSnapshot.findMany({
      orderBy: { snapshotDate: "desc" },
      take: 30,
    }),
    prisma.estimate
      .count({
        where: {
          createdAt: { gte: since24h },
          sourceType: "ai_extracted",
        },
      })
      .catch(() => 0),
    prisma.aiCache
      .count({
        where: {
          createdAt: { gte: since24h },
          // Sonnet tag identifies the estimate-extract path (the only
          // sonnet+AiCache combination today). Other AiCache writers
          // use Haiku.
          model: "claude-sonnet-4-6",
        },
      })
      .catch(() => 0),
    // Phase 3 L3 wave 4 — Realtime broadcast metrics. publishRealtimeEvent
    // writes one audit row per send (success: realtime.broadcast.published
    // with detail.kind, failure: realtime.broadcast.failed). We pull all
    // 7-day rows and group in JS rather than running 5 separate count()
    // queries — the row count for a couple-scale workload is small (<1000
    // per week), so the round-trip win matters more than the wire size.
    prisma.auditLog
      .findMany({
        where: {
          action: "realtime.broadcast.published",
          createdAt: { gte: since7d },
        },
        select: { detail: true },
      })
      .catch(() => [] as Array<{ detail: unknown }>),
    prisma.auditLog
      .count({
        where: {
          action: "realtime.broadcast.failed",
          createdAt: { gte: since7d },
        },
      })
      .catch(() => 0),
    // P3 L3 W2 monitoring — pull last 7d of PushSendLog rows for the
    // realtime push activity section. Cap at 5000 rows so a future
    // surge can't tip the dashboard into a multi-second query (the
    // page is operator-facing — pulling more requires a real
    // visualisation surface). The (sent_at) index makes the range
    // scan cheap.
    prisma.pushSendLog
      .findMany({
        where: { sentAt: { gte: since7d } },
        select: {
          recipientUserId: true,
          kind: true,
          scopeId: true,
          hourBucket: true,
          sentAt: true,
        },
        orderBy: { sentAt: "desc" },
        take: 5000,
      })
      .catch(() => []),
    // Per-event opt-out rate = users with notify*=false / total
    // pref rows. Tiny projection so even a million-row pref table
    // is one cheap scan.
    prisma.notificationPreference
      .findMany({
        select: {
          notifyPartnerRating: true,
          notifyPartnerNote: true,
          notifyDecisionSaved: true,
          notifyWeddingDateSet: true,
          notifyPartnerVenueAdded: true,
          notifyPartnerVenueDeleted: true,
        },
      })
      .catch(() => []),
  ]);

  const pushStats = aggregatePushThrottleStats(pushSendLogs7d);
  const optOutStats = aggregateOptOutRates(notificationPrefs);

  const snapshots: SnapshotRow[] = rows.map((r) => ({
    snapshotDate: r.snapshotDate,
    dailyUsedUsd: Number(r.dailyUsedUsd),
    dailyBudgetUsd: Number(r.dailyBudgetUsd),
    monthlyUsedUsd: Number(r.monthlyUsedUsd),
    monthlyBudgetUsd: Number(r.monthlyBudgetUsd),
    shouldAlert: r.shouldAlert,
    dailyByBucket:
      (r.dailyByBucket as Record<
        string,
        { calls: number; estCostUsd: number }
      > | null) ?? null,
    tierStats:
      (r.tierStats as Record<
        string,
        {
          calls: number;
          cacheHits: number;
          cacheWrites: number;
          hitRate: number;
        }
      > | null) ?? null,
  }));

  const latest = snapshots[0];

  // Forecast uses the latest snapshot's monthly-used as month-to-date.
  // Falls back to 0 when no snapshots yet so the section still renders
  // (with a "no data" sentinel) rather than crashing the whole page.
  const forecast = forecastMonthlyCostUsd({
    snapshots: snapshots.map((s) => ({
      snapshotDate: s.snapshotDate,
      dailyUsedUsd: s.dailyUsedUsd,
    })),
    monthToDateUsd: latest?.monthlyUsedUsd ?? 0,
  });

  // Cache-hit-rate approximation. Hits clamped to >= 0 so the percent
  // never goes negative when a cron + load race produces (writes > calls).
  const approxCacheHits = Math.max(0, estimateCount24h - aiCacheWrites24h);
  const cacheHitPct =
    estimateCount24h > 0
      ? Math.round((approxCacheHits / estimateCount24h) * 100)
      : 0;

  // Group realtime publishes by `detail.kind` (the RealtimeEvent
  // discriminator). Unknown kinds (= future events that ship before
  // the dashboard knows about them) bucket into "other" so nothing
  // disappears silently.
  const realtimeKnownKinds = [
    "rating_saved",
    "note_added",
    "decision_made",
    "wedding_date_updated",
  ] as const;
  type RealtimeKnownKind = (typeof realtimeKnownKinds)[number];
  const realtimeByKind: Record<RealtimeKnownKind | "other", number> = {
    rating_saved: 0,
    note_added: 0,
    decision_made: 0,
    wedding_date_updated: 0,
    other: 0,
  };
  for (const row of realtimePublishedRows) {
    const detail = row.detail as { kind?: string } | null;
    const kind = detail?.kind;
    if (
      kind &&
      (realtimeKnownKinds as readonly string[]).includes(kind)
    ) {
      realtimeByKind[kind as RealtimeKnownKind] += 1;
    } else {
      realtimeByKind.other += 1;
    }
  }
  const realtimePublishedTotal = realtimePublishedRows.length;
  const realtimeAttempts = realtimePublishedTotal + realtimeFailedCount;
  const realtimeFailureRatePct =
    realtimeAttempts > 0
      ? Math.round((realtimeFailedCount / realtimeAttempts) * 100)
      : 0;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 text-sm">
      <header className="mb-6">
        <h1 className="text-xl font-medium">Cost Dashboard</h1>
        <p className="mt-1 text-muted-foreground">
          Anthropic API daily spend snapshots. Source:
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5">
            ai_cost_snapshots
          </code>
          (populated by{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            /api/cron/ai-cost-summary
          </code>
          ).
        </p>
        <p className="mt-1 text-muted-foreground">
          Rate-limit backend:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            {activeBackendName()}
          </code>
        </p>
      </header>

      {latest ? (
        <section className="mb-8 rounded-lg border p-4">
          <h2 className="mb-3 text-base font-medium">Latest snapshot</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Date</dt>
              <dd className="font-mono">{fmtJstDate(latest.snapshotDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Daily</dt>
              <dd className="font-mono">
                {fmtUsd(latest.dailyUsedUsd)} /{" "}
                {fmtUsd(latest.dailyBudgetUsd)}{" "}
                <span className="text-muted-foreground">
                  ({pct(latest.dailyUsedUsd, latest.dailyBudgetUsd)}%)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Monthly</dt>
              <dd className="font-mono">
                {fmtUsd(latest.monthlyUsedUsd)} /{" "}
                {fmtUsd(latest.monthlyBudgetUsd)}{" "}
                <span className="text-muted-foreground">
                  ({pct(latest.monthlyUsedUsd, latest.monthlyBudgetUsd)}%)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Alert</dt>
              <dd className="font-mono">
                {latest.shouldAlert ? (
                  <span className="text-red-600">tripped</span>
                ) : (
                  <span className="text-green-600">ok</span>
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : (
        <p className="rounded border border-dashed p-4 text-muted-foreground">
          No snapshots yet — run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            curl -X POST -H &quot;authorization: Bearer $CRON_SECRET&quot;
            https://&lt;host&gt;/api/cron/ai-cost-summary
          </code>{" "}
          to backfill the first row.
        </p>
      )}

      {/* Round 15: Month-end forecast — projects monthlyUsedUsd to month
          end using a trailing 7-day average. Helps spot a budget breach
          mid-month before the monthly threshold actually trips. */}
      {latest && (
        <section className="mb-8 rounded-lg border p-4">
          <h2 className="mb-3 text-base font-medium">Month-end forecast</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">
                Forecast (month-end)
              </dt>
              <dd className="font-mono">
                {fmtUsd(forecast.monthEndForecastUsd)}{" "}
                <span className="text-muted-foreground">
                  ({Math.round(forecast.forecastPct)}%)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Trailing daily avg
              </dt>
              <dd className="font-mono">
                {fmtUsd(forecast.trailingDailyAvgUsd)}{" "}
                <span className="text-muted-foreground">
                  (n={forecast.trailingDaysSampled})
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Remaining days</dt>
              <dd className="font-mono">{forecast.remainingDays}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pace</dt>
              <dd className="font-mono">
                {forecast.pace === "under" ? (
                  <span className="text-green-600">under</span>
                ) : forecast.pace === "watch" ? (
                  <span className="text-amber-600">watch</span>
                ) : (
                  <span className="text-red-600">over</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Recipe: month-to-date {fmtUsd(latest.monthlyUsedUsd)} +
            (trailing-{forecast.trailingDaysSampled}-day avg ×{" "}
            {forecast.remainingDays} remaining days). Linear projection;
            does not yet account for weekday seasonality. Pace bands:
            ≤80% under, 80–110% watch, &gt;110% over.
          </p>
        </section>
      )}

      {/* Round 15: estimate-pdf cache hit rate (24h, approximated).
          Until we wire per-tier counters into AiCostSnapshot the recipe
          is: estimate_count - aiCache_writes ≈ cache hits. Signed-URL
          fallback also writes to AiCache, so we cannot yet split
          files-api vs signed-url tiers from this number alone. */}
      <section className="mb-8 rounded-lg border p-4">
        <h2 className="mb-3 text-base font-medium">
          Estimate-PDF cache hit rate (24h, approx)
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">PDF analyses</dt>
            <dd className="font-mono">{estimateCount24h}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">AiCache writes</dt>
            <dd className="font-mono">{aiCacheWrites24h}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Approx hits</dt>
            <dd className="font-mono">{approxCacheHits}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Hit rate</dt>
            <dd className="font-mono">
              {estimateCount24h > 0 ? `${cacheHitPct}%` : "n/a"}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Approximation: <code>analyses − writes ≈ hits</code>. AiCache
          rows tagged <code>claude-sonnet-4-6</code> are the
          estimate-extract path (no other sonnet+AiCache caller today).
          Per-tier (cache / files-api / signed-url) split lands when the
          cron parses log drains; until then ops can grep
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5">
            event:&quot;estimate_extract_tier&quot;
          </code>
          for the breakdown.
        </p>
      </section>

      {/*
        P3 L3 W2 monitoring — Realtime push activity (7d).
        Source rows: push_send_logs (PushSendLog model, P3 L3 W2).
        What's covered + what isn't is documented in
        src/lib/push-throttle-stats.ts — TL;DR: durable counts of
        what was SENT plus per-event opt-out rate. The atomic
        cool-down's silent skip count isn't durable (P2002 leaves no
        row), so we don't pretend to surface it.
      */}
      <section className="mb-8 rounded-lg border p-4">
        <h2 className="mb-3 text-base font-medium">
          Realtime push activity · 7d
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b text-[10.5px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">event</th>
                <th className="py-2 pr-3 text-right">sent 24h</th>
                <th className="py-2 pr-3 text-right">sent 7d</th>
                <th className="py-2 pr-3 text-right">unique (recipient × scope)</th>
                <th className="py-2 pr-3 text-right">hour-buckets touched</th>
                <th className="py-2 pr-3 text-right">avg sends / active hour</th>
                <th className="py-2 text-right">opt-out</th>
              </tr>
            </thead>
            <tbody>
              {pushStats.map((s) => {
                const optOut = optOutStats.find((o) => o.kind === s.kind);
                return (
                  <tr key={s.kind} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 font-mono">
                      {pushEventLabel(s.kind)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.sent24h}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.sent7d}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.uniqueRecipientScopes7d}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.hourBucketsTouched7d}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.sendsPerActiveBucket7d > 0
                        ? s.sendsPerActiveBucket7d.toFixed(1)
                        : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {optOut && optOut.totalUsersWithPref > 0 ? (
                        <span
                          title={`${optOut.optedOut} / ${optOut.totalUsersWithPref}`}
                        >
                          {optOut.optOutPct}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Throttle skip count (atomic 1-per-hour cool-down via P2002 on{" "}
          <code className="rounded bg-muted px-1 py-0.5">push_send_logs</code>
          ) is intentionally not durable — surfacing it would need
          log-drain ingestion of the{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            realtime_push_dispatch
          </code>{" "}
          event. The signal we DO have is opt-out rate (above) +
          burst density (sends / active hour); a sustained
          opt-out climb is the leading indicator that the copy or
          frequency is wrong.
        </p>
      </section>

      {/* Round 22: estimate-pdf tier hit-rate trend, persisted per-day
          via AiCostSnapshot.tierStats. Same recipe as the 24h section
          above, but read from the snapshot rows so historical days
          appear instead of just "today". Pre-round-22 rows + quiet
          days both render as "—" (the cron writes null for both). */}
      {snapshots.some((s) => s.tierStats?.["estimate-pdf"]) && (
        <section className="mb-8">
          <h2 className="mb-3 text-base font-medium">
            Estimate-PDF tier history
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Calls</th>
                  <th className="px-3 py-2 font-medium">Cache hits</th>
                  <th className="px-3 py-2 font-medium">Cache writes</th>
                  <th className="px-3 py-2 font-medium">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => {
                  const t = s.tierStats?.["estimate-pdf"] ?? null;
                  return (
                    <tr key={s.snapshotDate.toISOString()}>
                      <td className="px-3 py-2 font-mono">
                        {fmtJstDate(s.snapshotDate)}
                      </td>
                      <td className="px-3 py-2 font-mono">{t?.calls ?? "—"}</td>
                      <td className="px-3 py-2 font-mono">
                        {t?.cacheHits ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {t?.cacheWrites ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {t ? `${t.hitRate}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Persisted nightly by{" "}
            <code className="rounded bg-muted px-1.5 py-0.5">
              /api/cron/ai-cost-summary
            </code>{" "}
            into{" "}
            <code className="rounded bg-muted px-1.5 py-0.5">
              ai_cost_snapshots.tier_stats
            </code>
            . Same approximation as the 24h section above —{" "}
            <code>analyses − writes ≈ hits</code>; signed-URL fallback
            counts as a cache write so the &quot;hits&quot; bucket
            isolates only the cache-short-circuit path. Empty cells = day
            had no estimate-pdf activity (or pre-round-22 row).
          </p>
        </section>
      )}

      {/* Phase 3 L3 wave 4 — Realtime broadcast metric.
          publishRealtimeEvent writes a `realtime.broadcast.published`
          (or `.failed`) audit row per send; this section reads the
          last 7d and groups by RealtimeEvent kind. Subscribe count +
          per-client connection failure rate need client telemetry to
          measure and are tracked in docs/phase3/partner-level-3-design.md
          § 12 as wave-5 follow-up. */}
      <section className="mb-8">
        <h2 className="mb-3 text-base font-medium">
          Realtime broadcasts (7d)
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Total publishes</dt>
            <dd className="font-mono">{realtimePublishedTotal}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Failed publishes</dt>
            <dd className="font-mono">
              {realtimeFailedCount}
              {realtimeAttempts > 0 && (
                <span className="ml-2 text-muted-foreground">
                  ({realtimeFailureRatePct}%)
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Subscribe count (7d)
            </dt>
            <dd className="font-mono text-muted-foreground">— (wave 5)</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Connection failure rate
            </dt>
            <dd className="font-mono text-muted-foreground">— (wave 5)</dd>
          </div>
        </dl>
        <div className="mt-4 overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 font-medium">Event kind</th>
                <th className="px-3 py-2 font-medium">Count (7d)</th>
                <th className="px-3 py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...realtimeKnownKinds.map((k) => ({
                  kind: k as string,
                  count: realtimeByKind[k],
                })),
                { kind: "other", count: realtimeByKind.other },
              ].map(({ kind, count }) => {
                const share =
                  realtimePublishedTotal > 0
                    ? Math.round((count / realtimePublishedTotal) * 100)
                    : 0;
                return (
                  <tr key={kind}>
                    <td className="px-3 py-2 font-mono">{kind}</td>
                    <td className="px-3 py-2 font-mono">{count}</td>
                    <td className="px-3 py-2 font-mono">
                      {realtimePublishedTotal > 0 ? `${share}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Source:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">audit_logs</code>{" "}
          rows where{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            action = &apos;realtime.broadcast.published&apos;
          </code>{" "}
          (or{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">.failed</code>),
          grouped by{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">detail.kind</code>.
          Written by{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            src/lib/realtime/publish.ts
          </code>{" "}
          one row per send. Subscribe count + per-client connection failure
          rate require client telemetry — tracked as wave 5 in{" "}
          <a
            className="underline"
            href="https://github.com/ykaya-jp/haretoki/blob/main/docs/phase3/partner-level-3-design.md"
          >
            docs/phase3/partner-level-3-design.md
          </a>{" "}
          § 12.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-base font-medium">Last 30 snapshots</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Daily $</th>
                <th className="px-3 py-2 font-medium">Daily %</th>
                <th className="px-3 py-2 font-medium">Monthly $</th>
                <th className="px-3 py-2 font-medium">Monthly %</th>
                <th className="px-3 py-2 font-medium">Alert</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr
                  key={s.snapshotDate.toISOString()}
                  className={s.shouldAlert ? "bg-red-50 dark:bg-red-950/30" : ""}
                >
                  <td className="px-3 py-2 font-mono">
                    {fmtJstDate(s.snapshotDate)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {fmtUsd(s.dailyUsedUsd)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {pct(s.dailyUsedUsd, s.dailyBudgetUsd)}%
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {fmtUsd(s.monthlyUsedUsd)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {pct(s.monthlyUsedUsd, s.monthlyBudgetUsd)}%
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {s.shouldAlert ? "⚠" : "·"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {latest?.dailyByBucket && (
          <details className="mt-4 rounded border p-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Latest dailyByBucket detail (JSON)
            </summary>
            <pre className="mt-2 overflow-x-auto text-xs">
              {JSON.stringify(latest.dailyByBucket, null, 2)}
            </pre>
          </details>
        )}
      </section>

      <footer className="mt-8 text-xs text-muted-foreground">
        運用 doc:{" "}
        <a className="underline" href="https://github.com/ykaya-jp/haretoki/blob/main/docs/ai/cost-baseline.md">
          docs/ai/cost-baseline.md
        </a>{" "}
        — Sentry alert routing:{" "}
        <a className="underline" href="https://github.com/ykaya-jp/haretoki/blob/main/docs/harness/sentry-alerts.md">
          docs/harness/sentry-alerts.md
        </a>
      </footer>
    </main>
  );
}
