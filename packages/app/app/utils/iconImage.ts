// Client-side preparation of an uploaded workspace icon.
//
// Everything is normalized to a square PNG before it leaves the browser: a logo
// arrives as anything (a 4MB photo-sized PNG, a wide SVG wordmark, a JPEG
// screenshot) and has to render at 24–48px in the switcher. Doing it here means
// the API stores one small, predictable format — and a big source image doesn't
// bounce off the upload limit for no reason.

/** Edge of the stored square. 256 covers a 48px tile at 3× and stays tiny. */
export const ICON_SIZE = 256;

/** What the file input accepts. SVG is allowed in, but is rasterized to PNG
 *  below — the API never stores SVG (it can carry script). */
export const ICON_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

/** Refuse absurd source files before decoding them. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * Logos are often shipped as white-on-transparent, for use on a dark header.
 * Dropped straight onto the light icon tile, such a file renders as an empty
 * square — the upload "worked" and shows nothing. So near-white artwork gets
 * composited onto Charcoal (the brand's foreground ink) at prepare time, which
 * makes the stored PNG legible on any surface instead of depending on one.
 */
const DARK_BACKDROP = "#2B2F33";

/** Mean luminance (0–1) above which artwork counts as "too light for a light
 *  tile". Set high so only genuinely white-ish logos are treated. */
const LIGHT_ARTWORK_LUMINANCE = 0.8;

export class IconImageError extends Error {}

/**
 * Decode `file`, fit it inside a transparent {@link ICON_SIZE} square (contain,
 * never crop — a wordmark letterboxes rather than losing its ends) and return
 * the PNG bytes. Rejects with an IconImageError the caller can show as-is.
 */
export async function prepareIconImage(file: File | Blob): Promise<Blob> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new IconImageError("That image is too large — try one under 20MB.");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new IconImageError("Couldn't process that image in this browser.");

    // An SVG with no intrinsic size decodes to 0×0 in some browsers; there is
    // nothing to scale from, so say so rather than upload an empty square.
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new IconImageError("Couldn't read that image's size — try a PNG.");

    const scale = Math.min(ICON_SIZE / w, ICON_SIZE / h);
    const drawW = Math.max(1, Math.round(w * scale));
    const drawH = Math.max(1, Math.round(h * scale));
    const x = (ICON_SIZE - drawW) / 2;
    const y = (ICON_SIZE - drawH) / 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x, y, drawW, drawH);

    if (isLightArtwork(ctx)) {
      ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
      ctx.fillStyle = DARK_BACKDROP;
      ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
      ctx.drawImage(img, x, y, drawW, drawH);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new IconImageError("Couldn't process that image — try a PNG.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * True when the drawn artwork is nearly all light pixels — i.e. it would vanish
 * on a light tile. Only opaque-ish pixels count: the transparent surround of a
 * logo says nothing about the mark itself. Fully opaque artwork is exempt, since
 * it brings its own background and can't disappear into ours.
 */
function isLightArtwork(ctx: CanvasRenderingContext2D): boolean {
  const { data } = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
  let sum = 0;
  let counted = 0;
  let transparent = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 128) {
      transparent += 1;
      continue;
    }
    // Rec. 601 luma — close enough to perceived brightness for a threshold.
    sum += (0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)) / 255;
    counted += 1;
  }
  if (!counted || !transparent) return false;
  return sum / counted > LIGHT_ARTWORK_LUMINANCE;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new IconImageError("That file isn't an image we can read."));
    img.src = src;
  });
}