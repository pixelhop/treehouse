import type { AccessSubject } from "../server/utils/acl";

// Access subjects for tests that drive the file service directly. Type-only
// import, so this can load before ./env.

/** A member (the default role) — writes anything no restriction keeps them from. */
export const asMember = (userId: string): AccessSubject => ({ userId, role: "member" });

/**
 * A member who holds no grants: what an actor with no user id used to mean to
 * the evaluator (open paths yes, restricted paths no).
 */
export const NO_GRANTS = asMember("test-member-without-grants");