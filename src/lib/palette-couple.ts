/**
 * Couple palette tokens — single source of truth for "自分 / 相手 / 合意"
 * color mapping across the app.
 *
 * # Why this exists
 *
 * The 2026-05-24 audit caught three places where "自分 / 相手" was painted
 * with different colors (partner-comparison-summary used Rose=自分 Brown=相手,
 * rating-section used Gold=自分 Secondary=相手, compare-redesigned used Gold
 * for the "winner" and nothing for partner). Couples learning the
 * "妻 vs 夫" affordance had to re-decode it on every screen.
 *
 * DESIGN.md §"Color Usage Rules" sets the brand colors but doesn't fix
 * their semantic role for couple comparison. This module pins it:
 *
 *   - own       → `var(--primary)` (Morning Light Rose)  →  "自分の評価・行動"
 *   - partner   → `var(--secondary)` (Warm Brown)         →  "相手の評価・行動"
 *   - consensus → `var(--gold-warm)` (Gold)               →  "ふたりの合意・winner"
 *
 * Gold remains reserved for AI features and "winner" highlights
 * (DESIGN.md line 587-590) — it deliberately does NOT mean "your" score.
 *
 * Usage: import { COUPLE } from "@/lib/palette-couple" and apply the
 * tokens as `style={{ backgroundColor: COUPLE.own.bg }}` or via
 * `className="bg-[var(--primary)]"` etc. The tokens are CSS-variable
 * strings so they pick up dark-mode swaps automatically.
 */

export const COUPLE = {
  own: {
    /** Solid fill for chips, bars, score badges authored by the viewer. */
    bg: "var(--primary)",
    /** Text color when paired with a transparent / muted background. */
    text: "var(--primary)",
    /** Soft tint for backgrounds (e.g. row highlight where I rated > partner). */
    soft: "color-mix(in oklab, var(--primary) 12%, transparent)",
  },
  partner: {
    bg: "var(--secondary)",
    text: "var(--secondary)",
    soft: "color-mix(in oklab, var(--secondary) 12%, transparent)",
  },
  consensus: {
    /** Used for "winner" / "agreement" / AI-generated highlights — anywhere
     *  the screen is celebrating a couple-wide consensus rather than a
     *  single member's perspective. */
    bg: "var(--gold-warm)",
    text: "var(--gold-warm)",
    soft: "var(--gold-subtle)",
  },
} as const;

export type CoupleRole = keyof typeof COUPLE;
