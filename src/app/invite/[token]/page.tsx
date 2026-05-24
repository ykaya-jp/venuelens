import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import Link from "next/link";
import { cookies } from "next/headers";
import { CloudOff } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { consumeInvitationLink } from "@/server/actions/invitation-links";
import { prisma } from "@/server/db";
import {
  GUEST_COOKIE_NAME,
  verifyGuestSession,
} from "@/lib/guest-session";
import { SkyChip } from "@/components/home/sky-chip";

export const metadata: Metadata = {
  title: "おふたりからの招待",
  description:
    "おふたりのプロジェクトに招かれました。1 タップで合流できます。",
  // Same logic as /family/[token]: token URLs are per-recipient and
  // single-use; crawler indexing or social-share previews would burn
  // the consumption counter and leak the token in `og:url`.
  robots: { index: false, follow: false, nocache: true },
  openGraph: undefined,
  twitter: undefined,
};

/**
 * F4 1-tap invitation landing — D2 editorial refresh (DESIGN.md v4.2).
 *
 * Visual language:
 *   - Welcome: 朝のひかり wash (gold-warm tinted gradient) + SkyChip(break)
 *     + Shippori serif h1 + amber-tinted primary CTA — "曇り→晴れ間" の
 *     ブランドメタファーがここで初めて partner に届く
 *   - JoinConfirm / SwitchConfirm: 同じ editorial 言語、 トーンを微妙に
 *     落として「これから一緒に決める」 切替の重みを伝える
 *   - Invalid: 鈍色の SkyChip(cloudy) + muted-fg + 同じ vocabulary。
 *     "原因不明" は維持 (enumeration mitigation §2.6 — invalid と stale
 *     を同コピーで描画して token 存在判定をさせない)
 *
 * Logic flow (unchanged from F4 / Level 3):
 *   1. Authed + already-consumed (stale) → quietly redirect /home
 *   2. Authed + valid → consume + redirect /home?invited=1
 *   3. Authed + valid + !confirm=join → JoinConfirmCard
 *   4. Unauthed + invalid/expired/stale → InvalidCard
 *   5. Unauthed + valid + switch=1 → SwitchConfirmCard
 *   6. Unauthed + valid → WelcomeCard
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ confirm?: string; switch?: string }>;
}) {
  await connection();
  const { token } = await params;
  const { confirm, switch: switchParam } = await searchParams;

  // Validate token shape early — 64 hex chars.
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return <InvalidCard reason="invalid" />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Authed path ──────────────────────────────────────────────────
  if (user) {
    const peek = await prisma.projectInvitation.findUnique({
      where: { token },
      select: { consumedAt: true, consumedBy: true },
    });
    if (peek?.consumedAt && peek.consumedBy === user.id) {
      redirect("/home");
    }

    if (confirm !== "join") {
      const invitation = await prisma.projectInvitation.findUnique({
        where: { token },
        select: {
          expiresAt: true,
          consumedAt: true,
          creator: { select: { name: true, email: true } },
          project: { select: { name: true } },
        },
      });
      if (!invitation) return <InvalidCard reason="invalid" />;
      if (invitation.consumedAt) redirect("/home");
      if (invitation.expiresAt < new Date()) return <InvalidCard reason="expired" />;
      const inviterName =
        invitation.creator.name ??
        invitation.creator.email.split("@")[0] ??
        "パートナー";
      return <JoinConfirmCard token={token} inviterName={inviterName} />;
    }

    const result = await consumeInvitationLink(token);
    if (result.ok) {
      const params = new URLSearchParams({ invited: "1" });
      if (result.discardedProjectCount > 0) {
        params.set("discarded", String(result.discardedProjectCount));
      }
      redirect(`/home?${params.toString()}`);
    }
    if (result.reason === "stale") {
      redirect("/home");
    }
    return <InvalidCard reason={result.reason} />;
  }

  // ── Unauthed path ────────────────────────────────────────────────
  const invitation = await prisma.projectInvitation.findUnique({
    where: { token },
    select: {
      expiresAt: true,
      consumedAt: true,
      creator: { select: { name: true, email: true } },
      project: { select: { name: true } },
    },
  });

  if (!invitation) return <InvalidCard reason="invalid" />;
  if (invitation.consumedAt) return <InvalidCard reason="invalid" />;
  if (invitation.expiresAt < new Date()) return <InvalidCard reason="expired" />;

  const inviterName =
    invitation.creator.name ??
    invitation.creator.email.split("@")[0] ??
    "ふたりのひとり";

  if (switchParam === "1") {
    const cookieStore = await cookies();
    const raw = cookieStore.get(GUEST_COOKIE_NAME)?.value;
    const verified = verifyGuestSession(raw);
    if (verified && verified.payload.projectId !== undefined) {
      const otherProject = await prisma.project.findUnique({
        where: { id: verified.payload.projectId },
        select: {
          name: true,
          members: {
            where: { role: "owner" },
            select: { user: { select: { name: true, email: true } } },
          },
        },
      });
      const otherInviterName =
        otherProject?.members[0]?.user?.name ??
        otherProject?.members[0]?.user?.email?.split("@")[0] ??
        "前のパートナー";
      return (
        <SwitchConfirmCard
          token={token}
          currentInviterName={otherInviterName}
          currentProjectName={otherProject?.name ?? "ふたりの式場さがし"}
          newInviterName={inviterName}
        />
      );
    }
  }

  return (
    <WelcomeCard
      token={token}
      inviterName={inviterName}
      expiresAt={invitation.expiresAt}
    />
  );
}

// ── UI fragments ──────────────────────────────────────────────────

/**
 * Welcome — the moment the partner sees Haretoki for the first time.
 * Editorial v4.2 vocabulary: 朝のひかり wash + SkyChip(break) + Shippori
 * serif h1 + gold-warm gradient hairline. Two CTAs:
 *   - primary (amber-tinted bordered): "ここだけ見る" — guest cookie path
 *   - secondary (text link): "参加する" — signup path
 *
 * Tone deliberately welcoming but not pushy: the inviter set the
 * expectation, we honour it without sales copy.
 */
function WelcomeCard({
  token,
  inviterName,
  expiresAt,
}: {
  token: string;
  inviterName: string;
  expiresAt: Date;
}) {
  return (
    <main
      className="relative min-h-[100dvh] overflow-hidden bg-gradient-to-b from-amber-50/50 via-background to-background"
      aria-labelledby="invite-welcome-heading"
    >
      {/* 朝のひかり — radial wash sits behind the card, never above the
          fold. Mirrors the Hero entry treatment in EditorialHero. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[60vh]"
        style={{
          background:
            "radial-gradient(120% 60% at 50% 0%, color-mix(in oklab, var(--gold-warm) 14%, transparent) 0%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[420px] items-center justify-center px-6 py-12">
        <div className="w-full space-y-8 text-center">
          <header className="space-y-4">
            <p className="text-[11.5px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="font-medium text-[var(--gold-warm)]">
                HARETOKI
              </span>
              <span aria-hidden="true" className="mx-2 opacity-30">·</span>
              <span>Invitation</span>
            </p>
            <div className="flex justify-center">
              <SkyChip mood="break" size={64} />
            </div>
            <div
              aria-hidden="true"
              className="mx-auto h-px w-32"
              style={{
                background:
                  "linear-gradient(to right, transparent 0%, color-mix(in oklab, var(--gold-warm) 50%, transparent) 50%, transparent 100%)",
              }}
            />
          </header>

          <div className="space-y-4">
            <h1
              id="invite-welcome-heading"
              className="font-[family-name:var(--font-display)] text-[26px] font-light leading-[1.4] tracking-[-0.005em] text-foreground"
            >
              {inviterName}さんが、
              <br />
              <span className="font-normal">
                ふたりで選ぶ場所
              </span>
              に招いてくれました。
            </h1>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              アカウントを作らずに、まずは
              <br />
              ちょっと覗いてみるところから。
            </p>
          </div>

          <div className="space-y-2.5">
            {/* Primary: Level 1 guest view via POST so the cookie set
                stays server-only (no client JS required). Amber-tinted
                outline mirrors the family-share Active link CTA so the
                partner-facing surface reads as one visual family. */}
            <form action={`/invite/${token}/guest-start`} method="post">
              <button
                type="submit"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-[14px] border bg-background text-[14.5px] font-medium tracking-[0.01em] shadow-sm transition active:scale-[0.98]"
                style={{
                  borderColor:
                    "color-mix(in oklab, var(--gold-warm) 60%, transparent)",
                  color: "var(--gold-warm)",
                  backgroundColor:
                    "color-mix(in oklab, var(--gold-warm) 4%, var(--background))",
                }}
              >
                ここだけ見る
              </button>
            </form>
            <Link
              href={`/signup?next=${encodeURIComponent(`/invite/${token}`)}`}
              className="inline-flex min-h-11 w-full items-center justify-center text-[13px] text-muted-foreground underline-offset-4 hover:underline"
            >
              アカウントを作って参加する
            </Link>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            アカウント登録は後からでも大丈夫です。
            <br />
            このリンクは{" "}
            <span className="tabular-nums">
              {new Date(expiresAt).toLocaleDateString("ja-JP")}
            </span>
            {" "}まで有効です。
          </p>
        </div>
      </div>
    </main>
  );
}

/**
 * Level 3 合流 confirm — partner is authed; we insist on a deliberate
 * tap before consuming. Same editorial frame as WelcomeCard with a
 * slightly hushed wash (the user has decided, this is just confirming).
 */
function JoinConfirmCard({
  token,
  inviterName,
}: {
  token: string;
  inviterName: string;
}) {
  return (
    <main
      className="relative min-h-[100dvh] bg-gradient-to-b from-amber-50/30 via-background to-background"
      aria-labelledby="invite-join-heading"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[50vh]"
        style={{
          background:
            "radial-gradient(120% 50% at 50% 0%, color-mix(in oklab, var(--gold-warm) 10%, transparent) 0%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[420px] items-center justify-center px-6 py-12">
        <div className="w-full space-y-7 text-center">
          <header className="space-y-4">
            <p className="text-[11.5px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="font-medium text-[var(--gold-warm)]">
                HARETOKI
              </span>
              <span aria-hidden="true" className="mx-2 opacity-30">·</span>
              <span>Join</span>
            </p>
            <div className="flex justify-center">
              <SkyChip mood="break" size={56} />
            </div>
            <div
              aria-hidden="true"
              className="mx-auto h-px w-24"
              style={{
                background:
                  "linear-gradient(to right, transparent 0%, color-mix(in oklab, var(--gold-warm) 45%, transparent) 50%, transparent 100%)",
              }}
            />
          </header>

          <div className="space-y-3">
            <h1
              id="invite-join-heading"
              className="font-[family-name:var(--font-display)] text-[24px] font-light leading-[1.45] tracking-[-0.005em] text-foreground"
            >
              {inviterName}さんの相棒として、
              <br />
              <span className="font-normal">合流しますか</span>。
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              合流すると、おふたりの式場さがしに参加できます。
              <br />
              ご自身の印象や ハートも、ここに残せるようになります。
            </p>
          </div>

          <div className="space-y-2.5">
            <Link
              href={`/invite/${token}?confirm=join`}
              prefetch={false}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-[14px] bg-primary text-[14.5px] font-medium tracking-[0.01em] text-primary-foreground shadow-sm transition active:scale-[0.98]"
            >
              合流する
            </Link>
            <Link
              href="/home"
              className="inline-flex min-h-11 w-full items-center justify-center text-[13px] text-muted-foreground underline-offset-4 hover:underline"
            >
              いまはやめておく
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Cross-project switch confirm — partner already has a guest session
 * for owner A; switching to owner B replaces that. Tone is more cautious
 * than JoinConfirm because the action is destructive (the previous
 * session view becomes inaccessible without re-tapping A's link).
 */
function SwitchConfirmCard({
  token,
  currentInviterName,
  currentProjectName,
  newInviterName,
}: {
  token: string;
  currentInviterName: string;
  currentProjectName: string;
  newInviterName: string;
}) {
  return (
    <main
      className="relative min-h-[100dvh] bg-gradient-to-b from-muted/30 via-background to-background"
      aria-labelledby="invite-switch-heading"
    >
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[420px] items-center justify-center px-6 py-12">
        <div className="w-full space-y-6 text-center">
          <header className="space-y-3">
            <p className="text-[11.5px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="font-medium text-[var(--gold-warm)]">
                HARETOKI
              </span>
              <span aria-hidden="true" className="mx-2 opacity-30">·</span>
              <span>Switch</span>
            </p>
            <div className="flex justify-center">
              <SkyChip mood="cloudy" size={56} />
            </div>
            <div
              aria-hidden="true"
              className="mx-auto h-px w-24 bg-border"
            />
          </header>

          <div className="space-y-3">
            <h1
              id="invite-switch-heading"
              className="font-[family-name:var(--font-display)] text-[22px] font-light leading-[1.5] tracking-[-0.005em] text-foreground"
            >
              いまは {currentInviterName}さんの
              <br />
              「{currentProjectName}」を見ています。
              <br />
              {newInviterName}さんの招待に
              <br />
              <span className="font-normal">切り替えますか</span>。
            </h1>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              切り替えると、{currentInviterName}さんの見ていた画面は閉じます。
              もう一度見るには、{currentInviterName}さんのリンクを
              もう一度タップしてください。
            </p>
          </div>

          <div className="space-y-2.5">
            <form action={`/invite/${token}/guest-start?confirm=1`} method="post">
              <button
                type="submit"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-[14px] bg-primary px-4 text-[14px] font-medium tracking-[0.01em] text-primary-foreground shadow-sm transition active:scale-[0.98]"
              >
                {newInviterName}さんの招待に切り替える
              </button>
            </form>
            <Link
              href={`/invite/${token}/view`}
              className="inline-flex min-h-11 w-full items-center justify-center text-[13px] text-muted-foreground underline-offset-4 hover:underline"
            >
              いまの画面にもどる
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Fail state. Editorial vocabulary preserved but the wash is muted +
 * the SkyChip is cloudy — the partner immediately reads "this isn't
 * for me". Copy stays identical for invalid + stale per the §2.6
 * enumeration-mitigation contract; expired / self / already_joined
 * each get a distinct line because each points at a real recovery.
 */
function InvalidCard({
  reason,
}: {
  reason:
    | "invalid"
    | "expired"
    | "stale"
    | "self"
    | "already_joined"
    | "wrong_recipient";
}) {
  const messages: Record<typeof reason, string> = {
    invalid:
      "このリンクは、うまく読み取れませんでした。送ってくれた方に、もう一度お伝えください。",
    stale:
      "このリンクは、うまく読み取れませんでした。送ってくれた方に、もう一度お伝えください。",
    expired:
      "このリンクは、有効期限が切れてしまいました。新しい招待リンクをお願いしてください。",
    self: "ご自身で作ったリンクは、ご自身ではお使いになれません。パートナーにお渡しください。",
    already_joined:
      "すでに別の式場さがしに参加しています。パートナーと同じ場所に合流するには、ご本人にもう一度招待をお願いしてください。",
    // Audit P0-1: explicit copy for "this URL is bound to a specific
    // email and your Supabase Auth email doesn't match" — keeps the
    // legitimate recipient from being scared off ("did I do something
    // wrong?") while still refusing the wrong account.
    wrong_recipient:
      "この招待リンクは、別のメールアドレス宛にお送りされたものです。招待された方のアドレスでサインインのうえ、もう一度お試しください。",
  };

  return (
    <main
      className="relative min-h-[100dvh] bg-gradient-to-b from-muted/40 via-background to-background"
      role="alert"
      aria-live="polite"
      aria-labelledby="invite-invalid-heading"
    >
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[420px] items-center justify-center px-6 py-12">
        <div className="w-full space-y-6 text-center">
          <header className="space-y-4">
            <p className="text-[11.5px] uppercase tracking-[0.28em] text-muted-foreground">
              Invitation
            </p>
            {/*
              CloudOff icon inside a hushed circular surface — quieter
              than SkyChip(cloudy) so the fail state never reads as
              "still in the brand journey". The stroke + text-muted
              kombination signals "this surface is closed".
            */}
            <div
              aria-hidden="true"
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-border/60 bg-muted/40"
            >
              <CloudOff className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div
              aria-hidden="true"
              className="mx-auto h-px w-20 bg-border"
            />
          </header>

          <div className="space-y-3">
            <h1
              id="invite-invalid-heading"
              className="font-[family-name:var(--font-display)] text-[20px] font-light leading-[1.5] tracking-[-0.005em] text-foreground"
            >
              この招待は、
              <br />
              うまくお渡しできませんでした。
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {messages[reason]}
            </p>
          </div>

          <Link
            href="/home"
            className="inline-flex min-h-11 items-center justify-center rounded-[14px] bg-primary px-6 text-[13px] font-medium text-primary-foreground"
          >
            ホームへ
          </Link>
        </div>
      </div>
    </main>
  );
}
