/**
 * Pure aggregation helpers for the /admin/cost realtime-push section.
 *
 * Lives outside `server/` so the spec runner can import directly
 * without standing up Prisma. The page passes raw rows in; these
 * helpers do no I/O.
 *
 * What we surface (and what we DON'T):
 *
 *   ✓ per-event 7d / 24h send count
 *     (= rows in PushSendLog matching kind)
 *   ✓ distinct (recipient, scope) per event
 *     (≈ "unique conversations the event touched")
 *   ✓ distinct hour-buckets per event
 *     (= how spread out across the week the activity was)
 *   ✓ avg sends per active hour-bucket per event
 *     (= burst density when the event was firing)
 *   ✓ per-event opt-out rate
 *     (= % of users with notify*=false on that event)
 *
 *   ✗ throttle "skip" count
 *     The dispatcher's atomic 1-per-hour cool-down is enforced via
 *     P2002-on-create — losers DON'T leave a row. Counting them
 *     accurately requires log-drain ingestion (counters returned
 *     in `realtime_push_dispatch` log events) which isn't wired up.
 *     The page surfaces what we can durably count and labels the
 *     gap honestly.
 */

import type { RealtimePushEvent } from "@/lib/push/realtime-copy";

/** Minimal PushSendLog projection used by the helpers. */
export interface PushSendLogLite {
  recipientUserId: string;
  kind: string;
  scopeId: string;
  hourBucket: number;
  sentAt: Date;
}

/** Minimal NotificationPreference projection used by opt-out aggregation. */
export interface PreferenceOptOutRow {
  notifyPartnerRating: boolean;
  notifyPartnerNote: boolean;
  notifyDecisionSaved: boolean;
  notifyWeddingDateSet: boolean;
  notifyPartnerVenueAdded: boolean;
  notifyPartnerVenueDeleted: boolean;
}

export interface PushEventStats {
  /** Event kind. */
  kind: RealtimePushEvent;
  sent7d: number;
  sent24h: number;
  /** Distinct (recipient, scope) tuples seen in the 7d window. */
  uniqueRecipientScopes7d: number;
  /** Distinct hour-buckets seen in the 7d window. */
  hourBucketsTouched7d: number;
  /**
   * `sent7d / hourBucketsTouched7d` rounded to 1 decimal. > 1.0
   * means the event tended to fan out across multiple recipients
   * inside the same hour (the cool-down's typical job). 0 when no
   * sends in window — UI displays "—".
   */
  sendsPerActiveBucket7d: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const KNOWN_EVENTS: ReadonlyArray<RealtimePushEvent> = [
  "partner_rating_added",
  "partner_note_added",
  "decision_saved",
  "wedding_date_set",
];

/**
 * Roll PushSendLog rows up into per-event stats. Always returns one
 * row per known event (zeros for events with no activity) so the UI
 * doesn't have to special-case missing series.
 *
 * `now` is parameterised for tests — production passes `new Date()`.
 */
export function aggregatePushThrottleStats(
  rows: PushSendLogLite[],
  options: { now?: Date } = {},
): PushEventStats[] {
  const now = options.now ?? new Date();
  const cutoff7d = now.getTime() - 7 * DAY_MS;
  const cutoff24h = now.getTime() - 1 * DAY_MS;

  // Pre-filter to the 7d window once so all the per-event passes
  // walk a smaller list. 7d is the longest horizon we surface.
  const within7d = rows.filter((r) => r.sentAt.getTime() >= cutoff7d);

  return KNOWN_EVENTS.map((kind) => {
    const subset = within7d.filter((r) => r.kind === kind);
    const uniqueRecipientScopes = new Set(
      subset.map((r) => `${r.recipientUserId}::${r.scopeId}`),
    );
    const hourBuckets = new Set(subset.map((r) => r.hourBucket));
    const sent24h = subset.filter((r) => r.sentAt.getTime() >= cutoff24h).length;
    const sendsPerBucket =
      hourBuckets.size === 0
        ? 0
        : Math.round((subset.length / hourBuckets.size) * 10) / 10;
    return {
      kind,
      sent7d: subset.length,
      sent24h,
      uniqueRecipientScopes7d: uniqueRecipientScopes.size,
      hourBucketsTouched7d: hourBuckets.size,
      sendsPerActiveBucket7d: sendsPerBucket,
    };
  });
}

export interface OptOutStats {
  kind: RealtimePushEvent;
  /** Users with notify*=false on this event. */
  optedOut: number;
  /** Total users who have a NotificationPreference row at all. */
  totalUsersWithPref: number;
  /**
   * Rounded percentage (0-100) of users opted out. 0 when there are
   * no pref rows; UI displays "n/a" in that case (which usually means
   * a fresh deploy with no signups yet).
   */
  optOutPct: number;
}

const EVENT_TO_PREF_KEY: Record<RealtimePushEvent, keyof PreferenceOptOutRow> = {
  partner_rating_added: "notifyPartnerRating",
  partner_note_added: "notifyPartnerNote",
  decision_saved: "notifyDecisionSaved",
  wedding_date_set: "notifyWeddingDateSet",
  partner_venue_added: "notifyPartnerVenueAdded",
  partner_venue_deleted: "notifyPartnerVenueDeleted",
};

/**
 * Per-event opt-out rate from a snapshot of NotificationPreference
 * rows. Always returns one stats entry per known event (mirrors
 * `aggregatePushThrottleStats`'s exhaustive-by-default shape).
 */
export function aggregateOptOutRates(
  rows: PreferenceOptOutRow[],
): OptOutStats[] {
  const total = rows.length;
  return KNOWN_EVENTS.map((kind) => {
    const key = EVENT_TO_PREF_KEY[kind];
    const optedOut = rows.filter((r) => r[key] === false).length;
    const optOutPct = total === 0 ? 0 : Math.round((optedOut / total) * 100);
    return {
      kind,
      optedOut,
      totalUsersWithPref: total,
      optOutPct,
    };
  });
}

/**
 * Render-friendly label for the operator UI. Centralised so a copy
 * change is one edit.
 */
export function pushEventLabel(kind: RealtimePushEvent): string {
  switch (kind) {
    case "partner_rating_added":
      return "partner rating added";
    case "partner_note_added":
      return "partner note added";
    case "decision_saved":
      return "decision saved";
    case "wedding_date_set":
      return "wedding date set";
    case "partner_venue_added":
      return "partner venue added";
    case "partner_venue_deleted":
      return "partner venue deleted";
  }
}
