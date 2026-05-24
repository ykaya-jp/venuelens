"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { HeartButton } from "@/components/venues/heart-button";
import { ShareButton } from "@/components/venues/share-button";
import { HaloTap } from "@/components/ui/halo-tap";
import { toggleFavorite } from "@/server/actions/favorites";

interface VenueActionBarProps {
  venueId: string;
  venueName: string;
  isFavorite: boolean;
}

/**
 * Sticky bottom ActionBar — Heart + Share + primary CTA only.
 *
 * Destructive "この式場を削除" was previously sitting next to the primary
 * "比べる" link at 375px; couples mis-tapped it. Delete has moved to
 * VenueOverflowMenu (top-right of the page header), matching the
 * Airbnb / Zola / Resy pattern of never placing destructive actions
 * next to primary CTAs.
 *
 * The CTA branches on `isFavorite`:
 *   - Not yet a favorite → "候補に入れて比べる" first toggles the heart
 *     ON, then navigates to /candidates?view=compare. Previously this was
 *     a bare `<Link>` so the user assumed the venue had been added when
 *     in fact only the heart-icon would have done that — a frequent
 *     report ("追加されないし", incident 2026-05-24) when partners landed
 *     here from /candidates?view=partner.
 *   - Already a favorite → "ほかの式場と比べる" is plain navigation.
 */
export function VenueActionBar({ venueId, venueName, isFavorite }: VenueActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [favoriteState, setFavoriteState] = useState(isFavorite);
  const compareHref = `/candidates?view=compare&venueIds=${venueId}`;

  const handleAddAndCompare = () => {
    // Optimistic — repaint immediately so the tap feels coupled to the
    // visual response, even before the server roundtrip finishes.
    setFavoriteState(true);
    startTransition(async () => {
      try {
        await toggleFavorite(venueId);
        toast.success("候補に追加して比べます", { duration: 4000 });
        router.push(compareHref);
      } catch (e) {
        // Surface auth redirects untouched (session expired → /login).
        if (
          e instanceof Error &&
          typeof (e as { digest?: unknown }).digest === "string" &&
          (e as unknown as { digest: string }).digest.startsWith("NEXT_REDIRECT")
        ) {
          throw e;
        }
        console.error("[VenueActionBar] toggleFavorite failed", e);
        setFavoriteState(false);
        const detail =
          e instanceof Error && e.message ? `: ${e.message.slice(0, 80)}` : "";
        toast.error(`候補に入れられませんでした${detail}`, { duration: 6000 });
      }
    });
  };

  return (
    <div className="fixed bottom-[calc(56px+env(safe-area-inset-bottom))] left-0 right-0 z-40 border-t border-border/40 bg-card/80 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] py-3 backdrop-blur-xl supports-[backdrop-filter]:bg-card/60">
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <HeartButton venueId={venueId} initialFavorite={favoriteState} />
        <ShareButton venueName={venueName} />
        <HaloTap className="flex-1 rounded-full">
          {favoriteState ? (
            <Link
              href={compareHref}
              prefetch={true}
              className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
            >
              ほかの式場と比べる
            </Link>
          ) : (
            <button
              type="button"
              onClick={handleAddAndCompare}
              disabled={pending}
              aria-busy={pending}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-transform active:scale-95 disabled:opacity-70"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {pending ? "候補に入れています…" : "候補に入れて比べる"}
            </button>
          )}
        </HaloTap>
      </div>
    </div>
  );
}
