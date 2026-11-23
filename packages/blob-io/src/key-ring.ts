// Rotatable secret keys from the environment: one active key that new material
// is sealed under, plus retired keys that are still accepted when opening.
// The file-encryption KEK (BLOB_KEK) and the byte-Worker grant key
// (BLOB_WORKER_TOKEN_KEY) share the `<id>:<base64-32-byte-key>` format.

const KEY_BYTES = 32;

export interface KeyRing {
  /** The key new material is sealed under. */
  active: { id: string; key: Uint8Array };
  /** Every key available for opening, including retired ones. */
  byId: Map<string, Uint8Array>;
}

/**
 * Parse one `<id>:<base64-32-byte-key>` entry. Returns null rather than
 * throwing so the caller can attribute the failure to a specific variable.
 */
export function parseKeyEntry(entry: string): { id: string; key: Uint8Array } | null {
  const trimmed = entry.trim();
  const sep = trimmed.indexOf(":");
  if (sep <= 0) return null;
  const id = trimmed.slice(0, sep);
  const encoded = trimmed.slice(sep + 1);
  if (!id || !encoded) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
  // Buffer.from is lenient with invalid base64 (it skips bad characters), so
  // the length check is what actually validates the material.
  if (raw.byteLength !== KEY_BYTES) return null;
  return { id, key: new Uint8Array(raw) };
}

/**
 * Build a ring from an active entry and a comma-separated list of retired
 * ones. `invalid` names the variable at fault, so the thrown message can say
 * which one to fix. The active id wins a collision: a retired entry must never
 * shadow the key new material is sealed under.
 */
export function buildKeyRing(
  active: string,
  retired: string | undefined,
  invalid: (which: "active" | "retired") => Error,
): KeyRing {
  const current = parseKeyEntry(active);
  if (!current) throw invalid("active");
  const byId = new Map<string, Uint8Array>([[current.id, current.key]]);
  for (const entry of retired?.split(",") ?? []) {
    if (!entry.trim()) continue;
    const key = parseKeyEntry(entry);
    if (!key) throw invalid("retired");
    if (!byId.has(key.id)) byId.set(key.id, key.key);
  }
  return { active: current, byId };
}