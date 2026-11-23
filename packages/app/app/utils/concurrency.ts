// Map over items with bounded parallelism, preserving input order in the result.
// Used to drain multi-file uploads a few at a time rather than firing every PUT
// at once (mirrors the CLI sync queue's bounded-parallelism drain).
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  let failed = false;
  const workers = Math.max(1, Math.min(limit, items.length || 1));

  async function run() {
    // Stop pulling new items once any task has thrown — no point spending more
    // requests on a batch that's already going to reject.
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}