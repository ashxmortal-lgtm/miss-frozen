/**
 * Minimal PNG encoder for the TGCloud V8 isolate.
 *
 * The runtime has no `node:zlib`, no npm packages and no native modules, so a
 * normal PNG writer (deflate) is unavailable. PNG only requires a *valid zlib
 * stream*; RFC 1951 §3.2.4 "stored" blocks are uncompressed and legal, so this
 * encoder builds the deflate stream by hand plus the two checksums PNG needs
 * (CRC-32 per chunk, Adler-32 for the zlib trailer).
 *
 * Images are written as 8-bit indexed colour (PNG colour type 3) with an
 * optional `tRNS` for transparency. That is what keeps a 512×512 sticker inside
 * Telegram's 512 KB limit: indexed pixels are 1 byte each (~263 KB with stored
 * deflate), while RGBA would be ~1 MB — too large, since stored blocks do not
 * compress.
 *
 * Everything here is pure JavaScript over `Uint8Array`, so it behaves the same
 * in the isolate and in the Node test harness.
 */

import { zlibDeflate } from './deflate.js';
import { zlibInflate } from './inflate.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---- checksums -------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- zlib with stored blocks ----------------------------------------------

/**
 * Wrap bytes in a zlib container using only stored (uncompressed) deflate
 * blocks: 0x78 0x01 header, blocks of at most 65535 bytes, Adler-32 trailer.
 */
export function zlibStored(bytes) {
  const MAX = 0xffff;
  const blocks = Math.max(1, Math.ceil(bytes.length / MAX));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  out[0] = 0x78; // CMF: deflate, 32K window
  out[1] = 0x01; // FLG: no dict, fastest — (0x78<<8|0x01) % 31 === 0
  let offset = 2;
  for (let i = 0; i < blocks; i += 1) {
    const start = i * MAX;
    const len = Math.min(MAX, bytes.length - start);
    const final = i === blocks - 1 ? 1 : 0;
    out[offset] = final; // BFINAL + BTYPE=00 (stored), rest of the byte is padding
    out[offset + 1] = len & 0xff;
    out[offset + 2] = (len >>> 8) & 0xff;
    out[offset + 3] = ~len & 0xff;
    out[offset + 4] = (~len >>> 8) & 0xff;
    out.set(bytes.subarray(start, start + len), offset + 5);
    offset += 5 + len;
  }
  const sum = adler32(bytes);
  out[offset] = (sum >>> 24) & 0xff;
  out[offset + 1] = (sum >>> 16) & 0xff;
  out[offset + 2] = (sum >>> 8) & 0xff;
  out[offset + 3] = sum & 0xff;
  return out;
}

// ---- chunks ---------------------------------------------------------------

function u32(value) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function ascii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type, data) {
  const length = u32(data.length);
  const body = concat([ascii(type), data]);
  const crc = u32(crc32(body));
  return concat([length, body, crc]);
}

// ---- encoder --------------------------------------------------------------

/**
 * Encode an indexed image as PNG.
 *
 * @param {object} image
 * @param {number} image.width
 * @param {number} image.height
 * @param {Uint8Array} image.indices  one palette index per pixel, row-major
 * @param {Array<[number, number, number]>} image.palette  up to 256 sRGB colours
 * @param {Array<number>} [image.alpha]  optional per-entry alpha (0–255) → tRNS
 * @returns {Uint8Array} PNG bytes
 */
export function encodeIndexedPng({ width, height, indices, palette, alpha = null }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodeIndexedPng: bad size ${width}x${height}`);
  }
  if (!palette?.length || palette.length > 256) {
    throw new Error(`encodeIndexedPng: palette must hold 1–256 colours (got ${palette?.length})`);
  }
  if (indices.length !== width * height) {
    throw new Error(`encodeIndexedPng: expected ${width * height} pixels, got ${indices.length}`);
  }

  const ihdr = concat([
    u32(width),
    u32(height),
    new Uint8Array([
      8, // bit depth
      3, // colour type: indexed
      0, // compression: deflate
      0, // filter: adaptive
      0, // interlace: none
    ]),
  ]);

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => {
    plte[i * 3] = r & 0xff;
    plte[i * 3 + 1] = g & 0xff;
    plte[i * 3 + 2] = b & 0xff;
  });

  // Filter type 0 (None) in front of every scanline.
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raw.set(indices.subarray(y * width, y * width + width), y * (width + 1) + 1);
  }

  const chunks = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (alpha && alpha.some((a) => a < 255)) {
    const trns = new Uint8Array(alpha.length);
    alpha.forEach((a, i) => { trns[i] = Math.max(0, Math.min(255, a)); });
    // tRNS may be shorter than the palette: trailing entries are opaque.
    chunks.push(chunk('tRNS', trns));
  }
  chunks.push(chunk('IDAT', zlibStored(raw)));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

/** Read back the IHDR of a PNG — used by tests and the sticker validators. */
export function readPngHeader(bytes) {
  if (bytes.length < 33) throw new Error('not a PNG: too short');
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG: bad signature');
  }
  const be = (offset) => (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
  return {
    width: be(16),
    height: be(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    compression: bytes[26],
    filter: bytes[27],
    interlace: bytes[28],
  };
}

// ---- truecolour + alpha ----------------------------------------------------

/**
 * Encode an RGBA image as PNG (colour type 6) with real deflate compression.
 *
 * Used for stickers, which need genuine transparency outside the artwork:
 * uncompressed RGBA would be ~1 MB, but flat artwork compresses to tens of KB.
 *
 * @param {object} image
 * @param {number} image.width
 * @param {number} image.height
 * @param {Uint8Array} image.rgba  width × height × 4 bytes, row-major
 * @param {boolean} [image.filtering] apply per-row Sub/Up filters (default true)
 */
export function encodeRgbaPng({ width, height, rgba, filtering = true }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodeRgbaPng: bad size ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodeRgbaPng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const start = y * stride;
    current.set(rgba.subarray(start, start + stride));
    const rowStart = y * (stride + 1);

    // Pick the filter with the smallest sum of absolute differences — the
    // standard heuristic, and a big win on flat artwork.
    let bestFilter = 0;
    let bestScore = Infinity;
    let bestRow = null;
    if (!filtering) {
      bestRow = current;
    } else {
      for (const filter of [1, 2]) { // Sub, Up (None is the baseline)
        const candidate = new Uint8Array(stride);
        let score = 0;
        for (let i = 0; i < stride; i += 1) {
          const left = i >= 4 ? current[i - 4] : 0;
          const up = previous[i];
          const value = filter === 1 ? (current[i] - left) & 0xff : (current[i] - up) & 0xff;
          candidate[i] = value;
          score += value < 128 ? value : 256 - value;
        }
        if (score < bestScore) {
          bestScore = score;
          bestFilter = filter;
          bestRow = candidate;
        }
      }
      let scoreNone = 0;
      for (let i = 0; i < stride; i += 1) {
        const value = current[i];
        scoreNone += value < 128 ? value : 256 - value;
      }
      if (scoreNone <= bestScore) {
        bestFilter = 0;
        bestRow = current;
      }
    }
    raw[rowStart] = bestFilter;
    raw.set(bestRow, rowStart + 1);
    previous.set(current);
  }

  const ihdr = concat([
    u32(width),
    u32(height),
    new Uint8Array([8, 6, 0, 0, 0]), // 8-bit RGBA, deflate, adaptive filter, no interlace
  ]);

  return concat([
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---- decoder ---------------------------------------------------------------

const be32 = (bytes, offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16)
  | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/**
 * Decode a PNG to RGBA. Supports colour types 0/2/3/4/6 at 8 and 16 bit depth,
 * all five row filters, and both `tRNS` styles. Interlaced PNGs are rejected —
 * Telegram profile photos are never interlaced, and the fallback avatar covers
 * the (unlikely) failure.
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 8 <= bytes.length) {
    const length = be32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = be32(data, 0);
      height = be32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error('PNG has no IHDR');
  if (interlace) throw new Error('interlaced PNG is not supported');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`unsupported PNG bit depth ${bitDepth}`);

  const totalLength = idat.reduce((n, part) => n + part.length, 0);
  const compressed = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of idat) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = zlibInflate(compressed);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const bytesPerSample = bitDepth / 8;
  const stride = width * channels * bytesPerSample;
  const bpp = Math.max(1, channels * bytesPerSample);

  const pixels = new Uint8Array(stride * height);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[rawOffset + i];
      const left = i >= bpp ? pixels[rowStart + i - bpp] : 0;
      const up = y > 0 ? pixels[previousStart + i] : 0;
      const upLeft = y > 0 && i >= bpp ? pixels[previousStart + i - bpp] : 0;
      let result;
      switch (filter) {
        case 0: result = value; break;
        case 1: result = value + left; break;
        case 2: result = value + up; break;
        case 3: result = value + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
          result = value + predictor;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[rowStart + i] = result & 0xff;
    }
    rawOffset += stride;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const out = index * 4;
      const base = y * stride + x * channels * bytesPerSample;
      const sample = (channel) => pixels[base + channel * bytesPerSample];
      if (colorType === 3) {
        const paletteIndex = pixels[base];
        rgba[out] = palette[paletteIndex * 3];
        rgba[out + 1] = palette[paletteIndex * 3 + 1];
        rgba[out + 2] = palette[paletteIndex * 3 + 2];
        rgba[out + 3] = transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const gray = sample(0);
        rgba[out] = gray;
        rgba[out + 1] = gray;
        rgba[out + 2] = gray;
        rgba[out + 3] = colorType === 4 ? sample(1) : 255;
        if (colorType === 0 && transparency && transparency.length >= 2 && gray === transparency[1]) rgba[out + 3] = 0;
      } else {
        rgba[out] = sample(0);
        rgba[out + 1] = sample(1);
        rgba[out + 2] = sample(2);
        rgba[out + 3] = colorType === 6 ? sample(3) : 255;
        if (colorType === 2 && transparency && transparency.length >= 6
          && rgba[out] === transparency[1] && rgba[out + 1] === transparency[3] && rgba[out + 2] === transparency[5]) {
          rgba[out + 3] = 0;
        }
      }
    }
  }
  return { width, height, rgba };
}
