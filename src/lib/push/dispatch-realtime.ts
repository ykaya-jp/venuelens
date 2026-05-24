/**
 * Phase 3 Level 3 wave 2 — couple-activity push dispatcher.
 *
 * Called by Realtime broadcast handlers (Wave 1 by PaneA) when a
 * partner-visible action lands. Fans out a push notification to
 * every project member EXCEPT the actor, gated by:
 *
 *   1. per-event NotificationPreference toggle (notifyPartnerRating
 *      etc.) — if false, silently skip without recording a throttle
 *      row so re-enabling later still fires the next event.
 *   2. frequency=off — same blanket silence as visit-reminder cron.
 *   3. PushSendLog @@unique([recipientUserId, kind, scopeId,
 *      hourBucket]) — atomic 1-per-hour cool-down. Concurrent
 *      Realtime broadcasts P2002 each other and one of them wins;
 *      the loser is a no-op (not an error).
 *
 * Designer-warned race + invalidation contracts pinned in tests:
 *   - same kind/scope/hour: only one push regardless of N callers
 *   - hour rollover: a fresh send is allowed in the new bucket
 *   - opt-out: no PushSendLog row created, so toggle-back-on still
 *     fires the next qualifying event (matches B-3 reminder-toggle
 *     shape exactly)
 *   - actor never receives own-event push (recipients = members
 *     minus actor)
 *
 * Returns a small result so the caller (Realtime broadcast handler)
 * can log per-event throughput without re-querying.
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import { captureError } from "@/lib/sentry";
import { logEvent } from "@/lib/observability";
import { sendPushToUser } from "@/lib/push/send";
import {
  hourBucketOf,
  pickRealtimeCopy,
  pickRealtimeUrl,
  type RealtimePushEvent,
} from "@/lib/push/realtime-copy";

export interface DispatchRealtimeInput {
  kind: RealtimePushEvent;
  /** Source-of-truth project — recipients are joined from this. */
  projectId: string;
  /** Acting user — excluded from recipients (no self-pings). */
  actorUserId: string;
  /**
   * Scope identifier embedded in the throttle key + push tag.
   * - partner_rating_added / partner_note_added / decision_saved → venueId
   * - wedding_date_set → projectId
   * Stringly-typed so a hard delete of the scope row doesn't cascade
   * onto the throttle history (sweep handles retention).
   */
  scopeId: string;
  /** Optional venue display name for the copy template. */
  venueName?: string | null;
  /**
   * Optional injected clock for deterministic tests. Production
   * callers rely on the default `new Date()`.
   */
  now?: Date;
}

export interface DispatchRealtimeResult {
  attempted: number;
  sent: number;
  /** Members who tripped the per-event toggle (no log row created). */
  skippedOptOut: number;
  /** Members the dispatcher silenced via frequency=off. */
  skippedFrequencyOff: number;
  /** Members whose 1h throttle row already existed (P2002 caught). */
  skippedThrottled: number;
  /** Members with no live PushSubscription rows. */
  noSubscription: number;
  /** Per-recipient errors that didn't fit any classified path. */
  errors: number;
}

/**
 * Map kind → per-event preference column. Centralised so a column
 * rename surfaces as one compile error.
 */
const KIND_TO_PREF_COLUMN = {
  partner_rating_added: "notifyPartnerRating",
  partner_note_added: "notifyPartnerNote",
  decision_saved: "notifyDecisionSaved",
  wedding_date_set: "notifyWeddingDateSet",
  partner_venue_added: "notifyPartnerVenueAdded",
  partner_venue_deleted: "notifyPartnerVenueDeleted",
} as const satisfies Record<RealtimePushEvent, string>;

type RecipientPref = {
  frequency: string;
  notifyPartnerRating: boolean;
  notifyPartnerNote: boolean;
  notifyDecisionSaved: boolean;
  notifyWeddingDateSet: boolean;
  notifyPartnerVenueAdded: boolean;
  notifyPartnerVenueDeleted: boolean;
};

function isEventEnabledForPref(
  kind: RealtimePushEvent,
  pref: RecipientPref | null | undefined,
): boolean {
  // No preference row yet → schema defaults (all true). Same shape
  // as visit-reminder dispatcher's missing-pref branch.
  if (!pref) return true;
  const col = KIND_TO_PREF_COLUMN[kind];
  return pref[col as keyof RecipientPref] as boolean;
}

export async function dispatchRealtimeEvent(
  input: DispatchRealtimeInput,
): Promise<DispatchRealtimeResult> {
  const now = input.now ?? new Date();
  const bucket = hourBucketOf(now);

  // Look up co-members + their preferences + actor display name in
  // parallel — three small reads, no fan-out yet.
  const [members, actor] = await Promise.all([
    prisma.projectMember.findMany({
      where: {
        projectId: input.projectId,
        acceptedAt: { not: null },
        userId: { not: input.actorUserId },
      },
      select: {
        userId: true,
        user: {
          select: {
            notificationPreference: {
              select: {
                frequency: true,
                notifyPartnerRating: true,
                notifyPartnerNote: true,
                notifyDecisionSaved: true,
                notifyWeddingDateSet: true,
                notifyPartnerVenueAdded: true,
                notifyPartnerVenueDeleted: true,
              },
            },
          },
        },
      },
    }),
    prisma.user.findUnique({
      where: { id: input.actorUserId },
      select: { name: true, email: true },
    }),
  ]);

  const partnerName = derivePartnerName(actor);
  const copy = pickRealtimeCopy({
    kind: input.kind,
    venueName: input.venueName,
    partnerName,
  });
  const url = pickRealtimeUrl(input.kind, input.scopeId);

  const result: DispatchRealtimeResult = {
    attempted: members.length,
    sent: 0,
    skippedOptOut: 0,
    skippedFrequencyOff: 0,
    skippedThrottled: 0,
    noSubscription: 0,
    errors: 0,
  };

  for (const member of members) {
    const pref = member.user.notificationPreference;
    // frequency=off silences EVERY surface — same shape as visit-
    // reminder cron. No throttle row recorded so a later toggle to
    // auto re-arms the user.
    if (pref?.frequency === "off") {
      result.skippedFrequencyOff++;
      continue;
    }
    if (!isEventEnabledForPref(input.kind, pref)) {
      result.skippedOptOut++;
      continue;
    }

    // Atomic throttle gate. P2002 = "another caller already sent
    // this hour" → silent skip.
    try {
      await prisma.pushSendLog.create({
        data: {
          recipientUserId: member.userId,
          kind: input.kind,
          scopeId: input.scopeId,
          hourBucket: bucket,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        result.skippedThrottled++;
        continue;
      }
      captureError(err, {
        component: "push.send",
        alertRoute: "p3-digest",
        extra: {
          action: "realtime-push:throttle-create",
          kind: input.kind,
          recipientUserId: member.userId,
        },
      });
      result.errors++;
      continue;
    }

    // Send. The push leg is best-effort — failure here NEVER
    // blocks the loop, captured per-error inside sendPushToUser.
    try {
      const fanOut = await sendPushToUser(member.userId, {
        title: copy.title,
        body: copy.body,
        url,
        tag: `realtime-push:${input.kind}:${input.scopeId}`,
      });
      if (fanOut.attempted === 0) {
        result.noSubscription++;
      } else if (fanOut.succeeded > 0) {
        result.sent++;
      }
    } catch (err) {
      captureError(err, {
        component: "push.send",
        alertRoute: "p3-digest",
        extra: {
          action: "realtime-push:send",
          kind: input.kind,
          recipientUserId: member.userId,
        },
      });
      result.errors++;
    }
  }

  // Structured cron-like summary so the Realtime broadcast handler's
  // log doesn't have to re-derive these counters. Dropped to
  // p3-digest level — couple activity is high-frequency and noisy
  // for the p2-email surface.
  logEvent({
    event: "realtime_push_dispatch",
    fields: {
      kind: input.kind,
      projectId: input.projectId,
      attempted: result.attempted,
      sent: result.sent,
      skippedOptOut: result.skippedOptOut,
      skippedFrequencyOff: result.skippedFrequencyOff,
      skippedThrottled: result.skippedThrottled,
      noSubscription: result.noSubscription,
      errors: result.errors,
    },
  });

  return result;
}

/**
 * Derive a display name for the actor from User.{name, email}. Email
 * local-part is used as a fallback (so partner sees "yuki" rather
 * than "相手の方") when name is absent. Returns null when neither
 * field is usable; the copy picker substitutes "相手の方".
 */
function derivePartnerName(
  actor: { name: string | null; email: string | null } | null,
): string | null {
  if (!actor) return null;
  if (actor.name && actor.name.trim().length > 0) return actor.name.trim();
  if (actor.email) {
    const local = actor.email.split("@")[0]?.trim();
    if (local && local.length > 0) return local;
  }
  return null;
}
