import { defineEventHandler } from "h3";
import { hostname } from "node:os";
import { requireInternalJobSecret } from "../../../../utils/internal-job";
import { keyRotationStatus } from "../../../../utils/key-maintenance";
import { resolveKekRing } from "../../../../utils/workspace-keys";

// Where a key rotation has got to: which master key each data key is sealed
// under, which data-key generations are in use, and what this pod's last
// maintenance run did. Counts and key ids only, never key material.
export default defineEventHandler(async (event) => {
  requireInternalJobSecret(event);
  const ring = resolveKekRing();
  if (!ring) return { encrypted: false };
  return {
    encrypted: true,
    pod: hostname(),
    ...(await keyRotationStatus(ring)),
  };
});