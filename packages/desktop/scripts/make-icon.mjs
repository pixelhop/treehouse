import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Compose the macOS app icon (build/icon.icns) from the brand illustration in
// assets/logo.png, laid out on Apple's icon grid: a 1024 canvas with an 824
// rounded-rect tile inset 100px on every side, artwork centred inside it.
//
// This is a DEV-TIME script, not part of the packaging pipeline: it needs
// ImageMagick (`brew install imagemagick`) and macOS `iconutil`, neither of which
// the release runner installs. The generated icon.icns is COMMITTED, so CI just
// consumes the artifact — run this only when the artwork or layout changes.
//
// Swapping in new artwork is one command: replace assets/logo.png (a square-ish
// transparent PNG, ~1200px, already trimmed of its margins) and re-run.

const dir = fileURLToPath(new URL("..", import.meta.url));

/** Icon grid (Apple's macOS template): canvas, tile, and corner radius. */
export const GRID = { canvas: 1024, tile: 824, radius: 185, art: 700 };

/** Vertical background gradient — sky above, warm ground-light below. Chosen to
 * sit behind the green canopy without competing with it. */
const GRADIENT = "#8ecae6-#fdf3dc";

// The `.icns` sizes macOS expects. Each entry is (points, scale): Finder, the
// Dock, and Get Info each pick a different one, and a missing size is silently
// substituted with a blurry resample of another.
const ICONSET = [
  [16, 1],
  [16, 2],
  [32, 1],
  [32, 2],
  [128, 1],
  [128, 2],
  [256, 1],
  [256, 2],
  [512, 1],
  [512, 2],
];

const magick = (args) => execFileSync("magick", args, { stdio: "inherit" });

function main() {
  const tmp = mkdtempSync(join(tmpdir(), "th-icon-"));
  const { canvas, tile, radius, art } = GRID;
  try {
    const mask = join(tmp, "mask.png");
    const bg = join(tmp, "bg.png");
    const fitted = join(tmp, "art.png");
    const master = join(dir, "build", "icon.png");

    // A rounded-rect alpha mask, then the gradient clipped to it.
    magick([
      "-size",
      `${tile}x${tile}`,
      "xc:none",
      "-draw",
      `roundrectangle 0,0,${tile - 1},${tile - 1},${radius},${radius}`,
      "-alpha",
      "extract",
      mask,
    ]);
    magick(["-size", `${tile}x${tile}`, `gradient:${GRADIENT}`, bg]);
    magick([bg, mask, "-alpha", "off", "-compose", "CopyOpacity", "-composite", bg]);

    // Artwork centred on the tile, nudged down slightly: the illustration is
    // top-heavy (canopy) and sits optically high when placed on true centre.
    magick([join(dir, "assets", "logo.png"), "-resize", `${art}x${art}`, fitted]);
    magick([bg, fitted, "-gravity", "center", "-geometry", "+0+20", "-composite", bg]);

    // Inset the tile into the full canvas — the transparent margin is what gives
    // macOS room for the Dock's drop shadow.
    magick([
      "-size",
      `${canvas}x${canvas}`,
      "xc:none",
      bg,
      "-gravity",
      "center",
      "-composite",
      master,
    ]);

    // Build the .iconset and let iconutil pack it.
    const iconset = join(tmp, "icon.iconset");
    execFileSync("mkdir", ["-p", iconset]);
    for (const [pt, scale] of ICONSET) {
      const px = pt * scale;
      const name = scale === 1 ? `icon_${pt}x${pt}.png` : `icon_${pt}x${pt}@2x.png`;
      magick([master, "-resize", `${px}x${px}`, join(iconset, name)]);
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(dir, "build", "icon.icns")], {
      stdio: "inherit",
    });
    console.log("wrote build/icon.icns + build/icon.png");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Compare PATHS, not a hand-built URL. `import.meta.url` is percent-encoded, so a
// checkout containing a space (or any character a file URL escapes) makes the
// string comparison fail and the script silently do nothing when run directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();