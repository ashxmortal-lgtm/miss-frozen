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
import { emojiTint, nameIsEmojiOnly } from './emoji.js';
import {
  loadAtlas, drawLine, drawRich, ellipsizeRich, measureLine, normalizeText,
  renderableShare, wrapText, clampLines, lineHeightOf,
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
  avatarFallbackLight: [232, 226, 242], // for emoji artwork that is itself dark
  badgeDisc: [48, 40, 64],              // dim disc behind the name-row emoji
  badgeInk: [176, 168, 192],
  avatarInk: [138, 122, 168],
  nestedBg: [44, 33, 62],      // the quoted block, a shade above the bubble
  nestedText: [196, 186, 212],
};

const MARGIN = 4;        // outer transparent padding
const AVATAR = 124;      // big avatar diameter (LEFT of the bubble)
const GAP = 14;          // avatar → bubble
const BUBBLE_RADIUS = 38;
const TEXT_PADDING = 24;
/** Small repeat of the avatar inside the bubble, next to the name (QuotLy). */
const BADGE = 34;

// ---- nested quote (`/q r`) -------------------------------------------------
/** The message being replied to, shown inside the bubble above the main text. */
/**
 * How much of the avatar radius the emoji glyph fills.
 * Measured on the render: 0.55 puts the drawn glyph at ~46% of the disc
 * diameter, which is what the reference sticker shows.
 */
const EMOJI_GLYPH_SCALE = 0.55;

const NESTED = {
  pad: 12,          // inner padding of the quoted block
  bar: 4,           // accent bar on the left
  barGap: 10,       // bar → quoted content
  nameSize: 15,
  nameHeight: 20,
  textSize: 17,
  maxLines: 3,
  gapAfter: 12,     // quoted block → main text
};

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
   * Draw an image's *shape* in one colour, masked by a circle.
   *
   * Emoji avatars are drawn this way — a single-tone glyph over a tinted disc —
   * which is how Telegram paints custom emoji (`needs_repainting`, Bot API 6.6)
   * and why the native avatar looks clean rather than like flat artwork.
   *
   * @param {{width:number,height:number,rgba:Uint8Array}} image  alpha is the mask
   * @param {number[]} color  the single tone to paint
   */
  circularImageTinted(image, cx, cy, radius, color, artScale = 1) {
    const { width, height, rgba } = image;
    const [cr, cg, cb] = color;
    const side = Math.min(width, height);
    const offsetX = (width - side) / 2;
    const offsetY = (height - side) / 2;
    const artRadius = radius * artScale;

    for (let py = Math.floor(cy - radius) - 1; py <= Math.ceil(cy + radius) + 1; py += 1) {
      for (let px = Math.floor(cx - radius) - 1; px <= Math.ceil(cx + radius) + 1; px += 1) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const coverage = Math.min(1, Math.max(0, 0.5 - (Math.sqrt(dx * dx + dy * dy) - radius)));
        if (coverage <= 0) continue;

        const u = (px + 0.5 - (cx - artRadius)) / (artRadius * 2);
        const v = (py + 0.5 - (cy - artRadius)) / (artRadius * 2);
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;

        const sx = Math.min(width - 1, Math.floor(offsetX + u * side));
        const sy = Math.min(height - 1, Math.floor(offsetY + v * side));
        const alpha = rgba[(sy * width + sx) * 4 + 3] / 255;
        if (alpha <= 0) continue;
        this.blend(px, py, cr, cg, cb, coverage * alpha);
      }
    }
  }

  /**
   * Draw a decoded image into a rectangle — the inline emoji inside a name.
   * Bilinear sampling, because the baked tile is 40 px and the name row is ~23.
   */
  imageRect(image, x, y, width, height) {
    const { width: sourceWidth, height: sourceHeight, rgba } = image;
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      if (py < 0 || py >= this.height) continue;
      const v = ((py + 0.5 - y) / height) * sourceHeight - 0.5;
      const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(v)));
      const y1 = Math.min(sourceHeight - 1, y0 + 1);
      const fy = Math.min(1, Math.max(0, v - y0));
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
        if (px < 0 || px >= this.width) continue;
        const u = ((px + 0.5 - x) / width) * sourceWidth - 0.5;
        const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(u)));
        const x1 = Math.min(sourceWidth - 1, x0 + 1);
        const fx = Math.min(1, Math.max(0, u - x0));

        const sample = (sx, sy, channel) => rgba[(sy * sourceWidth + sx) * 4 + channel];
        const mix = (channel) => {
          const top = sample(x0, y0, channel) * (1 - fx) + sample(x1, y0, channel) * fx;
          const bottom = sample(x0, y1, channel) * (1 - fx) + sample(x1, y1, channel) * fx;
          return top * (1 - fy) + bottom * fy;
        };
        const alpha = mix(3) / 255;
        if (alpha <= 0.004) continue;
        this.blend(px, py, Math.round(mix(0)), Math.round(mix(1)), Math.round(mix(2)), alpha);
      }
    }
  }

  /**
   * Draw a decoded image into a circle (the profile photo), cropped to a square
   * from its centre like Telegram does, then masked by the circle's coverage.
   *
   * @param {{width:number,height:number,rgba:Uint8Array}} image
   * @param {number} [artScale]  artwork size relative to the mask (1 = fills it).
   *        Emoji artwork is drawn slightly inside the disc so its edges are not
   *        clipped by the circle; photos keep the default full bleed.
   */
  circularImage(image, cx, cy, radius, artScale = 1) {
    const { width, height, rgba } = image;
    const side = Math.min(width, height);
    const offsetX = (width - side) / 2;
    const offsetY = (height - side) / 2;
    const artRadius = radius * artScale;

    for (let py = Math.floor(cy - radius) - 1; py <= Math.ceil(cy + radius) + 1; py += 1) {
      for (let px = Math.floor(cx - radius) - 1; px <= Math.ceil(cx + radius) + 1; px += 1) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const distance = Math.sqrt(dx * dx + dy * dy) - radius;
        const coverage = Math.min(1, Math.max(0, 0.5 - distance));
        if (coverage <= 0) continue;

        // Map the pixel into the source square.
        const u = (px + 0.5 - (cx - artRadius)) / (artRadius * 2);
        const v = (py + 0.5 - (cy - artRadius)) / (artRadius * 2);
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
  badge = false, nested = null,
}) {
  const avatarSpace = hasAvatar ? AVATAR + GAP : 0;
  const bubbleWidth = width - MARGIN * 2 - avatarSpace;
  const innerWidth = bubbleWidth - TEXT_PADDING * 2;
  const nameSize = 23;
  // The name shares its row with the small badge, so the row is taller.
  const nameLineHeight = Math.max(Math.round(nameSize * 1.3), badge ? BADGE + 6 : 0);

  // The nested quote (`/q r`) has a fixed, small type size, so its size does not
  // depend on the main text and is measured once.
  const nestedLines = nested && nested.text
    ? clampLines(wrapText(normalizeText(nested.text), nestedContentWidth(innerWidth), NESTED.textSize),
      NESTED.maxLines, nestedContentWidth(innerWidth), NESTED.textSize).lines
    : [];
  const nestedBoxHeight = nestedLines.length
    ? NESTED.pad * 2 + NESTED.nameHeight + nestedLines.length * lineHeightOf(NESTED.textSize) + 3
    : 0;
  const nestedBlock = nestedBoxHeight ? nestedBoxHeight + NESTED.gapAfter : 0;

  for (const size of FONT_STEPS) {
    const lines = text ? wrapText(normalizeText(text), innerWidth, size) : [];
    const lineHeight = lineHeightOf(size);
    const bubbleHeight = TEXT_PADDING * 2 + nameLineHeight + 10 + nestedBlock
      + (lines.length ? lines.length * lineHeight : lineHeight);
    const height = Math.max(bubbleHeight + MARGIN * 2 + (hasAvatar ? 16 : 0),
      hasAvatar ? AVATAR + MARGIN * 2 : 0);
    if (height <= maxHeight) {
      return {
        fontSize: size, lines, lineHeight, bubbleWidth, bubbleHeight, innerWidth,
        nameSize, nameLineHeight, height: Math.min(maxHeight, Math.round(height)), clipped: false,
        nestedLines, nestedBoxHeight,
      };
    }
  }

  // Even the smallest size overflows: clip to the available rows.
  const size = FONT_STEPS[FONT_STEPS.length - 1];
  const lineHeight = lineHeightOf(size);
  const room = Math.floor((maxHeight - MARGIN * 2 - TEXT_PADDING * 2 - nameLineHeight - 10 - nestedBlock)
    / lineHeight);
  const wrapped = wrapText(normalizeText(text), innerWidth, size);
  const { lines, clipped } = clampLines(wrapped, Math.max(1, room), innerWidth, size);
  const bubbleHeight = TEXT_PADDING * 2 + nameLineHeight + 10 + nestedBlock + lines.length * lineHeight;
  return {
    fontSize: size, lines, lineHeight, bubbleWidth, bubbleHeight, innerWidth,
    nameSize, nameLineHeight, height: maxHeight, clipped, nestedLines, nestedBoxHeight,
  };
}

/** Width available to the quoted text: block − padding − accent bar − bar gap. */
function nestedContentWidth(innerWidth) {
  return Math.max(40, innerWidth - NESTED.pad * 2 - NESTED.bar - NESTED.barGap);
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
 * @param {{name:string,text:string,userId?:number}} [options.nested]
 *        the message this one was replying to (`/q r`), drawn inside the bubble
 * @param {boolean} [options.emojiAvatar]  the avatar is emoji artwork, drawn as a
 *        single-tone glyph on a tinted disc the way Telegram paints it
 * @param {number} [options.emojiCodepoint]  which emoji, to pick its tint
 * @param {Map<string, object>|null} [options.nameEmoji]  artwork for the emoji
 *        inside the display name, keyed by cluster ("❄️")
 */
export function renderQuote({
  text = '', name = '', userId = 0, avatar = null, kind = '', nested = null,
  emojiAvatar = false, emojiCodepoint = 0, nameEmoji = null,
}) {
  loadAtlas(); // fail fast if the atlas is unusable

  const cleanText = String(text ?? '').trim();
  const drawableText = normalizeText(cleanText).trim();
  const onlyEmoji = Boolean(cleanText) && !drawableText;
  const label = (!drawableText || onlyEmoji) ? (kind || 'Emoji') : '';

  // The small avatar is repeated inside the bubble beside the name — the detail
  // that makes the card read as a QuotLy sticker rather than a text box.
  const badge = true;

  const plan = planLayout({ text: drawableText || '', name, hasAvatar: true, badge, nested });
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
  const nestedTop = nameRowTop + plan.nameLineHeight + 10;
  const firstLineBaseline = nestedTop + (plan.nestedBoxHeight ? plan.nestedBoxHeight + NESTED.gapAfter : 0)
    + plan.lineHeight - Math.round((plan.lineHeight - plan.nameSize) / 2);

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
  // The avatar arrives as an image in every case — a photo, an emoji tile, or an
  // emoji downloaded from the CDN. Only a total miss reaches the lettered disc.
  const initials = ([...normalizeText(name).trim()][0] || '').toUpperCase();
  // Emoji avatars are painted as one tone on a tinted disc, matching Telegram.
  const tint = emojiAvatar ? emojiTint(emojiCodepoint) : null;
  const drawFace = (image, cx, cy, radius, fontSize) => {
    if (image) {
      if (tint) {
        // Tinted disc + single-tone glyph: the native avatar look.
        surface.circle(cx, cy, radius, tint.bg);
        surface.circularImageTinted(image, cx, cy, radius, tint.ink, EMOJI_GLYPH_SCALE);
        return;
      }
      surface.circularImage(image, cx, cy, radius);
      return;
    }
    // No photo and no emoji: an honest disc with the initial.
    surface.circle(cx, cy, radius, PALETTE.avatarFallback);
    if (!initials) return;
    const width = measureLine(initials, fontSize);
    drawLine(surface, initials, cx - width / 2, cy + fontSize * 0.36, fontSize, PALETTE.avatarInk);
  };
  drawFace(avatar, avatarCx, avatarCy, avatarRadius, 52);

  // ---- badge + display name inside the bubble ---------------------------
  const badgeCx = textX + BADGE / 2;
  const badgeCy = nameRowTop + BADGE / 2;
  if (tint && avatar) {
    // The badge is the same glyph in a neutral tone, on a dimmed disc — the
    // reference shows a small grey web on a barely-visible circle.
    surface.circle(badgeCx, badgeCy, BADGE / 2, PALETTE.badgeDisc);
    surface.circularImageTinted(avatar, badgeCx, badgeCy, BADGE / 2, PALETTE.badgeInk, 0.92);
  } else {
    drawFace(avatar, badgeCx, badgeCy, BADGE / 2, 18);
  }

  const nameX = textX + BADGE + 12;
  const nameWidth = plan.innerWidth - BADGE - 12;
  // The name keeps its own typography: 𝒃𝒐𝒍𝒅 stays bold, 𝑖𝑡𝑎𝑙𝑖𝑐 stays italic,
  // and the ❄️ inside it is drawn as artwork instead of disappearing.
  const cleanName = normalizeText(name, { keepEmoji: true }).trim();
  // A name that is only an emoji (🕸️) is drawn AS that emoji, on the badge
  // beside it. Calling it "Unknown" was wrong: the emoji IS the name.
  const emojiOnlyName = nameIsEmojiOnly(name);
  const shownName = emojiOnlyName
    ? String(name).trim()
    : ellipsizeRich(cleanName || 'Unknown', nameWidth, plan.nameSize);
  if (!emojiOnlyName) {
    drawRich(surface, shownName, nameX, nameBaseline, plan.nameSize,
      nameColor(userId), nameEmoji);
  }

  // ---- the quoted message, inside the bubble (`/q r`) --------------------
  if (plan.nestedLines.length) {
    const boxX = textX;
    const boxW = plan.innerWidth;
    const boxH = plan.nestedBoxHeight;
    surface.roundRect(boxX, nestedTop, boxW, boxH, 10, PALETTE.nestedBg);

    // Accent bar, in the quoted author's colour, like Telegram's reply strip.
    const accent = nameColor(nested?.userId || userId);
    surface.roundRect(boxX + NESTED.pad, nestedTop + NESTED.pad, NESTED.bar,
      boxH - NESTED.pad * 2, NESTED.bar / 2, accent);

    const contentX = boxX + NESTED.pad + NESTED.bar + NESTED.barGap;
    const contentW = nestedContentWidth(plan.innerWidth);
    const nestedName = ellipsizeRich(
      normalizeText(nested?.name || '', { keepEmoji: true }).trim(), contentW, NESTED.nameSize);
    if (nestedName) {
      drawRich(surface, nestedName, contentX,
        nestedTop + NESTED.pad + NESTED.nameSize, NESTED.nameSize, accent, nameEmoji);
    }
    const nestedLineHeight = lineHeightOf(NESTED.textSize);
    plan.nestedLines.forEach((line, index) => {
      drawLine(surface, line, contentX,
        nestedTop + NESTED.pad + NESTED.nameHeight + (index + 1) * nestedLineHeight
          - Math.round((nestedLineHeight - NESTED.textSize) / 2),
        NESTED.textSize, PALETTE.nestedText);
    });
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
    // True when the disc shows emoji artwork instead of a photo.
    emojiAvatar: Boolean(avatar) && Boolean(emojiAvatar),
    // What the card actually credits — lets tests assert the visible name.
    drawnName: shownName,
    nestedLines: plan.nestedLines,
  };
}

/** Render → PNG bytes ready for `sendSticker` / `createNewStickerSet`. */
export function renderQuotePng(options) {
  const image = renderQuote(options);
  const bytes = encodeRgbaPng({ width: image.width, height: image.height, rgba: image.rgba });
  return { ...image, bytes };
}

export { wrapText };
