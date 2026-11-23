<script setup lang="ts">
import type { WorkspaceUsage } from "~/composables/useTreehouseApi";
import { prettyBytes } from "~/utils/format";

const props = defineProps<{
  name: string;
  workspaceId: string;
  icon?: string | null;
  color?: string | null;
  fileCount: number;
  // null while loading or when the (non-blocking) usage fetch failed → widget hidden.
  usage: WorkspaceUsage | null;
}>();

// Fraction of the limit consumed, clamped to [0,1]; only meaningful when limited.
const fraction = computed(() => {
  const u = props.usage;
  if (!u || u.limitBytes == null || u.limitBytes <= 0) return 0;
  return Math.min(1, u.usedBytes / u.limitBytes);
});

// File count is the primary workspace limit: a gigabyte holds roughly 100,000
// markdown documents, so bytes rarely bind and the file cap is what a user
// actually meets.
const fileFraction = computed(() => {
  const u = props.usage;
  if (!u || u.limitFiles == null || u.limitFiles <= 0) return 0;
  return Math.min(1, u.usedFiles / u.limitFiles);
});
const filesWarning = computed(() => {
  const u = props.usage;
  return u?.limitFiles != null && u.usedFiles / u.limitFiles >= 0.9;
});

// Which figures are capped. An uncapped one is a plain fact and goes in the rows;
// a capped one gets a meter. Until usage loads, only the file count is known.
const limits = computed(() => ({
  files: props.usage?.limitFiles != null,
  bytes: props.usage?.limitBytes != null,
  shares: props.usage?.shareViewLimit != null,
}));
</script>

<template>
  <section class="space-y-3">
    <!-- Same header shape as the folder panel: icon, name, what kind of thing it is. -->
    <header class="flex items-center gap-3">
      <WorkspaceIcon :icon="icon" :color="color" :workspace-id="workspaceId" />
      <div class="min-w-0">
        <h3 class="truncate text-base font-semibold text-fg" :title="name">{{ name }}</h3>
        <p class="text-xs text-fg-subtle">Workspace</p>
      </div>
    </header>

    <!-- Anything without a limit is a plain fact, so it sits in the same rows the
         file and folder panels use. A limited figure gets a meter below instead. -->
    <dl class="panel-rows">
      <div v-if="!limits.files">
        <dt>Files</dt>
        <dd>{{ fileCount.toLocaleString() }}</dd>
      </div>
      <template v-if="usage">
        <div v-if="!limits.bytes">
          <dt>Storage</dt>
          <dd>{{ prettyBytes(usage.usedBytes) }} used</dd>
        </div>
        <!-- Share traffic. Framed as "your work is being read" rather than as a
             meter running down — it is the number that makes the free tier convert,
             and it should not read as a threat.
             Shown on EVERY plan: this was previously hidden whenever the limit was
             unlimited, so the paying customer lost a metric the free user got.
             "Did the client open it?" is worth more once you pay, not less. -->
        <div v-if="!limits.shares">
          <dt>Share views</dt>
          <dd :class="{ 'text-warning': usage.shareWarning }">
            {{ usage.shareViews.toLocaleString() }} this month
          </dd>
        </div>
      </template>
    </dl>

    <template v-if="usage">
      <!-- The file count carries its own bar, because it is the limit a documents
           workspace actually reaches. -->
      <UsageMeter
        v-if="limits.files"
        heading="Files"
        :fraction="fileFraction"
        :warning="filesWarning"
      >
        {{ usage.usedFiles.toLocaleString() }} of {{ usage.limitFiles?.toLocaleString() }} used
      </UsageMeter>
      <UsageMeter
        v-if="limits.bytes"
        heading="Storage"
        :fraction="fraction"
        :warning="usage.warning"
      >
        {{ prettyBytes(usage.usedBytes) }} of {{ prettyBytes(usage.limitBytes ?? 0) }} used
      </UsageMeter>
      <UsageMeter v-if="limits.shares" heading="Share views" :warning="usage.shareWarning">
        {{ usage.shareViews.toLocaleString() }} of {{ usage.shareViewLimit?.toLocaleString() }} this
        month
      </UsageMeter>
      <p v-if="usage.sharesPaused" class="text-xs text-warning">
        Your links are paused until next month.
      </p>

      <WorkspacePlan :workspace-id="workspaceId" :billing="usage.billing" />
    </template>
  </section>
</template>