<script setup lang="ts">
import type { WorkspaceBilling } from "~/composables/useTreehouseApi";

// What adding a person to a paid workspace actually costs.
//
// The plans are sold per member, and the Stripe quantity follows the member
// list — so inviting someone genuinely changes the next invoice. Nothing said
// so. The price appeared once, on the plan card, and then the invite button sat
// there looking free.
//
// Only shown on a paid plan. On the free tier the limit is one person and the
// refusal explains itself; quoting a seat price to someone who has not bought
// anything would be an upsell dressed as information.

const props = defineProps<{ billing: WorkspaceBilling | null | undefined }>();

const { plans } = usePlanOffers();

const seatPrice = computed(() => {
  const b = props.billing;
  if (!b?.paid) return null;
  const offer = plans.value.find((p) => p.slug === b.plan);
  if (!offer) return null;
  const price = b.interval === "year" ? offer.annual : offer.monthly;
  if (!price) return null;
  return {
    amount: formatMoney(price.unitAmount, price.currency),
    per: price.interval === "year" ? "year" : "month",
  };
});
</script>

<template>
  <p v-if="seatPrice" class="text-sm text-fg-muted">
    Every member is a seat: <strong class="font-medium text-fg">{{ seatPrice.amount }}</strong> per
    {{ seatPrice.per }} each. Inviting someone adds a seat to this workspace's bill straight away,
    charged pro rata for the rest of the {{ seatPrice.per }}; removing them takes it off the same
    way.
  </p>
</template>