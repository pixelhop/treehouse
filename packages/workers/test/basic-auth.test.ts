import type { H3Event } from "h3";
import { describe, expect, it } from "vite-plus/test";
import { createBasicAuth } from "../server/utils/basic-auth";

// `createBasicAuth().check()` reads the Authorization header via h3's
// `getHeader` (which resolves `event.node.req.headers`) and writes the decoded
// user onto `event.context.auth`. A minimal stub event with those two shapes is
// enough to exercise the logic without a running server.
function makeEvent(authorization?: string): H3Event {
  return {
    node: { req: { headers: authorization ? { authorization } : {} } },
    context: {},
  } as unknown as H3Event;
}

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

describe("createBasicAuth().check", () => {
  const auth = createBasicAuth({ username: "admin", password: "s3cret" });

  it("returns true for a Basic header with matching credentials", () => {
    expect(auth.check(makeEvent(basicHeader("admin", "s3cret")))).toBe(true);
  });

  it("returns false when the password is wrong", () => {
    expect(auth.check(makeEvent(basicHeader("admin", "nope")))).toBe(false);
  });

  it("returns false for a non-Basic (Bearer) scheme", () => {
    expect(auth.check(makeEvent("Bearer sometoken"))).toBe(false);
  });

  it("returns false when no Authorization header is present", () => {
    expect(auth.check(makeEvent())).toBe(false);
  });

  it("sets context.auth.session.user to the decoded username on a Basic parse", () => {
    const event = makeEvent(basicHeader("admin", "s3cret"));
    auth.check(event);
    expect(event.context.auth.session.user).toBe("admin");
  });
});