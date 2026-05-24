import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getVenueHeader,
  getVenueEstimates,
  getVenueVisits,
  getVenueLatestEstimateTotal,
} from "@/server/actions/venues";
import { getCoupleRatings } from "@/server/actions/ratings";
import { getFavorites } from "@/server/actions/favorites";
import { requireUser, requireProjectMembership } from "@/server/auth";
import { prisma } from "@/server/db";
import { VibeTagEditor } from "@/components/venues/vibe-tag-editor";
import { getVenueReviews, getVenueReviewEstimateAggregate } from "@/server/actions/reviews";
import { getVenuePlans } from "@/server/actions/plans";
import { VenuePhotoGallery } from "@/components/venues/venue-photo-gallery";
import { VenueHeader } from "@/components/venues/venue-header";
import { RatingSection } from "@/components/venues/rating-section";
import { EstimateSection } from "@/components/venues/estimate-section";
import { MoneyReality } from "@/components/venues/money-reality";
import { getMoneyReality } from "@/server/actions/money-reality";
import { ReviewSection } from "@/components/venues/review-section";
import { ReviewClusterPanel } from "@/components/venues/review-cluster-panel";
import { VenueWhisper } from "@/components/venues/venue-whisper";
import { PlanSection } from "@/components/venues/plan-section";
import { VenueActionBar } from "@/components/venues/venue-action-bar";
import { PartnerComparisonSummary } from "@/components/ratings/partner-comparison-summary";
import { PartnerCanRateHint } from "@/components/ratings/partner-can-rate-hint";
import { VisitSection } from "@/components/visits/visit-section";
import { VenueMemoSection } from "@/components/venues/venue-memo-section";
import { getVenueMemos } from "@/server/actions/venue-memos";
import { EstimateXRay } from "@/components/venues/estimate-xray";
import { EstimateWaterfallChart } from "@/components/venues/estimate-waterfall-chart";
import { EstimateTimeline } from "@/components/estimates/estimate-timeline";
import { VenueDetailBackLink } from "@/components/venues/back-link";
import { VenueOverflowMenu } from "@/components/venues/venue-overflow-menu";
import { VenueHeroRibbon } from "@/components/venues/venue-hero-ribbon";
import { VenueUpdatedBanner } from "@/components/venues/venue-updated-banner";
import { VenueFreshnessChip } from "@/components/venues/venue-freshness-chip";
import { VenueSegmentsNav } from "@/components/venues/venue-segments-nav";
import { VenueFactSheet } from "@/components/venues/venue-fact-sheet";
import { VenueAmenitiesSection } from "@/components/venues/venue-amenities-section";
import { VenueCostBreakdown } from "@/components/venues/venue-cost-breakdown";
import { VenueCuisineSection } from "@/components/venues/venue-cuisine-section";
import { SimilarVenues } from "@/components/venues/similar-venues";
import { Skeleton } from "@/components/ui/skeleton";

// Section order follows a "decision journey" rather than operational
// grouping: start with the place itself (概要), absorb external signals
// (口コミ + プラン) that shape judgement, then the couple's own records
// (見積 + 見学). Airbnb / Zola / The Knot PDP all sequence this way.
// Previously ran 概要 → 見積 → 見学 → 口コミ → プラン (vendor-side
// lifecycle order), which buried the "what do others think?" question
// at the bottom when it's the first thing couples actually look for.
const VENUE_SECTIONS = [
  { id: "overview", label: "概要" },
  { id: "review", label: "口コミ" },
  { id: "plan", label: "プラン" },
  { id: "estimate", label: "見積" },
  { id: "memo", label: "メモ" },
  { id: "visit", label: "見学" },
] as const;

// Bump function timeout for the URL-import server actions
// (batchImportReviewUrls, analyzeVenueReviews,
// extractIndividualReviewsFromSource) invoked from this page. The
// per-card backfill button now does an 8-page multi-source crawl
// (~80-150s wall time on a slow upstream like mwed). 300s is Vercel
// Pro's hard ceiling.
export const maxDuration = 300;

export default async function VenueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await requireUser();
  const membership = await requireProjectMembership(user.id);
  const isOwner = membership.role === "owner";

  const [venue, favorites, latestEstimateTotal] = await Promise.all([
    getVenueHeader(id),
    getFavorites("mine"),
    // Latest estimate total drives the hero ribbon. Fetched in parallel
    // with the other above-the-fold data so it doesn't add to TTFB.
    getVenueLatestEstimateTotal(id),
  ]);

  if (!venue) notFound();

  const isFavorite = favorites.some((f) => f.venue.id === venue.id);

  // Extract user ratings into Record<dimension, score>
  const userRatings: Record<string, number> = {};
  for (const score of venue.scores) {
    if (score.source === "user_rating") {
      userRatings[score.dimension] = Number(score.score);
    }
  }

  return (
    <div className="space-y-10 pb-36">
      {/* Top row: back link (left) + overflow menu (right). Destructive
          actions live in the overflow menu so they're never adjacent to
          the primary CTA in the sticky bottom bar. */}
      <div className="flex items-center justify-between">
        <VenueDetailBackLink variant="compact" />
        <VenueOverflowMenu
          venueId={venue.id}
          venueName={venue.name}
          hasSourceUrl={(venue.sourceUrls ?? []).length > 0}
        />
      </div>

      {/* Merged-import banner — present only when ?updated=1, self-scrubs. */}
      <VenueUpdatedBanner />

      {/* Photo Gallery — above the fold */}
      <VenuePhotoGallery
        venueId={venue.id}
        name={venue.name}
        photoUrls={venue.photoUrls}
      />

      {/* L2-B1: Editorial overlap — Ribbon は写真の下端に -mt-8 で
          かぶさり、雑誌の見開きのような非対称な視覚リズムを作る。
          z-10 で写真より前面、relative で stacking context 確保。
          ribbon が無いとき (no price + no rating) は overlap も不発生。 */}
      <div className="relative z-10 -mt-8 px-2">
        <VenueHeroRibbon
          estimateTotal={latestEstimateTotal}
          externalRatingValue={venue.externalRatingValue}
          externalReviewCount={venue.externalReviewCount}
        />
      </div>

      {/* Venue Header — above the fold */}
      <VenueHeader
        name={venue.name}
        location={venue.location}
        accessInfo={venue.accessInfo}
        capacityMin={venue.capacityMin}
        capacityMax={venue.capacityMax}
        ceremonyStyles={venue.ceremonyStyles}
        status={venue.status}
      />

      {/* Freshness chip — surfaces when the imported fields were last
          updated, and offers a one-tap re-import for URL-sourced venues.
          Past 30d it switches to a gold-warm "情報が古い可能性" style. */}
      <VenueFreshnessChip
        venueId={venue.id}
        updatedAt={venue.updatedAt}
        hasSourceUrl={(venue.sourceUrls ?? []).length > 0}
      />

      {/* Sticky segmented control — scroll-spy via IntersectionObserver */}
      <VenueSegmentsNav sections={[...VENUE_SECTIONS]} />

      {/* ===== Overview section ===== */}
      <section
        id="overview"
        role="tabpanel"
        aria-labelledby="tab-overview"
        // WAI-ARIA tabpanel pattern: tabIndex=0 lets keyboard users
        // land on the panel after activating its tab in
        // VenueSegmentsNav. jsx-a11y excludes tabpanel from its
        // interactive-roles list, hence the static-rule disable.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="space-y-4 focus-visible:outline-none"
      >
        <div
          aria-hidden="true"
          className="h-px bg-gradient-to-r from-transparent via-[color-mix(in_oklab,var(--gold-warm)_35%,transparent)] to-transparent"
        />

        {/* Rating Section — render the rating bars immediately with the
            synchronously-loaded userRatings (already in `venue.scores`
            above) so the section can never be invisible. The partner
            comparison + viewer-aware hint stream in separately via the
            inner Suspense; if their fetch fails or times out, the bars
            stay visible by themselves.

            Phase 0 fix (PR #3): the previous code wrapped both the bars
            AND the partner fetch in one Suspense, so any hang in
            getCoupleRatings made the entire rating UI disappear behind
            a skeleton — which is what the user reported as "evaluation
            screen vanished". Splitting them guarantees the input UI is
            always reachable. */}
        <RatingSection
          venueId={venue.id}
          initialRatings={userRatings}
        />
        <Suspense fallback={null}>
          <RatingPartnerOverlay
            venueId={venue.id}
            userRatings={userRatings}
            viewerIsPartner={!isOwner}
          />
        </Suspense>

        {/* Focused-mode CTA — sends couples to the dedicated
            /venues/[id]/impression page for distraction-free scoring
            (added in PR #3 of the comparison rebuild). The original
            dashed-italic styling read as a caption rather than a
            tappable affordance and the 12px text + p-3 padding gave a
            ~40px hit target — both below the 44px minimum. Promoted to
            an explicit gold-accented button so the impression-mode
            entry is unmistakable from the rest of the dense PDP. */}
        <Link
          href={`/venues/${venue.id}/impression`}
          prefetch
          className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--gold-warm)]/60 bg-[var(--gold-subtle)] px-4 py-2.5 text-sm font-medium text-[var(--gold-warm)] shadow-[0_1px_2px_rgba(42,35,32,0.06)] active:bg-[color-mix(in_oklab,var(--gold-warm)_18%,var(--background))] active:scale-[0.98] transition-transform"
        >
          <span>印象を残す</span>
          <span aria-hidden className="text-xs opacity-70">·</span>
          <span className="text-xs opacity-80">集中モードでひらく</span>
          <span aria-hidden className="text-xs">→</span>
        </Link>

        {/* Fact Sheet — external rating ★, address, phone, map.
            Each sub-field is null-safe; section hides itself when no data. */}
        <VenueFactSheet
          venueName={venue.name}
          externalRatingValue={venue.externalRatingValue}
          externalReviewCount={venue.externalReviewCount}
          postalCode={venue.postalCode}
          streetAddress={venue.streetAddress}
          latitude={venue.latitude}
          longitude={venue.longitude}
          phoneNumber={venue.phoneNumber}
        />

        {/* Amenities — 設備と過ごし方 chip grid. Moved inside overview so
            the SegmentsNav tab accurately describes what the reader
            will find. Returns null when zero chips build. */}
        <VenueAmenitiesSection
          hasParking={venue.hasParking}
          parkingCapacity={venue.parkingCapacity}
          hasShuttle={venue.hasShuttle}
          hasAccommodation={venue.hasAccommodation}
          acceptsSecondParty={venue.acceptsSecondParty}
          barrierFree={venue.barrierFree}
          operatingHours={venue.operatingHours}
          closedDays={venue.closedDays}
        />

        {/* Cuisine — 料理・シェフ. Same relocation reason: belongs to the
            "what kind of place is this" read, not an orphaned float. */}
        <VenueCuisineSection
          cuisineTypes={venue.cuisineTypes}
          chefCredentials={venue.chefCredentials}
        />
      </section>

      {/* ===== Review section ===== (moved earlier — "what do others say?"
          is the first external signal couples look for) */}
      <section
        id="review"
        role="tabpanel"
        aria-labelledby="tab-review"
        // WAI-ARIA tabpanel — see overview section above for rationale.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="space-y-4 focus-visible:outline-none"
      >
        <Suspense fallback={<ReviewsSkeleton />}>
          <ReviewsContent
            venueId={venue.id}
            reviewClusters={
              venue.reviewClusters as {
                positive: Array<{ theme: string; summary: string; count?: number }>;
                negative: Array<{ theme: string; summary: string; count?: number }>;
              } | null
            }
            externalReviewCount={venue.externalReviewCount}
          />
        </Suspense>
      </section>

      {/* ===== Plan section ===== (venue-published packages come next,
          right after reviews — couples pick a baseline package before
          layering their own estimate numbers on top) */}
      <section
        id="plan"
        role="tabpanel"
        aria-labelledby="tab-plan"
        // WAI-ARIA tabpanel — see overview section above for rationale.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="space-y-4 focus-visible:outline-none"
      >
        <Suspense fallback={<PlansSkeleton />}>
          <PlansContent venueId={venue.id} />
        </Suspense>

        {/* VibeTag editor — owner only */}
        {isOwner && (
          <VibeTagEditor venueId={venue.id} initialTags={venue.vibeTags} />
        )}
      </section>

      <div
        aria-hidden="true"
        className="h-px bg-gradient-to-r from-transparent via-[oklch(0.70_0.13_80/0.35)] to-transparent"
      />

      {/* ===== Estimate section ===== (couple's own record — comes after
          external signals) */}
      <section
        id="estimate"
        role="tabpanel"
        aria-labelledby="tab-estimate"
        // WAI-ARIA tabpanel — see overview section above for rationale.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="space-y-4 focus-visible:outline-none"
      >
        <Suspense fallback={<EstimatesSkeleton />}>
          <EstimatesContent venueId={venue.id} />
        </Suspense>

        {/* Cost Breakdown — venue-published base fees (挙式料 / 演出料 /
            サービス料率). Complements the user's own estimate above.
            Hides when all three fields are null. */}
        <VenueCostBreakdown
          ceremonyFeeExact={venue.ceremonyFeeExact}
          productionFeeMin={venue.productionFeeMin}
          productionFeeMax={venue.productionFeeMax}
          serviceFeeRate={
            venue.serviceFeeRate != null ? Number(venue.serviceFeeRate) : null
          }
        />
      </section>

      {/* ===== Memo section ===== — Venue-scoped free-text. Sits above
          the visit section so couples can jot pre-visit thoughts and
          post-comparison summaries without scheduling a visit row first. */}
      <section
        id="memo"
        role="tabpanel"
        aria-labelledby="tab-memo"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="space-y-4 focus-visible:outline-none"
      >
        <Suspense fallback={<MemosSkeleton />}>
          <MemosContent
            venueId={venue.id}
            projectId={venue.projectId}
          />
        </Suspense>
      </section>

      {/* ===== Visit section ===== (last — scheduling happens after the
          couple has judged they want to visit at all) */}
      <section
        id="visit"
        role="tabpanel"
        aria-labelledby="tab-visit"
        // WAI-ARIA tabpanel — see overview section above for rationale.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="space-y-4 focus-visible:outline-none"
      >
        <Suspense fallback={<VisitsSkeleton />}>
          <VisitsContent
            venueId={venue.id}
            venueName={venue.name}
            projectId={venue.projectId}
          />
        </Suspense>
      </section>

      {/* ===== Similar venues ===== (broaden consideration — ranked by
          pure-maths similarity across ceremonyStyles / vibeTags /
          location / cost / capacity. Self-hides when there are no
          other venues or zero overlap. Keep this below 見学 so it
          never competes with primary actions.) */}
      <Suspense fallback={<SimilarVenuesSkeleton />}>
        <SimilarVenues venueId={venue.id} />
      </Suspense>

      {/* Action Bar */}
      <VenueActionBar
        venueId={venue.id}
        venueName={venue.name}
        isFavorite={isFavorite}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Async child Server Components — each one is a Suspense boundary.
// ---------------------------------------------------------------------------

/**
 * Partner-aware overlay that streams in alongside the (already-rendered)
 * RatingSection. Splits the previous monolithic RatingWithPartner so
 * the rating bars themselves are never gated on the partner fetch —
 * fixes the Phase 0 "evaluation screen vanished" bug where any hang in
 * getCoupleRatings hid the input entirely.
 *
 * What this still does:
 *   - Surfaces the partner-can-rate hint to partner viewers with no
 *     own ratings yet.
 *   - Renders the cross-rater comparison summary when partner data
 *     exists.
 *
 * What it no longer does:
 *   - Render the RatingSection itself. That now lives in the parent
 *     server component and is synchronous against `userRatings`.
 */
async function RatingPartnerOverlay({
  venueId,
  userRatings,
  viewerIsPartner,
}: {
  venueId: string;
  userRatings: Record<string, number>;
  viewerIsPartner: boolean;
}) {
  const coupleRatingsData = await getCoupleRatings(venueId).catch(() => null);

  const partnerRatings: Record<string, number> = {};
  if (coupleRatingsData?.otherRatings) {
    for (const [dim, score] of Object.entries(
      coupleRatingsData.otherRatings.ratings,
    )) {
      partnerRatings[dim] = score;
    }
  }
  const hasPartner = Object.keys(partnerRatings).length > 0;
  const showCanRateHint =
    viewerIsPartner && Object.keys(userRatings).length === 0;

  return (
    <>
      {showCanRateHint && <PartnerCanRateHint />}
      {hasPartner && (
        <PartnerComparisonSummary
          venueId={venueId}
          myRatings={userRatings}
          partnerRatings={partnerRatings}
        />
      )}
    </>
  );
}

/** Audit P2-29: resolve "誰が作成した見積か" to a viewer-aware label.
 *  Returns null when the author is unknown (legacy row, deleted user)
 *  so EstimateXRay simply hides the line — better than printing a
 *  stale id. "自分" wins over the partnerName match so reflexive
 *  recognition stays instant. */
function resolveEstimateAuthorLabel(
  author: { id: string; name: string | null; email: string | null } | null,
  viewerUserId: string,
): string | null {
  if (!author) return null;
  if (author.id === viewerUserId) return "自分が入力";
  const display = author.name?.trim() || author.email?.split("@")[0] || null;
  return display ? `${display} さんが入力` : null;
}

async function EstimatesContent({ venueId }: { venueId: string }) {
  const user = await requireUser();
  const [estimates, reviewEstimateAgg] = await Promise.all([
    getVenueEstimates(venueId),
    getVenueReviewEstimateAggregate(venueId),
  ]);
  const currentUserId = user.id;

  // Render EstimateSection even when empty — its internal empty-state CTA
  // invites the user to add their first estimate. Previously we returned
  // null here, which made the "見積" tab a dead-end on venues with no
  // estimate recorded yet.
  if (estimates.length === 0) {
    return (
      <EstimateSection venueId={venueId} estimates={[]} />
    );
  }

  const moneyReality = await getMoneyReality(estimates[0].id).catch(() => null);

  const reviewMeanFinal =
    reviewEstimateAgg?.deltaYen != null
      ? estimates[0].total + reviewEstimateAgg.deltaYen
      : undefined;

  return (
    <>
      <EstimateSection
        venueId={venueId}
        estimates={estimates.map((e) => ({
          ...e,
          predictedFinal: e.predictedFinal,
          // Coerce Prisma Decimal objects to plain numbers so the payload
          // can cross the Server → Client Component boundary without the
          // 'Only plain objects can be passed' warning.
          items: e.items.map((item) => ({
            ...item,
            amount: Number(item.amount),
            upgradeProbability:
              item.upgradeProbability != null
                ? Number(item.upgradeProbability)
                : null,
          })),
        }))}
      />

      {/* Version timeline — v1 → v2 → v3 の推移。version が 1 件だけの
          ときは component 側で null を返すので render しても副作用なし。 */}
      <EstimateTimeline
        estimates={estimates.map((e) => ({
          id: e.id,
          version: e.version,
          total: e.total,
          createdAt: e.createdAt,
          items: e.items.map((item) => ({
            category: item.category,
            amount: Number(item.amount),
          })),
        }))}
      />

      {estimates[0].items.length > 0 && (
        <EstimateXRay
          venueId={venueId}
          items={estimates[0].items.map((item) => ({
            category: item.category,
            itemName: item.itemName,
            amount: item.amount,
            tier: item.tier,
            predictedUpgrade: item.predictedUpgrade ?? null,
            upgradeProbability: item.upgradeProbability
              ? Number(item.upgradeProbability)
              : null,
          }))}
          totalEstimate={estimates[0].total}
          predictedFinal={estimates[0].predictedFinal}
          authorLabel={resolveEstimateAuthorLabel(
            estimates[0].author,
            currentUserId,
          )}
        />
      )}

      {estimates[0].predictedFinal && (
        <EstimateWaterfallChart
          initialTotal={estimates[0].total}
          predictedFinal={estimates[0].predictedFinal}
          items={estimates[0].items.map((item) => ({
            category: item.category,
            itemName: item.itemName,
            amount: item.amount,
            predictedUpgrade: item.predictedUpgrade ?? 0,
          }))}
          reviewMeanFinal={reviewMeanFinal}
          reviewSampleCount={reviewEstimateAgg?.sampleCount ?? undefined}
          reviewStdDevYen={reviewEstimateAgg?.standardDeviation ?? undefined}
        />
      )}

      {moneyReality && <MoneyReality report={moneyReality} />}
    </>
  );
}

async function ReviewsContent({
  venueId,
  reviewClusters,
  externalReviewCount,
}: {
  venueId: string;
  reviewClusters: {
    positive: Array<{ theme: string; summary: string; count?: number }>;
    negative: Array<{ theme: string; summary: string; count?: number }>;
  } | null;
  externalReviewCount: number | null;
}) {
  const [reviews, venueAgg] = await Promise.all([
    getVenueReviews(venueId),
    getVenueReviewEstimateAggregate(venueId),
  ]);
  return (
    <div className="space-y-5">
      {/* AI-clustered "よかった / 気になる" panel. Renders only when
          reviewClusters has at least one theme on either side. Distilled
          from the multi-page kuchikomi corpus during URL import. */}
      {reviewClusters && (
        <ReviewClusterPanel
          positive={reviewClusters.positive ?? []}
          negative={reviewClusters.negative ?? []}
          sourceCount={externalReviewCount}
        />
      )}

      {/* E-9 Venue Whisper: distilled 2-axis summary at the top. Falls back
          to no render when no reviews analyzed yet (0 noise). */}
      <VenueWhisper
        reviews={reviews.map((r) => ({
          categorySummary: r.categorySummary,
          isNegative: r.isNegative,
        }))}
        reviewEstimateAggregate={venueAgg}
      />

      <ReviewSection
        venueId={venueId}
        reviews={reviews.map((r) => ({
          id: r.id,
          source: r.source,
          sourceUrl: r.sourceUrl,
          aiSummary: r.aiSummary,
          sentiment: r.sentiment as Record<string, number> | null,
          rating: r.rating ? Number(r.rating) : null,
          categorySummary: r.categorySummary as Record<string, string> | null,
          isNegative: r.isNegative,
          estimateIncrease: r.estimateIncrease as {
            deltaYen?: number;
            deltaPct?: number;
            confidence?: "high" | "medium" | "low";
            note?: string;
          } | null,
        }))}
        venueEstimateAggregate={venueAgg}
      />
    </div>
  );
}

async function PlansContent({ venueId }: { venueId: string }) {
  const plans = await getVenuePlans(venueId);
  return (
    <PlanSection
      venueId={venueId}
      plans={plans.map((p) => ({
        id: p.id,
        name: p.name,
        basePrice: p.basePrice,
        guestCountMin: p.guestCountMin,
        guestCountMax: p.guestCountMax,
        includedItems: (p.includedItems as string[]) ?? [],
        excludedItems: (p.excludedItems as string[]) ?? [],
        bringInItems:
          (p.bringInItems as Array<{ item: string; fee?: number }>) ?? [],
        dressAllowance: p.dressAllowance,
        dressAllowanceNote: p.dressAllowanceNote,
        dressBrideCount: p.dressBrideCount,
        dressGroomCount: p.dressGroomCount,
        dressBudgetCapYen: p.dressBudgetCapYen,
        campaigns:
          (p.campaigns as Array<{ name: string; discount?: string }>) ?? [],
        notes: p.notes,
      }))}
    />
  );
}

async function VisitsContent({
  venueId,
  venueName,
  projectId,
}: {
  venueId: string;
  venueName: string;
  projectId: string;
}) {
  const user = await requireUser();
  const visits = await getVenueVisits(venueId);

  // Resolve partner userId for "誰が書いたか" note labels
  const allMembers = await prisma.projectMember.findMany({
    where: { projectId },
    select: { userId: true },
  });
  const partnerUserId = allMembers.find((m) => m.userId !== user.id)?.userId ?? undefined;

  return (
    <VisitSection
      venueId={venueId}
      venueName={venueName}
      projectId={projectId}
      currentUserId={user.id}
      partnerUserId={partnerUserId}
      vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""}
      visits={visits.map((v) => ({
        id: v.id,
        scheduledAt: v.scheduledAt,
        status: v.status,
        completedAt: v.completedAt,
        title: v.title,
        memo: v.memo,
        calendarExportedAt: v.calendarExportedAt,
        checklist:
          v.checklist?.map((c) => ({
            id: c.id,
            item: c.item,
            category: c.category,
            status: c.status,
            memo: c.memo,
            photoUrls: c.photoUrls,
          })) ?? [],
        notes:
          v.notes?.map((n) => ({
            id: n.id,
            content: n.content,
            tags: n.tags,
            userId: n.userId,
            locationLat: n.locationLat ? Number(n.locationLat) : null,
            locationLng: n.locationLng ? Number(n.locationLng) : null,
            createdAt: n.createdAt,
            media:
              n.media?.map((m) => ({
                id: m.id,
                type: m.type,
                mediaUrl: m.mediaUrl,
              })) ?? [],
          })) ?? [],
        ratings: (v.ratings ?? [])
          .filter((r) => r.userId === user.id)
          .map((r) => ({ dimension: r.dimension, score: Number(r.score) })),
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Skeleton fallbacks — approximate real layout to avoid layout shift when
// each Suspense boundary resolves.
// ---------------------------------------------------------------------------

// RatingSkeleton removed in PR #3: RatingSection now renders synchronously,
// no Suspense fallback needed for the input UI. The partner overlay's
// Suspense uses `null` as fallback (= invisible while streaming).

function EstimatesSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function ReviewsSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function PlansSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function VisitsSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

async function MemosContent({
  venueId,
  projectId,
}: {
  venueId: string;
  projectId: string;
}) {
  const user = await requireUser();
  const memos = await getVenueMemos(venueId);
  const allMembers = await prisma.projectMember.findMany({
    where: { projectId },
    select: { userId: true },
  });
  const partnerUserId = allMembers.find((m) => m.userId !== user.id)?.userId ?? undefined;
  return (
    <VenueMemoSection
      venueId={venueId}
      memos={memos}
      currentUserId={user.id}
      partnerUserId={partnerUserId}
    />
  );
}

function MemosSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-24 w-full rounded-2xl" />
    </div>
  );
}

function SimilarVenuesSkeleton() {
  // Mirrors the carousel layout so the section doesn't pop-in with
  // layout shift once `getSimilarVenues` resolves. We show 3 cards
  // (roughly what fits on 375px) at the same 4:5 aspect as the real
  // card photos.
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-40" />
      <div className="-mx-5 flex gap-4 overflow-hidden px-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="min-w-[220px] shrink-0 space-y-2">
            <Skeleton className="aspect-[4/5] w-full rounded-2xl" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
