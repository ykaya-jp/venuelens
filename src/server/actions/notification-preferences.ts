"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth";
import { captureError } from "@/lib/sentry";
import type { VisitReminderPhase } from "@/lib/visit-reminders";
import type { RealtimePushEvent } from "@/lib/push/realtime-copy";

export type FrequencyMode = "auto" | "quiet" | "off";

export interface ReminderTimingFlags {
  /** day_before phase (T-24h, JST 19:00 cron). */
  dayBefore: boolean;
  /** morning_of phase (T-1h, JST 08:00 cron). */
  morningOf: boolean;
  /** way_home phase (T+30m, JST 22:00 cron). */
  wayHome: boolean;
}

export interface PartnerActivityFlags {
  partnerRating: boolean;
  partnerNote: boolean;
  decisionSaved: boolean;
  weddingDateSet: boolean;
}

export interface NotificationPreferenceData {
  frequency: FrequencyMode;
  emailEnabled: boolean;
  pushEnabled: boolean;
  /**
   * Track B-3 per-timing toggles. Always returned (never undefined) so
   * the UI doesn't need to special-case "preference row not yet
   * written". Defaults to all-true to mirror the schema default.
   */
  reminderTimings: ReminderTimingFlags;
  /**
   * P3 L3 W2 — couple-activity push toggles. Always returned (defaults
   * all-true) so the dispatcher gate has the same shape regardless of
   * whether the user has opened settings.
   */
  partnerActivity: PartnerActivityFlags;
}

const DEFAULT_PREF: NotificationPreferenceData = {
  frequency: "auto",
  emailEnabled: true,
  pushEnabled: false,
  reminderTimings: { dayBefore: true, morningOf: true, wayHome: true },
  partnerActivity: {
    partnerRating: true,
    partnerNote: true,
    decisionSaved: true,
    weddingDateSet: true,
  },
};

/** Returns the current user's notification preference, defaulting if absent. */
export async function getMyNotificationPreference(): Promise<NotificationPreferenceData> {
  const user = await requireUser();

  const pref = await prisma.notificationPreference.findUnique({
    where: { userId: user.id },
    select: {
      frequency: true,
      emailEnabled: true,
      pushEnabled: true,
      remindersDayBefore: true,
      remindersMorningOf: true,
      remindersWayHome: true,
      notifyPartnerRating: true,
      notifyPartnerNote: true,
      notifyDecisionSaved: true,
      notifyWeddingDateSet: true,
    },
  });

  if (!pref) return DEFAULT_PREF;

  return {
    frequency: pref.frequency as FrequencyMode,
    emailEnabled: pref.emailEnabled,
    pushEnabled: pref.pushEnabled,
    reminderTimings: {
      dayBefore: pref.remindersDayBefore,
      morningOf: pref.remindersMorningOf,
      wayHome: pref.remindersWayHome,
    },
    partnerActivity: {
      partnerRating: pref.notifyPartnerRating,
      partnerNote: pref.notifyPartnerNote,
      decisionSaved: pref.notifyDecisionSaved,
      weddingDateSet: pref.notifyWeddingDateSet,
    },
  };
}

/** Upserts the frequency mode for the current user. */
export async function updateNotificationFrequency(
  frequency: FrequencyMode,
): Promise<void> {
  const user = await requireUser();

  // Prisma accepts the enum string value directly when generated types are not available.
  await prisma.notificationPreference.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      frequency: frequency as any,
      emailEnabled: true,
      pushEnabled: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: { frequency: frequency as any },
  });
}

/**
 * Map UI-side phase identifiers to the boolean column the dispatcher
 * reads. Centralised here (instead of inlined at the call site) so a
 * schema rename surfaces as one compile error rather than three.
 */
const PHASE_TO_COLUMN = {
  day_before: "remindersDayBefore",
  morning_of: "remindersMorningOf",
  way_home: "remindersWayHome",
} as const satisfies Record<VisitReminderPhase, string>;

const updateTimingSchema = z.object({
  phase: z.enum(["day_before", "morning_of", "way_home"]),
  enabled: z.boolean(),
});

export type UpdateVisitReminderTimingInput = z.infer<typeof updateTimingSchema>;

export interface UpdateVisitReminderTimingResult {
  ok: boolean;
  error?: string;
}

/**
 * Track B-3: toggle a single visit-reminder timing on/off for the
 * current user. Upserts the NotificationPreference row so users who
 * never opened settings before still get a row created with sane
 * defaults (mirrors `updateNotificationFrequency`).
 *
 * The dispatcher (B-2 handler) reads these columns BEFORE creating a
 * VisitReminderSent dedupe row, so flipping a timing back on later
 * doesn't get swallowed by a stale dedupe entry.
 */
export async function updateVisitReminderTiming(
  input: UpdateVisitReminderTimingInput,
): Promise<UpdateVisitReminderTimingResult> {
  const parsed = updateTimingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "通知設定の値が不正です" };
  }
  const { phase, enabled } = parsed.data;
  const column = PHASE_TO_COLUMN[phase];

  const user = await requireUser();

  try {
    await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        emailEnabled: true,
        pushEnabled: false,
        // The two not-being-toggled columns inherit the schema default
        // (`true`); only the targeted column gets the explicit value.
        [column]: enabled,
      },
      update: { [column]: enabled },
    });
    // The mypage settings page is rendered as a Server Component;
    // refresh so a navigation back to /settings doesn't show stale state.
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    captureError(err, {
      component: "auth",
      alertRoute: "p3-digest",
      extra: { action: "notification-pref:update-timing", phase },
    });
    return { ok: false, error: "通知設定の保存に失敗しました" };
  }
}

/**
 * P3 L3 W2: map RealtimePushEvent → preference column. One edit
 * here propagates everywhere that consumes the toggles (UI setter +
 * dispatcher gate). `satisfies` enforces exhaustiveness — adding a
 * new event without an entry here is a compile error.
 */
const PARTNER_EVENT_TO_COLUMN = {
  partner_rating_added: "notifyPartnerRating",
  partner_note_added: "notifyPartnerNote",
  decision_saved: "notifyDecisionSaved",
  wedding_date_set: "notifyWeddingDateSet",
  partner_venue_added: "notifyPartnerVenueAdded",
  partner_venue_deleted: "notifyPartnerVenueDeleted",
} as const satisfies Record<RealtimePushEvent, string>;

const updatePartnerActivitySchema = z.object({
  event: z.enum([
    "partner_rating_added",
    "partner_note_added",
    "decision_saved",
    "wedding_date_set",
    "partner_venue_added",
    "partner_venue_deleted",
  ]),
  enabled: z.boolean(),
});

export type UpdatePartnerActivityInput = z.infer<
  typeof updatePartnerActivitySchema
>;

export interface UpdatePartnerActivityResult {
  ok: boolean;
  error?: string;
}

/**
 * P3 L3 W2: toggle a single couple-activity push event on/off for
 * the current user. Same upsert-shape as `updateVisitReminderTiming`
 * (B-3) so the UI pattern is symmetric. The dispatcher
 * (`dispatchRealtimeEvent`) reads these columns BEFORE creating a
 * `PushSendLog` throttle row, so flipping a toggle back on later
 * doesn't get swallowed by a stale throttle entry.
 */
export async function updatePartnerActivityToggle(
  input: UpdatePartnerActivityInput,
): Promise<UpdatePartnerActivityResult> {
  const parsed = updatePartnerActivitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "通知設定の値が不正です" };
  }
  const { event, enabled } = parsed.data;
  const column = PARTNER_EVENT_TO_COLUMN[event];

  const user = await requireUser();

  try {
    await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        emailEnabled: true,
        pushEnabled: false,
        // Only the targeted column gets the explicit value; the
        // other 3 inherit the schema default `true`.
        [column]: enabled,
      },
      update: { [column]: enabled },
    });
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    captureError(err, {
      component: "auth",
      alertRoute: "p3-digest",
      extra: { action: "notification-pref:update-partner-activity", event },
    });
    return { ok: false, error: "通知設定の保存に失敗しました" };
  }
}
