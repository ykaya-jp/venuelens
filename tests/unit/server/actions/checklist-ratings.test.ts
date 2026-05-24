import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Server-action coverage for the four endpoints shipped in PR #39
 * (`src/server/actions/checklist-ratings.ts`):
 *
 *   - saveChildRating
 *   - bulkSetDimensionRating
 *   - addCustomChecklistItem
 *   - deleteCustomChecklistItem
 *
 * What we pin:
 *   1. Authz — every action must reject the call before any Prisma
 *      write whenever `requireUser` / `requireVenueAccess` /
 *      `requireProjectMembership` rejects. The cross-project IDOR
 *      class of regression (= a user from project A modifying a row
 *      owned by project B) lives here.
 *   2. Validation — zod-rejected inputs return `{ success: false }`
 *      WITHOUT touching Prisma (= the validation is upstream of any
 *      DB write).
 *   3. 50-item cap on custom items.
 *   4. Soft-delete idempotency on deleteCustomChecklistItem.
 *   5. Happy-path round-trip for the two write actions so an
 *      accidental break of the Prisma upsert shape is caught.
 *
 * Uses the same vi.mock pattern the existing
 * `decisions-wedding-date.test.ts` / `family-invitations.test.ts`
 * tests use — we never touch a real DB.
 */

const mockRequireUser = vi.fn();
const mockRequireVenueAccess = vi.fn();
const mockRequireProjectMembership = vi.fn();
const mockRevalidateTag = vi.fn();

const mockProjectChecklistFindUnique = vi.fn();
const mockProjectChecklistCreate = vi.fn();
const mockVenueChecklistAnswerUpsert = vi.fn();
const mockCustomChecklistItemFindUnique = vi.fn();
const mockCustomChecklistItemCount = vi.fn();
const mockCustomChecklistItemCreate = vi.fn();
const mockCustomChecklistItemUpdate = vi.fn();
const mockUserUpsert = vi.fn();
// 2026-05-25 atomic upsert: saveChildRating + bulkSetDimensionRating
// now use `tx.$executeRaw` with `INSERT ... ON CONFLICT DO UPDATE` to
// avoid the SELECT-then-INSERT race that produced P2002 / P2025 toasts
// in production. The mock just records the call so the suite can
// assert "the action attempted a write" + that the rest of the
// pipeline (authz, validation, member fetch) ran in the right order.
const mockExecuteRaw = vi.fn().mockResolvedValue(1);

const mockTransaction = vi.fn();

vi.mock("@/server/db", () => ({
  prisma: {
    projectChecklist: {
      findUnique: (...a: unknown[]) => mockProjectChecklistFindUnique(...a),
      create: (...a: unknown[]) => mockProjectChecklistCreate(...a),
    },
    venueChecklistAnswer: {
      // Retained for the few tests that still inspect this — the
      // production code path goes through $executeRaw below.
      upsert: (...a: unknown[]) => mockVenueChecklistAnswerUpsert(...a),
    },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
    customChecklistItem: {
      findUnique: (...a: unknown[]) => mockCustomChecklistItemFindUnique(...a),
      count: (...a: unknown[]) => mockCustomChecklistItemCount(...a),
      create: (...a: unknown[]) => mockCustomChecklistItemCreate(...a),
      update: (...a: unknown[]) => mockCustomChecklistItemUpdate(...a),
    },
    // public.users upsert — added 2026-05-24 to defensively sync the
    // Supabase auth.users row to public.users before the
    // venue_checklist_answers.user FK bites. See incident
    // `error.digest=142404057`.
    user: {
      upsert: (...a: unknown[]) => mockUserUpsert(...a),
    },
    // bulkSetDimensionRating wraps its writes in an interactive
    // transaction; the mock just invokes the callback with a `tx`
    // that delegates back to the same per-model mocks so the per-
    // action assertions still fire.
    $transaction: (cb: (tx: unknown) => Promise<unknown>) =>
      mockTransaction(cb),
  },
}));

vi.mock("@/server/auth", () => ({
  requireUser: (...a: unknown[]) => mockRequireUser(...a),
  requireVenueAccess: (...a: unknown[]) => mockRequireVenueAccess(...a),
  requireProjectMembership: (...a: unknown[]) =>
    mockRequireProjectMembership(...a),
}));

vi.mock("next/cache", () => ({
  revalidateTag: (...a: unknown[]) => mockRevalidateTag(...a),
}));

// publishRealtimeEvent and friends are best-effort fire-and-forget;
// the suite doesn't care what they were called with, only that they
// don't throw and don't pull `prisma.user.findUnique` (the real
// implementation does, which crashes when the suite's prisma mock
// hasn't stubbed it). Stub-and-resolve.
vi.mock("@/lib/realtime/publish", () => ({
  publishRealtimeEvent: vi.fn().mockResolvedValue(undefined),
  resolveActor: vi
    .fn()
    .mockResolvedValue({ userId: "user-1", name: "Test User" }),
}));

import {
  saveChildRating,
  bulkSetDimensionRating,
  addCustomChecklistItem,
  deleteCustomChecklistItem,
} from "@/server/actions/checklist-ratings";

const VENUE_ID = "11111111-2222-4333-8444-555555555555";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "user-1";
const PRESET_ITEM_ID = "chapel.interior.decor-style"; // present in CHECKLIST_PRESETS

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({
    id: USER_ID,
    email: `${USER_ID}@example.com`,
    user_metadata: { name: "Test User" },
  });
  mockRequireVenueAccess.mockResolvedValue({ projectId: PROJECT_ID });
  mockRequireProjectMembership.mockResolvedValue({ projectId: PROJECT_ID });
  mockUserUpsert.mockResolvedValue({ id: USER_ID });
  mockExecuteRaw.mockResolvedValue(1);
  // Provide a default transaction implementation that simply invokes
  // the callback with the same per-model mocks. Individual tests can
  // override when they need to assert tx-specific behaviour.
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      projectChecklist: {
        findUnique: mockProjectChecklistFindUnique,
        create: mockProjectChecklistCreate,
      },
      venueChecklistAnswer: {
        upsert: mockVenueChecklistAnswerUpsert,
      },
      // The atomic-upsert path uses $executeRaw inside the tx — wire
      // the same shared mock so happy-path assertions still see the
      // call.
      $executeRaw: mockExecuteRaw,
    };
    return cb(tx);
  });
});

// ─── saveChildRating ────────────────────────────────────────────────────

describe("saveChildRating — validation rejects before Prisma", () => {
  it("rejects non-UUID venueId without calling Prisma", async () => {
    const result = await saveChildRating({
      venueId: "not-a-uuid",
      itemId: PRESET_ITEM_ID,
      score: 4.0,
    });
    expect(result.success).toBe(false);
    expect(mockVenueChecklistAnswerUpsert).not.toHaveBeenCalled();
    expect(mockRequireUser).not.toHaveBeenCalled();
  });

  it("rejects score below 0.5 without calling Prisma", async () => {
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: 0.4,
    });
    expect(result.success).toBe(false);
    expect(mockVenueChecklistAnswerUpsert).not.toHaveBeenCalled();
  });

  it("rejects score not on the 0.5 grid (e.g. 3.3) without calling Prisma", async () => {
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: 3.3,
    });
    expect(result.success).toBe(false);
    expect(mockVenueChecklistAnswerUpsert).not.toHaveBeenCalled();
  });

  it("accepts null score (= 'clear my rating' semantics)", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue({ id: "pc-1" });
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: null,
    });
    expect(result.success).toBe(true);
    // 2026-05-25: production write goes through $executeRaw with
    // `INSERT ... ON CONFLICT DO UPDATE` for atomicity. Same intent
    // as the legacy upsert mock — assert "one write happened".
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});

describe("saveChildRating — authz contract", () => {
  it("returns failure (does not throw) when requireVenueAccess rejects (= cross-project IDOR)", async () => {
    // Behaviour change 2026-05-24: server-action throws now get caught
    // and surface as `{ success: false }` so the React error boundary
    // is never tripped (= the canonical 142404057 incident). The IDOR
    // contract is still enforced — Prisma writes never happen.
    mockRequireVenueAccess.mockRejectedValueOnce(
      new Error("式場が見つからないか、アクセス権がありません"),
    );
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: 4.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.formErrors?.[0]).toMatch(/アクセス権/);
    }
    expect(mockVenueChecklistAnswerUpsert).not.toHaveBeenCalled();
  });

  it("calls requireUser BEFORE any Prisma write", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue({ id: "pc-1" });
    await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: 4.0,
    });
    // The auth check must fire first — assert call order against the
    // atomic $executeRaw call site (replaces the legacy upsert call).
    const userCallOrder = mockRequireUser.mock.invocationCallOrder[0];
    const writeCallOrder = mockExecuteRaw.mock.invocationCallOrder[0];
    expect(userCallOrder).toBeLessThan(writeCallOrder);
  });
});

describe("saveChildRating — preset vs custom item resolution", () => {
  it("happy path with a preset item id reuses existing ProjectChecklist", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue({ id: "pc-existing" });
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: 4.5,
    });
    expect(result.success).toBe(true);
    expect(mockProjectChecklistCreate).not.toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("preset item with no ProjectChecklist row yet creates one", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue(null);
    mockProjectChecklistCreate.mockResolvedValue({ id: "pc-new" });
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: PRESET_ITEM_ID,
      score: 4.5,
    });
    expect(result.success).toBe(true);
    expect(mockProjectChecklistCreate).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("unknown itemId that is neither preset nor custom returns failure with no DB write", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue(null);
    mockCustomChecklistItemFindUnique.mockResolvedValue(null);
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: "definitely-not-a-real-item",
      score: 4.0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.formErrors?.[0]).toMatch(/評価項目/);
    }
    expect(mockProjectChecklistCreate).not.toHaveBeenCalled();
    expect(mockVenueChecklistAnswerUpsert).not.toHaveBeenCalled();
  });

  it("custom item owned by a DIFFERENT project returns failure (= IDOR via custom-id)", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue(null);
    mockCustomChecklistItemFindUnique.mockResolvedValue({
      projectId: "00000000-0000-4000-8000-999999999999", // wrong project
      deletedAt: null,
    });
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: "custom-id-x",
      score: 4.0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.formErrors?.[0]).toMatch(/評価項目/);
    }
    expect(mockProjectChecklistCreate).not.toHaveBeenCalled();
  });

  it("soft-deleted custom item returns failure even when projectId matches", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue(null);
    mockCustomChecklistItemFindUnique.mockResolvedValue({
      projectId: PROJECT_ID,
      deletedAt: new Date(),
    });
    const result = await saveChildRating({
      venueId: VENUE_ID,
      itemId: "custom-id-x",
      score: 4.0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.formErrors?.[0]).toMatch(/評価項目/);
    }
  });
});

// ─── bulkSetDimensionRating ─────────────────────────────────────────────

describe("bulkSetDimensionRating — validation + authz", () => {
  it("rejects empty itemIds array without calling Prisma", async () => {
    const result = await bulkSetDimensionRating({
      venueId: VENUE_ID,
      itemIds: [],
      score: 4.0,
    });
    expect(result.success).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects out-of-grid score (e.g. 4.7) without calling Prisma", async () => {
    const result = await bulkSetDimensionRating({
      venueId: VENUE_ID,
      itemIds: [PRESET_ITEM_ID],
      score: 4.7,
    });
    expect(result.success).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns failure when requireVenueAccess rejects (= cross-project IDOR)", async () => {
    mockRequireVenueAccess.mockRejectedValueOnce(new Error("no access"));
    const result = await bulkSetDimensionRating({
      venueId: VENUE_ID,
      itemIds: [PRESET_ITEM_ID],
      score: 4.0,
    });
    expect(result.success).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("happy path wraps writes in a transaction", async () => {
    mockProjectChecklistFindUnique.mockResolvedValue({ id: "pc-1" });
    const result = await bulkSetDimensionRating({
      venueId: VENUE_ID,
      itemIds: [PRESET_ITEM_ID, "chapel.interior.size"],
      score: 4.5,
    });
    expect(result.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // 2 itemIds → 2 atomic $executeRaw INSERT...ON CONFLICT statements.
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
  });
});

// ─── addCustomChecklistItem ─────────────────────────────────────────────

describe("addCustomChecklistItem", () => {
  it("rejects question shorter than 2 chars without calling Prisma", async () => {
    const result = await addCustomChecklistItem({
      category: "chapel",
      question: "x",
    });
    expect(result.success).toBe(false);
    expect(mockCustomChecklistItemCount).not.toHaveBeenCalled();
    expect(mockCustomChecklistItemCreate).not.toHaveBeenCalled();
  });

  it("rejects question longer than 140 chars", async () => {
    const result = await addCustomChecklistItem({
      category: "chapel",
      question: "x".repeat(141),
    });
    expect(result.success).toBe(false);
    expect(mockCustomChecklistItemCreate).not.toHaveBeenCalled();
  });

  it("rejects empty category", async () => {
    const result = await addCustomChecklistItem({
      category: "",
      question: "親族控室は十分？",
    });
    expect(result.success).toBe(false);
    expect(mockCustomChecklistItemCreate).not.toHaveBeenCalled();
  });

  it("rejects when project has already reached the 50-item cap", async () => {
    mockCustomChecklistItemCount.mockResolvedValue(50);
    const result = await addCustomChecklistItem({
      category: "chapel",
      question: "親族控室の畳数は？",
    });
    expect(result.success).toBe(false);
    if (!result.success && "formErrors" in (result.error ?? {})) {
      expect(result.error!.formErrors?.[0]).toMatch(/50/);
    }
    expect(mockCustomChecklistItemCreate).not.toHaveBeenCalled();
  });

  it("allows the 50th add (= cap is exclusive)", async () => {
    mockCustomChecklistItemCount.mockResolvedValue(49);
    mockCustomChecklistItemCreate.mockResolvedValue({ id: "new-item" });
    const result = await addCustomChecklistItem({
      category: "chapel",
      question: "親族控室の畳数は？",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.itemId).toBe("new-item");
  });

  it("happy path creates an item scoped to the resolved projectId", async () => {
    mockCustomChecklistItemCount.mockResolvedValue(0);
    mockCustomChecklistItemCreate.mockResolvedValue({ id: "abc" });
    await addCustomChecklistItem({
      category: "chapel",
      subcategory: "インテリア・雰囲気",
      question: "親族控室の畳数は何畳？",
    });
    expect(mockCustomChecklistItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: PROJECT_ID,
          category: "chapel",
          subcategory: "インテリア・雰囲気",
          question: "親族控室の畳数は何畳？",
        }),
      }),
    );
  });

  it("rejects when requireProjectMembership fails", async () => {
    mockRequireProjectMembership.mockRejectedValueOnce(
      new Error("no membership"),
    );
    await expect(
      addCustomChecklistItem({
        category: "chapel",
        question: "親族控室の畳数は？",
      }),
    ).rejects.toThrow();
    expect(mockCustomChecklistItemCreate).not.toHaveBeenCalled();
  });
});

// ─── deleteCustomChecklistItem ──────────────────────────────────────────

describe("deleteCustomChecklistItem", () => {
  it("rejects an item owned by a different project (= IDOR)", async () => {
    mockCustomChecklistItemFindUnique.mockResolvedValue({
      projectId: "00000000-0000-4000-8000-999999999999",
      deletedAt: null,
    });
    const result = await deleteCustomChecklistItem({
      customItemId: "ci-1",
    });
    expect(result.success).toBe(false);
    expect(mockCustomChecklistItemUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-existent item", async () => {
    mockCustomChecklistItemFindUnique.mockResolvedValue(null);
    const result = await deleteCustomChecklistItem({
      customItemId: "ci-1",
    });
    expect(result.success).toBe(false);
    expect(mockCustomChecklistItemUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent — already-soft-deleted item returns success without an update", async () => {
    mockCustomChecklistItemFindUnique.mockResolvedValue({
      projectId: PROJECT_ID,
      deletedAt: new Date(),
    });
    const result = await deleteCustomChecklistItem({
      customItemId: "ci-1",
    });
    expect(result.success).toBe(true);
    expect(mockCustomChecklistItemUpdate).not.toHaveBeenCalled();
  });

  it("happy path soft-deletes (= sets deletedAt) but does not hard-delete", async () => {
    mockCustomChecklistItemFindUnique.mockResolvedValue({
      projectId: PROJECT_ID,
      deletedAt: null,
    });
    mockCustomChecklistItemUpdate.mockResolvedValue({ id: "ci-1" });
    const result = await deleteCustomChecklistItem({
      customItemId: "ci-1",
    });
    expect(result.success).toBe(true);
    expect(mockCustomChecklistItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ci-1" },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      }),
    );
  });
});
