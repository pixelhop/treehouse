# Sync investigation harness

Built for the August 2026 conflicted-copy investigation; kept because the
questions recur. Findings:
`docs/solutions/bugs/sync-baseline-and-conflict-bursts.md`.

Needs a running API (`pnpm dev:api`, port 3010) and a database.

```sh
SMOKE_BASE=http://localhost:3010 node_modules/.bin/tsx scripts/investigation/drive.mts <scenario>
```

Each run provisions a throwaway account + workspace, starts a real sync engine
with every API call traced to `<root>.trace.jsonl`, drives one scenario, then
reports local vs remote content hashes, duplicate conflicted copies (grouped by
content), and any path where local and remote disagree.

| scenario                           | what it exercises                                                     |
| ---------------------------------- | --------------------------------------------------------------------- |
| `s1-create-wait-edit`              | baseline: create, wait for ack, edit                                  |
| `s2-create-edit-immediate`         | create and edit inside the watcher's debounce                         |
| `s3-copy-rebase`                   | copy a note, immediately rebase its links                             |
| `s4-rapid-patches`                 | several patches in quick succession                                   |
| `s5-move-repair`                   | move a file, immediately repair its links                             |
| `s6-copy-pause-rebase`             | the same with a deliberate pause                                      |
| `s7-two-writer`                    | control: a genuine two-writer conflict (expects exactly one copy)     |
| `s9-chaos`                         | 200 files under a continuous edit batch with frequent full reconciles |
| `s10-two-process`                  | daemon engine plus a manual one-shot `treehouse sync`                 |
| `s11-two-devices` / `s12-both-new` | two sync clients on one workspace                                     |
| `s13-burst-hunt`                   | two devices plus a slow origin                                        |
| `s14-flaky-origin`                 | one device, origin drops responses after committing                   |

Knobs: `INV_POLL_MS`, `INV_RECONCILE_MS`, `INV_CHAOS_MS`, `INV_PUT_DELAY_MS`,
`INV_ENGINES`, `INV_TWIN_PUT_DELAY_MS`, `INV_REBASE_GAP_MS`.

`reload-race.mts` runs the **real daemon** in its own `TREEHOUSE_HOME` over a
folder big enough for a slow bootstrap, sends `reload` during it, and counts how
many engines end up watching the one root. `INV_RELOADS`, `INV_SETTLE_MS` (allow
enough settle time — a duplicate still bootstrapping when the daemon is killed
never reaches its `watching` line, and the leak reads as absent).

`analyse.mts <trace>` reports overlapping or repeated PUTs per path. (A PUT whose
response never arrives has no `put:recv`, so it stays "open" and is reported as an
overlap — read those alongside the drop log.)

`flaky-proxy.mts` sits in front of the API (`:3011` → `:3010`) and, for a
configurable fraction of PUTs (`INV_DROP_RATE`), lets the origin commit and then
destroys the client connection — the `fetch failed` shape the production daemon
log is full of. Point a scenario at it with `SMOKE_BASE=http://127.0.0.1:3011`.