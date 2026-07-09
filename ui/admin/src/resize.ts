// Client-side image downscale before upload (decision #14): the server never
// resizes (no sharp on the minimal VPS), it only validates. CMS images are
// capped at 1600px on the long edge and re-encoded as JPEG (quality 0.85) —
// which also strips EXIF metadata — unless the source is a PNG that's already
// small and within bounds, which passes through untouched (JPEG would smear
// screenshots/diagrams).
//
// NOTE on testing: jsdom implements neither createImageBitmap nor a real
// canvas, so this module can't be exercised by unit tests; it's covered by
// its structure (small, linear, no branching beyond the pass-through) and by
// use in the browser. The page tests mock it.

export interface ResizedImage {
  blob: Blob;
  mime: string;
}

const MAX_EDGE = 1600; // CMS long-edge cap (decision #14)
const JPEG_QUALITY = 0.85;
const SMALL_PNG_BYTES = 512 * 1024; // PNGs under this and within the edge cap pass through

/** Decode, downscale and re-encode an image file; rejects if it can't be
 *  decoded (not actually an image, or a format the browser doesn't know).
 *  maxEdge defaults to the CMS cap; brand slots pass their own (#15). */
export async function resizeImage(file: File, maxEdge = MAX_EDGE): Promise<ResizedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} is not a decodable image`);
  }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === 'image/png' && file.size <= SMALL_PNG_BYTES) {
      return { blob: file, mime: 'image/png' };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d context unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (blob === null) throw new Error(`could not re-encode ${file.name}`);
    return { blob, mime: 'image/jpeg' };
  } finally {
    bitmap.close();
  }
}
