import { describe, expect, it } from 'vitest';
import { stripImageMetadata } from './imageMeta';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => String.fromCharCode(...b);
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

const jpegSegment = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];

/** Camera data (big-endian) with a rotation flag and a text entry that stands in for GPS and camera details. */
function exif(orientation: number, secret: string) {
  const textBytes = [...ascii(secret), 0];
  const entries = 2;
  const textAt = 8 + 2 + entries * 12 + 4;
  return [
    ...ascii('Exif'), 0, 0,
    0x4d, 0x4d, 0x00, 0x2a, ...be32(8),
    ...be16(entries),
    ...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), 0, 0,
    ...be16(0x010f), ...be16(2), ...be32(textBytes.length), ...be32(textAt),
    ...be32(0),
    ...textBytes,
  ];
}

const SCAN = [0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0x33, 0xff, 0xd9];

function jpeg(orientation: number) {
  return Uint8Array.from([
    0xff, 0xd8,
    ...jpegSegment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...jpegSegment(0xe1, exif(orientation, 'GPS 51.5N 0.1W')),
    ...jpegSegment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta>secret-xmp</x:xmpmeta>')]),
    ...jpegSegment(0xed, ascii('Photoshop 3.0 secret-iptc')),
    ...jpegSegment(0xfe, ascii('secret-comment')),
    ...jpegSegment(0xdb, [0, 1, 2, 3, 4]),
    ...SCAN,
  ]);
}

describe('stripImageMetadata', () => {
  it('removes camera, location, XMP, IPTC and comments from a JPEG, and keeps the picture', () => {
    const out = stripImageMetadata(jpeg(1), 'image/jpeg');
    expect(out).not.toBeNull();
    const t = text(out as Uint8Array);
    for (const gone of ['GPS 51.5N', 'secret-xmp', 'secret-iptc', 'secret-comment', 'Exif']) expect(t).not.toContain(gone);
    expect(t).toContain('JFIF');
    // The picture data is untouched, and the file still starts and ends properly.
    expect(Array.from((out as Uint8Array).slice(-SCAN.length))).toEqual(SCAN);
    expect(Array.from((out as Uint8Array).slice(0, 2))).toEqual([0xff, 0xd8]);
  });

  it('keeps a JPEG’s rotation, so the picture still shows the right way up', () => {
    const out = stripImageMetadata(jpeg(6), 'image/jpeg') as Uint8Array;
    const t = text(out);
    expect(t).not.toContain('GPS 51.5N');
    const at = t.indexOf('Exif');
    expect(at).toBeGreaterThan(0);
    // 0xffe1, length 34, "Exif\0\0", header, 1 entry, tag 0x0112 (type short, count 1) with value 6.
    expect(Array.from(out.slice(at - 4, at - 2))).toEqual([0xff, 0xe1]);
    expect(Array.from(out.slice(at - 2, at))).toEqual(be16(34));
    expect(Array.from(out.slice(at + 6 + 8 + 2, at + 6 + 8 + 2 + 2))).toEqual(be16(0x0112));
    expect(Array.from(out.slice(at + 6 + 8 + 2 + 8, at + 6 + 8 + 2 + 10))).toEqual(be16(6));
  });

  it('removes text and EXIF chunks from a PNG, and keeps the rest', () => {
    const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...chunk('tEXt', ascii('Author\0secret-author')),
      ...chunk('eXIf', ascii('secret-exif')),
      ...chunk('IDAT', [1, 2, 3]),
      ...chunk('IEND', []),
    ]);
    const out = stripImageMetadata(png, 'image/png') as Uint8Array;
    const t = text(out);
    expect(t).not.toContain('secret');
    for (const kept of ['IHDR', 'IDAT', 'IEND']) expect(t).toContain(kept);
    expect(out.length).toBe(png.length - 2 * 12 - ascii('Author\0secret-author').length - ascii('secret-exif').length);
  });

  it('removes EXIF and XMP chunks from a WebP and fixes the sizes', () => {
    const chunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
    const body = [
      ...ascii('WEBP'),
      ...chunk('VP8X', [0x08 | 0x04 | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ...chunk('EXIF', ascii('secret-exif')),
      ...chunk('XMP ', ascii('secret-xmp')),
      ...chunk('VP8 ', [9, 8, 7]),
    ];
    const webp = Uint8Array.from([...ascii('RIFF'), ...le32(body.length), ...body]);
    const out = stripImageMetadata(webp, 'image/webp') as Uint8Array;
    const t = text(out);
    expect(t).not.toContain('secret');
    expect(t).toContain('VP8 ');
    const size = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    expect(size).toBe(out.length - 8);
    // The extended header no longer says there is camera or XMP data; the transparency flag stays.
    const flags = out[12 + 8];
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(flags & 0x10).toBe(0x10);
  });

  it('refuses files that are not what they claim, and kinds it cannot clean', () => {
    expect(stripImageMetadata(Uint8Array.from([1, 2, 3, 4]), 'image/jpeg')).toBeNull();
    expect(stripImageMetadata(Uint8Array.from(ascii('not a png at all')), 'image/png')).toBeNull();
    expect(stripImageMetadata(Uint8Array.from(ascii('RIFFxxxxWAVE')), 'image/webp')).toBeNull();
    expect(stripImageMetadata(jpeg(1).slice(0, 30), 'image/jpeg')).toBeNull();
    expect(stripImageMetadata(Uint8Array.from([0, 0, 0, 0x18]), 'image/avif')).toBeNull();
  });
});
