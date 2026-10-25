/**
 * Quote-sticker renderer — pure JavaScript, no canvas.
 *
 * Draws into an RGB surface (no alpha, so shapes composite by painting) at a
 * supersampling factor, downsamples to the output size for smooth edges, then
 * quantises to an indexed palette and encodes a PNG (quote/png.js).
 *
 * Layout is Classic QuotLy-inspired: a dark card, the author's round avatar and
 * name on top, and the quoted message in a light speech bubble.
 */

import { encodeIndexedPng } from './png.js';
import {
  GLYPH_HEIGHT, GLYPH_SPACING,
  glyph, glyphMetrics, normalizeText, renderableShare, textWidth,
} from './font.js';

/** Prefixes a word that should get a highlight behind it. */
export const HIGHLIGHT_MARKER = '\u0001';

export const STICKER_SIZE = 512;
/** Telegram static stickers: one side exactly 512 px, the other ≤ 512 px. */
export const MAX_SIDE = 512;
const SUPERSAMPLE = 2;

export const PALETTE = {
  card: [26, 31, 42],
  cardEdge: [37, 44, 58],
  bubble: [255, 255, 255],
  highlight: [255, 232, 138],
  text: [24, 28, 36],
  name: [231, 236, 245],
  handle: [138, 149, 168],
  avatar: [58, 68, 88],
  avatarInk: [124, 137, 158],
  accent: [86, 132, 255],
  footnote: [104, 115, 134],
};

// ---- surface ---------------------------------------------------------------

export class Surface {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.fill(background);
  }

  fill([r, g, b]) {
    const px = new Uint8Array(this.width * this.height * 3);
    for (let i = 0; i < px.length; i += 3) {
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
    this.pixels = px;
  }

  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.pixels[i] = r;
    this.pixels[i + 1] = g;
    this.pixels[i + 2] = b;
  }

  /** Axis-aligned rectangle. */
  rect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.set(px, py, color);
    }
  }

  /** Rounded rectangle — the bubble and the card itself. */
  roundRect(x, y, w, h, radius, color) {
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        // Distance from the pixel centre to the nearest corner centre.
        const cx = px < x0 + r ? x0 + r : px >= x1 - r ? x1 - r - 1 : px;
        const cy = py < y0 + r ? y0 + r : py >= y1 - r ? y1 - r - 1 : py;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= r * r + r * 0.5) this.set(px, py, color);
      }
    }
  }

  circle(cx, cy, radius, color) {
    const r2 = radius * radius;
    for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py += 1) {
      for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px += 1) {
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= r2) this.set(px, py, color);
      }
    }
  }

  /** One glyph at `scale` device pixels per font pixel, trimmed to its ink. */
  glyph(char, x, y, scale, color) {
    const rows = glyph(char);
    const { trim } = glyphMetrics(char);
    for (let ry = 0; ry < GLYPH_HEIGHT; ry += 1) {
      const row = rows[ry];
      for (let rx = 0; rx < row.length; rx += 1) {
        if (!row[rx]) continue;
        this.rect(x + (rx - trim) * scale, y + ry * scale, scale, scale, color);
      }
    }
  }

  /** Draw a single proportional line; returns the advance width in pixels. */
  line(text, x, y, scale, color) {
    let cursor = x;
    for (const char of text) {
      const advance = glyphMetrics(char).ink + GLYPH_SPACING;
      if (char !== ' ' && char !== HIGHLIGHT_MARKER) this.glyph(char, cursor, y, scale, color);
      cursor += advance * scale;
    }
    return cursor - x;
  }

  /**
   * Draw a line, painting a rounded highlight behind everything between two
   * HIGHLIGHT_MARKER characters (QuotLy's signature word highlighting).
   */
  highlightedLine(text, x, y, scale, color, highlightColor) {
    const marks = [];
    let cursor = x;
    let openAt = null;
    for (const char of text) {
      const advance = (glyphMetrics(char).ink + GLYPH_SPACING) * scale;
      if (char === HIGHLIGHT_MARKER) {
        if (openAt === null) openAt = cursor;
        else {
          marks.push([openAt, cursor]);
          openAt = null;
        }
      }
      cursor += advance;
    }
    for (const [from, to] of marks) {
      this.roundRect(from - 2 * scale, y - 2 * scale, (to - from) + 4 * scale,
        GLYPH_HEIGHT * scale + 4 * scale, 3 * scale, highlightColor);
    }
    return this.line(text, x, y, scale, color);
  }

  /** Downsample by `factor` (box filter) → full-resolution RGB. */
  downsample(factor) {
    const w = Math.floor(this.width / factor);
    const h = Math.floor(this.height / factor);
    const out = {
      width: w,
      height: h,
      rgb: new Uint8Array(w * h * 3),
    };
    const area = factor * factor;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < factor; sy += 1) {
          for (let sx = 0; sx < factor; sx += 1) {
            const i = ((y * factor + sy) * this.width + (x * factor + sx)) * 3;
            r += this.pixels[i];
            g += this.pixels[i + 1];
            b += this.pixels[i + 2];
          }
        }
        const o = (y * w + x) * 3;
        out.rgb[o] = Math.round(r / area);
        out.rgb[o + 1] = Math.round(g / area);
        out.rgb[o + 2] = Math.round(b / area);
      }
    }
    return out;
  }
}

// ---- text layout -----------------------------------------------------------

/**
 * Wrap text to `maxWidth` font pixels. Honours explicit newlines, breaks on
 * spaces, and hard-breaks words that are longer than a line (URLs, emoji runs).
 */
export function wrapText(text, maxWidth, maxLines = Infinity) {
  const normalized = normalizeText(text);
  const lines = [];
  for (const paragraph of normalized.split('\n')) {
    if (lines.length >= maxLines) break;
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (lines.length >= maxLines) break;
      if (textWidth(word) <= maxWidth) {
        current = word;
        continue;
      }
      // Hard-break an over-long word.
      let chunk = '';
      for (const char of word) {
        if (textWidth(chunk + char) > maxWidth && chunk) {
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

/** Ellipsis for the last line when the text did not fit. */
function clampLines(lines, maxLines, maxWidth) {
  if (lines.length <= maxLines) return { lines, clipped: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && textWidth(`${last}...`) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}...`;
  return { lines: kept, clipped: true };
}

// ---- sticker ---------------------------------------------------------------

/**
 * Build the quote sticker.
 *
 * @param {object} quote
 * @param {string} quote.text       quoted message text (already extracted)
 * @param {string} quote.name       author display name
 * @param {string} [quote.handle]   "@username" or a hint like "Sticker"
 * @param {string} [quote.kind]     label shown when the message had no text
 * @param {number} [height]         output height (512 wide, ≤ 512 tall)
 */
export function renderQuote({ text, name, handle = '', kind = '', height = 0, highlight = true }) {
  // A media-only quote has no text: no lines at all (an empty string would
  // otherwise wrap to one blank line and push the label out of the bubble).
  text = String(text ?? '').trim();
  const width = STICKER_SIZE;
  const s = SUPERSAMPLE;

  // ---- measure first, so the card is exactly as tall as the quote needs ----
  const bubbleXf = 28;
  const bubbleWf = width - bubbleXf * 2;
  const padding = 26;
  const innerW = bubbleWf - padding * 2;
  const HEADER = 124; // avatar + name block
  const FOOTER = 28;
  const KIND_H = 30;

  let scale = 4;
  let lines = [];
  let clipped = false;
  let outHeight = STICKER_SIZE;

  const tryLayout = (faceScale, forcedHeight) => {
    const fontWidth = Math.floor(innerW / faceScale);
    const wrapped = wrapText(text, fontWidth);
    const lineHeight = (GLYPH_HEIGHT + 6) * faceScale;
    const kindSpace = label ? KIND_H : 0;
    const needed = HEADER + padding * 2 + wrapped.length * lineHeight + kindSpace + FOOTER;
    return { wrapped, lineHeight, needed, fontWidth };
  };

  // QuotLy emphasises a key word per line — here the longest word that is long
  // enough to be worth marking (never a 1–3 letter word, never the whole line).
  const decorate = (list) => (highlight
    ? list.map((line) => {
        const words = [...line.matchAll(/\S+/g)];
        if (words.length < 2) return line;
        const best = words
          .filter((word) => word[0].length >= 4 && word[0].length <= 18)
          .sort((a, b) => b[0].length - a[0].length)[0];
        if (!best) return line;
        const at = best.index;
        return `${line.slice(0, at)}${HIGHLIGHT_MARKER}${line.slice(at, at + best[0].length)}`
          + `${HIGHLIGHT_MARKER}${line.slice(at + best[0].length)}`;
      })
    : list);

  // A quote made only of emoji has nothing to draw: fall back to a label.
  let label = kind;
  if (text && !normalizeText(text).trim()) label = label || 'Emoji';

  if (!text || !normalizeText(text).trim()) {
    lines = [];
    outHeight = height ? Math.min(MAX_SIDE, Math.max(360, Math.round(height))) : 360;
  }

  for (const faceScale of (text && normalizeText(text).trim()) ? [4, 3, 2] : []) {
    const layout = tryLayout(faceScale);
    if (layout.needed <= MAX_SIDE) {
      scale = faceScale;
      lines = decorate(layout.wrapped);
      outHeight = height || Math.max(360, layout.needed);
      break;
    }
    // Too tall even before clamping: keep this scale and clip below.
    scale = faceScale;
    const maxLines = Math.max(1, Math.floor(
      (MAX_SIDE - HEADER - FOOTER - padding * 2 - (kind ? KIND_H : 0)) / layout.lineHeight,
    ));
    const clamped = clampLines(layout.wrapped, maxLines, layout.fontWidth);
    lines = decorate(clamped.lines);
    clipped = clamped.clipped;
    outHeight = height || MAX_SIDE;
  }
  if (height) outHeight = Math.min(MAX_SIDE, Math.max(360, Math.round(height)));
  const lineHeight = (GLYPH_HEIGHT + 6) * scale;

  // ---- draw at supersampled resolution ------------------------------------
  const card = new Surface(width * s, outHeight * s, PALETTE.card);
  card.roundRect(0, 0, width * s, outHeight * s, 44 * s, PALETTE.card);
  card.rect(44 * s, 2 * s, (width - 88) * s, s, PALETTE.cardEdge);

  // Avatar: neutral silhouette (there is no image codec in the isolate).
  const avatarCx = 64 * s;
  const avatarCy = 64 * s;
  card.circle(avatarCx, avatarCy, 34 * s, PALETTE.avatar);
  card.circle(avatarCx, avatarCy - 12 * s, 12 * s, PALETTE.avatarInk);
  card.roundRect(avatarCx - 20 * s, avatarCy + 6 * s, 40 * s, 34 * s, 18 * s, PALETTE.avatarInk);

  // Author name + handle. If the display name is in a script the bitmap face
  // cannot draw, fall back to the Latin @username rather than showing "???".
  const nameX = 112 * s;
  const rawName = String(name || '').trim();
  const rawHandle = String(handle || '').replace(/^@/, '').trim();
  const shownName = renderableShare(rawName) >= 0.5
    ? rawName
    : (renderableShare(rawHandle) >= 0.5 ? rawHandle : 'USER');
  const authorName = normalizeText(shownName).slice(0, 24) || 'USER';
  const nameScale = authorName.length > 16 ? 3 : 4;
  card.line(authorName, nameX, 40 * s, nameScale * s, PALETTE.name);
  if (handle) card.line(normalizeText(handle).slice(0, 30), nameX, 84 * s, 2 * s, PALETTE.handle);
  card.roundRect(nameX, 104 * s, 44 * s, 4 * s, 2 * s, PALETTE.accent);

  // Speech bubble, sized to the measured content.
  const bubbleY = HEADER;
  const bubbleH = Math.max(120, outHeight - HEADER - FOOTER);
  card.roundRect(bubbleXf * s, bubbleY * s, bubbleWf * s, bubbleH * s, 26 * s, PALETTE.bubble);

  // The surface is supersampled: every coordinate must be scaled by `s`, or the
  // text lands at half position with a mismatched size.
  const textX = (bubbleXf + padding) * s;
  const textTop = (bubbleY + padding) * s;
  lines.forEach((line, index) => {
    card.highlightedLine(line, textX, textTop + index * lineHeight * s, scale * s,
      PALETTE.text, PALETTE.highlight);
  });
  if (label && !lines.length) {
    // Media-only quote: the label carries the whole bubble, so centre it.
    const labelText = normalizeText(label).slice(0, 30);
    const labelScale = 3;
    const labelWidth = textWidth(labelText) * labelScale;
    card.line(labelText, (bubbleXf + (bubbleWf - labelWidth) / 2) * s,
      (bubbleY + bubbleH / 2 - (GLYPH_HEIGHT * labelScale) / 2) * s,
      labelScale * s, PALETTE.footnote);
  } else if (label) {
    card.line(normalizeText(label).slice(0, 40),
      textX,
      (bubbleY + bubbleH - padding - 14) * s,
      2 * s, PALETTE.footnote);
  }

  // Honesty note: the bitmap face is Latin-only. When most of the quote cannot
  // be drawn, say so instead of shipping a card full of "?".
  const unsupportedScript = Boolean(text) && renderableShare(text) < 0.5
    && Boolean(normalizeText(text).trim());
  if (unsupportedScript) {
    card.line('SCRIPT NOT SUPPORTED', textX,
      (bubbleY + bubbleH - padding - 14) * s, 2 * s, PALETTE.footnote);
  }

  const flat = card.downsample(s);
  return { ...flattenToPalette(flat), clipped, lines, scale, unsupportedScript, label };
}

/**
 * Map the rendered RGB image onto an indexed palette. The design uses a small
 * fixed palette, but supersampling produces blends, so colours are quantised to
 * 5 bits per channel and the distinct results become the palette (≤ 256 entries,
 * the PNG colour-type-3 limit).
 */
function flattenToPalette({ width, height, rgb }) {
  const counts = new Map();
  const quantised = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = rgb[i * 3] & 0xf8;
    const g = rgb[i * 3 + 1] & 0xf8;
    const b = rgb[i * 3 + 2] & 0xf8;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length > 256) entries = entries.slice(0, 256);
  const palette = entries.map(([key]) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff]);
  const indexOf = new Map(entries.map(([key], i) => [key, i]));
  for (let i = 0; i < width * height; i += 1) {
    const r = rgb[i * 3] & 0xf8;
    const g = rgb[i * 3 + 1] & 0xf8;
    const b = rgb[i * 3 + 2] & 0xf8;
    const key = (r << 16) | (g << 8) | b;
    quantised[i] = indexOf.get(key) ?? nearestIndex(palette, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  }
  return { width, height, indices: quantised, palette };
}

function nearestIndex(palette, r, g, b) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const dr = palette[i][0] - r;
    const dg = palette[i][1] - g;
    const db = palette[i][2] - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** Render → PNG bytes ready for `sendSticker` / `createNewStickerSet`. */
export function renderQuotePng(options) {
  const image = renderQuote(options);
  const bytes = encodeIndexedPng({
    width: image.width,
    height: image.height,
    indices: image.indices,
    palette: image.palette,
  });
  return {
    bytes,
    width: image.width,
    height: image.height,
    clipped: image.clipped,
    lines: image.lines,
    label: image.label,
    unsupportedScript: image.unsupportedScript,
  };
}

/** Height that fits `lineCount` wrapped lines, clamped to the sticker limits. */
export function heightForLines(lineCount, scale = 4, hasKind = false) {
  const needed = 124 + 52 + lineCount * (GLYPH_HEIGHT + 6) * scale + (hasKind ? 30 : 0) + 28;
  return Math.min(MAX_SIDE, Math.max(360, needed));
}
