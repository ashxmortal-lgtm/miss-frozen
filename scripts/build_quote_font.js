#!/usr/bin/env node
/**
 * Build the quote-sticker font atlas — a BUILD-TIME tool, not a runtime import.
 *
 * The TGCloud isolate cannot load fonts, and a 5×7 bitmap face looks like pixel
 * art at sticker size. So real glyphs are baked here, once, from DejaVu Sans
 * (free, Bitstream Vera licence) and committed as `tgcloud/lib/quote/font_atlas.js`.
 *
 * Steps per character:
 *   1. ImageMagick renders the glyph at a fixed baseline on a transparent canvas
 *      (anti-aliased, 8-bit coverage).
 *   2. The ink box is trimmed; its offset from the baseline is recorded.
 *   3. The advance width comes from the TTF's own `hmtx` table — parsed here
 *      because ImageMagick cannot report it.
 *   4. Trimmed coverage bitmaps are packed into one atlas, deflated with the
 *      project's own encoder (so the runtime only needs its own inflate) and
 *      written out as base64.
 *
 * Usage: node scripts/build_quote_font.js
 * Requires ImageMagick (`convert`) and DejaVu Sans; neither is needed at runtime.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const EM = 64; // pixels per em while rendering
const SIZE = 200; // render canvas (generous, trimmed afterwards)
const BASELINE = 150; // baseline y inside the canvas
const ORIGIN_X = 40; // pen origin x inside the canvas

const CHARS = (() => {
  const list = [];
  for (let code = 32; code <= 126; code += 1) list.push(String.fromCharCode(code));
  // Typographic characters users actually paste; folded before lookup at runtime.
  return list;
})();

// ---- minimal TTF reader (cmap format 4 + hmtx + head/hhea) -----------------

function readTables(buffer) {
  const numTables = buffer.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const offset = 12 + i * 16;
    const tag = buffer.toString('ascii', offset, offset + 4);
    tables[tag] = {
      offset: buffer.readUInt32BE(offset + 8),
      length: buffer.readUInt32BE(offset + 12),
    };
  }
  return tables;
}

function parseCmapFormat4(buffer, offset) {
  const segCount = buffer.readUInt16BE(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  const glyphs = new Map();
  for (let segment = 0; segment < segCount; segment += 1) {
    const end = buffer.readUInt16BE(endCodes + segment * 2);
    const start = buffer.readUInt16BE(startCodes + segment * 2);
    const delta = buffer.readInt16BE(idDeltas + segment * 2);
    const rangeOffsetAt = idRangeOffsets + segment * 2;
    const rangeOffset = buffer.readUInt16BE(rangeOffsetAt);
    if (start === 0xffff) continue;
    for (let code = start; code <= end && code <= 0xffff; code += 1) {
      let glyphIndex;
      if (rangeOffset === 0) {
        glyphIndex = (code + delta) & 0xffff;
      } else {
        const address = rangeOffsetAt + rangeOffset + (code - start) * 2;
        if (address + 2 > buffer.length) continue;
        glyphIndex = buffer.readUInt16BE(address);
        if (glyphIndex !== 0) glyphIndex = (glyphIndex + delta) & 0xffff;
      }
      if (glyphIndex !== 0 && !glyphs.has(code)) glyphs.set(code, glyphIndex);
    }
  }
  return glyphs;
}

function fontMetrics(path) {
  const buffer = readFileSync(path);
  const tables = readTables(buffer);
  const unitsPerEm = buffer.readUInt16BE(tables.head.offset + 18);
  const ascent = buffer.readInt16BE(tables.hhea.offset + 4);
  const descent = buffer.readInt16BE(tables.hhea.offset + 6);
  const numberOfHMetrics = buffer.readUInt16BE(tables.hhea.offset + 34);

  // Prefer a Unicode BMP cmap subtable (platform 3 / encoding 1, else platform 0).
  const cmapBase = tables.cmap.offset;
  const count = buffer.readUInt16BE(cmapBase + 2);
  let subtable = null;
  for (let i = 0; i < count; i += 1) {
    const record = cmapBase + 4 + i * 8;
    const platform = buffer.readUInt16BE(record);
    const encoding = buffer.readUInt16BE(record + 2);
    const offset = buffer.readUInt32BE(record + 4);
    const format = buffer.readUInt16BE(cmapBase + offset);
    if (format === 4 && (platform === 3 || platform === 0)) {
      if (encoding === 1 || encoding === 0 || encoding === 3) {
        subtable = cmapBase + offset;
        if (platform === 3 && encoding === 1) break;
      }
    }
  }
  if (!subtable) throw new Error('no Unicode cmap format 4 subtable');

  const glyphs = parseCmapFormat4(buffer, subtable);
  const advances = new Map();
  const hmtxBase = tables.hmtx.offset;
  const advanceOf = (glyphIndex) => {
    if (glyphIndex >= numberOfHMetrics) return buffer.readUInt16BE(hmtxBase + (numberOfHMetrics - 1) * 4);
    return buffer.readUInt16BE(hmtxBase + glyphIndex * 4);
  };
  for (const [code, glyphIndex] of glyphs) advances.set(code, advanceOf(glyphIndex));

  return { unitsPerEm, ascent, descent, advances };
}

// ---- rasterise -------------------------------------------------------------

/** Alpha coverage of one character, rendered at a fixed baseline. */
function renderGlyph(char) {
  const alpha = execFileSync('convert', [
    '-size', `${SIZE}x${SIZE}`, 'xc:none',
    '-font', REGULAR,
    '-pointsize', String(EM),
    '-fill', 'white',
    '-annotate', `+${ORIGIN_X}+${BASELINE}`, char,
    '-alpha', 'extract',
    '-depth', '8',
    'gray:-',
  ], { maxBuffer: 64 * 1024 * 1024 });

  if (alpha.length !== SIZE * SIZE) throw new Error(`unexpected raster size for ${JSON.stringify(char)}`);

  let minX = SIZE;
  let minY = SIZE;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (alpha[y * SIZE + x] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // whitespace: no ink

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = alpha[(minY + y) * SIZE + (minX + x)];
    }
  }
  return {
    width,
    height,
    bearingX: minX - ORIGIN_X, // pen origin → first ink column
    bearingY: BASELINE - minY, // baseline → top of ink
    pixels,
  };
}

// ---- pack + emit -----------------------------------------------------------

const metrics = fontMetrics(REGULAR);
const scaleToEm = EM / metrics.unitsPerEm;

const glyphs = new Map();
for (const char of CHARS) {
  const rendered = renderGlyph(char);
  const code = char.charCodeAt(0);
  const advance = Math.round((metrics.advances.get(code) ?? EM * 0.6) * scaleToEm);
  glyphs.set(char, rendered ? { ...rendered, advance } : { width: 0, height: 0, advance });
}

// Shelf packing: sort by height, fill rows up to ATLAS_WIDTH.
const ATLAS_WIDTH = 900;
const ordered = [...glyphs.entries()].sort((a, b) => b[1].height - a[1].height);
let cursorX = 1;
let cursorY = 1;
let shelfHeight = 0;
for (const [, glyph] of ordered) {
  if (!glyph.width) { glyph.x = 0; glyph.y = 0; continue; }
  if (cursorX + glyph.width + 1 > ATLAS_WIDTH) {
    cursorX = 1;
    cursorY += shelfHeight + 1;
    shelfHeight = 0;
  }
  glyph.x = cursorX;
  glyph.y = cursorY;
  cursorX += glyph.width + 1;
  shelfHeight = Math.max(shelfHeight, glyph.height);
}
const ATLAS_HEIGHT = cursorY + shelfHeight + 1;

const atlas = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT);
for (const [, glyph] of glyphs) {
  if (!glyph.width) continue;
  for (let y = 0; y < glyph.height; y += 1) {
    for (let x = 0; x < glyph.width; x += 1) {
      atlas[(glyph.y + y) * ATLAS_WIDTH + (glyph.x + x)] = glyph.pixels[y * glyph.width + x];
    }
  }
}

// Deflate with the project's own encoder so the runtime decrypts with its own
// inflate — no new runtime dependency.
const { zlibDeflate } = await import('../tgcloud/lib/quote/deflate.js');
const compressed = zlibDeflate(atlas);
const base64 = Buffer.from(compressed).toString('base64');

const table = {};
for (const [char, glyph] of glyphs) {
  if (!glyph.width) { table[char] = [0, 0, 0, 0, 0, 0, glyph.advance]; continue; }
  table[char] = [glyph.x, glyph.y, glyph.width, glyph.height, glyph.bearingX, glyph.bearingY, glyph.advance];
}

const output = `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build_quote_font.js from DejaVu Sans (Bitstream Vera licence).
 *
 * 8-bit anti-aliased coverage atlas, deflated with the project's own encoder.
 * Glyph entry: [x, y, width, height, bearingX, bearingY, advance]
 *   bearingX — pen origin → first ink column
 *   bearingY — baseline → top of ink
 * All units are pixels at em = ${EM}.
 */
export const FONT_EM = ${EM};
export const ATLAS_WIDTH = ${ATLAS_WIDTH};
export const ATLAS_HEIGHT = ${ATLAS_HEIGHT};
export const ATLAS_DEFLATED_BASE64 = '${base64}';

export const GLYPHS = ${JSON.stringify(table)};
`;

writeFileSync(new URL('../tgcloud/lib/quote/font_atlas.js', import.meta.url), output);
console.log(`font atlas: ${Object.keys(table).length} glyphs, ${ATLAS_WIDTH}x${ATLAS_HEIGHT}px `
  + `(${atlas.length}B → ${compressed.length}B → ${base64.length}B base64)`);
