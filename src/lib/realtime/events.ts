/**
 * Phase 3 Level 3 wave 1 — Supabase Realtime broadcast event vocabulary.
 *
 * The existing `useRealtimeSync` hook in `src/lib/supabase/realtime.ts`
 * already wires Postgres Changes (CDC) → router.refresh(), which keeps
 * the UI eventually-consistent with the DB. This module is the
 * COMPLEMENT of that: a thin Supabase Broadcast layer that carries
 * SEMANTIC events (kind + actor + scope) instead of raw row diffs.
 *
 * Why both layers?
 *   - CDC tells you "something changed" but loses the actor and the
 *     business intent (rating-saved vs note-added vs decision-made
 *     all collapse into row UPDATEs on different tables).
 *   - Broadcast carries `actorUserId` + `actorName` + `kind`, which
 *     is what the UI needs to render "{partner name}が評価しました"
 *     toasts and to suppress own-actions from triggering self-toasts.
 *   - CDC is automatic (any DB write fires it); broadcast is OPT-IN
 *     from the server action, so we publish only the events the
 *     couple genuinely cares about (skipping noisy bookkeeping
 *     writes like AiCache rows or login session updates).
 *
 * Channel naming: `project:${projectId}` — RLS for the broadcast
 * channel is enforced by Supabase's "Realtime Authorization" feature
 * (the channel is `private`, the broadcast policy joins
 * `project_members` to gate subscribe). For wave 1 we ship with
 * authorization mode `broadcast: { self: false }` and rely on the
 * obscurity of the project UUID until the SQL-side policy lands in
 * a follow-up migration. Documented as a known limitation in the
 * L3 design doc.
 */

/** Channel name for project-scoped realtime broadcasts. */
export function projectChannelName(projectId: string): string {
  return `project:${projectId}`;
}

/** The single broadcast `event` name we use for every kind of payload —
 *  a discriminated union inside `payload.kind` keeps subscribers
 *  filtering server-side off Supabase's index without us defining
 *  N separate event names. */
export const REALTIME_EVENT = "haretoki:event" as const;

/** Identifying the actor lets the client suppress own-action toasts.
 *  `actorName` falls back to email or a generic placeholder server-side
 *  before publish, so the client never has to render `null`. */
export interface RealtimeActor {
  userId: string;
  name: string;
}

/** Discriminated union of every semantic event we broadcast.
 *
 *  Adding a new kind:
 *    1. Extend the union here.
 *    2. Update `publishRealtimeEvent` consumers (server actions) to
 *       call publish on the new event.
 *    3. Add a case in `useRealtimeProject` to render the right toast
 *       + decide whether to call router.refresh().
 *
 *  Renaming a kind: requires a migration window because in-flight
 *  subscribers may receive the old name from older server instances
 *  during a deploy. Add the new kind, dual-publish for one rollout,
 *  then remove the old.
 */
export type RealtimeEvent =
  | {
      kind: "rating_saved";
      actor: RealtimeActor;
      venueId: string;
      /** Number of dimensions touched in this save (>= 1). The toast
       *  copy stays the same regardless ("評価しました"); the count is
       *  carried so future analytics can reconstruct burst saves. */
      dimensionCount: number;
    }
  | {
      kind: "note_added";
      actor: RealtimeActor;
      venueId: string;
      visitId: string;
    }
  | {
      kind: "decision_made";
      actor: RealtimeActor;
      venueId: string;
    }
  | {
      kind: "wedding_date_updated";
      actor: RealtimeActor;
      /** ISO date (YYYY-MM-DD) or null when the date was cleared. The
       *  client decides on the toast copy split. */
      weddingDate: string | null;
    }
  | {
      kind: "venue_deleted";
      actor: RealtimeActor;
      venueId: string;
      /** Venue name at the time of deletion. Carried in-band so the
       *  partner's toast can name the venue ("Aホテルを手放しました") even
       *  though by the time the event lands the row is already
       *  soft-deleted and `getVenueHeader` would return null. */
      venueName: string;
    }
  | {
      kind: "venue_added";
      actor: RealtimeActor;
      venueId: string;
      /** Venue name carried in-band — same shape as `venue_deleted` —
       *  so the partner toast can name it without an extra fetch and
       *  the Web Push body picker can interpolate {venueName}. */
      venueName: string;
    };

/** The `kind` discriminant exported as a value so consumers can
 *  exhaustively switch in tests and admin tooling without typing the
 *  string literals by hand. */
export const REALTIME_EVENT_KINDS = [
  "rating_saved",
  "note_added",
  "decision_made",
  "wedding_date_updated",
  "venue_deleted",
  "venue_added",
] as const satisfies ReadonlyArray<RealtimeEvent["kind"]>;

export type RealtimeEventKind = RealtimeEvent["kind"];
