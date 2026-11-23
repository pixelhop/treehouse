import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const R2_VARS = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

/**
 * Point the blob store at a throwaway temp directory for the duration of a test
 * file, and force the filesystem driver by clearing EVERY R2 variable.
 *
 * Clearing all four matters twice over. `./env` loads the package `.env`, which
 * on a real developer machine holds live R2 credentials — so a test that only
 * unsets some of them either resolves to the REAL bucket (reading and writing
 * production blobs from a test run) or trips `resolveBlobStore`'s partial-config
 * guard and fails to boot. Neither is acceptable, and which one you get depends
 * on which vars the test happened to delete.
 *
 * Call this AFTER `import "./env"` and BEFORE dynamic-importing anything under
 * `server/` — the blob store is memoized on first resolution.
 */
export function useTempBlobDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.BLOB_DIR = dir;
  for (const v of R2_VARS) delete process.env[v];
  return dir;
}