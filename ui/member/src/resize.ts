// Client-side image downscale (decision #14): the server never resizes —
// the uploading UI shrinks to the long-edge cap and re-encodes as JPEG,
// which also strips EXIF (no GPS coordinates in uploads) and keeps uploads
// under the server's size caps. Profile photos use the 512px default
// (256KB cap); listing photos pass 1200 (1MB cap, phase 3).
//
// jsdom has no canvas implementation, so tests mock this module instead of
// exercising it; the flow around it (resize -> upload -> refresh) is what
// the tests assert.

const JPEG_QUALITY = 0.85;

export interface ResizedImage {
  blob: Blob;
  mime: string;
}

export async function resizeImage(file: Blob, maxEdge = 512): Promise<ResizedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d context unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result === null ? reject(new Error('image encoding failed')) : resolve(result),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
    return { blob, mime: 'image/jpeg' };
  } finally {
    bitmap.close();
  }
}
