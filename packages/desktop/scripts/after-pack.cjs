// Ad-hoc sign the packaged .app when we have no Developer ID certificate.
//
// Without this an unsigned build ships with NO bundle signature at all:
// electron-builder skips its signing pass, leaving only the linker's automatic
// ad-hoc signature on the main executable (mandatory on Apple Silicon). That
// signature declares resources must be present while `Contents/_CodeSignature`
// does not exist, so `codesign --verify` fails and macOS reports the app as
// "damaged and can't be opened" — with no user-side workaround, because macOS 15
// removed the Control-click → Open bypass for unnotarized apps.
//
// An ad-hoc bundle signature does not make the app notarized or Gatekeeper-
// trusted; the user still clears it once via Privacy & Security. It makes the
// bundle structurally VALID so it can launch at all.
//
// Runs only when CSC_LINK is empty. With a real certificate this is a no-op and
// electron-builder's own signing pass handles everything.
//
// ── TREEHOUSE_SELFSIGN_IDENTITY: making alpha builds AUTO-UPDATABLE ──
//
// Ad-hoc is the default, but it makes auto-update structurally impossible.
// electron-updater delegates the macOS install to Squirrel.Mac, which validates
// the downloaded bundle against the RUNNING app's designated requirement. Signed
// ad-hoc, that requirement is a hash of this exact binary:
//
//   designated => cdhash H"8ee02f07…"
//
// which no other build can ever satisfy — so every update is rejected after a
// full download, silently.
//
// Signing with a self-signed certificate instead anchors the requirement to the
// CERTIFICATE rather than the bytes:
//
//   designated => identifier "io.treehouse.desktop" and certificate root = H"9e05…"
//
// which every future build signed with the same cert satisfies. That is all
// Squirrel.Mac checks, and it does NOT require the cert to be trusted — trust is
// a Gatekeeper concern, and an un-notarized alpha is cleared through Privacy &
// Security once either way. So this buys a working update path with no Apple
// Developer Program membership.
//
// The certificate is therefore load-bearing STATE, not a build detail: lose the
// .p12 and every installed self-signed build is stranded on its current version
// with no way to update it, exactly as losing a Developer ID cert would.
//
// The daemon's Team-ID gate needs no change — a self-signed cert carries no
// TeamIdentifier, so `parseTeamId` returns null and the existing
// TREEHOUSE_ALLOW_ADHOC_DAEMON hatch accepts it (see src/daemon.ts).
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK) return;

  // A self-signed identity (SHA-1 hash or common name) when one is configured,
  // else "-" for ad-hoc. Same codesign invocations either way.
  const identity = process.env.TREEHOUSE_SELFSIGN_IDENTITY || "-";
  const kind = identity === "-" ? "ad-hoc" : `self-signed (${identity})`;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // Sign the bundled daemon EXPLICITLY, before the outer app.
  //
  // `--deep` below does not reach it: a bare executable under Contents/Resources
  // is not a standard nested-code location, so codesign skips it. Today it still
  // verifies, but only because the SEA build happens to leave a linker ad-hoc
  // signature on it. That is incidental — if it ever stopped, the daemon would
  // ship unsigned, `codesign --verify` would fail, and reconcileDaemon would
  // refuse to install it, dead-ending onboarding exactly as the missing bundle
  // signature did. Sign it here so the guarantee is explicit.
  //
  // Deliberately NOT `--options runtime`: hardened runtime without the JIT
  // entitlements would break this V8-based binary at runtime, and granting it
  // the app's entitlements would over-permission a network-facing daemon. The
  // signed release path handles that separately via `binaries` +
  // `entitlementsInherit`.
  execFileSync(
    "codesign",
    ["--force", "--sign", identity, join(app, "Contents/Resources/daemon")],
    { stdio: "inherit" },
  );

  // --options runtime + entitlements mirror the signed path, so the hardened
  // runtime behaves the same in alpha as it will in a real release.
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--entitlements",
      join(__dirname, "..", "build", "entitlements.mac.plist"),
      app,
    ],
    { stdio: "inherit" },
  );
  // Fail the BUILD rather than ship another bundle macOS refuses to launch.
  execFileSync("codesign", ["--verify", "--strict", "--deep", app], { stdio: "inherit" });

  // When self-signing, assert the thing we are actually buying: a designated
  // requirement anchored to the CERTIFICATE. A cdhash requirement here means the
  // signature silently fell back to ad-hoc, and the build would ship looking
  // signed while being un-updatable — the exact failure this flag exists to fix,
  // and one that is invisible until a release fails to reach anyone.
  if (identity !== "-") {
    const dr = execFileSync("codesign", ["-d", "-r-", app], { encoding: "utf8" });
    if (!/designated =>.*certificate/.test(dr) || /designated =>\s*cdhash/.test(dr)) {
      throw new Error(
        `self-signed build produced a non-certificate designated requirement — auto-update would be impossible:\n${dr}`,
      );
    }
  }
  console.log(`  • ${kind} signed + verified ${app}`);
};