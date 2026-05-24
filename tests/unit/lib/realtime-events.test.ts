import { describe, it, expect } from "vitest";
import {
  projectChannelName,
  REALTIME_EVENT,
  REALTIME_EVENT_KINDS,
  type RealtimeEvent,
} from "@/lib/realtime/events";

/**
 * Phase 3 L3 wave 1 — pin the broadcast vocabulary.
 *
 * The channel naming and event-kind list are part of the contract
 * between the publisher (server actions) and the subscriber (client
 * hook). A rename here without coordinating both sides means in-flight
 * subscribers go silent on next deploy. These tests fail loudly so the
 * rename can't merge without intent.
 */

describe("realtime/events — channel naming", () => {
  it("returns project:<id> exactly", () => {
    expect(projectChannelName("abc-123")).toBe("project:abc-123");
  });

  it("does NOT change between calls (idempotent)", () => {
    const a = projectChannelName("p1");
    const b = projectChannelName("p1");
    expect(a).toBe(b);
  });
});

describe("realtime/events — event vocabulary", () => {
  it("REALTIME_EVENT is the haretoki:event constant", () => {
    expect(REALTIME_EVENT).toBe("haretoki:event");
  });

  it("REALTIME_EVENT_KINDS lists every kind in the union", () => {
    // If this fails after adding a new kind, also update:
    //   1. publishRealtimeEvent consumers in src/server/actions/*
    //   2. useRealtimeProject toastCopy + dedupKey switch statements
    expect(REALTIME_EVENT_KINDS).toEqual([
      "rating_saved",
      "note_added",
      "decision_made",
      "wedding_date_updated",
      "venue_deleted",
      "venue_added",
    ]);
  });

  it("rating_saved payload carries actor + venueId + dimensionCount", () => {
    const event: RealtimeEvent = {
      kind: "rating_saved",
      actor: { userId: "u1", name: "オーナー" },
      venueId: "v1",
      dimensionCount: 3,
    };
    expect(event.kind).toBe("rating_saved");
    expect(event.actor.userId).toBe("u1");
    expect(event.venueId).toBe("v1");
    expect(event.dimensionCount).toBe(3);
  });

  it("note_added payload carries actor + venueId + visitId", () => {
    const event: RealtimeEvent = {
      kind: "note_added",
      actor: { userId: "u1", name: "オーナー" },
      venueId: "v1",
      visitId: "vis1",
    };
    expect(event.visitId).toBe("vis1");
  });

  it("wedding_date_updated payload may carry null weddingDate (cleared)", () => {
    const event: RealtimeEvent = {
      kind: "wedding_date_updated",
      actor: { userId: "u1", name: "オーナー" },
      weddingDate: null,
    };
    expect(event.weddingDate).toBeNull();
  });
});
