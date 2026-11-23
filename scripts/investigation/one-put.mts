// One PUT through the flaky proxy. Prints what the CLIENT saw.
const [base, ws, key, path] = process.argv.slice(2);
try {
  const res = await fetch(`${base}/api/workspaces/${ws}/files/${path}`, {
    method: "PUT",
    headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
    body: "# hello\n",
  });
  console.log("client saw:", res.status, await res.text());
} catch (e) {
  console.log(
    "client saw ERROR:",
    (e as Error).message,
    "cause:",
    String((e as any).cause?.message ?? ""),
  );
}