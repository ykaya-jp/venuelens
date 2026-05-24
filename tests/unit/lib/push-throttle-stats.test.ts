import { describe, it, expect } from "vitest";
import {
  aggregatePushThrottleStats,
  aggregateOptOutRates,
  pushEventLabel,
  type PushSendLogLite,
  type PreferenceOptOutRow,
} from "@/lib/push-throttle-stats";

/**
 * Pin the /admin/cost realtime-push surface math. The dashboard is
 * read-only diagnostics so a regression here doesn't ship a bug to
 * couples — it ships an operator confidence loss. Still important
 * enough to test cleanly.
 */

const NOW = new Date("2026-05-03T12:00:00Z");

function row(overrides: Partial<PushSendLogLite> & { hoursAgo?: number }): PushSendLogLite {
  const hoursAgo = overrides.hoursAgo ?? 0;
  return {
    recipientUserId: overrides.recipientUserId ?? "u-1",
    kind: overrides.kind ?? "partner_rating_added",
    scopeId: overrides.scopeId ?? "venue-1",
    hourBucket:
      overrides.hourBucket ??
      Math.floor((NOW.getTime() - hoursAgo * 60 * 60 * 1000) / 3600000),
    sentAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000),
  };
}

describe("aggregatePushThrottleStats", () => {
  it("returns one entry per known event even with zero rows (always renderable)", () => {
    const stats = aggregatePushThrottleStats([], { now: NOW });
    expect(stats).toHaveLength(4);
    expect(stats.every((s) => s.sent7d === 0)).toBe(true);
    expect(stats.every((s) => s.sendsPerActiveBucket7d === 0)).toBe(true);
    expect(stats.map((s) => s.kind).sort()).toEqual([
      "decision_saved",
      "partner_note_added",
      "partner_rating_added",
      "wedding_date_set",
    ]);
  });

  it("counts 7d sends correctly per event", () => {
    const rows = [
      row({ kind: "partner_rating_added" }),
      row({ kind: "partner_rating_added", recipientUserId: "u-2" }),
      row({ kind: "decision_saved" }),
    ];
    const stats = aggregatePushThrottleStats(rows, { now: NOW });
    const rating = stats.find((s) => s.kind === "partner_rating_added")!;
    const decision = stats.find((s) => s.kind === "decision_saved")!;
    expect(rating.sent7d).toBe(2);
    expect(decision.sent7d).toBe(1);
  });

  it("ignores rows older than 7 days (window-bounded)", () => {
    const rows = [
      row({ kind: "partner_rating_added", hoursAgo: 2 }),
      row({ kind: "partner_rating_added", hoursAgo: 24 * 8 }), // 8 days
    ];
    const stats = aggregatePushThrottleStats(rows, { now: NOW });
    expect(stats.find((s) => s.kind === "partner_rating_added")!.sent7d).toBe(1);
  });

  it("counts 24h sends as a strict subset of 7d", () => {
    const rows = [
      row({ kind: "partner_rating_added", hoursAgo: 1 }), // in 24h
      row({ kind: "partner_rating_added", hoursAgo: 12 }), // in 24h
      row({ kind: "partner_rating_added", hoursAgo: 48 }), // in 7d only
    ];
    const stats = aggregatePushThrottleStats(rows, { now: NOW });
    const rating = stats.find((s) => s.kind === "partner_rating_added")!;
    expect(rating.sent24h).toBe(2);
    expect(rating.sent7d).toBe(3);
  });

  it("counts unique (recipient, scope) tuples (de-duplicates per pair)", () => {
    const rows = [
      // Same (u-1, venue-1) at different hour buckets — distinct rows
      // but ONE unique pair.
      row({ recipientUserId: "u-1", scopeId: "venue-1", hoursAgo: 2 }),
      row({ recipientUserId: "u-1", scopeId: "venue-1", hoursAgo: 6 }),
      // (u-1, venue-2) — second pair.
      row({ recipientUserId: "u-1", scopeId: "venue-2", hoursAgo: 1 }),
      // (u-2, venue-1) — third pair.
      row({ recipientUserId: "u-2", scopeId: "venue-1", hoursAgo: 1 }),
    ];
    const stats = aggregatePushThrottleStats(rows, { now: NOW });
    const rating = stats.find((s) => s.kind === "partner_rating_added")!;
    expect(rating.uniqueRecipientScopes7d).toBe(3);
    expect(rating.sent7d).toBe(4);
  });

  it("counts distinct hour-buckets touched (cool-down density signal)", () => {
    const rows = [
      row({ hourBucket: 100, recipientUserId: "u-1" }),
      row({ hourBucket: 100, recipientUserId: "u-2" }),
      row({ hourBucket: 101, recipientUserId: "u-1" }),
    ];
    // 2 distinct buckets touched, 3 rows → sendsPerActiveBucket = 1.5
    const stats = aggregatePushThrottleStats(rows, { now: NOW });
    const rating = stats.find((s) => s.kind === "partner_rating_added")!;
    expect(rating.hourBucketsTouched7d).toBe(2);
    expect(rating.sendsPerActiveBucket7d).toBe(1.5);
  });

  it("rounds sendsPerActiveBucket to 1 decimal", () => {
    const rows = [
      row({ hourBucket: 100, recipientUserId: "u-1" }),
      row({ hourBucket: 100, recipientUserId: "u-2" }),
      row({ hourBucket: 100, recipientUserId: "u-3" }),
      row({ hourBucket: 101, recipientUserId: "u-1" }),
      row({ hourBucket: 101, recipientUserId: "u-2" }),
      row({ hourBucket: 102, recipientUserId: "u-1" }),
    ];
    // 6 rows / 3 buckets = 2.0 exactly
    const stats = aggregatePushThrottleStats(rows, { now: NOW });
    const rating = stats.find((s) => s.kind === "partner_rating_added")!;
    expect(rating.sendsPerActiveBucket7d).toBe(2);
  });

  it("returns 0 (not NaN / Infinity) for sendsPerActiveBucket when there's no activity", () => {
    const stats = aggregatePushThrottleStats([], { now: NOW });
    for (const s of stats) {
      expect(Number.isFinite(s.sendsPerActiveBucket7d)).toBe(true);
      expect(s.sendsPerActiveBucket7d).toBe(0);
    }
  });
});

describe("aggregateOptOutRates", () => {
  function pref(overrides: Partial<PreferenceOptOutRow>): PreferenceOptOutRow {
    return {
      notifyPartnerRating: overrides.notifyPartnerRating ?? true,
      notifyPartnerNote: overrides.notifyPartnerNote ?? true,
      notifyDecisionSaved: overrides.notifyDecisionSaved ?? true,
      notifyWeddingDateSet: overrides.notifyWeddingDateSet ?? true,
      notifyPartnerVenueAdded: overrides.notifyPartnerVenueAdded ?? true,
      notifyPartnerVenueDeleted: overrides.notifyPartnerVenueDeleted ?? true,
    };
  }

  it("returns optOutPct=0 + totalUsersWithPref=0 for empty input", () => {
    const stats = aggregateOptOutRates([]);
    expect(stats).toHaveLength(4);
    for (const s of stats) {
      expect(s.totalUsersWithPref).toBe(0);
      expect(s.optedOut).toBe(0);
      expect(s.optOutPct).toBe(0);
    }
  });

  it("0% opt-out when every row defaults all-true", () => {
    const stats = aggregateOptOutRates([pref({}), pref({}), pref({})]);
    for (const s of stats) {
      expect(s.totalUsersWithPref).toBe(3);
      expect(s.optedOut).toBe(0);
      expect(s.optOutPct).toBe(0);
    }
  });

  it("counts opt-outs per event independently", () => {
    const stats = aggregateOptOutRates([
      pref({ notifyPartnerRating: false }),
      pref({ notifyPartnerRating: false, notifyPartnerNote: false }),
      pref({ notifyDecisionSaved: false }),
      pref({}),
    ]);
    const rating = stats.find((s) => s.kind === "partner_rating_added")!;
    const note = stats.find((s) => s.kind === "partner_note_added")!;
    const decision = stats.find((s) => s.kind === "decision_saved")!;
    const wedding = stats.find((s) => s.kind === "wedding_date_set")!;
    expect(rating.optedOut).toBe(2);
    expect(note.optedOut).toBe(1);
    expect(decision.optedOut).toBe(1);
    expect(wedding.optedOut).toBe(0);
    // 4 users; 2 opt-outs on rating → 50%
    expect(rating.optOutPct).toBe(50);
    expect(note.optOutPct).toBe(25);
  });

  it("rounds optOutPct to a whole number (no decimal noise on the dashboard)", () => {
    // 1 of 3 = 33.33% → rounds to 33
    const stats = aggregateOptOutRates([
      pref({ notifyDecisionSaved: false }),
      pref({}),
      pref({}),
    ]);
    expect(stats.find((s) => s.kind === "decision_saved")!.optOutPct).toBe(33);
  });
});

describe("pushEventLabel — exhaustive coverage", () => {
  // Compile-time exhaustiveness comes from the switch + the
  // RealtimePushEvent union; this test is the behavioural pin so a
  // future copy change (e.g. translation) lands as a visible diff.
  const events = [
    "partner_rating_added",
    "partner_note_added",
    "decision_saved",
    "wedding_date_set",
  ] as const;

  for (const e of events) {
    it(`returns a non-empty label for ${e}`, () => {
      expect(pushEventLabel(e).length).toBeGreaterThan(0);
    });
  }
});
