import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P10 soft-merge contract — toggleFavorite keeps venue.status in sync
 * with heart state, but only for safe transitions. Lifecycle states
 * (visited / selected / rejected) must NOT be silently overwritten by
 * a stray heart tap, or the user's decision history gets lost.
 *
 * Transition matrix (pinned here so regressions can't sneak in):
 *
 *                 | heart ON         | heart OFF
 *   researching   | → shortlisted    | (no change)
 *   visit_scheduled | → shortlisted  | (no change)
 *   shortlisted   | (no change)      | → researching
 *   visited       | (no change)      | (no change)
 *   selected      | (no change)      | (no change)
 *   rejected      | (no change)      | (no change)
 */

const findUniqueFavoriteMock = vi.fn();
const deleteFavoriteMock = vi.fn();
const createFavoriteMock = vi.fn();
const updateVenueMock = vi.fn();
// Count reflects remaining favorites after toggle; tests override as needed.
// Default 0 means "no other members still favorite this venue" → the
// shortlisted → researching demotion is allowed to proceed.
const countFavoritesMock = vi.fn(async () => 0);
const transactionMock = vi.fn(
  async (cb: (tx: unknown) => Promise<unknown>) => {
    // Our transactional closure uses venueFavorite + venue on tx. The
    // new partner-aware demotion path also calls venueFavorite.count.
    return await cb({
      venueFavorite: {
        delete: deleteFavoriteMock,
        create: createFavoriteMock,
        count: countFavoritesMock,
      },
      venue: {
        update: updateVenueMock,
      },
    });
  },
);

type VenueStatus =
  | "researching"
  | "visit_scheduled"
  | "visited"
  | "shortlisted"
  | "selected"
  | "rejected";

const venueRow: { id: string; projectId: string; status: VenueStatus } = {
  id: "venue-1",
  projectId: "proj-1",
  status: "researching",
};

vi.mock("@/server/db", () => ({
  prisma: {
    venueFavorite: {
      findUnique: (...args: unknown[]) => findUniqueFavoriteMock(...args),
    },
    venue: {
      findUnique: vi.fn(async () => venueRow),
    },
    projectMember: {
      findFirst: vi.fn(async () => ({ projectId: "proj-1", role: "owner" })),
    },
    // 2026-05-24: toggleFavorite now performs a defensive `public.users`
    // upsert before the favorite write so a partner whose auth.users row
    // never synced to public.users does not hit P2003. The unit-mock
    // just no-ops so the suite still focuses on status-sync behaviour.
    user: {
      upsert: vi.fn(async () => ({ id: "user-1" })),
    },
    $transaction: (cb: (tx: unknown) => Promise<void>) => transactionMock(cb),
  },
}));

vi.mock("@/server/auth", async () => ({
  requireUser: vi.fn(async () => ({
    id: "user-1",
    email: "user-1@example.com",
    user_metadata: { name: "Test User" },
  })),
  requireProjectMembership: vi.fn(async () => ({
    projectId: "proj-1",
    role: "owner",
  })),
  requireVenueAccess: vi.fn(async () => ({ projectId: "proj-1", venue: venueRow })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  cacheTag: vi.fn(),
}));

describe("toggleFavorite — heart ↔ status sync", () => {
  beforeEach(() => {
    findUniqueFavoriteMock.mockReset();
    deleteFavoriteMock.mockReset();
    createFavoriteMock.mockReset();
    updateVenueMock.mockReset();
    transactionMock.mockClear();
  });

  describe("heart ON (no existing favorite)", () => {
    beforeEach(() => {
      findUniqueFavoriteMock.mockResolvedValue(null);
    });

    it.each([
      ["researching", "shortlisted"],
      ["visit_scheduled", "shortlisted"],
    ] as const)(
      "promotes %s → %s",
      async (currentStatus, expectedStatus) => {
        venueRow.status = currentStatus;
        const { toggleFavorite } = await import("@/server/actions/favorites");
        const result = await toggleFavorite("venue-1");

        expect(result).toEqual({ isFavorite: true });
        expect(createFavoriteMock).toHaveBeenCalledOnce();
        expect(updateVenueMock).toHaveBeenCalledWith({
          where: { id: "venue-1" },
          data: { status: expectedStatus },
        });
      },
    );

    it.each(["shortlisted", "visited", "selected", "rejected"] as const)(
      "leaves status untouched when current is %s",
      async (currentStatus) => {
        venueRow.status = currentStatus;
        const { toggleFavorite } = await import("@/server/actions/favorites");
        await toggleFavorite("venue-1");

        expect(createFavoriteMock).toHaveBeenCalledOnce();
        expect(updateVenueMock).not.toHaveBeenCalled();
      },
    );
  });

  describe("heart OFF (existing favorite)", () => {
    beforeEach(() => {
      findUniqueFavoriteMock.mockResolvedValue({ id: "fav-1" });
    });

    it("demotes shortlisted → researching", async () => {
      venueRow.status = "shortlisted";
      const { toggleFavorite } = await import("@/server/actions/favorites");
      const result = await toggleFavorite("venue-1");

      expect(result).toEqual({ isFavorite: false });
      expect(deleteFavoriteMock).toHaveBeenCalledOnce();
      expect(updateVenueMock).toHaveBeenCalledWith({
        where: { id: "venue-1" },
        data: { status: "researching" },
      });
    });

    it.each([
      "researching",
      "visit_scheduled",
      "visited",
      "selected",
      "rejected",
    ] as const)(
      "leaves status untouched when current is %s",
      async (currentStatus) => {
        venueRow.status = currentStatus;
        const { toggleFavorite } = await import("@/server/actions/favorites");
        await toggleFavorite("venue-1");

        expect(deleteFavoriteMock).toHaveBeenCalledOnce();
        expect(updateVenueMock).not.toHaveBeenCalled();
      },
    );
  });
});
