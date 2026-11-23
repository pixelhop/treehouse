// A fault-injecting proxy in front of the API: forwards every request to the
// origin, then (for PUTs) drops the client connection WITHOUT answering — the
// exact shape of the `fetch failed` / `terminated` errors all over the real
// daemon log. Counts how many times the ORIGIN sees each request, so a
// client-side or transport-level retry shows up as duplicate origin hits.
import { createServer, request } from "node:http";

const ORIGIN = { host: "localhost", port: 3010, family: 0 as const };
const counts = new Map<string, number>();
const queued = new Map<string, number>();
let dropped = 0;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const k = `${req.method} ${req.url}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    console.log(JSON.stringify({ ev: "origin-hit", n: counts.get(k), k, bytes: body.length }));
    const up = request(
      {
        ...ORIGIN,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `localhost:${ORIGIN.port}` },
      },
      (ur) => {
        const ub: Buffer[] = [];
        ur.on("data", (c) => ub.push(c));
        ur.on("end", () => {
          queued.set(k, Math.max(0, (queued.get(k) ?? 1) - 1));
          // The origin has now COMMITTED the write. Drop the client connection
          // without answering — the client sees a transport failure, the server
          // saw a successful write.
          const rate = Number(process.env.INV_DROP_RATE ?? (process.env.INV_DROP === "1" ? 1 : 0));
          if (req.method === "PUT" && Math.random() < rate) {
            dropped++;
            console.log(JSON.stringify({ ev: "drop", k, originStatus: ur.statusCode }));
            res.socket?.destroy();
            return;
          }
          res.writeHead(ur.statusCode ?? 500, ur.headers as any);
          res.end(Buffer.concat(ub));
        });
      },
    );
    up.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    up.end(body);
  });
});
server.listen(3011, () =>
  console.log(JSON.stringify({ ev: "proxy-up", port: 3011, drop: process.env.INV_DROP === "1" })),
);
process.on("SIGTERM", () => {
  console.log(
    JSON.stringify({
      ev: "summary",
      dropped,
      distinct: counts.size,
      hits: [...counts.entries()].filter(([, n]) => n > 1),
    }),
  );
  process.exit(0);
});