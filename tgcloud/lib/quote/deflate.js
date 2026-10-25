/**
 * Deflate compressor (RFC 1951, fixed Huffman) in pure JavaScript.
 *
 * The sticker needs genuine transparency, which means an RGBA PNG. Uncompressed
 * ("stored") deflate would make 512×512 RGBA ≈ 1 MB — twice Telegram's 512 KB
 * sticker cap. Real compression takes the same image to a few tens of KB.
 *
 * LZ77 with hash-chain match finding + the fixed Huffman code table: no dynamic
 * tree construction, which keeps the encoder small and predictable.
 */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_CHAIN = 24;

/** Fixed-Huffman literal/length code for a symbol, MSB-first. */
function literalCode(symbol) {
  if (symbol < 144) return { code: 0x30 + symbol, bits: 8 };
  if (symbol < 256) return { code: 0x190 + (symbol - 144), bits: 9 };
  if (symbol < 280) return { code: symbol - 256, bits: 7 };
  return { code: 0xc0 + (symbol - 280), bits: 8 };
}

class BitWriter {
  constructor(size) {
    this.bytes = new Uint8Array(Math.max(256, size));
    this.length = 0;
    this.buffer = 0;
    this.count = 0;
  }

  ensure(extra) {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  /** Write `count` bits, least-significant bit first (deflate bit order). */
  writeBits(value, count) {
    for (let i = 0; i < count; i += 1) {
      this.buffer |= ((value >>> i) & 1) << this.count;
      this.count += 1;
      if (this.count === 8) {
        this.ensure(1);
        this.bytes[this.length++] = this.buffer;
        this.buffer = 0;
        this.count = 0;
      }
    }
  }

  /** Huffman codes are stored most-significant bit first. */
  writeCode(code, bits) {
    for (let i = bits - 1; i >= 0; i -= 1) this.writeBits((code >>> i) & 1, 1);
  }

  finish() {
    if (this.count) {
      this.ensure(1);
      this.bytes[this.length++] = this.buffer;
      this.buffer = 0;
      this.count = 0;
    }
    return this.bytes.subarray(0, this.length);
  }
}

const hashAt = (data, position) => (((data[position] << 10)
  ^ (data[position + 1] << 5) ^ data[position + 2]) & (HASH_SIZE - 1)) >>> 0;

function lengthCode(length) {
  let index = LEN_BASE.length - 1;
  while (index > 0 && LEN_BASE[index] > length) index -= 1;
  // 258 has its own code (285) with no extra bits.
  if (length === 258) index = LEN_BASE.length - 1;
  return { symbol: 257 + index, extra: length - LEN_BASE[index], extraBits: LEN_EXTRA[index] };
}

function distanceCode(distance) {
  let index = DIST_BASE.length - 1;
  while (index > 0 && DIST_BASE[index] > distance) index -= 1;
  return { symbol: index, extra: distance - DIST_BASE[index], extraBits: DIST_EXTRA[index] };
}

/** Raw deflate stream; a single fixed-Huffman block containing everything. */
export function deflateRaw(data) {
  const writer = new BitWriter(Math.max(1024, Math.floor(data.length / 2)));
  writer.writeBits(1, 1); // BFINAL
  writer.writeBits(1, 2); // BTYPE = 01 (fixed Huffman)

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const emitLiteral = (byte) => {
    const { code, bits } = literalCode(byte);
    writer.writeCode(code, bits);
  };
  const emitMatch = (length, distance) => {
    const lengthInfo = lengthCode(length);
    const lengthHuffman = literalCode(lengthInfo.symbol);
    writer.writeCode(lengthHuffman.code, lengthHuffman.bits);
    if (lengthInfo.extraBits) writer.writeBits(lengthInfo.extra, lengthInfo.extraBits);

    const distanceInfo = distanceCode(distance);
    writer.writeCode(distanceInfo.symbol, 5); // fixed distance codes are 5 bits
    if (distanceInfo.extraBits) writer.writeBits(distanceInfo.extra, distanceInfo.extraBits);
  };

  let position = 0;
  while (position < data.length) {
    let bestLength = 0;
    let bestDistance = 0;

    if (position + MIN_MATCH <= data.length) {
      const hash = hashAt(data, position);
      let candidate = head[hash];
      let chain = MAX_CHAIN;
      const limit = Math.min(MAX_MATCH, data.length - position);
      while (candidate >= 0 && chain > 0) {
        const distance = position - candidate;
        if (distance > WINDOW) break;
        chain -= 1;
        if (data[candidate + bestLength] === data[position + bestLength]) {
          let length = 0;
          while (length < limit && data[candidate + length] === data[position + length]) length += 1;
          if (length > bestLength) {
            bestLength = length;
            bestDistance = distance;
            if (length >= limit) break;
          }
        }
        candidate = prev[candidate];
      }
    }

    if (bestLength >= MIN_MATCH) {
      emitMatch(bestLength, bestDistance);
      // Register every covered position in the hash chain.
      const end = Math.min(position + bestLength, data.length - MIN_MATCH + 1);
      for (let p = position; p < end; p += 1) {
        const hash = hashAt(data, p);
        prev[p] = head[hash];
        head[hash] = p;
      }
      position += bestLength;
    } else {
      emitLiteral(data[position]);
      if (position + MIN_MATCH <= data.length) {
        const hash = hashAt(data, position);
        prev[position] = head[hash];
        head[hash] = position;
      }
      position += 1;
    }
  }

  const endCode = literalCode(256);
  writer.writeCode(endCode.code, endCode.bits);
  return writer.finish();
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib container around a raw deflate stream (header + Adler-32 trailer). */
export function zlibDeflate(bytes) {
  const raw = deflateRaw(bytes);
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(raw, 2);
  const sum = adler32(bytes);
  out[out.length - 4] = (sum >>> 24) & 0xff;
  out[out.length - 3] = (sum >>> 16) & 0xff;
  out[out.length - 2] = (sum >>> 8) & 0xff;
  out[out.length - 1] = sum & 0xff;
  return out;
}
