#!/usr/bin/env node
/**
 * Build the quote-sticker emoji atlas — a BUILD-TIME tool, not a runtime import.
 *
 * The isolate cannot fetch fonts or load images from the network mid-render, and
 * the text atlas is ASCII-only, so emoji are baked here once and committed as
 * `tgcloud/lib/quote/emoji_atlas.js`.
 *
 * Artwork: Google Noto Emoji, via the `emoji-datasource-google` npm package
 * (Apache-2.0). Only the curated set below is shipped — the full catalogue is
 * ~3,800 images and far too large to commit.
 *
 * Each emoji is downscaled to EMOJI_EM×EMOJI_EM RGBA, packed into one square
 * grid, deflated with the project's own encoder and written out as base64. The
 * runtime only needs its own inflate + the atlas dimensions.
 *
 * Usage:
 *   npm i --no-save emoji-datasource-google
 *   node scripts/build_emoji_atlas.js [path/to/emoji-datasource-google]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zlibDeflate } from '../tgcloud/lib/quote/deflate.js';

const EM = 32; // pixels per emoji in the atlas
const COLUMNS = 16;

const SOURCE = process.argv[2] || 'node_modules/emoji-datasource-google';

/**
 * Curated set, selected by category and capped per group so the atlas stays a
 * reasonable size. Skin-tone variants and flags are excluded: names use the
 * default presentation, and a flag is rare in a first name.
 */
/**
 * Always shipped, whatever the category caps say — these are the emoji people
 * actually put in a first name, and a missing 🕸️ when that is the whole name is
 * exactly the bug this atlas exists to fix.
 */
const ALWAYS = [
  0x1f578, // spider web
  0x1f525, // fire
  0x2728, // sparkles
  0x2b50, // star
  0x1f31f, // glowing star
  0x1f4ab, // dizzy
  0x26a1, // high voltage
  0x1f600, 0x1f602, 0x1f60a, 0x1f60d, 0x1f618, 0x1f61c, 0x1f643, 0x1f929,
  0x2764, 0x1f494, 0x1f495, 0x1f49e, 0x1f496, 0x1f49b, 0x1f49c, 0x1f49a,
  0x1f338, 0x1f339, 0x1f33b, 0x1f33c, 0x1f490, 0x1f340, 0x1f343, 0x1f342,
  0x1f480, 0x1f451, 0x1f48e, 0x1f3c6, 0x1f3af, 0x1f3ae, 0x1f3b5, 0x1f3b8,
  0x1f319, 0x2600, 0x1f308, 0x2744, 0x1f30a, 0x1f41d, 0x1f43a, 0x1f98a,
  0x1f409, 0x1f996, 0x1f989, 0x1f43e, 0x1f984,
];

const GROUPS = [
  { category: 'Smileys & Emotion', cap: 34 },
  { category: 'Animals & Nature', cap: 34 },
  { category: 'Food & Drink', cap: 14 },
  { category: 'Activities', cap: 14 },
  { category: 'Travel & Places', cap: 12 },
  { category: 'Objects', cap: 14 },
  { category: 'Symbols', cap: 34 },
  { category: 'People & Body', subcategories: ['hand-fingers-open', 'hand-fingers-partial', 'hand-single-finger'], cap: 12 },
];

const pickEmoji = (catalogue) => {
  const picked = [];
  const seen = new Set();

  // 1. The must-have set first, in the order listed.
  for (const cp of ALWAYS) {
    const hex = cp.toString(16).toUpperCase();
    const entry = catalogue.find((candidate) => candidate.has_img_google
      && candidate.image && candidate.unified.split('-')[0] === hex);
    if (!entry || seen.has(entry.unified)) continue;
    seen.add(entry.unified);
    picked.push(entry);
  }

  // 2. Fill each category with its most-established emoji. `sort_order` follows
  //    Unicode's original ordering (older = far more common in names), which is
  //    a much better popularity proxy than an even spread.
  for (const group of GROUPS) {
    const pool = catalogue.filter((entry) => {
      if (!entry.has_img_google || !entry.image) return false;
      if (entry.category !== group.category) return false;
      if (group.subcategories && !group.subcategories.includes(entry.subcategory)) return false;
      // Skip skin-tone / hair variants and "component" placeholders.
      if (/tone/i.test(entry.name) || /tone/i.test(entry.short_name)) return false;
      if (entry.subcategory === 'skin-tone') return false;
      return true;
    });
    pool.sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9));
    let taken = 0;
    for (const entry of pool) {
      if (taken >= group.cap) break;
      const key = entry.unified;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(entry);
      taken += 1;
    }
  }
  return picked;
};

const main = () => {
  const catalogue = JSON.parse(readFileSync(join(SOURCE, 'emoji.json'), 'utf8'));
  const picks = pickEmoji(catalogue);
  if (!picks.length) throw new Error(`no emoji found under ${SOURCE}`);

  const rows = Math.ceil(picks.length / COLUMNS);
  const width = COLUMNS * EM;
  const height = rows * EM;
  const atlas = new Uint8Array(width * height * 4);
  const work = mkdtempSync(join(tmpdir(), 'emoji-atlas-'));

  const codePoints = [];
  picks.forEach((entry, index) => {
    const file = join(SOURCE, 'img', 'google', '64', entry.image);
    const rgbaFile = join(work, `${index}.rgba`);
    execFileSync('convert', [file, '-resize', `${EM}x${EM}!`, '-depth', '8', `rgba:${rgbaFile}`]);
    const pixels = readFileSync(rgbaFile);
    if (pixels.length !== EM * EM * 4) {
      throw new Error(`${entry.image}: expected ${EM * EM * 4} RGBA bytes, got ${pixels.length}`);
    }

    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    for (let y = 0; y < EM; y += 1) {
      const src = y * EM * 4;
      const dst = ((row * EM + y) * width + col * EM) * 4;
      atlas.set(pixels.subarray(src, src + EM * 4), dst);
    }

    // A single emoji may have several code points (fe0f, zwj sequences); the
    // atlas is keyed by the first, which is what a renderer looks up.
    codePoints.push(entry.unified.split('-')[0]);
  });

  rmSync(work, { recursive: true, force: true });

  const compressed = zlibDeflate(atlas);
  const base64 = Buffer.from(compressed).toString('base64');

  const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Built by scripts/build_emoji_atlas.js from Google Noto Emoji
 * (emoji-datasource-google, Apache-2.0).
 *
 * ${picks.length} emoji, ${EM}×${EM} px each, packed ${COLUMNS} per row in one
 * ${width}×${height} RGBA atlas, deflated with the project's own encoder.
 *
 * Codepoints are hex strings (the first code point of each sequence), in atlas
 * order — index i lives at column i % ${COLUMNS}, row floor(i / ${COLUMNS}).
 */
export const EMOJI_EM = ${EM};
export const EMOJI_COLUMNS = ${COLUMNS};
export const EMOJI_WIDTH = ${width};
export const EMOJI_HEIGHT = ${height};
export const EMOJI_CODEPOINTS = ${JSON.stringify(codePoints)};
export const EMOJI_DEFLATED_BASE64 = '${base64}';
`;

  const target = join('tgcloud', 'lib', 'quote', 'emoji_atlas.js');
  writeFileSync(target, out);
  console.log(`emoji atlas: ${picks.length} emoji, ${width}x${height} px, `
    + `${(out.length / 1024).toFixed(0)} KB source → ${target}`);
};

void readdirSync;
main();
