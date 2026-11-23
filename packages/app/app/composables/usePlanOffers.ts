import { useQuery } from "@tanstack/vue-query";
import { formatMoney, perMonth } from "shared";
import type { PlanOffer } from "~/composables/useTreehouseApi";

// The plan catalogue with live prices, fetched once and shared.
//
// One query for every place that asks for money — the sidebar, the 402 notice,
// the create dialog, onboarding — so they can never quote different numbers at
// each other. Prices change roughly annually, hence the long staleTime.

export function usePlanOffers() {
  const api = useTreehouseApi();
  const query = useQuery({
    queryKey: ["plans"],
    queryFn: () => api.plans(),
    staleTime: 10 * 60 * 1000,
    // A pricing blip must not spin forever in front of someone mid-purchase.
    retry: 1,
  });

  return {
    plans: computed<PlanOffer[]>(() => query.data.value?.plans ?? []),
    /** False on a self-hosted deployment with nothing to sell. */
    available: computed(() => query.data.value?.available === true),
    loading: computed(() => query.isPending.value),
    failed: computed(() => query.isError.value),
  };
}

// Formatting is shared with the marketing homepage, which quotes the same
// prices. Re-exported so the auto-imported names stay where callers expect.
export { formatMoney, perMonth };

/** Percent saved by paying yearly, or null when there is nothing to compare. */
export function annualSaving(offer: PlanOffer): number | null {
  if (!offer.monthly || !offer.annual) return null;
  const yearlyAtMonthlyRate = offer.monthly.unitAmount * 12;
  if (yearlyAtMonthlyRate <= 0) return null;
  const saved = 1 - offer.annual.unitAmount / yearlyAtMonthlyRate;
  const pct = Math.round(saved * 100);
  // Only worth a badge if it is actually a saving.
  return pct > 0 ? pct : null;
}