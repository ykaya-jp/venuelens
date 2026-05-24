"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { showToast } from "@/lib/toast";
import {
  projectChannelName,
  REALTIME_EVENT,
  type RealtimeEvent,
} from "@/lib/realtime/events";

/**
 * Phase 3 L3 wave 1 — semantic event subscription for the project.
 *
 * Pairs with `useRealtimeSync` (CDC → router.refresh): this hook listens
 * to broadcast events fired by server actions and renders the
 * "{partner} が {action} しました" toast that lets the couple feel
 * each other's presence in the app.
 *
 * Intentional split:
 *   - CDC (`useRealtimeSync`) handles the data refresh (router.refresh
 *     debounced) so screens stay accurate.
 *   - Broadcast (this hook) handles the SOCIAL signal (toast + actor
 *     name + intent). It still calls router.refresh() for the events
 *     where the toast and the data refresh should land at the same
 *     moment (rating_saved / decision_made), so users on screens
 *     CDC isn't subscribed to (e.g. the home dashboard) still see the
 *     change reflected.
 *
 * Self-action filter:
 *   - The publisher writes `actor.userId`. The subscriber drops events
 *     where `actor.userId === viewerUserId` so couples don't see their
 *     own action toasted back at them.
 *
 * Dedup window:
 *   - Same `(kind, scope)` pair within 5s is collapsed to a single
 *     toast. Burst saves (rating bar dragged across 4 dimensions in
 *     2 seconds) shouldn't pop 4 toasts.
 *
 * Cleanup:
 *   - Channel removed on unmount AND on viewerUserId change. Auth
 *     transitions (sign-out / token-refresh) are handled by the
 *     existing `useRealtimeSync` reconnect code path; this hook
 *     stays scoped to the (projectId, viewerUserId) tuple and lets
 *     the consumer remount when the user identity changes.
 */

interface UseRealtimeProjectOptions {
  projectId: string;
  viewerUserId: string;
}

const DEDUP_WINDOW_MS = 5_000;

function dedupKey(event: RealtimeEvent): string {
  switch (event.kind) {
    case "rating_saved":
    case "decision_made":
    case "venue_deleted":
    case "venue_added":
      return `${event.kind}:${event.venueId}:${event.actor.userId}`;
    case "note_added":
      return `${event.kind}:${event.visitId}:${event.actor.userId}`;
    case "wedding_date_updated":
      return `${event.kind}:${event.actor.userId}`;
  }
}

function toastCopy(event: RealtimeEvent): { kind: "info" | "success"; msg: string } {
  const name = event.actor.name;
  switch (event.kind) {
    case "rating_saved":
      return { kind: "info", msg: `${name}さんが評価を残しました` };
    case "note_added":
      return { kind: "info", msg: `${name}さんがメモを残しました` };
    case "decision_made":
      return { kind: "success", msg: `${name}さんが式場を決定しました` };
    case "wedding_date_updated":
      return event.weddingDate
        ? { kind: "success", msg: `${name}さんが挙式日を更新しました` }
        : { kind: "info", msg: `${name}さんが挙式日をクリアしました` };
    case "venue_deleted":
      // Deliberately info (not error) — 手放す is a normal couple action.
      // Naming the venue in-band lets the partner see exactly which row
      // vanished without having to refresh and notice the empty slot.
      return { kind: "info", msg: `${name}さんが「${event.venueName}」を手放しました` };
    case "venue_added":
      return {
        kind: "info",
        msg: `${name}さんが「${event.venueName}」を候補に追加しました`,
      };
  }
}

/** Events that should also trigger a router.refresh — i.e. where the
 *  data the user is currently looking at probably needs to redraw.
 *  Decision / wedding-date are global enough to refresh always; rating
 *  + note refresh too because the venue + visit pages display the
 *  affected rows directly. venue_deleted refreshes because the partner
 *  might be reading the very page that just got soft-deleted. */
function shouldRefresh(event: RealtimeEvent): boolean {
  switch (event.kind) {
    case "rating_saved":
    case "note_added":
    case "decision_made":
    case "wedding_date_updated":
    case "venue_deleted":
    case "venue_added":
      return true;
  }
}

export function useRealtimeProject({
  projectId,
  viewerUserId,
}: UseRealtimeProjectOptions): void {
  const router = useRouter();
  // Holds the last seen timestamp per dedup key so burst events
  // collapse without setState (which would re-render and tear down
  // the channel). Using a ref keeps the dedup table out of React's
  // reconciliation entirely.
  const lastSeenRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!projectId || !viewerUserId) return;

    const supabase = createClient();
    const channel = supabase.channel(projectChannelName(projectId), {
      config: { broadcast: { self: false, ack: false } },
    });

    channel
      .on("broadcast", { event: REALTIME_EVENT }, (raw) => {
        // Supabase wraps the published payload one level deep:
        // { type, event, payload: <our RealtimeEvent> }. The callback
        // signature is loosely typed as { [k]: unknown } so we narrow
        // ourselves; runtime guards below cover any malformed message
        // (a v3 client sending the old shape, etc.).
        const event = (raw as { payload?: RealtimeEvent }).payload;
        if (!event || !event.kind || !event.actor) return;

          // Self-action filter — the publisher already sets
          // broadcast.self = false, but we double-guard the client
          // because supabase has historically had bugs where self
          // delivery leaked through during reconnects.
          if (event.actor.userId === viewerUserId) return;

          // Dedup
          const key = dedupKey(event);
          const now = Date.now();
          const last = lastSeenRef.current.get(key) ?? 0;
          if (now - last < DEDUP_WINDOW_MS) return;
          lastSeenRef.current.set(key, now);

          const { kind, msg } = toastCopy(event);
          showToast(kind, msg);

          if (shouldRefresh(event)) {
            // Defer one tick — sonner mounts the toast in this same
            // microtask, and router.refresh in older Next builds has
            // shown a tendency to interrupt animation frames if
            // started in the same tick. The 0ms timeout keeps both
            // observable but well-ordered.
            setTimeout(() => {
              router.refresh();
            }, 0);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, viewerUserId, router]);
}
