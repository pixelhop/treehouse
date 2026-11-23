// Poll the workspace change feed for live collision detection. The app's first
// polling consumer: it uses the reliable seq cursor (changesSince), advancing
// `head` each tick and handing fresh events to a callback. Polling only runs
// while `enabled` is true (i.e. a file is open for editing) so an idle workspace
// makes no requests. `head` is seeded to the current max on start, so we only
// react to changes that land after editing begins.
//
// Second call site: the commented reading view polls the same way, but opts
// into comment events (`includeComments`) so a thread posted elsewhere shows up
// within a cycle. Comment traffic stays invisible to every other caller.
import type { Ref } from "vue";
import type { ChangeFeedEvent } from "~/composables/useTreehouseApi";

export function useChangeFeedPoll(
  workspaceId: Ref<string | undefined>,
  enabled: Ref<boolean>,
  onEvents: (events: ChangeFeedEvent[]) => void,
  intervalMs = 5000,
  opts: { includeComments?: boolean } = {},
) {
  const api = useTreehouseApi();
  const since = opts.includeComments ? api.changesSinceWithComments : api.changesSince;
  let head = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  async function tick() {
    const id = workspaceId.value;
    if (!id || inFlight) return;
    inFlight = true;
    try {
      const res = await since(id, head);
      // Disabled (file closed / unmounted) while the request was in flight —
      // drop the result rather than pushing a stale update.
      if (!enabled.value) return;
      const fresh = res.changes.filter((c) => c.seq > head);
      // Advance on `nextSeq` (the last *scanned* seq, ACL-blind) so we neither
      // skip a visible event beyond a truncated page nor stall on a page that is
      // fully filtered out for us. It never exceeds head and is monotonic from
      // `sinceSeq`. Fall back to head for a server that predates nextSeq.
      head = res.nextSeq ?? Math.max(head, res.head);
      if (fresh.length) onEvents(fresh);
    } catch {
      // Transient (offline / auth blip) — retry on the next tick.
    } finally {
      inFlight = false;
    }
  }

  async function seedHead() {
    const id = workspaceId.value;
    if (!id) return;
    try {
      head = (await since(id, head)).head;
    } catch {
      // leave head as-is; first tick will still advance it
    }
  }

  // Generation token: every start/stop bumps it so a start() whose seedHead is
  // still in flight when enabled toggles off→on again is superseded and won't
  // install a second (leaked) interval.
  let gen = 0;
  function stop() {
    gen += 1;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function start() {
    if (timer || !import.meta.client) return;
    const myGen = (gen += 1);
    void seedHead().then(() => {
      if (myGen === gen && enabled.value && !timer) {
        timer = setInterval(() => void tick(), intervalMs);
      }
    });
  }

  watch(
    enabled,
    (on) => {
      if (on) start();
      else stop();
    },
    { immediate: true },
  );
  onScopeDispose(stop);
}