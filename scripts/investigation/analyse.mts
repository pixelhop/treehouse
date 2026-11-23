// Scan an engine trace for two things the incident note describes:
//   * overlapping PUTs for the SAME path (concurrent writes from one client)
//   * repeated PUTs of identical bytes to one path
import { readFileSync } from "node:fs";
const path = process.argv[2];
const lines = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean) as any[];
const open = new Map<string, any[]>();
let overlaps = 0;
const sends = new Map<string, any[]>();
for (const e of lines) {
  if (e.event === "put:send") {
    const cur = open.get(e.path) ?? [];
    if (cur.length) {
      overlaps++;
      console.log(`OVERLAPPING PUT ${e.path}: ${cur.length + 1} in flight at t=${e.t}`);
    }
    open.set(e.path, [...cur, e]);
    sends.set(e.path, [...(sends.get(e.path) ?? []), e]);
  }
  if (e.event === "put:recv") open.set(e.path, (open.get(e.path) ?? []).slice(1));
}
console.log(`overlapping-put events: ${overlaps}`);
for (const [p, es] of sends) {
  const byHash = new Map<string, number>();
  for (const e of es) byHash.set(e.hash, (byHash.get(e.hash) ?? 0) + 1);
  for (const [h, n] of byHash) if (n > 1) console.log(`REPEATED PUT x${n} of ${h} -> ${p}`);
}