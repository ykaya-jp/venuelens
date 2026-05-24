"use server";

import { prisma } from "@/server/db";
import { revalidatePath, revalidateTag } from "next/cache";
import { cacheTag } from "next/cache";
import { requireUser, requireProjectMembership, requireVenueAccess } from "@/server/auth";
import type { VenueStatus } from "@/generated/prisma/client";

/**
 * Toggle the heart on a venue AND keep venue.status in sync so the chip
 * row / card badges don't disagree with the heart state (P10 soft merge).
 *
 * Rules (chosen to not stomp on user-driven status edits):
 *   - heart on  + status is researching / visit_scheduled → bump to shortlisted
 *   - heart off + status is shortlisted                   → drop to researching
 *   - visited / selected / rejected are never touched by the heart, because
 *     those are lifecycle states the user reached on purpose and a stray
 *     heart tap should not silently reset them.
 */
const HEART_ON_PROMOTE_FROM: VenueStatus[] = ["researching", "visit_scheduled"];
const HEART_OFF_DEMOTE_FROM: VenueStatus[] = ["shortlisted"];

export async function toggleFavorite(venueId: string): Promise<{ isFavorite: boolean }> {
  try {
    return await toggleFavoriteImpl(venueId);
  } catch (e) {
    if (
      e instanceof Error &&
      typeof (e as { digest?: unknown }).digest === "string" &&
      (e as unknown as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw e;
    }
    // Verbose log for Vercel runtime logs — debugging "ハートを押しても何も
    // 起きない" (`incident report 2026-05-24`) where the server side throws
    // silently and the client toast.error fires too briefly to notice.
    console.error("[toggleFavorite] failed", {
      venueId,
      error:
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack, code: (e as { code?: unknown }).code }
          : { message: String(e) },
    });
    throw e;
  }
}

async function toggleFavoriteImpl(venueId: string): Promise<{ isFavorite: boolean }> {
  const user = await requireUser();
  const { venue } = await requireVenueAccess(user.id, venueId);
  const { projectId } = await requireProjectMembership(user.id);

  // Mirror checklist-ratings.ts: ensure the auth.users row has a matching
  // public.users row so `venue_favorites.user_id` FK can land. A partner
  // invited via ProjectInvitation can land here without ever having had
  // public.users seeded — without this defensive upsert the heart tap
  // throws P2003 silently (toast.error fires for 2 s and the visible
  // state never updates).
  const fallbackEmail = user.email ?? `${user.id}@unknown.local`;
  const fallbackName =
    (user.user_metadata?.name as string | undefined) ??
    (user.user_metadata?.full_name as string | undefined) ??
    null;
  await prisma.user.upsert({
    where: { id: user.id },
    create: { id: user.id, email: fallbackEmail, name: fallbackName },
    update: {},
  });

  const existing = await prisma.venueFavorite.findUnique({
    where: { venueId_userId: { venueId, userId: user.id } },
  });

  const nextFavorite = !existing;

  // Status transition — bounded to the safe cases above. For everything
  // else we leave status alone so e.g. a "rejected" venue stays rejected
  // even if the user toggles the heart. Partner-aware: heart-off only
  // demotes to researching when the OTHER project member also doesn't
  // favorite the venue. Otherwise owner removing their heart would
  // silently drop the venue out of partner's "candidates" chip even
  // though partner still loves it. Computed inside the tx after the
  // toggle so the count is post-change.
  // Serializable isolation: the heart-off → status-demote branch reads
  // `venueFavorite.count` to decide whether the project as a whole still
  // loves this venue. Under READ COMMITTED, a concurrent partner heart-on
  // committing on a separate connection is invisible, so a demote can fire
  // even though the partner just favorited — leaving "favorite=true but
  // status=researching" inconsistent. Serializable serialises the count
  // against any conflicting heart write, with Postgres retrying the
  // loser; Prisma surfaces SerializationError which the outer try/catch
  // already normalises into `{ isFavorite: previous, error }` for the
  // client.
  const statusUpdate = await prisma.$transaction(
    async (tx): Promise<VenueStatus | null> => {
      if (existing) {
        await tx.venueFavorite.delete({ where: { id: existing.id } });
      } else {
        await tx.venueFavorite.create({
          data: { venueId, userId: user.id },
        });
      }

      if (nextFavorite && HEART_ON_PROMOTE_FROM.includes(venue.status)) {
        await tx.venue.update({
          where: { id: venueId },
          data: { status: "shortlisted" },
        });
        return "shortlisted";
      }
      if (!nextFavorite && HEART_OFF_DEMOTE_FROM.includes(venue.status)) {
        // Only demote when zero members favorite the venue now. If
        // partner still has a heart on it, the "shortlisted" signal
        // is still legitimate project-wide.
        const remaining = await tx.venueFavorite.count({
          where: { venueId },
        });
        if (remaining === 0) {
          await tx.venue.update({
            where: { id: venueId },
            data: { status: "researching" },
          });
          return "researching";
        }
      }
      return null;
    },
    { isolationLevel: "Serializable" },
  );

  revalidateTag(`project:${projectId}`, { expire: 0 });
  if (statusUpdate) {
    revalidatePath("/explore");
    revalidatePath("/candidates");
    revalidatePath(`/venues/${venueId}`);
  }

  return { isFavorite: nextFavorite };
}

type FavoriteFilter = "mine" | "partner" | "both";

interface FavoriteVenue {
  venue: {
    id: string;
    name: string;
    location: string | null;
    photoUrls: string[];
    status: VenueStatus;
    ceremonyStyles: string[];
    dressBringIn: string | null;
    costMin: number | null;
    costMax: number | null;
    capacityMin: number | null;
    capacityMax: number | null;
    scores: Array<{ dimension: string; score: number; source: string }>;
  };
  favoritedBy: string[];
}

/** Cached inner loader. Keyed on (projectId, userId, filter). */
async function fetchFavorites(
  projectId: string,
  userId: string,
  filter: FavoriteFilter,
): Promise<FavoriteVenue[]> {
  "use cache";
  cacheTag(`project:${projectId}`);

  // Get all project members
  const members = await prisma.projectMember.findMany({
    where: { projectId, acceptedAt: { not: null } },
    select: { userId: true },
  });

  const memberIds = members.map((m) => m.userId);
  const partnerId = memberIds.find((id) => id !== userId);

  let userFilter: string[];
  switch (filter) {
    case "mine":
      userFilter = [userId];
      break;
    case "partner":
      userFilter = partnerId ? [partnerId] : [];
      break;
    case "both":
      userFilter = memberIds;
      break;
  }

  if (userFilter.length === 0) return [];

  // Get favorites with venue data
  const favorites = await prisma.venueFavorite.findMany({
    where: {
      userId: { in: userFilter },
      // Venue uses soft-delete (deletedAt). VenueFavorite has onDelete:
      // Cascade at the FK level, but cascade only fires on physical
      // DELETE — soft-deleted Venues leave their favorites rows behind.
      // Filter them out so the candidates page stops surfacing 式場
      // that the user just removed from /explore.
      venue: { projectId, deletedAt: null },
    },
    include: {
      venue: {
        include: {
          // Include all sources so computeCompositeScore can weight them
          scores: {
            select: { dimension: true, score: true, source: true },
          },
        },
      },
    },
  });

  // Group by venue
  const venueMap = new Map<string, FavoriteVenue>();
  for (const fav of favorites) {
    const existing = venueMap.get(fav.venueId);
    if (existing) {
      existing.favoritedBy.push(fav.userId);
    } else {
      venueMap.set(fav.venueId, {
        venue: {
          id: fav.venue.id,
          name: fav.venue.name,
          location: fav.venue.location,
          photoUrls: fav.venue.photoUrls,
          status: fav.venue.status,
          ceremonyStyles: fav.venue.ceremonyStyles ?? [],
          dressBringIn: fav.venue.dressBringIn ?? null,
          costMin: fav.venue.costMin ?? null,
          costMax: fav.venue.costMax ?? null,
          capacityMin: fav.venue.capacityMin ?? null,
          capacityMax: fav.venue.capacityMax ?? null,
          scores: fav.venue.scores.map((s) => ({
            dimension: s.dimension,
            score: Number(s.score),
            source: s.source,
          })),
        },
        favoritedBy: [fav.userId],
      });
    }
  }

  // For "both" filter, only include venues favorited by ALL members
  if (filter === "both" && memberIds.length > 1) {
    for (const [venueId, data] of venueMap) {
      if (data.favoritedBy.length < memberIds.length) {
        venueMap.delete(venueId);
      }
    }
  }

  return Array.from(venueMap.values());
}

export async function getFavorites(filter: FavoriteFilter = "mine"): Promise<FavoriteVenue[]> {
  const user = await requireUser();
  const { projectId } = await requireProjectMembership(user.id);
  return fetchFavorites(projectId, user.id, filter);
}
