/**
 * 5×7 bitmap font for the quote-sticker renderer.
 *
 * The isolate has no font rasteriser (no canvas, no FreeType, no npm packages),
 * so glyphs are defined as pixels. Each entry is 7 rows of 5 columns; `#` is
 * ink. Lowercase is drawn as uppercase (a bitmap face cannot carry two cases at
 * this size) and the typographic characters Telegram users actually paste are
 * folded onto ASCII before rendering.
 */

const GLYPHS = {
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  0: '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  1: '..#../.##../..#../..#../..#../..#../.###.',
  2: '.###./#...#/....#/...#./..#../.#.../#####',
  3: '#####/...#./..#../...#./....#/#...#/.###.',
  4: '...#./..##./.#.#./#..#./#####/...#./...#.',
  5: '#####/#..../####./....#/....#/#...#/.###.',
  6: '..##./.#.../#..../####./#...#/#...#/.###.',
  7: '#####/....#/...#./..#../.#.../.#.../.#...',
  8: '.###./#...#/#...#/.###./#...#/#...#/.###.',
  9: '.###./#...#/#...#/.####/....#/...#./.##..',
  ' ': '...../...../...../...../...../...../.....',
  '.': '...../...../...../...../...../.##../.##..',
  ',': '...../...../...../...../.##../.##../.#...',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  ':': '...../.##../.##../...../.##../.##../.....',
  ';': '...../.##../.##../...../.##../.##../.#...',
  "'": '..#../..#../...../...../...../...../.....',
  '"': '.#.#./.#.#./...../...../...../...../.....',
  '-': '...../...../...../#####/...../...../.....',
  '_': '...../...../...../...../...../...../#####',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.',
  ']': '.###./...#./...#./...#./...#./...#./.###.',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '\\': '#..../#..../.#.../..#../...#./....#/....#',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  '#': '.#.#./#####/.#.#./#####/.#.#./...../.....',
  '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#',
  '+': '...../..#../..#../#####/..#../..#../.....',
  '=': '...../...../#####/...../#####/...../.....',
  '*': '...../#.#.#/.###./#####/.###./#.#.#/.....',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  $: '..#../.####/#.#../.###./..#.#/####./..#..',
  '^': '..#../.#.#./#...#/...../...../...../.....',
  '~': '...../...../.##.#/#..#./...../...../.....',
  '|': '..#../..#../..#../..#../..#../..#../..#..',
  '\u0001': '...../...../...../...../...../...../.....', // highlight marker: no ink
};

/** Fold typographic/Unicode punctuation onto the ASCII face. */
const FOLD = new Map(Object.entries({
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u00ad': '-',
  '\u2026': '...', '\u00a0': ' ', '\u2007': ' ', '\u202f': ' ',
  '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '',
  '\u00d7': 'x', '\u00ab': '"', '\u00bb': '"',
}));

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Blank columns between glyphs, in font pixels. */
export const GLYPH_SPACING = 1;

const compiled = new Map();
/** Per-glyph ink metrics so the face can be proportional, not monospaced. */
const metrics = new Map();
for (const [char, art] of Object.entries(GLYPHS)) {
  const rows = art.split('/').map((row) => row.split('').map((c) => (c === '#' ? 1 : 0)));
  compiled.set(char, rows);
  let minX = GLYPH_WIDTH;
  let maxX = -1;
  for (let y = 0; y < rows.length; y += 1) {
    for (let x = 0; x < rows[y].length; x += 1) {
      if (!rows[y][x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  // Blank glyphs (space, zero-width folds) keep a fixed advance.
  metrics.set(char, maxX < 0
    ? { trim: 0, ink: 3 }
    : { trim: minX, ink: maxX - minX + 1 });
}

/** Placeholder for characters the face cannot draw (emoji, CJK, …). */
export const UNSUPPORTED_GLYPH = '?';

/**
 * Emoji and pictographs are decorative: they are **dropped**, so an English
 * sentence with a 🌅 still reads cleanly. Other scripts (Devanagari, CJK, …)
 * carry meaning, so they become `?` and the card says the script is unsupported.
 */
function isPictograph(cp) {
  return cp > 0xffff            // emoji planes
    || (cp >= 0x2190 && cp <= 0x2bff) // arrows, dingbats, misc symbols (❄ ✨ ✅ …)
    || cp === 0xfe0e || cp === 0xfe0f // variation selectors
    || cp === 0x20e3            // combining enclosing keycap
    || (cp >= 0x1f1e6 && cp <= 0x1f1ff); // flags
}

/**
 * Turn arbitrary user text into drawable characters: fold known Unicode,
 * uppercase, drop control characters and emoji, and replace other scripts with
 * `?`. The result is always safe to draw — user text is never interpreted.
 */
export function normalizeText(input) {
  const source = String(input ?? '');
  let out = '';
  for (const raw of source) {
    const folded = FOLD.get(raw);
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    const char = raw.toUpperCase();
    if (compiled.has(char)) {
      out += char;
      continue;
    }
    if (raw === '\n') { out += '\n'; continue; }
    const cp = raw.codePointAt(0);
    if (cp > 0x7f) {
      if (isPictograph(cp)) continue; // emoji never become pixels or "?"
      // One placeholder per run of undrawable characters (not one each).
      if (out.endsWith(UNSUPPORTED_GLYPH)) continue;
      out += UNSUPPORTED_GLYPH;
    }
  }
  return out;
}

/**
 * Share of characters the face can actually draw (0–1). Used to tell the user
 * when a quote is in a script the bitmap font does not cover, instead of
 * silently rendering a row of `?`.
 */
export function renderableShare(input) {
  // Emoji are excluded from the ratio: dropping a 🌅 is not a missing script.
  const source = [...String(input ?? '')]
    .filter((c) => c.trim() && !isPictograph(c.codePointAt(0)));
  if (!source.length) return 1;
  let drawable = 0;
  for (const raw of source) {
    if (FOLD.has(raw)) { drawable += 1; continue; }
    if (compiled.has(raw.toUpperCase())) drawable += 1;
  }
  return drawable / source.length;
}

export function glyph(char) {
  return compiled.get(char) || compiled.get(UNSUPPORTED_GLYPH);
}

/** Left trim + ink width of a glyph, in font pixels. */
export function glyphMetrics(char) {
  return metrics.get(char) || metrics.get(UNSUPPORTED_GLYPH);
}

export function supports(char) {
  return compiled.has(char);
}

/** Visible width of a string in font pixels (proportional, no trailing gap). */
export function textWidth(text) {
  const chars = [...text];
  if (!chars.length) return 0;
  let width = 0;
  for (const char of chars) width += glyphMetrics(char).ink + GLYPH_SPACING;
  return width - GLYPH_SPACING;
}
