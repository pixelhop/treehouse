// Test-only Worker for runtime.test.ts: writes a request body into the same
// local R2 bucket the blob Worker reads, so the test can seed ciphertext the
// way the API's R2 driver would. Never deployed; nothing imports it.
export default {
  async fetch(request, env) {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    await env.BLOBS.put(key, await request.arrayBuffer());
    return new Response("stored");
  },
};