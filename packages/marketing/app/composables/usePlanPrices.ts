import type { PlanOffer } from "~/utils/planPricing";

// The live plan catalogue, read from the API's public `/api/plans`.
//
// The same endpoint the app's plan picker reads, so the homepage cannot quote a
// price checkout does not charge. The amounts are configured in Stripe and
// nowhere else; there is deliberately no fallback table here, because a
// fallback table is how a pricing page ends up advertising one figure and
// billing another. If the API cannot be reached, the cards say where to find
// the price instead of inventing one.
export function usePlanPrices() {
  const { apiUrl } = useRuntimeConfig().public;
  const plans = ref<PlanOffer[]>([]);
  const loading = ref(true);

  onMounted(async () => {
    try {
      // No cookies: this is the public price list, and the API only grants
      // other origins a cookie-free read of it.
      const res = await $fetch<{ available: boolean; plans: PlanOffer[] }>("/api/plans", {
        baseURL: apiUrl,
        credentials: "omit",
      });
      plans.value = res.available ? res.plans : [];
    } catch {
      plans.value = [];
    } finally {
      loading.value = false;
    }
  });

  return { plans, loading };
}