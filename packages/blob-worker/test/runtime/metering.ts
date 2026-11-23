// Test-only Worker for runtime.test.ts: runs meteredBody against workerd's real
// FixedLengthStream and reports what it counted when the reader takes nothing,
// one chunk, or everything. Never deployed; started by config path only.
import { meteredBody } from "../../src/body";

const CHUNK = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* chunks(n: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < n; i++) yield new Uint8Array(CHUNK).fill(i);
}

/** Read `take` chunks (all of them when Infinity), cancel, and report the count. */
async function scenario(take: number): Promise<{ counted: number; read: number }> {
  let counted = -1;
  const body = meteredBody(chunks(3), 3 * CHUNK, (sent) => {
    counted = sent;
  });
  const reader = body.getReader();
  // Give the pump every chance to run ahead of the reader.
  await sleep(50);
  let read = 0;
  for (let i = 0; i < take; i++) {
    const next = await reader.read();
    if (next.done) break;
    read += next.value.byteLength;
  }
  if (take !== Infinity) await reader.cancel();
  for (let i = 0; i < 50 && counted < 0; i++) await sleep(10);
  return { counted, read };
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      none: await scenario(0),
      one: await scenario(1),
      all: await scenario(Infinity),
    });
  },
};