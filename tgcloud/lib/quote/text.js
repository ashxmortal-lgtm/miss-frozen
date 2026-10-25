/**
 * Text layout/drawing on top of the baked DejaVu Sans atlas.
 *
 * The atlas (font_atlas.js, generated at build time) holds 8-bit anti-aliased
 * coverage for ASCII. This module inflates it once, then measures and blits
 * glyphs at any size with a box filter — no font engine needed at runtime.
 */

import { zlibInflate } from './inflate.js';
import {
  ATLAS_DEFLATED_BASE64, ATLAS_HEIGHT, ATLAS_WIDTH, FONT_EM, GLYPHS,
} from './font_atlas.js';

let atlas = null;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i += 1) table[BASE64.charCodeAt(i)] = i;
  return table;
})();

/** Decode base64 (the isolate may not provide `atob`). */
export function base64Decode(text) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let length = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_LOOKUP[clean.charCodeAt(i)];
    const b = BASE64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = BASE64_LOOKUP[clean.charCodeAt(i + 2)];
    const d = BASE64_LOOKUP[clean.charCodeAt(i + 3)];
    const triple = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out[length++] = (triple >>> 16) & 0xff;
    if (c >= 0) out[length++] = (triple >>> 8) & 0xff;
    if (d >= 0) out[length++] = triple & 0xff;
  }
  return out.subarray(0, length);
}

/** Inflate the atlas once per isolate instance. */
export function loadAtlas() {
  if (!atlas) {
    const compressed = base64Decode(ATLAS_DEFLATED_BASE64);
    const bytes = zlibInflate(compressed);
    if (bytes.length !== ATLAS_WIDTH * ATLAS_HEIGHT) {
      throw new Error(`font atlas corrupt: ${bytes.length} bytes, expected ${ATLAS_WIDTH * ATLAS_HEIGHT}`);
    }
    atlas = bytes;
  }
  return atlas;
}

// ---- character mapping -----------------------------------------------------

/** Typographic characters folded onto the ASCII face. */
const FOLD = new Map(Object.entries({
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u00ad': '-',
  '\u2026': '...', '\u00a0': ' ', '\u2007': ' ', '\u202f': ' ',
  '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '',
  '\u00d7': 'x', '\u00ab': '"', '\u00bb': '"', '\u2032': "'", '\u2033': '"',
  '\u20b9': 'Rs', '\u00a3': 'GBP', '\u20ac': 'EUR',
}));

/** Emoji/pictographs are decorative — dropped, never rendered as `?`. */
export function isPictograph(cp) {
  return cp > 0xffff
    || (cp >= 0x2190 && cp <= 0x2bff)
    || cp === 0xfe0e || cp === 0xfe0f || cp === 0x20e3
    || (cp >= 0x1f1e6 && cp <= 0x1f1ff);
}

/**
 * Fold user text into drawable characters. Emoji disappear; scripts the atlas
 * lacks become `?` (one per run) and `renderableShare` reports the loss so the
 * card can say so instead of silently showing question marks.
 */
export function normalizeText(input) {
  let out = '';
  for (const raw of String(input ?? '')) {
    if (raw === '\n') { out += '\n'; continue; }
    const folded = FOLD.get(raw);
    if (folded !== undefined) { out += folded; continue; }
    if (GLYPHS[raw]) { out += raw; continue; }
    const cp = raw.codePointAt(0);
    if (cp < 0x20) continue;
    if (isPictograph(cp)) continue;
    if (cp > 0x7e) {
      if (!out.endsWith('?')) out += '?';
      continue;
    }
    out += raw;
  }
  return out;
}

/** Share of characters the atlas can actually draw (0–1). */
export function renderableShare(input) {
  const chars = [...String(input ?? '')].filter((c) => c.trim() && !isPictograph(c.codePointAt(0)));
  if (!chars.length) return 1;
  let drawable = 0;
  for (const raw of chars) if (FOLD.has(raw) || GLYPHS[raw]) drawable += 1;
  return drawable / chars.length;
}

// ---- metrics ---------------------------------------------------------------

const scaleOf = (size) => size / FONT_EM;

/** Width of one line at `size` px, in pixels. */
export function measureLine(line, size) {
  const scale = scaleOf(size);
  let width = 0;
  for (const char of line) {
    const glyph = GLYPHS[char];
    width += (glyph ? glyph[6] : GLYPHS['?'][6]) * scale;
  }
  return width;
}

/** Width of the widest line. */
export function measure(text, size) {
  return String(text).split('\n').reduce((max, line) => Math.max(max, measureLine(line, size)), 0);
}

/** Height of one line at `size` px (line box, not ink). */
export const lineHeightOf = (size) => Math.round(size * 1.32);

/**
 * Word wrap. Honours explicit newlines, breaks on spaces, and hard-breaks words
 * wider than the line (URLs, emoji runs already folded).
 */
export function wrapText(text, maxWidth, size, maxLines = Infinity) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (lines.length >= maxLines) break;
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureLine(candidate, size) <= maxWidth) { current = candidate; continue; }
      if (current) lines.push(current);
      if (lines.length >= maxLines) break;
      if (measureLine(word, size) <= maxWidth) { current = word; continue; }
      let chunk = '';
      for (const char of word) {
        if (measureLine(chunk + char, size) > maxWidth && chunk) {
          lines.push(chunk);
          if (lines.length >= maxLines) break;
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    }
    if (lines.length >= maxLines) break;
    lines.push(current);
  }
  return lines.slice(0, maxLines === Infinity ? undefined : maxLines);
}

/** Clamp to `maxLines`, ending the last line with an ellipsis. */
export function clampLines(lines, maxLines, maxWidth, size) {
  if (lines.length <= maxLines) return { lines, clipped: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measureLine(`${last}...`, size) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}...`;
  return { lines: kept, clipped: true };
}

/** Shorten a single line with an ellipsis so it fits `maxWidth`. */
export function ellipsize(text, maxWidth, size) {
  if (measureLine(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && measureLine(`${cut}...`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

// ---- drawing ---------------------------------------------------------------

/**
 * Blit one glyph's coverage onto an RGBA surface with `over` compositing.
 * The atlas is 8-bit coverage, sampled with a box filter when scaled down.
 */
function blitGlyph(surface, char, penX, baselineY, size, color) {
  const glyph = GLYPHS[char] || GLYPHS['?'];
  const [atlasX, atlasY, width, height, bearingX, bearingY] = glyph;
  if (!width || !height) return;

  const scale = scaleOf(size);
  const originX = penX + bearingX * scale;
  const originY = baselineY - bearingY * scale;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const [r, g, b] = color;

  const atlasData = loadAtlas();
  const startX = Math.round(originX);
  const startY = Math.round(originY);

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y = startY + ty;
    if (y < 0 || y >= surface.height) continue;
    const sourceTop = (ty * height) / targetHeight;
    const sourceBottom = ((ty + 1) * height) / targetHeight;
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x = startX + tx;
      if (x < 0 || x >= surface.width) continue;
      const sourceLeft = (tx * width) / targetWidth;
      const sourceRight = ((tx + 1) * width) / targetWidth;

      // Area-average the source coverage over this output pixel.
      let coverage = 0;
      let samples = 0;
      const y0 = Math.floor(sourceTop);
      const y1 = Math.min(height, Math.ceil(sourceBottom));
      const x0 = Math.floor(sourceLeft);
      const x1 = Math.min(width, Math.ceil(sourceRight));
      const yWeight = 1 / Math.max(1e-6, sourceBottom - sourceTop);
      const xWeight = 1 / Math.max(1e-6, sourceRight - sourceLeft);
      for (let sy = y0; sy < y1; sy += 1) {
        const overlapY = Math.min(sourceBottom, sy + 1) - Math.max(sourceTop, sy);
        if (overlapY <= 0) continue;
        const rowBase = (atlasY + sy) * ATLAS_WIDTH + atlasX;
        for (let sx = x0; sx < x1; sx += 1) {
          const overlapX = Math.min(sourceRight, sx + 1) - Math.max(sourceLeft, sx);
          if (overlapX <= 0) continue;
          coverage += atlasData[rowBase + sx] * overlapX * overlapY;
          samples += overlapX * overlapY;
        }
      }
      void xWeight; void yWeight; void samples;
      const alpha = coverage / Math.max(1e-6, (sourceBottom - sourceTop) * (sourceRight - sourceLeft));
      if (alpha < 0.5) continue;
      surface.blend(x, y, r, g, b, Math.min(1, alpha / 255));
    }
  }
}

/** Draw one line of text. Returns the advance width in pixels. */
export function drawLine(surface, line, x, baselineY, size, color) {
  const scale = scaleOf(size);
  let penX = x;
  for (const char of line) {
    blitGlyph(surface, char, penX, baselineY, size, color);
    const glyph = GLYPHS[char] || GLYPHS['?'];
    penX += glyph[6] * scale;
  }
  return penX - x;
}
