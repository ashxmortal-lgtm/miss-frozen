/**
 * Quote-sticker renderer — pure JavaScript, transparent RGBA output.
 *
 * Layout follows a Classic QuotLy sticker: the author's round profile photo sits
 * to the left, and a compact dark rounded speech bubble with a soft tail holds
 * the display name and the quoted text. Everything outside that artwork is
 * fully transparent, so the sticker floats on any chat theme.
 *
 * There is no canvas in the isolate; shapes are drawn with signed-distance
 * coverage (crisp anti-aliased edges), text comes from the baked DejaVu atlas
 * (quote/text.js), and the PNG is written with real deflate compression
 * (quote/png.js). Sticker constraints: one side exactly 512 px, the other
 * ≤ 512 px, ≤ 512 KB.
 */

import { encodeRgbaPng } from './png.js';
import {
  loadAtlas, drawLine, measureLine, normalizeText, renderableShare,
  wrapText, clampLines, ellipsize, lineHeightOf,
} from './text.js';

export const STICKER_SIZE = 512;
export const MAX_SIDE = 512;

/** Palette sampled from the reference QuotLy sticker. */
export const PALETTE = {
  bubble: [27, 19, 40],        // #1B1328 dark purple, near black
  bubbleEdge: [45, 34, 62],
  text: [248, 248, 250],
  nameFallback: [167, 139, 250],
  meta: [150, 138, 168],
  avatarFallback: [58, 47, 78],
  avatarInk: [138, 122, 168],
};

const MARGIN = 4;        // outer transparent padding
const AVATAR = 124;      // big avatar diameter (LEFT of the bubble)
const GAP = 14;          // avatar → bubble
const BUBBLE_RADIUS = 38;
const TEXT_PADDING = 24;
/** Small repeat of the avatar inside the bubble, next to the name (QuotLy). */
const BADGE = 34;

// ---- surface ---------------------------------------------------------------

export class Surface {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4); // transparent
  }

  /** Source-over blend of one pixel. */
  blend(x, y, r, g, b, alpha = 1) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const data = this.data;
    if (alpha >= 1) {
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
      return;
    }
    const srcA = alpha;
    const dstA = data[index + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    data[index] = Math.round((r * srcA + data[index] * dstA * (1 - srcA)) / outA);
    data[index + 1] = Math.round((g * srcA + data[index + 1] * dstA * (1 - srcA)) / outA);
    data[index + 2] = Math.round((b * srcA + data[index + 2] * dstA * (1 - srcA)) / outA);
    data[index + 3] = Math.round(outA * 255);
  }

  /** Rounded rectangle with analytic anti-aliasing. */
  roundRect(x, y, width, height, radius, color) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    const right = x + width;
    const bottom = y + height;
    const [cr, cg, cb] = color;
    for (let py = Math.floor(y) - 1; py < Math.ceil(bottom) + 1; py += 1) {
      for (let px = Math.floor(x) - 1; px < Math.ceil(right) + 1; px += 1) {
        const sampleX = px + 0.5;
        const sampleY = py + 0.5;
        // Signed distance to the rounded rectangle.
        const dx = Math.max(x + r - sampleX, 0, sampleX - (right - r));
        const dy = Math.max(y + r - sampleY, 0, sampleY - (bottom - r));
        const distance = Math.sqrt(dx * dx + dy * dy) - r;
        const coverage = Math.min(1, Math.max(0, 0.5 - distance));
        if (coverage > 0) this.blend(px, py, cr, cg, cb, coverage);
      }
    }
  }

  /** Circle with analytic anti-aliasing. */
  circle(cx, cy, radius, color, alpha = 1) {
    const [cr, cg, cb] = color;
    for (let py = Math.floor(cy - radius) - 1; py <= Math.ceil(cy + radius) + 1; py += 1) {
      for (let px = Math.floor(cx - radius) - 1; px <= Math.ceil(cx + radius) + 1; px += 1) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const distance = Math.sqrt(dx * dx + dy * dy) - radius;
        const coverage = Math.min(1, Math.max(0, 0.5 - distance));
        if (coverage > 0) this.blend(px, py, cr, cg, cb, coverage * alpha);
      }
    }
  }

  /**
   * Draw a decoded image into a circle (the profile photo), cropped to a square
   * from its centre like Telegram does, then masked by the circle's coverage.
   *
   * @param {{width:number,height:number,rgba:Uint8Array}} image
   */
  circularImage(image, cx, cy, radius) {
    const { width, height, rgba } = image;
    const side = Math.min(width, height);
    const offsetX = (width - side) / 2;
    const offsetY = (height - side) / 2;

    for (let py = Math.floor(cy - radius) - 1; py <= Math.ceil(cy + radius) + 1; py += 1) {
      for (let px = Math.floor(cx - radius) - 1; px <= Math.ceil(cx + radius) + 1; px += 1) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const distance = Math.sqrt(dx * dx + dy * dy) - radius;
        const coverage = Math.min(1, Math.max(0, 0.5 - distance));
        if (coverage <= 0) continue;

        // Map the pixel into the source square.
        const u = (px + 0.5 - (cx - radius)) / (radius * 2);
        const v = (py + 0.5 - (cy - radius)) / (radius * 2);
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        const sx = Math.min(width - 1, Math.floor(offsetX + u * side));
        const sy = Math.min(height - 1, Math.floor(offsetY + v * side));
        const index = (sy * width + sx) * 4;
        this.blend(px, py, rgba[index], rgba[index + 1], rgba[index + 2],
          coverage * (rgba[index + 3] / 255));
      }
    }
  }

  /**
   * Speech-bubble tail: a fin hanging from the bubble's bottom-left corner that
   * tapers to a point below, like QuotLy's. `top` is where it meets the bubble,
   * `drop` how far it hangs, `width` how far it reaches left of `left`.
   */
  tail(left, top, drop, width, color) {
    const [cr, cg, cb] = color;
    const anchorRight = left + width * 0.62;
    for (let py = Math.floor(top) - 1; py <= Math.ceil(top + drop) + 1; py += 1) {
      const t = (py + 0.5 - top) / drop; // 0 at the bubble edge, 1 at the tip
      if (t < 0 || t > 1) continue;
      // Widest at the top, tapering to nothing; sweeps left on the way down.
      const finWidth = width * Math.pow(1 - t, 0.55);
      const finLeft = anchorRight - finWidth - t * width * 0.5;
      for (let px = Math.floor(finLeft) - 1; px <= Math.ceil(anchorRight) + 1; px += 1) {
        // Coverage in x only (the y transition is hidden inside the bubble).
        const coverageX = Math.min(1, Math.max(0, (px + 1.5 - finLeft)));
        const coverageY = t > 0.94 ? (1 - t) / 0.06 : 1;
        const coverage = Math.min(1, coverageX) * Math.min(1, coverageY);
        if (coverage > 0) this.blend(px, py, cr, cg, cb, coverage);
      }
    }
  }
}

// ---- layout ----------------------------------------------------------------

/** Deterministic pleasant colour for a display name (Telegram-style). */
export function nameColor(userId) {
  const palette = [
    [255, 143, 171], [255, 173, 120], [255, 214, 117], [167, 235, 154],
    [122, 226, 214], [137, 196, 255], [178, 168, 255], [231, 160, 255],
  ];
  const seed = Math.abs(Number(userId) || 0);
  return palette[seed % palette.length];
}

const FONT_STEPS = [40, 36, 33, 30, 27, 24, 21, 19, 17];

/**
 * Plan the card: pick a font size that fits the text, then the bubble height.
 * Pure arithmetic, so it can be unit-tested without rendering.
 */
export function planLayout({
  text = '', name = '', hasAvatar = true, width = STICKER_SIZE, maxHeight = MAX_SIDE,
  badge = false,
}) {
  const avatarSpace = hasAvatar ? AVATAR + GAP : 0;
  const bubbleWidth = width - MARGIN * 2 - avatarSpace;
  const innerWidth = bubbleWidth - TEXT_PADDING * 2;
  const nameSize = 23;
  // The name shares its row with the small badge, so the row is taller.
  const nameLineHeight = Math.max(Math.round(nameSize * 1.3), badge ? BADGE + 6 : 0);

  for (const size of FONT_STEPS) {
    const lines = text ? wrapText(normalizeText(text), innerWidth, size) : [];
    const lineHeight = lineHeightOf(size);
    const bubbleHeight = TEXT_PADDING * 2 + nameLineHeight + 10
      + (lines.length ? lines.length * lineHeight : lineHeight);
    const height = Math.max(bubbleHeight + MARGIN * 2 + (hasAvatar ? 16 : 0),
      hasAvatar ? AVATAR + MARGIN * 2 : 0);
    if (height <= maxHeight) {
      return {
        fontSize: size, lines, lineHeight, bubbleWidth, bubbleHeight, innerWidth,
        nameSize, nameLineHeight, height: Math.min(maxHeight, Math.round(height)), clipped: false,
      };
    }
  }

  // Even the smallest size overflows: clip to the available rows.
  const size = FONT_STEPS[FONT_STEPS.length - 1];
  const lineHeight = lineHeightOf(size);
  const room = Math.floor((maxHeight - MARGIN * 2 - TEXT_PADDING * 2 - nameLineHeight - 10)
    / lineHeight);
  const wrapped = wrapText(normalizeText(text), innerWidth, size);
  const { lines, clipped } = clampLines(wrapped, Math.max(1, room), innerWidth, size);
  const bubbleHeight = TEXT_PADDING * 2 + nameLineHeight + 10 + lines.length * lineHeight;
  return {
    fontSize: size, lines, lineHeight, bubbleWidth, bubbleHeight, innerWidth,
    nameSize, nameLineHeight, height: maxHeight, clipped,
  };
}

// ---- sticker ---------------------------------------------------------------

/**
 * Render a quote sticker.
 *
 * @param {object} options
 * @param {string} options.text        quoted message text (already extracted)
 * @param {string} options.name        display name of the author
 * @param {string} [options.time]      e.g. "7:37 PM"
 * @param {number} [options.userId]    seeds the name colour
 * @param {object|null} [options.avatar]  decoded RGBA image for the profile photo
 * @param {string} [options.kind]      label when the message had no text
 */
export function renderQuote({
  text = '', name = '', userId = 0, avatar = null, kind = '', subtitle = '',
}) {
  loadAtlas(); // fail fast if the atlas is unusable

  const cleanText = String(text ?? '').trim();
  const drawableText = normalizeText(cleanText).trim();
  const onlyEmoji = Boolean(cleanText) && !drawableText;
  const label = (!drawableText || onlyEmoji) ? (kind || 'Emoji') : '';

  // The small avatar is repeated inside the bubble beside the name — the detail
  // that makes the card read as a QuotLy sticker rather than a text box.
  const badge = true;

  const plan = planLayout({ text: drawableText || '', name, hasAvatar: true, badge });
  const height = plan.height;
  const surface = new Surface(STICKER_SIZE, height);

  const avatarRadius = AVATAR / 2;
  const avatarCx = MARGIN + avatarRadius;
  const bubbleX = MARGIN + AVATAR + GAP;
  const bubbleY = MARGIN;
  const bubbleW = STICKER_SIZE - MARGIN - bubbleX;
  // The tail hangs below the bubble's bottom-left, pointing at the avatar.
  const TAIL_DROP = 18;
  const bubbleH = height - MARGIN * 2 - TAIL_DROP;

  const textX = bubbleX + TEXT_PADDING;
  const nameRowTop = bubbleY + TEXT_PADDING;
  const nameBaseline = nameRowTop + Math.round(BADGE / 2 + plan.nameSize * 0.34);
  const firstLineBaseline = nameRowTop + plan.nameLineHeight + 10 + plan.lineHeight
    - Math.round((plan.lineHeight - plan.nameSize) / 2);

  // Blank lines shrink to a paragraph gap instead of a full line box.
  const baselineOf = (index) => {
    let y = firstLineBaseline;
    for (let i = 0; i < index; i += 1) {
      y += plan.lines[i].trim() ? plan.lineHeight : Math.round(plan.lineHeight * 0.45);
    }
    return y;
  };

  // Tail first, then the bubble paints over the seam.
  surface.tail(bubbleX, bubbleY + bubbleH - 34, TAIL_DROP + 20, 46, PALETTE.bubble);
  surface.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, BUBBLE_RADIUS, PALETTE.bubble);

  // ---- the author's avatar, LEFT, centred against the bubble --------------
  const avatarCy = bubbleY + bubbleH / 2;
  const initials = (normalizeText(name).trim()[0] || '?').toUpperCase();
  const drawFace = (image, cx, cy, radius, fontSize) => {
    if (image) {
      surface.circularImage(image, cx, cy, radius);
      return;
    }
    // Honest fallback: a tinted disc with the initial. Never a fake person.
    surface.circle(cx, cy, radius, PALETTE.avatarFallback);
    const width = measureLine(initials, fontSize);
    drawLine(surface, initials, cx - width / 2, cy + fontSize * 0.36, fontSize, PALETTE.avatarInk);
  };
  drawFace(avatar, avatarCx, avatarCy, avatarRadius, 52);

  // ---- badge + display name inside the bubble ---------------------------
  const badgeCx = textX + BADGE / 2;
  const badgeCy = nameRowTop + BADGE / 2;
  drawFace(avatar, badgeCx, badgeCy, BADGE / 2, 18);

  const nameX = textX + BADGE + 12;
  const nameWidth = plan.innerWidth - BADGE - 12;
  const shownName = ellipsize(normalizeText(name).trim() || 'Unknown', nameWidth, plan.nameSize);
  drawLine(surface, shownName, nameX, nameBaseline, plan.nameSize, nameColor(userId));

  if (subtitle) {
    const subSize = 15;
    const shownSub = ellipsize(normalizeText(subtitle), nameWidth, subSize);
    drawLine(surface, shownSub, nameX, nameBaseline + subSize + 3, subSize, PALETTE.meta);
  }

  // ---- quoted text -------------------------------------------------------
  if (label) {
    const size = Math.min(plan.fontSize, 30);
    drawLine(surface, normalizeText(label), textX, firstLineBaseline + size * 0.1,
      size, PALETTE.meta);
  } else {
    plan.lines.forEach((line, index) => {
      drawLine(surface, line, textX, baselineOf(index), plan.fontSize, PALETTE.text);
    });
  }

  // Honesty: the atlas is Latin-only.
  const unsupportedScript = Boolean(drawableText) && renderableShare(cleanText) < 0.5;

  return {
    width: STICKER_SIZE,
    height: plan.height,
    rgba: surface.data,
    lines: plan.lines,
    fontSize: plan.fontSize,
    clipped: plan.clipped,
    label,
    unsupportedScript,
    hasAvatar: Boolean(avatar),
  };
}

/** Render → PNG bytes ready for `sendSticker` / `createNewStickerSet`. */
export function renderQuotePng(options) {
  const image = renderQuote(options);
  const bytes = encodeRgbaPng({ width: image.width, height: image.height, rgba: image.rgba });
  return { ...image, bytes };
}

export { wrapText };
