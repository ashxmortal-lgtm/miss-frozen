/**
 * Inflate (RFC 1951 / zlib RFC 1950) in pure JavaScript.
 *
 * Needed to *decode* images at runtime: the TGCloud isolate has no `node:zlib`,
 * no npm packages and no native modules. PNG avatar bytes arrive deflate-
 * compressed, so reading a profile photo requires this decoder.
 *
 * Bit-by-bit Huffman decoding (puff-style): simple, allocation-light, and fast
 * enough for the small images a Telegram profile photo yields.
 */

const MAX_BITS = 15;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class InflateError extends Error {}

/** Growable byte sink. */
class Output {
  constructor(size) {
    this.bytes = new Uint8Array(Math.max(1024, size || 1024));
    this.length = 0;
  }

  ensure(extra) {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  push(byte) {
    this.ensure(1);
    this.bytes[this.length++] = byte;
  }

  pushBytes(source, start, count) {
    this.ensure(count);
    this.bytes.set(source.subarray(start, start + count), this.length);
    this.length += count;
  }

  copyBack(distance, count) {
    this.ensure(count);
    let from = this.length - distance;
    if (from < 0) throw new InflateError('distance before start of output');
    for (let i = 0; i < count; i += 1) this.bytes[this.length++] = this.bytes[from++];
  }

  result() {
    return this.bytes.subarray(0, this.length);
  }
}

class BitReader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  bits(count) {
    while (this.bitCount < count) {
      if (this.pos >= this.end) throw new InflateError('unexpected end of deflate stream');
      this.bitBuffer |= this.bytes[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  /** Stored blocks start on a byte boundary. */
  alignToByte() {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  byteAlignedRead(count) {
    if (this.pos + count > this.end) throw new InflateError('truncated stored block');
    const value = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return value;
  }
}

/** Canonical Huffman table in puff form: per-length counts + ordered symbols. */
function buildHuffman(lengths) {
  const counts = new Uint16Array(MAX_BITS + 1);
  for (const length of lengths) counts[length] += 1;
  counts[0] = 0;

  const offsets = new Uint16Array(MAX_BITS + 2);
  for (let length = 1; length <= MAX_BITS; length += 1) {
    offsets[length + 1] = offsets[length] + counts[length];
  }
  const symbols = new Uint16Array(lengths.length);
  const cursor = offsets.slice();
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (length) symbols[cursor[length]++] = symbol;
  }
  return { counts, symbols };
}

function decodeSymbol(reader, table) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= MAX_BITS; length += 1) {
    code |= reader.bits(1);
    const count = table.counts[length];
    if (code - count < first) return table.symbols[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new InflateError('invalid Huffman code');
}

let FIXED_LITERALS = null;
let FIXED_DISTANCES = null;

function fixedTables() {
  if (!FIXED_LITERALS) {
    const literals = new Uint8Array(288);
    for (let i = 0; i < 144; i += 1) literals[i] = 8;
    for (let i = 144; i < 256; i += 1) literals[i] = 9;
    for (let i = 256; i < 280; i += 1) literals[i] = 7;
    for (let i = 280; i < 288; i += 1) literals[i] = 8;
    FIXED_LITERALS = buildHuffman(literals);
    FIXED_DISTANCES = buildHuffman(new Uint8Array(30).fill(5));
  }
  return { literals: FIXED_LITERALS, distances: FIXED_DISTANCES };
}

function readDynamicTables(reader) {
  const hlit = reader.bits(5) + 257;
  const hdist = reader.bits(5) + 1;
  const hclen = reader.bits(4) + 4;

  const codeLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i += 1) codeLengths[CLEN_ORDER[i]] = reader.bits(3);

  const codeTable = buildHuffman(codeLengths);
  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < lengths.length) {
    const symbol = decodeSymbol(reader, codeTable);
    if (symbol < 16) {
      lengths[i++] = symbol;
      continue;
    }
    let repeat = 0;
    let value = 0;
    if (symbol === 16) {
      if (!i) throw new InflateError('repeat before any code length');
      value = lengths[i - 1];
      repeat = 3 + reader.bits(2);
    } else if (symbol === 17) {
      repeat = 3 + reader.bits(3);
    } else if (symbol === 18) {
      repeat = 11 + reader.bits(7);
    } else {
      throw new InflateError('bad code-length symbol');
    }
    if (i + repeat > lengths.length) throw new InflateError('code length overflow');
    for (let r = 0; r < repeat; r += 1) lengths[i++] = value;
  }

  return {
    literals: buildHuffman(lengths.subarray(0, hlit)),
    distances: buildHuffman(lengths.subarray(hlit)),
  };
}

function inflateBlockBody(reader, out, literals, distances) {
  for (;;) {
    const symbol = decodeSymbol(reader, literals);
    if (symbol < 256) {
      out.push(symbol);
      continue;
    }
    if (symbol === 256) return;
    const lengthIndex = symbol - 257;
    if (lengthIndex >= LEN_BASE.length) throw new InflateError('bad length symbol');
    const length = LEN_BASE[lengthIndex] + reader.bits(LEN_EXTRA[lengthIndex]);

    const distSymbol = decodeSymbol(reader, distances);
    if (distSymbol >= DIST_BASE.length) throw new InflateError('bad distance symbol');
    const distance = DIST_BASE[distSymbol] + reader.bits(DIST_EXTRA[distSymbol]);
    out.copyBack(distance, length);
  }
}

/** Raw deflate stream (no zlib wrapper). */
export function inflateRaw(bytes, start = 0, end = bytes.length) {
  const reader = new BitReader(bytes, start, end);
  const out = new Output(Math.max(1024, end - start) * 4);
  let final = 0;
  while (!final) {
    final = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      reader.alignToByte();
      const header = reader.byteAlignedRead(4);
      const length = header[0] | (header[1] << 8);
      const complement = header[2] | (header[3] << 8);
      if ((length ^ 0xffff) !== complement) throw new InflateError('stored block length mismatch');
      out.pushBytes(reader.byteAlignedRead(length), 0, length);
    } else if (type === 1) {
      const { literals, distances } = fixedTables();
      inflateBlockBody(reader, out, literals, distances);
    } else if (type === 2) {
      const { literals, distances } = readDynamicTables(reader);
      inflateBlockBody(reader, out, literals, distances);
    } else {
      throw new InflateError('invalid deflate block type');
    }
  }
  return out.result();
}

/** zlib-wrapped stream: 2-byte header, deflate data, Adler-32 trailer. */
export function zlibInflate(bytes) {
  if (bytes.length < 6) throw new InflateError('zlib stream too short');
  const cmf = bytes[0];
  const flg = bytes[1];
  if ((cmf & 0x0f) !== 8) throw new InflateError('not a deflate stream');
  if (((cmf << 8) | flg) % 31 !== 0) throw new InflateError('bad zlib header checksum');
  if (flg & 0x20) throw new InflateError('preset dictionary is not supported');

  const body = inflateRaw(bytes, 2, bytes.length - 4);
  const expected = ((bytes[bytes.length - 4] << 24) | (bytes[bytes.length - 3] << 16)
    | (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]) >>> 0;
  let a = 1;
  let b = 0;
  for (let i = 0; i < body.length; i += 1) {
    a = (a + body[i]) % 65521;
    b = (b + a) % 65521;
  }
  if ((((b << 16) | a) >>> 0) !== expected) throw new InflateError('Adler-32 mismatch');
  return body;
}
