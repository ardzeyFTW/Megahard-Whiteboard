import { stripImageMetadata } from './imageMeta';

export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}

/**
 * Standard shrinks and re-encodes images to save space. High keeps every pixel exactly as it
 * was, which can take several times more room. Neither keeps hidden camera or location data.
 */
export type ImageQuality = 'standard' | 'high';

const SETTINGS = {
  // Still sharp at a good zoom, but far smaller than a phone photo.
  standard: { maxDim: 1600, quality: 0.78 },
  // Longest side only capped so a huge photo can't fill a board on its own.
  high: { maxDim: 8192, quality: 1 },
};
/** Only swap to the re-encoded version when it saves at least this much. */
const MIN_SAVING = 0.15;

/**
 * Read an image (picked, dropped or pasted) and store it as the chosen quality allows.
 * Standard: downscale anything larger than 1600 px, re-encode as WebP (keeps transparency),
 * and keep the original instead when re-encoding wouldn't clearly save space.
 * High: the original pixels are kept as they are (a GIF becomes a lossless PNG still).
 * Either way, hidden data such as camera and location details is removed first: a picture
 * shared on a board shouldn't give away where it was taken.
 */
export async function prepareImage(file: Blob, quality: ImageQuality = 'standard'): Promise<{ src: string; width: number; height: number }> {
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const width = img.naturalWidth || 400;
  const height = img.naturalHeight || 300;
  // Vector images are already tiny and stay sharp at any size.
  if (file.type === 'image/svg+xml') return { src: original, width, height };

  // The original file without its hidden data, or null if this kind of file can't be cleaned that way.
  const cleaned = stripImageMetadata(new Uint8Array(await file.arrayBuffer()), file.type);
  const kept = cleaned ? await readAsDataUrl(new Blob([cleaned as Uint8Array<ArrayBuffer>], { type: file.type })) : null;

  const { maxDim, quality: q } = SETTINGS[quality];
  const s = Math.min(1, maxDim / Math.max(width, height));
  const isGif = file.type === 'image/gif';
  if (quality === 'high' && s === 1 && !isGif && kept) return { src: kept, width, height };

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * s));
  canvas.height = Math.max(1, Math.round(height * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { src: kept ?? original, width, height };
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let encoded: string;
  if (quality === 'high') {
    // Canvas can only write lossless PNG, so that's what a resized, animated or uncleanable image becomes.
    encoded = canvas.toDataURL('image/png');
  } else {
    encoded = canvas.toDataURL('image/webp', q);
    if (!encoded.startsWith('data:image/webp')) {
      // No WebP encoder (older Safari): JPEG for photos, otherwise PNG so transparency survives.
      encoded = file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', q) : canvas.toDataURL('image/png');
    }
  }
  // A GIF is shown as a still image anyway (its first frame), so it is always converted.
  const useEncoded = s < 1 || isGif || !kept || encoded.length < kept.length * (1 - MIN_SAVING);
  return useEncoded || !kept
    ? { src: encoded, width: canvas.width, height: canvas.height }
    : { src: kept, width, height };
}
