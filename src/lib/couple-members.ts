/**
 * Audit P1-25: viewer-aware "couple members" fetch helper.
 *
 * `getCoupleRatings` (ratings.ts) and `getCoupleChecklistAnswers`
 * (checklist-ratings.ts) both ran the same `prisma.projectMember
 * .findMany({ where: { projectId, acceptedAt: { not: null } } })`
 * with the same viewer-vs-other split logic. Two copies of the same
 * three queries drifted: getCoupleRatings selected `id` on user,
 * getCoupleChecklistAnswers didn't. This module is the single shape.
 */

import { prisma } from "@/server/db";

/** Member shape returned by `getCoupleMembers`. `name` and `email`
 *  carry through unchanged from `User` — the consumer picks whichever
 *  is best for its display (rating-section uses `name ?? email`). */
export interface CoupleMember {
  userId: string;
  name: string | null;
  email: string | null;
}

/**
 * Pull both project members (viewer + the other one) in a single
 * round trip. Returns null for either side that doesn't exist:
 *
 *   - `viewer === null` when the auth helpers somehow let a non-member
 *     reach the caller (this should not happen because the call sites
 *     gate on requireProjectMembership; null is the safer contract).
 *   - `other === null` when the project has no accepted partner yet
 *     (solo project, invitation still pending).
 *
 * `accepted_at IS NOT NULL` filter mirrors what both callers used
 * before; a pending invitee whose Supabase identity may never resolve
 * shouldn't surface as a couple member.
 */
export async function getCoupleMembers(
  projectId: string,
  viewerUserId: string,
): Promise<{
  viewer: CoupleMember | null;
  other: CoupleMember | null;
}> {
  const members = await prisma.projectMember.findMany({
    where: { projectId, acceptedAt: { not: null } },
    select: {
      userId: true,
      user: { select: { name: true, email: true } },
    },
  });
  const toMember = (m: (typeof members)[number]): CoupleMember => ({
    userId: m.userId,
    name: m.user?.name ?? null,
    email: m.user?.email ?? null,
  });
  const viewerRow = members.find((m) => m.userId === viewerUserId);
  const otherRow = members.find((m) => m.userId !== viewerUserId);
  return {
    viewer: viewerRow ? toMember(viewerRow) : null,
    other: otherRow ? toMember(otherRow) : null,
  };
}
