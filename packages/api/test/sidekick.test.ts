import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { describe, expect, it } from "vite-plus/test";
import { sidekickCheckoutMetadata, sidekickReferral } from "../server/utils/sidekick";

function requestWithCookie(cookie?: string) {
  const req = new IncomingMessage(new Socket());
  if (cookie) req.headers.cookie = cookie;
  return createEvent(req, new ServerResponse(req));
}

// The cookie is set by a script on another site and travels in every request
// to the API, so its value is untrusted. Only something shaped like a Sidekick
// referral id may reach Stripe metadata.

describe("sidekickReferral", () => {
  it("accepts a Sidekick referral id", () => {
    expect(sidekickReferral("cmhx2k9vq0001l80g8f3a2b1c")).toBe("cmhx2k9vq0001l80g8f3a2b1c");
    expect(sidekickReferral("  cmhx2k9vq0001l80g8f3a2b1c ")).toBe("cmhx2k9vq0001l80g8f3a2b1c");
  });

  it("sends nothing when there is no referral", () => {
    expect(sidekickReferral(undefined)).toBeNull();
    expect(sidekickReferral(null)).toBeNull();
    expect(sidekickReferral("")).toBeNull();
    expect(sidekickReferral("   ")).toBeNull();
  });

  it("refuses anything that is not shaped like an id", () => {
    expect(sidekickReferral("a".repeat(65))).toBeNull();
    expect(sidekickReferral("ref; other=1")).toBeNull();
    expect(sidekickReferral("<script>")).toBeNull();
    expect(sidekickReferral("ref id")).toBeNull();
  });
});

describe("sidekickCheckoutMetadata", () => {
  it("puts the referral cookie on the checkout as sidekick_referral", () => {
    // Set by the script with encodeURIComponent, alongside the session cookie.
    const event = requestWithCookie(
      "better-auth.session_token=abc; sk_ref=cmhx2k9vq0001l80g8f3a2b1c; ph_x=1",
    );
    expect(sidekickCheckoutMetadata(event)).toEqual({
      sidekick_referral: "cmhx2k9vq0001l80g8f3a2b1c",
    });
  });

  it("adds no metadata without a usable referral cookie", () => {
    expect(sidekickCheckoutMetadata(requestWithCookie())).toBeUndefined();
    expect(sidekickCheckoutMetadata(requestWithCookie("other=1"))).toBeUndefined();
    expect(sidekickCheckoutMetadata(requestWithCookie("sk_ref=%3Cscript%3E"))).toBeUndefined();
  });
});