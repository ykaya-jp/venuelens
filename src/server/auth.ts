/**
 * Auth & permission helpers — central definition of "who can do what".
 *
 * # Permission policy (W18-3 documentation)
 *
 * Two categories of data live under a Project; each enforces a different
 * boundary. Server actions across this codebase already follow these
 * rules consistently — this comment is the canonical reference.
 *
 * ## Shared data — both members can read AND mutate
 *   Venue, Estimate, EstimateItem, VenuePlan, Visit, VenueChecklistItem,
 *   AiAnalysis, ProjectMember (read), CoachSession.
 *
 * Either owner or partner can edit; cascade-delete via deleteVenue is
 * intentionally allowed for both, with a UI confirm dialog as the actual
 * guardrail (venue-overflow-menu.tsx). For Phase 1 (夫婦 2 人運用) this
 * matches expectations — both decided to add the venue, both can let go.
 *
 * Use {@link requireProjectMembership} (returns `{ projectId, role }`).
 *
 * ## Personal data — owned by `userId`, only the owner can write
 *   VenueFavorite, VisitRating, VisitNote, VisitNoteMedia (via VisitNote).
 *
 * Server actions hard-code `userId: user.id` on create/update/upsert,
 * so a partner physically cannot set the other's heart / score / memo.
 * No individual delete endpoints exist for these — the only path that
 * removes them is the venue cascade above (deleteMany scoped by venueId).
 *
 * Use {@link requireProjectMembership} to confirm the user belongs to
 * the project, then bind `userId: user.id` on the write itself.
 *
 * ## Owner-only operations
 *   Issuing / revoking partner invitations, project lifecycle (delete /
 *   transfer). These call {@link requireOwner}.
 *
 * Anything outside the three buckets above should be evaluated case by
 * case before adding a new server action — append it to this comment
 * once decided so future readers don't have to reverse-engineer the rule.
 */

import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/server/db";
import { redirect } from "next/navigation";
import { cache } from "react";

export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user;
});

export const requireProjectMembership = cache(async (userId: string) => {
  const membership = await prisma.projectMember.findFirst({
    where: { userId, acceptedAt: { not: null } },
    select: { projectId: true, role: true },
  });
  // No project yet — send them through onboarding instead of looping back
  // to /home (which would re-enter this function and infinite-redirect).
  if (!membership) redirect("/onboarding");
  return membership;
});

export async function requireOwner(userId: string) {
  const membership = await prisma.projectMember.findFirst({
    where: { userId, role: "owner", acceptedAt: { not: null } },
    select: { projectId: true },
  });
  if (!membership) throw new Error("はじめに登録した方のみ実行できます");
  return membership;
}

export async function requireVenueAccess(userId: string, venueId: string) {
  const { projectId } = await requireProjectMembership(userId);
  // `deletedAt: null` is mandatory per the schema comment on Venue
  // ("Every read path that surfaces venues to the user MUST filter by
  // deletedAt: null"). Before 2026-05-24 this helper used `findUnique`
  // without the filter, so a write racing against a soft-delete could
  // land on a tombstoned row and corrupt aggregators downstream.
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, projectId, deletedAt: null },
  });
  if (!venue) {
    throw new Error("式場が見つからないか、アクセス権がありません");
  }
  return { projectId, venue };
}

export async function requireVisitAccess(userId: string, visitId: string) {
  const { projectId } = await requireProjectMembership(userId);
  // Same deletedAt-on-venue rule as requireVenueAccess — a Visit whose
  // parent Venue was soft-deleted should be unreachable by writes.
  const visit = await prisma.visit.findFirst({
    where: {
      id: visitId,
      deletedAt: null,
      venue: { projectId, deletedAt: null },
    },
    include: { venue: { select: { projectId: true, id: true } } },
  });
  if (!visit) {
    throw new Error("見学記録が見つからないか、アクセス権がありません");
  }
  return { projectId, visit };
}
