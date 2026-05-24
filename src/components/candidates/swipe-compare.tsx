"use client";

import { useState } from "react";
import { SwipeCard } from "./swipe-card";
import { Heart, X, Scale } from "lucide-react";
import { toggleFavorite } from "@/server/actions/favorites";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface SwipeVenue {
  id: string;
  name: string;
  location: string | null;
  photoUrls: string[];
  totalScore: number;
  topStrengths: string[];
  latestEstimate: { total: number } | null;
}

interface SwipeCompareProps {
  venues: SwipeVenue[];
  onComplete: (kept: string[], compareIds: string[]) => void;
}

export function SwipeCompare({ venues, onComplete }: SwipeCompareProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [kept, setKept] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const router = useRouter();

  const handleSwipe = async (direction: "left" | "right" | "up") => {
    const venue = venues[currentIndex];

    // Build the next-state locally so onComplete sees the final swipe too;
    // reading `kept` / `compareIds` directly after setState would return
    // stale closure values on the last venue.
    let nextKept = kept;
    let nextCompareIds = compareIds;

    if (direction === "right") {
      nextKept = [...kept, venue.id];
      setKept(nextKept);
    } else if (direction === "left") {
      // Remove from favorites
      try {
        await toggleFavorite(venue.id);
      } catch {
        toast.error("うまくいきませんでした");
      }
    } else if (direction === "up") {
      nextCompareIds = [...compareIds, venue.id];
      setCompareIds(nextCompareIds);
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex >= venues.length) {
      onComplete(nextKept, nextCompareIds);
    } else {
      setCurrentIndex(nextIndex);
    }
  };

  if (currentIndex >= venues.length) {
    return (
      <div className="space-y-4 py-8 text-center">
        <h3 className="text-lg font-medium">スワイプ完了</h3>
        <p className="text-sm text-muted-foreground">
          {kept.length}件キープ、{compareIds.length}件を比較候補に追加しました
        </p>
        {compareIds.length >= 2 && (
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded-lg bg-primary px-6 py-2.5 text-primary-foreground"
          >
            比較ボードを開く
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-center text-sm text-muted-foreground">
        {currentIndex + 1}/{venues.length} 残り{venues.length - currentIndex - 1}件
      </div>

      <div className="relative min-h-[480px]">
        {venues.slice(currentIndex, currentIndex + 2).reverse().map((venue, i) => (
          <SwipeCard
            key={venue.id}
            venue={venue}
            onSwipe={handleSwipe}
            isTop={i === (Math.min(1, venues.length - currentIndex - 1))}
          />
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={() => handleSwipe("left")}
          className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-destructive/20 transition-transform active:scale-90"
        >
          <X className="h-6 w-6 text-destructive" />
        </button>
        <button
          type="button"
          onClick={() => handleSwipe("up")}
          className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[color-mix(in_oklab,var(--primary)_35%,transparent)] transition-transform active:scale-90"
        >
          <Scale className="h-5 w-5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />
        </button>
        <button
          type="button"
          onClick={() => handleSwipe("right")}
          className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-[color-mix(in_oklab,var(--gold-warm)_45%,transparent)] transition-transform active:scale-90"
        >
          <Heart className="h-6 w-6 text-[var(--gold-warm)]" />
        </button>
      </div>
    </div>
  );
}
