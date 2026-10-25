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

// ---- styled alphabets ------------------------------------------------------
//
// People paste their names in "fancy fonts": math bold (𝐒𝐚𝐤𝐮𝐫𝐚), double-struck
// (𝕊𝕒𝕜𝕦𝕣𝕒), fullwidth (Ｓａｋｕｒａ), small caps (ᴅᴇʙᴜɢ), circled (Ⓢⓐⓚ),
// Cyrillic/Greek lookalikes (ѕαкυяα). The atlas is ASCII-only, so every one of
// these is mapped back to the plain letter it stands for. Computed from the
// Unicode ranges rather than listed character by character, except where the
// gaps in a block make a lookup table the honest option.

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

const STYLED = new Map();

/** Map `count` consecutive code points starting at `base` onto `chars`. */
function mapRun(base, chars, offset = 0) {
  for (let i = 0; i < chars.length; i += 1) STYLED.set(base + i, chars[i]);
  return base + chars.length + offset;
}

/**
 * The Mathematical Alphanumeric Symbols block (U+1D400–U+1D7FF) is laid out as
 * runs of 52 (A–Z, a–z) and 10 (0–9). It is *not* contiguous: the italic, script,
 * fraktur and double-struck lower-case letters and a few others live in
 * Letterlike Symbols (U+2100 block) instead, leaving holes. Each styled alphabet
 * is therefore described by its own upper/lower base, with `null` meaning "these
 * letters are in the Letterlike block" (handled by `LETTERLIKE` below).
 */
const MATH_ALPHABETS = [
  // [upperBase, lowerBase] — every run is 26 long; a handful of letters inside
  // each run are "holes" whose real glyph lives in Letterlike Symbols, and are
  // overridden by LETTERLIKE below (ℬ ℰ ℱ ℋ ℐ ℒ ℳ ℛ ℭ ℌ ℑ ℜ ℨ, ℎ ℯ ℊ ℴ).
  [0x1d400, 0x1d41a], // bold
  [0x1d434, 0x1d44e], // italic            (h → ℎ)
  [0x1d468, 0x1d482], // bold italic
  [0x1d49c, 0x1d4b6], // script            (e → ℯ, g → ℊ, o → ℴ)
  [0x1d4d0, 0x1d4ea], // bold script
  [0x1d504, 0x1d51e], // fraktur
  [0x1d56c, 0x1d586], // bold fraktur
  [0x1d5a0, 0x1d5ba], // sans-serif
  [0x1d5d4, 0x1d5ee], // sans-serif bold
  [0x1d608, 0x1d622], // sans-serif italic
  [0x1d63c, 0x1d656], // sans-serif bold italic
  [0x1d670, 0x1d68a], // monospace
];

for (const [upperBase, lowerBase] of MATH_ALPHABETS) {
  mapRun(upperBase, ASCII_UPPER);
  mapRun(lowerBase, ASCII_LOWER);
}

// Double-struck is the messy one: ℂ ℋ ℕ ℙ ℚ ℝ ℤ are letters, and ℎ/… aside, the
// lower-case run starts at 𝕒. Digits 𝕆…𝟡 are double-struck 0–9.
mapRun(0x1D538, ASCII_UPPER.slice(0, 26));
mapRun(0x1D552, ASCII_LOWER);
mapRun(0x1D7D8, DIGITS);

/** Letters that live outside their block, in Letterlike Symbols. */
const LETTERLIKE = {
  0x2102: 'C', 0x210B: 'H', 0x2110: 'I', 0x2112: 'L', 0x2115: 'N',
  0x2119: 'P', 0x211A: 'Q', 0x211B: 'R', 0x211C: 'R', 0x211D: 'R', 0x2124: 'Z',
  0x210E: 'h', 0x210A: 'g', 0x2113: 'l', 0x212F: 'e', 0x2130: 'E', 0x2131: 'F',
  0x212C: 'B', 0x2133: 'M', 0x2134: 'o',
  0x2107: 'E', 0x2128: 'Z', 0x2111: 'I', 0x2118: 'P', 0x212E: 'e',
};
for (const [cp, ch] of Object.entries(LETTERLIKE)) STYLED.set(Number(cp), ch);

// Bold/blackboard digits and the double-struck alphabet's digits.
mapRun(0x1D7CE, DIGITS); // bold
mapRun(0x1D7E2, DIGITS); // sans-serif
mapRun(0x1D7EC, DIGITS); // sans-serif bold
mapRun(0x1D7F6, DIGITS); // monospace

// Fullwidth forms: ASCII shifted to U+FF01–FF5E, plus the ideographic space.
for (let cp = 0xff01; cp <= 0xff5e; cp += 1) {
  STYLED.set(cp, String.fromCharCode(cp - 0xfee0));
}
STYLED.set(0x3000, ' ');

// Enclosed alphanumerics: circled capitals Ⓐ, circled digits ①.
mapRun(0x24b6, ASCII_UPPER);
mapRun(0x24d0, ASCII_LOWER);
for (let d = 0; d < 9; d += 1) STYLED.set(0x2460 + d, DIGITS[d + 1]);
STYLED.set(0x24ea, '0');
// Negative circled / squared / parenthesised capitals.
mapRun(0x1f150, ASCII_UPPER); // 🅐 negative circled
mapRun(0x1f130, ASCII_UPPER); // 🄰 squared
mapRun(0x1f110, ASCII_UPPER); // 🄐 parenthesised

// Superscripts and subscripts (² ³ ¹ are outside the runs).
const SUPERSCRIPT = { 0x2070: '0', 0x00b9: '1', 0x00b2: '2', 0x00b3: '3' };
mapRun(0x2074, '456789');
for (const [cp, ch] of Object.entries(SUPERSCRIPT)) STYLED.set(Number(cp), ch);
mapRun(0x2080, DIGITS);

// Small capitals / phonetic letters that are not adjacent to anything.
const SMALL_CAPS = {
  0x1d00: 'A', 0x0299: 'B', 0x1d04: 'C', 0x1d05: 'D', 0x1d07: 'E', 0xa730: 'F',
  0x0262: 'G', 0x029c: 'H', 0x026a: 'I', 0x1d0a: 'J', 0x1d0b: 'K',
  0x029f: 'L', 0x1d0d: 'M', 0x0274: 'N', 0x1d0f: 'O', 0x1d18: 'P',
  0x0280: 'R', 0xa731: 'S', 0x1d1b: 'T', 0x1d1c: 'U', 0x1d20: 'V',
  0x1d21: 'W', 0x028f: 'Y', 0x1d22: 'Z',
  0x1d43: 'a', 0x1d47: 'b', 0x1d9c: 'c', 0x1d48: 'd', 0x1d49: 'e',
  0x1da0: 'f', 0x1d4d: 'g', 0x02b0: 'h', 0x2071: 'i', 0x02b2: 'j',
  0x1d4f: 'k', 0x02e1: 'l', 0x1d50: 'm', 0x207f: 'n', 0x1d52: 'o',
  0x1d56: 'p', 0x02b3: 'r', 0x02e2: 's', 0x1d57: 't', 0x1d58: 'u',
  0x1d5b: 'v', 0x02b7: 'w', 0x02e3: 'x', 0x02b8: 'y', 0x1dbb: 'z',
};
for (const [cp, ch] of Object.entries(SMALL_CAPS)) STYLED.set(Number(cp), ch);

// ---- accents and lookalikes ------------------------------------------------
//
// Latin letters with diacritics fold to their base letter (José → Jose,
// Nguyễn → Nguyen). Computed by decomposing where possible, with an explicit
// table for the ones that do not decompose (ø, ł, đ, ı…).

const NON_DECOMPOSING = {
  'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D',
  'þ': 'th', 'Þ': 'Th', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ß': 'ss',
  'ı': 'i', 'İ': 'I', 'ħ': 'h', 'Ħ': 'H', 'ŧ': 't', 'Ŧ': 'T', 'ŋ': 'n', 'Ŋ': 'N',
  'ƒ': 'f', 'ĸ': 'k', 'ŀ': 'l', 'Ŀ': 'L', 'ŉ': 'n', 'ſ': 's',
};

/** Cyrillic and Greek letters that are visually Latin. */
const LOOKALIKE = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j',
  'ԁ': 'd', 'ɡ': 'g', 'ո': 'n', 'ս': 'u', 'հ': 'h', 'ց': 'g', 'ք': 'p', 'օ': 'o',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v',
  'ο': 'o', 'ρ': 'p', 'σ': 'o', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
  'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  // Cyrillic letters with no Latin twin but a conventional keyboard reading —
  // these are what "fancy font" names actually use (ѕαкυяα).
  'б': 'b', 'г': 'r', 'д': 'd', 'ж': 'x', 'з': '3', 'и': 'u', 'л': 'n', 'п': 'n',
  'ф': 'f', 'ц': 'u', 'ч': '4', 'ш': 'w', 'щ': 'w', 'ъ': 'b', 'ы': 'bl', 'ь': 'b',
  'э': 'e', 'ю': 'u', 'я': 'r',
  'Б': 'B', 'Г': 'R', 'Д': 'D', 'Ж': 'X', 'З': '3', 'И': 'U', 'Л': 'N', 'П': 'N',
  'Ф': 'F', 'Ц': 'U', 'Ч': '4', 'Ш': 'W', 'Щ': 'W', 'Ъ': 'B', 'Ы': 'bl', 'Ь': 'B',
  'Э': 'E', 'Ю': 'U', 'Я': 'R',
};

for (const [ch, folded] of Object.entries({ ...NON_DECOMPOSING, ...LOOKALIKE })) {
  FOLD.set(ch, folded);
}

/** Decompose a precomposed Latin letter when the platform supports it. */
function foldDecomposed(ch) {
  if (typeof ch.normalize !== 'function') return null;
  const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (base === ch) return null;
  const cleaned = base.replace(/[^A-Za-z]/g, '');
  return cleaned ? [...cleaned] : null;
}

/**
 * Fold one character to its plain-ASCII stand-ins, or null if it is not a
 * letter/digit this atlas can draw.
 */
export function foldChar(ch) {
  const known = FOLD.get(ch);
  if (known !== undefined) return [...known];
  const styled = STYLED.get(ch.codePointAt(0));
  if (styled !== undefined) return [...styled];
  const cp = ch.codePointAt(0);
  // Latin-1 Supplement, Extended-A/B, Extended Additional (Vietnamese), and the
  // Greek block all decompose cleanly.
  if ((cp >= 0xc0 && cp <= 0x2af) || (cp >= 0x1e00 && cp <= 0x1eff)
    || (cp >= 0x370 && cp <= 0x3ff)) {
    const decomposed = foldDecomposed(ch);
    if (decomposed) return decomposed;
  }
  return null;
}

// ---- emoji ---------------------------------------------------------------

/**
 * Is this code point an emoji / decorative pictograph?
 *
 * Note that this is *not* "anything above the BMP": math letters (𝐒), regional
 * indicators and enclosed alphanumerics all live in the astral planes but are
 * text. Ranges follow Unicode's emoji blocks.
 */
export function isPictograph(cp) {
  if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x20e3 || cp === 0x200d) return true;
  if (cp < 0x2000) return false;
  return (
    (cp >= 0x2000 && cp <= 0x206f) // general punctuation (dashes, spaces) — decorative
    || (cp >= 0x2190 && cp <= 0x2bff) // arrows, misc symbols, dingbats
    || (cp >= 0x2e00 && cp <= 0x2e7f)
    || (cp >= 0x3000 && cp <= 0x303f) // CJK punctuation
    || (cp >= 0x3200 && cp <= 0x32ff) // enclosed CJK
    || (cp >= 0x4dc0 && cp <= 0x4dff)
    || (cp >= 0xa490 && cp <= 0xa4cf)
    || (cp >= 0xfe00 && cp <= 0xfe6f)
    || (cp >= 0x10100 && cp <= 0x1019f)
    || (cp >= 0x1f000 && cp <= 0x1faff) // emoji proper, region flags, skin tones
    || (cp >= 0x1f1e6 && cp <= 0x1f1ff)
  );
}

/** Keycap / tag / variation selectors carry an emoji but draw nothing themselves. */
export function isEmojiModifier(cp) {
  return cp === 0xfe0e || cp === 0xfe0f || cp === 0x20e3
    || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f);
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
    const cp = raw.codePointAt(0);
    if (cp < 0x20) continue;
    if (cp <= 0x7e) { out += raw; continue; }
    // Styled alphabets, accents and lookalikes fold back to plain letters.
    const folded = foldChar(raw);
    if (folded) { out += folded.join(''); continue; }
    if (isPictograph(cp)) continue;
    // A script the atlas genuinely lacks becomes one `?` per run, and
    // renderableShare reports the loss instead of hiding it.
    if (!out.endsWith('?')) out += '?';
  }
  return out;
}

/** Share of characters the atlas can actually draw (0–1). */
export function renderableShare(input) {
  const chars = [...String(input ?? '')].filter((c) => c.trim() && !isPictograph(c.codePointAt(0)));
  if (!chars.length) return 1;
  let drawable = 0;
  for (const raw of chars) {
    if (raw.codePointAt(0) <= 0x7e || GLYPHS[raw] || foldChar(raw)) drawable += 1;
  }
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
