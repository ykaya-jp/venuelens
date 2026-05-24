"use server";

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "@/server/db";
import { requireUser, requireOwner } from "@/server/auth";
import { revalidatePath } from "next/cache";
import { GUEST_COOKIE_NAME } from "@/lib/guest-session";

/**
 * Is the given project a throw-away auto-created project for `userId`?
 *
 * Mirrors `isAutoCreatedEmptyProject` in `invitations.ts` (the email-based
 * accept flow). We duplicate rather than cross-import to avoid pulling the
 * email code path into the link consume path and to keep both gates
 * independently auditable — any drift between them is a security bug and
 * should be caught in review. See design doc F4 §4.5: without this guard,
 * a partner who had previously self-signed-up on Haretoki (and now sits on
 * an auto-created empty project) is silently blocked from joining their
 * owner's project via a link.
 *
 * Rules (all must hold): sole owner, no venues/estimates/decisions, only
 * that owner as a member.
 */
async function isAutoCreatedEmptyProject(
  projectId: string,
  userId: string,
  role: string,
): Promise<boolean> {
  if (role !== "owner") return false;

  const [memberCount, venueCount, estimateCount, decisionCount] =
    await Promise.all([
      prisma.projectMember.count({ where: { projectId } }),
      prisma.venue.count({ where: { projectId, deletedAt: null } }),
      prisma.estimate.count({
        where: { venue: { projectId, deletedAt: null } },
      }),
      prisma.decision.count({ where: { projectId } }),
    ]);

  const singleOwnerMembership = await prisma.projectMember.findMany({
    where: { projectId },
    select: { userId: true, role: true },
  });
  const isSoleOwner =
    singleOwnerMembership.length === 1 &&
    singleOwnerMembership[0].userId === userId &&
    singleOwnerMembership[0].role === "owner";

  return (
    isSoleOwner &&
    memberCount === 1 &&
    venueCount === 0 &&
    estimateCount === 0 &&
    decisionCount === 0
  );
}

const TOKEN_BYTES = 32; // → 64 hex chars
const DEFAULT_EXPIRY_DAYS = 7;

export interface InvitationLink {
  url: string;
  token: string;
  expiresAt: string; // ISO
  // F4: progression state surfaced on /mypage/invite 4-dot timeline.
  // `lastViewedAt` fills when the partner opens the guest view; `joined`
  // becomes true once they signup + consume.
  lastViewedAt?: string | null; // ISO
  viewCount?: number;
  joined?: boolean;
  /** ISO timestamp when the partner consumed the invitation (i.e. joined). */
  joinedAt?: string | null; // ISO
  createdAt?: string; // ISO
}

/**
 * Owner: create a one-tap invitation link. 7 日有効、1 回限り。
 * Re-calling replaces any existing (un-consumed) link for the same project
 * to keep things tidy — only one live link at a time.
 */
/**
 * Owner: create a one-tap invitation link. 7 日有効、1 回限り。
 *
 * Audit P0-1: optional `invitedEmail` binds the token to a specific
 * recipient. When set, `consumeInvitationLink` requires the caller's
 * Supabase Auth email to match (case-insensitive) — a leaked URL alone
 * is no longer enough to join. Pass `undefined` for the legacy "shareable
 * link" semantics; existing rows with NULL `invitedEmail` behave the
 * same way until they expire.
 */
export async function createInvitationLink(
  invitedEmail?: string,
): Promise<InvitationLink> {
  const user = await requireUser();
  const { projectId } = await requireOwner(user.id);

  const normalizedEmail = invitedEmail
    ? invitedEmail.trim().toLowerCase() || null
    : null;
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("メールアドレスの形式が正しくありません");
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(
    Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );

  // Invalidate any prior unconsumed link for this project.
  await prisma.projectInvitation.updateMany({
    where: { projectId, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() },
  });

  await prisma.projectInvitation.create({
    data: {
      projectId,
      token,
      createdBy: user.id,
      expiresAt,
      invitedEmail: normalizedEmail,
    },
  });

  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://haretoki.vercel.app";
  return {
    url: `${base}/invite/${token}`,
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Partner tapping /invite/[token]. Consumes the token and joins the project.
 * Safe to call multiple times (idempotent) — already-consumed-by-you returns
 * success; already-consumed-by-somebody-else returns "stale".
 */
export async function consumeInvitationLink(token: string): Promise<
  | {
      ok: true;
      projectId: string;
      /** W20-4: how many auto-created empty projects we discarded as part of
       *  this consume. The UI uses this to surface a "以前の空の式場さがしを
       *  整理しました" toast on /home so the partner isn't surprised that
       *  their throw-away project disappeared during the merge. 0 in the
       *  steady state; almost always 1 when the partner had previously
       *  signed up before tapping the link. Capped only by however many
       *  empty projects they collected — non-empty projects abort consume
       *  with `already_joined` instead, so they never get counted here. */
      discardedProjectCount: number;
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "stale"
        | "self"
        | "already_joined"
        | "wrong_recipient";
    }
> {
  const user = await requireUser();

  const invitation = await prisma.projectInvitation.findUnique({
    where: { token },
  });
  if (!invitation) return { ok: false, reason: "invalid" };

  if (invitation.consumedAt && invitation.consumedBy !== user.id) {
    return { ok: false, reason: "stale" };
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (invitation.createdBy === user.id) {
    // Owner shouldn't self-consume.
    return { ok: false, reason: "self" };
  }

  // Audit P0-1: when the invitation was created with a bound recipient
  // email, only that email can consume it. Closes the URL-leak hijack
  // vector — pasting the link into a chat no longer gives the wrong
  // Google account access to the couple's full data. Null
  // `invitedEmail` (legacy rows pre-2026-05-24) falls through unchecked
  // for backwards compatibility; those rows expire within 30 days.
  if (invitation.invitedEmail) {
    const callerEmail = user.email?.toLowerCase().trim();
    if (!callerEmail || callerEmail !== invitation.invitedEmail.toLowerCase()) {
      return { ok: false, reason: "wrong_recipient" };
    }
  }

  // F4 guard (mirrors acceptInvitation): if the partner already sits on
  // another project as a full member, we must not silently take them out
  // of it. Auto-created empty projects are safe to discard (they're a
  // side-effect of getOrCreateProject on first /home visit). Projects
  // with real data require a human decision → return "already_joined" so
  // the UI can explain.
  const existingMemberships = await prisma.projectMember.findMany({
    where: {
      userId: user.id,
      acceptedAt: { not: null },
      NOT: { projectId: invitation.projectId },
    },
    select: { id: true, projectId: true, role: true },
  });

  // Each isAutoCreatedEmptyProject call is itself 5 queries against a
  // distinct projectId, so the per-membership probes are independent —
  // batch them. Steady state is N=0 or 1, but a partner who somehow
  // collected multiple auto-projects gets the same fan-out cost as a
  // single one.
  const discardability = await Promise.all(
    existingMemberships.map((m) =>
      isAutoCreatedEmptyProject(m.projectId, user.id, m.role).then(
        (canAutoDiscard) => ({ existing: m, canAutoDiscard }),
      ),
    ),
  );
  if (discardability.some((d) => !d.canAutoDiscard)) {
    return { ok: false, reason: "already_joined" };
  }
  const discardable = discardability.map((d) => d.existing);

  // Owner memberships trigger project deletion (cascades to venues etc.),
  // non-owner memberships are just the row. Done outside the consume
  // transaction because Prisma doesn't support nested transactions in
  // the adapter path we use. Deletes target distinct rows — Promise.all
  // keeps them independent and saves N round-trips when more than one
  // exists.
  await Promise.all(
    discardable.map((existing) =>
      existing.role === "owner"
        ? prisma.project.delete({ where: { id: existing.projectId } })
        : prisma.projectMember.delete({ where: { id: existing.id } }),
    ),
  );

  // Consume + upsert ProjectMember in a single transaction
  await prisma.$transaction(async (tx) => {
    await tx.projectInvitation.update({
      where: { token },
      data: { consumedAt: new Date(), consumedBy: user.id },
    });
    await tx.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId: invitation.projectId,
          userId: user.id,
        },
      },
      create: {
        projectId: invitation.projectId,
        userId: user.id,
        role: "partner",
        acceptedAt: new Date(),
      },
      update: { acceptedAt: new Date() },
    });
  });

  // Clean up the Level 1 guest cookie now that the partner has joined.
  // Server Actions run in the 'action' phase, so cookies().delete() is safe.
  const cookieStore = await cookies();
  cookieStore.delete(GUEST_COOKIE_NAME);

  revalidatePath("/home");
  revalidatePath("/mypage");
  return {
    ok: true,
    projectId: invitation.projectId,
    discardedProjectCount: discardable.length,
  };
}

/**
 * F4: record a guest view against an invitation. Called from the
 * `/invite/[token]/(guest)` route when a freshly-signed guest cookie
 * becomes active. Idempotent per session — the caller only invokes us
 * on the first request in a session (screenCount === 1 after bump).
 *
 * Writes:
 *   - lastViewedAt = now()
 *   - viewCount    = viewCount + 1
 *
 * Never throws — silent failures just mean "owner sees one-fewer view"
 * which is preferable to breaking the guest landing.
 */
export async function recordGuestInvitationView(token: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  try {
    await prisma.projectInvitation.update({
      where: { token },
      data: {
        lastViewedAt: new Date(),
        viewCount: { increment: 1 },
      },
    });
  } catch (err) {
    // swallow — guest observation is best-effort
    console.warn("recordGuestInvitationView failed", err);
  }
}

/**
 * Fetch the current live link for the owner's project (if any).
 */
export async function getCurrentInvitationLink(): Promise<InvitationLink | null> {
  const user = await requireUser();
  const { projectId } = await requireOwner(user.id);

  // F4: also surface a just-consumed link for 24h so the owner sees the
  // "合流しました" dot on /mypage/invite. `joined=true` swaps the UI into
  // a completed state (no regeneration button).
  const invitation = await prisma.projectInvitation.findFirst({
    where: {
      projectId,
      OR: [
        { consumedAt: null, expiresAt: { gt: new Date() } },
        {
          consumedAt: {
            gt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!invitation) return null;

  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://haretoki.vercel.app";
  return {
    url: `${base}/invite/${invitation.token}`,
    token: invitation.token,
    expiresAt: invitation.expiresAt.toISOString(),
    lastViewedAt: invitation.lastViewedAt?.toISOString() ?? null,
    viewCount: invitation.viewCount ?? 0,
    joined: invitation.consumedAt !== null,
    joinedAt: invitation.consumedAt?.toISOString() ?? null,
    createdAt: invitation.createdAt.toISOString(),
  };
}
