import { computed, nextTick, ref, watch } from "vue";
import { describe, expect, it, vi } from "vite-plus/test";

// Regression test for the in-flight-save race (PR #74): `save()` must baseline
// `loadedValue` on the bytes it actually SENT, not the live buffer. The editor
// stays editable while the write is in flight, so keystrokes typed then were
// never in the request — baselining the live buffer would mark them "saved",
// flip `dirty` to false, and let the service-worker updater reload the page
// over bytes that exist nowhere but this tab.
//
// useFileEditor leans on Nuxt auto-imports; this harness supplies them as
// globals (real Vue reactivity, stubbed app composables) so the composable
// runs in a plain unit test.

// What the viewers' cache holds for the open file, so a test can seed the editor.
const cache: { seed: string | undefined } = { seed: undefined };

vi.mock("@tanstack/vue-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: () => Promise.resolve(),
    setQueryData: () => {},
    getQueryData: () => cache.seed,
  }),
}));

interface WriteResult {
  ok: boolean;
  version: number;
}

function harness(
  read: () => Promise<{ body: string; version: number }> = () =>
    Promise.resolve({ body: "hello", version: 1 }),
) {
  let resolveWrite: (r: WriteResult) => void = () => {};
  const sent: string[] = [];
  const baseVersions: number[] = [];
  const api = {
    readFileWithMeta: read,
    writeFile: (_ws: string, _path: string, body: string, opts: { baseVersion: number }) => {
      sent.push(body);
      baseVersions.push(opts.baseVersion);
      return new Promise<WriteResult>((resolve) => {
        resolveWrite = resolve;
      });
    },
  };
  Object.assign(globalThis, {
    ref,
    computed,
    watch,
    onScopeDispose: () => {},
    useTreehouseApi: () => api,
    useChangeFeedPoll: () => {},
  });
  return { sent, baseVersions, resolveWrite: (r: WriteResult) => resolveWrite(r) };
}

describe("useFileEditor save()", () => {
  it("keeps the editor dirty when keystrokes land while the save is in flight", async () => {
    const h = harness();
    const { useFileEditor } = await import("../app/composables/useFileEditor");

    const entry = ref({ path: "notes.md", version: 1, contentType: "text/markdown" });
    const fe = useFileEditor(ref("ws1"), entry as never);
    await nextTick();
    await Promise.resolve(); // let load() settle
    expect(fe.buffer.value).toBe("hello");

    fe.buffer.value = "hello edited";
    const saving = fe.save();
    // The user keeps typing while the request is in flight.
    fe.buffer.value = "hello edited plus more typing";
    h.resolveWrite({ ok: true, version: 2 });
    expect(await saving).toBe(true);

    // The request carried the snapshot, not the later keystrokes…
    expect(h.sent).toEqual(["hello edited"]);
    // …and those keystrokes are still unsaved work.
    expect(fe.dirty.value).toBe(true);
  });

  it("keeps a save's version when the seeded editor's confirming read lands after it", async () => {
    let resolveRead: (r: { body: string; version: number }) => void = () => {};
    const h = harness(() => new Promise((resolve) => (resolveRead = resolve)));
    cache.seed = "hello";
    try {
      const { useFileEditor } = await import("../app/composables/useFileEditor");
      const entry = ref({ path: "notes.md", version: 1, contentType: "text/markdown" });
      const fe = useFileEditor(ref("ws1"), entry as never);
      await nextTick();
      expect(fe.buffer.value).toBe("hello"); // opened on the cached text

      fe.buffer.value = "hello edited";
      const saving = fe.save();
      h.resolveWrite({ ok: true, version: 2 });
      expect(await saving).toBe(true);

      // The read started before the save now lands, describing version 1.
      resolveRead({ body: "hello", version: 1 });
      await Promise.resolve();
      await Promise.resolve();

      // The next save must be based on version 2, or it is refused as a conflict.
      fe.buffer.value = "hello edited again";
      void fe.save();
      expect(h.baseVersions.at(-1)).toBe(2);
      expect(fe.dirty.value).toBe(true);
    } finally {
      cache.seed = undefined;
    }
  });
});