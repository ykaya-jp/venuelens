"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleFavorite } from "@/server/actions/favorites";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useHaptic } from "@/hooks/use-haptic";

interface HeartButtonProps {
  venueId: string;
  initialFavorite: boolean;
}

export function HeartButton({ venueId, initialFavorite }: HeartButtonProps) {
  // NOTE: useOptimistic requires an active Server Action transition to
  // auto-revert. We perform the mutation via a plain async call wrapped in
  // try/catch, so we need manual revert semantics — hence useState.
  const [favorite, setFavorite] = useState(initialFavorite);
  const inFlightRef = useRef(false);
  const router = useRouter();
  const haptic = useHaptic();

  // Keep in sync if the parent re-renders with a different value (e.g. after
  // `router.refresh()` re-hydrates from the server). Render-phase reset —
  // React 19's "adjusting state based on props" pattern, no effect cascade.
  const [prevInitial, setPrevInitial] = useState(initialFavorite);
  if (prevInitial !== initialFavorite) {
    setPrevInitial(initialFavorite);
    setFavorite(initialFavorite);
  }

  const handleToggle = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const previous = favorite;
    const next = !previous;
    setFavorite(next);
    // "select" pulse fires on press intent, before the network round-trip,
    // so the haptic feels coupled to the user's tap rather than to the
    // server response. The visual heart fill animates on the same frame,
    // matching the haptic to the visual change. Reduced-motion users skip
    // both — useHaptic checks the preference internally.
    haptic("select");

    try {
      await toggleFavorite(venueId);
      toast.success(next ? "候補に追加しました" : "候補から外しました", {
        // 4 s (was 2 s) — incident 2026-05-24: at 2 s a couple browsing on
        // dim mobile while comparing two candidates could miss the toast
        // entirely and report "ハートを押しても何も起きない". Long enough
        // to read, short enough to not stack on rapid double-tap.
        duration: 4000,
        action: !next
          ? { label: "戻す", onClick: () => void handleToggle() }
          : undefined,
      });
      // Refresh the server tree so any parent-owned favorite snapshot
      // (Explore/Candidates lists) reflects the change.
      router.refresh();
    } catch (e) {
      // Surface NEXT_REDIRECT (session expired → /login) untouched.
      if (
        e instanceof Error &&
        typeof (e as { digest?: unknown }).digest === "string" &&
        (e as unknown as { digest: string }).digest.startsWith("NEXT_REDIRECT")
      ) {
        throw e;
      }
      console.error("[HeartButton] toggleFavorite threw", e);
      setFavorite(previous); // revert optimistic state on failure
      const detail = e instanceof Error && e.message ? `: ${e.message.slice(0, 80)}` : "";
      toast.error(`ハートを残せませんでした${detail}`, {
        duration: 6000,
        action: { label: "もう一度", onClick: () => void handleToggle() },
      });
    } finally {
      inFlightRef.current = false;
    }
  };

  return (
    <motion.button
      type="button"
      onClick={handleToggle}
      aria-pressed={favorite}
      aria-label={favorite ? "候補から外す" : "候補に入れる"}
      title={favorite ? "候補から外す" : "候補に入れる"}
      className="flex h-12 w-12 items-center justify-center rounded-full bg-card/80 backdrop-blur-sm transition-[background-color,box-shadow] duration-200 hover:bg-card active:bg-card/60 active:shadow-[var(--shadow-hairline)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gold-warm)] focus-visible:ring-offset-2"
      whileTap={{ scale: 1.15 }}
      transition={{ type: "spring", stiffness: 200, damping: 12 }}
    >
      <motion.div
        key={favorite ? "filled" : "empty"}
        initial={{ scale: 0.3 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 12 }}
      >
        <Heart
          className={cn(
            "h-5 w-5 transition-colors duration-200",
            favorite
              ? "fill-primary text-primary"
              : "fill-none text-primary/70"
          )}
        />
      </motion.div>
    </motion.button>
  );
}
