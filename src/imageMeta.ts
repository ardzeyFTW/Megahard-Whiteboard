// Removes hidden data (camera model, GPS position, timestamps, editing history) from an image
// without touching its pixels, so a photo can be kept exactly as it was and still not give away
// where it was taken. Works on the bytes of JPEG, PNG and WebP files.

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const tag4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Bytes of "Exif" followed by two zero bytes, which starts the camera data in a JPEG. */
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];

/** The rotation flag (1 to 8) in a JPEG's camera data. Browsers turn the picture by it, so it must survive. */
function exifOrientation(seg: Uint8Array): number {
  // seg: after the segment length; starts with the Exif header, then a TIFF header.
  const t = 6;
  if (seg.length < t + 8) return 1;
  const little = seg[t] === 0x49 && seg[t + 1] === 0x49;
  if (!little && !(seg[t] === 0x4d && seg[t + 1] === 0x4d)) return 1;
  const r16 = (at: number) => (little ? seg[at] | (seg[at + 1] << 8) : u16(seg, at));
  const r32 = (at: number) => (little ? (seg[at] | (seg[at + 1] << 8) | (seg[at + 2] << 16) | (seg[at + 3] << 24)) >>> 0 : u32(seg, at));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > seg.length) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > seg.length) return 1;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** A camera-data segment holding nothing but the rotation flag. */
function orientationOnly(orientation: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xe1, 0x00, 0x22, ...EXIF_HEADER,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian, first directory right after this header
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // orientation
    0x00, 0x00, 0x00, 0x00, // no further directories
  ]);
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++; // padding
      continue;
    }
    // Start of scan: the picture data follows to the end, untouched.
    if (marker === 0xda) {
      parts.push(b.subarray(at));
      return join(parts);
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    const len = u16(b, at + 2);
    if (len < 2 || at + 2 + len > b.length) return null;
    const seg = b.subarray(at, at + 2 + len);
    const body = seg.subarray(4);
    if (marker === 0xe1) {
      // Camera data keeps only the rotation; other APP1 data (XMP) goes.
      if (EXIF_HEADER.every((v, i) => body[i] === v)) {
        const o = exifOrientation(body);
        if (o !== 1) parts.push(orientationOnly(o));
      }
    } else if (marker === 0xed || marker === 0xfe) {
      // Photoshop/IPTC data (captions, credits) and comments.
    } else parts.push(seg);
    at += 2 + len;
  }
  return null; // never reached the picture data: not something to trust
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Uint8Array): Uint8Array | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 || !sig.every((v, i) => b[i] === v)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= b.length) {
    const len = u32(b, at);
    const end = at + 12 + len;
    if (end > b.length) return null;
    const type = tag4(b, at + 4);
    if (!PNG_DROP.has(type)) parts.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') return join(parts);
  }
  return null;
}

function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 12 || tag4(b, 0) !== 'RIFF' || tag4(b, 8) !== 'WEBP') return null;
  const parts: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= b.length) {
    const type = tag4(b, at);
    const len = (b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24)) >>> 0;
    if (at + 8 + len > b.length) return null;
    const next = at + 8 + len + (len & 1); // chunks are padded to an even length
    const chunk = b.slice(at, Math.min(next, b.length));
    // The extended header lists which hidden-data chunks are present: clear those flags.
    if (type === 'VP8X') chunk[8] &= ~(0x08 | 0x04);
    if (type !== 'EXIF' && type !== 'XMP ') parts.push(chunk);
    at = next;
  }
  const body = join(parts);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  const size = body.length + 4;
  head[4] = size & 0xff;
  head[5] = (size >> 8) & 0xff;
  head[6] = (size >> 16) & 0xff;
  head[7] = (size >>> 24) & 0xff;
  return join([head, body]);
}

/**
 * The same picture without hidden data, or null when this kind of file can't be cleaned this way
 * (or isn't what it says it is). Types that never carry such data come back unchanged.
 */
export function stripImageMetadata(bytes: Uint8Array, mime: string): Uint8Array | null {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    case 'image/bmp':
      return bytes;
    default:
      return null;
  }
}
