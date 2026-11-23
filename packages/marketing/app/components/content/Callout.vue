<script lang="ts" setup>
// ::callout{type="note|info|warning|tip|agent"} - an aside in a docs page.
// The markdown twin (server/utils/docs-markdown.ts) renders it as a blockquote
// with the same label, so keep CALLOUT_LABELS there in step with `labels` here.
import IconInfo from "~icons/solar/info-circle-linear";
import IconWarning from "~icons/solar/danger-triangle-linear";
import IconTip from "~icons/solar/lightbulb-linear";
import IconAgent from "~icons/solar/magic-stick-3-linear";

type CalloutType = "note" | "info" | "warning" | "tip" | "agent";

const props = defineProps<{
  type?: string;
  title?: string;
}>();

const styles: Record<CalloutType, { box: string; icon: string; component: object; label: string }> =
  {
    note: {
      box: "bg-parchment ring-border",
      icon: "text-bark",
      component: IconInfo,
      label: "Note",
    },
    info: {
      box: "bg-mist/60 ring-sage/60",
      icon: "text-leaf-deep",
      component: IconInfo,
      label: "Info",
    },
    tip: {
      box: "bg-mist/60 ring-sage/60",
      icon: "text-leaf-deep",
      component: IconTip,
      label: "Tip",
    },
    warning: {
      box: "bg-wood/10 ring-wood/40",
      icon: "text-bark",
      component: IconWarning,
      label: "Warning",
    },
    agent: {
      box: "bg-sky/45 ring-sky-deep/25",
      icon: "text-sky-deep",
      component: IconAgent,
      label: "For agents",
    },
  };

const style = computed(
  () => styles[(props.type as CalloutType) in styles ? (props.type as CalloutType) : "note"],
);
</script>

<template>
  <aside
    :class="['callout not-prose my-7 flex gap-3.5 rounded-xl p-5 ring-1 ring-inset', style.box]"
  >
    <component
      :is="style.component"
      aria-hidden="true"
      :class="['mt-0.5 size-5 flex-none', style.icon]"
    />
    <div class="min-w-0 flex-auto">
      <p class="m-0 font-semibold text-fg">{{ title || style.label }}</p>
      <div class="callout-body docs-prose mt-1.5 text-[0.9375rem]">
        <slot />
      </div>
    </div>
  </aside>
</template>