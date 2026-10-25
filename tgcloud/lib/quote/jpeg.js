/**
 * Baseline JPEG decoder in pure JavaScript.
 *
 * Telegram's `getUserProfilePhotos` → `getFileContent` returns **JPEG** bytes.
 * There is no image codec in the TGCloud isolate (no canvas, no npm, no native
 * modules), so the profile picture can only be drawn if it can be decoded here.
 *
 * Scope: baseline and extended-sequential Huffman JPEGs (SOF0/SOF1) at 8-bit
 * precision, 1 or 3 components, with 1×1 … 4×2 sampling. Progressive JPEGs
 * (SOF2) are rejected explicitly — the caller then falls back to the generated
 * avatar rather than shipping a wrong or blank picture.
 *
 * Decoding follows the JPEG spec directly: marker scan → quantisation tables →
 * Huffman tables → MCU loop with DC prediction + AC run-length → dequantise →
 * 8×8 inverse DCT → chroma upsample → YCbCr→RGB.
 */

export class JpegError extends Error {}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export function isJpeg(bytes) {
  return Boolean(bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8);
}

class BitReader {
  constructor(bytes, start) {
    this.bytes = bytes;
    this.pos = start;
    this.buffer = 0;
    this.count = 0;
    this.markerHit = 0;
  }

  fill() {
    while (this.count <= 24) {
      let byte = 0;
      if (this.pos < this.bytes.length) {
        byte = this.bytes[this.pos];
        if (byte === 0xff) {
          const next = this.bytes[this.pos + 1];
          if (next === 0x00) {
            this.pos += 2; // byte stuffing
          } else {
            // A real marker ends the entropy-coded segment; feed zero bits.
            this.markerHit = next;
            this.pos = this.bytes.length;
            byte = 0;
          }
        } else {
          this.pos += 1;
        }
      }
      this.buffer = (this.buffer << 8) | byte;
      this.count += 8;
    }
  }

  bits(count) {
    if (count === 0) return 0;
    if (this.count < count) this.fill();
    this.count -= count;
    return (this.buffer >>> this.count) & ((1 << count) - 1);
  }

  /** JPEG's extend: a code of `size` bits maps to a signed value. */
  receiveExtend(size) {
    if (size === 0) return 0;
    const value = this.bits(size);
    return value < (1 << (size - 1)) ? value - (1 << size) + 1 : value;
  }

  reset() {
    this.buffer = 0;
    this.count = 0;
    this.markerHit = 0;
  }
}

const buildHuffmanTable = (counts, symbols) => {
  const codes = new Int32Array(256);
  const sizes = new Uint8Array(256);
  let code = 0;
  let symbol = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < counts[length - 1]; i += 1) {
      codes[symbols[symbol]] = code;
      sizes[symbols[symbol]] = length;
      symbol += 1;
      code += 1;
    }
    code <<= 1;
  }
  return { codes, sizes };
};

function decodeHuffman(reader, table) {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = (code << 1) | reader.bits(1);
    for (let symbol = 0; symbol < 256; symbol += 1) {
      if (table.sizes[symbol] === length && table.codes[symbol] === code) return symbol;
    }
  }
  throw new JpegError('invalid Huffman code');
}

// AAN-style scaled IDCT (float, 8×8). Output is level-shifted to 0..255 by the
// caller; coefficients arrive dequantised.
const IDCT = (() => {
  const output = new Float32Array(64);
  const cosine = new Float32Array(64 * 64);
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      cosine[(u * 8 + x)] = cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;
    }
  }
  return (block, context) => {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        let sum = 0;
        for (let v = 0; v < 8; v += 1) {
          for (let u = 0; u < 8; u += 1) {
            const coefficient = block[v * 8 + u];
            if (coefficient !== 0) sum += coefficient * cosine[v * 8 + y] * cosine[u * 8 + x];
          }
        }
        output[y * 8 + x] = sum;
      }
    }
    return output;
  };
})();

/**
 * Decode a JPEG to RGBA.
 * @returns {{width:number,height:number,rgba:Uint8Array}}
 */
export function decodeJpeg(bytes) {
  if (!isJpeg(bytes)) throw new JpegError('not a JPEG');
  let offset = 2;
  let frame = null;
  const quantization = [];
  const huffmanDC = [];
  const huffmanAC = [];
  let restartInterval = 0;

  const readSegment = () => {
    // Skip fill bytes.
    while (offset < bytes.length && bytes[offset] === 0xff && bytes[offset + 1] === 0xff) offset += 1;
    if (bytes[offset] !== 0xff) throw new JpegError('expected a marker');
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const start = offset + 4;
    offset += 2 + length;
    return { marker, start, length: length - 2 };
  };

  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff && bytes[offset + 1] === 0xff) offset += 1;
    if (bytes[offset] !== 0xff) throw new JpegError('JPEG marker expected');
    const marker = bytes[offset + 1];

    if (marker === 0xd8) { offset += 2; continue; }
    if (marker === 0xd9) break; // EOI
    if (marker === 0xda) { // SOS — entropy-coded data starts here
      if (!frame) throw new JpegError('SOS before SOF');
      const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const start = offset + 4;
      const scanComponents = bytes[start];
      const components = [];
      for (let i = 0; i < scanComponents; i += 1) {
        const id = bytes[start + 1 + i * 2];
        const selector = bytes[start + 2 + i * 2];
        const component = frame.components.find((c) => c.id === id);
        if (!component) throw new JpegError(`unknown component ${id}`);
        components.push({ component, dc: huffmanDC[selector >> 4], ac: huffmanAC[selector & 0x0f] });
      }
      const dataStart = start + segmentLength - 2;
      // The scan reports where its entropy-coded data ended (a marker follows).
      offset = decodeScan(bytes, dataStart, frame, components, quantization, restartInterval) + 2;
      continue;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const { start } = (() => {
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        return { start: offset + 4, length: length - 2 };
      })();
      if (marker === 0xc2) throw new JpegError('progressive JPEG is not supported');
      const precision = bytes[start];
      if (precision !== 8) throw new JpegError(`unsupported JPEG precision ${precision}`);
      const height = (bytes[start + 1] << 8) | bytes[start + 2];
      const width = (bytes[start + 3] << 8) | bytes[start + 4];
      const count = bytes[start + 5];
      const components = [];
      let hMax = 1;
      let vMax = 1;
      for (let i = 0; i < count; i += 1) {
        const base = start + 6 + i * 3;
        const h = bytes[base + 1] >> 4;
        const v = bytes[base + 1] & 0x0f;
        components.push({ id: bytes[base], h, v, quant: bytes[base + 2] });
        hMax = Math.max(hMax, h);
        vMax = Math.max(vMax, v);
      }
      frame = { width, height, components, hMax, vMax };
      offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
      continue;
    }
    if (marker === 0xc4) { // DHT
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      let cursor = offset + 4;
      const end = offset + 2 + length;
      while (cursor < end) {
        const spec = bytes[cursor];
        const tableClass = spec >> 4;
        const tableId = spec & 0x0f;
        const counts = bytes.subarray(cursor + 1, cursor + 17);
        let total = 0;
        for (let i = 0; i < 16; i += 1) total += counts[i];
        const symbols = bytes.subarray(cursor + 17, cursor + 17 + total);
        const table = buildHuffmanTable(counts, symbols);
        if (tableClass === 0) huffmanDC[tableId] = table;
        else huffmanAC[tableId] = table;
        cursor += 17 + total;
      }
      offset = end;
      continue;
    }
    if (marker === 0xdb) { // DQT
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      let cursor = offset + 4;
      const end = offset + 2 + length;
      while (cursor < end) {
        const spec = bytes[cursor];
        const precision = spec >> 4;
        const tableId = spec & 0x0f;
        const table = new Int32Array(64);
        cursor += 1;
        for (let i = 0; i < 64; i += 1) {
          if (precision === 0) {
            table[ZIGZAG[i]] = bytes[cursor];
            cursor += 1;
          } else {
            table[ZIGZAG[i]] = (bytes[cursor] << 8) | bytes[cursor + 1];
            cursor += 2;
          }
        }
        quantization[tableId] = table;
      }
      offset = end;
      continue;
    }
    if (marker === 0xdd) { // DRI
      restartInterval = (bytes[offset + 4] << 8) | bytes[offset + 5];
      offset += 4;
      continue;
    }
    if (marker === 0xd0 || marker === 0xd9) { offset += 2; continue; }
    // Everything else is a length-prefixed segment (APPn, COM, …).
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (!length) { offset += 2; continue; }
    offset += 2 + length;
  }

  if (!frame) throw new JpegError('no frame header found');
  return toRgba(frame, bytes);
}

/** Decode one scan; returns the offset of the marker that ended it. */
function decodeScan(bytes, dataStart, frame, components, quantization, restartInterval) {
  const reader = new BitReader(bytes, dataStart);
  const { width, height, hMax, vMax } = frame;

  const mcuWidth = hMax * 8;
  const mcuHeight = vMax * 8;
  const mcusPerRow = Math.ceil(width / mcuWidth);
  const mcusPerColumn = Math.ceil(height / mcuHeight);
  const componentCount = components.length === 1 ? 1 : 3;

  // Planes hold one sample per pixel of the *component's* resolution.
  for (const entry of components) {
    const { component } = entry;
    const planeWidth = mcusPerRow * component.h * 8;
    const planeHeight = mcusPerColumn * component.v * 8;
    entry.plane = new Float32Array(planeWidth * planeHeight);
    entry.planeWidth = planeWidth;
    entry.planeHeight = planeHeight;
    // DC prediction lives on the frame component (shared with the scan).
    component.prediction = 0;
  }

  const block = new Float32Array(64);
  const quantised = new Float32Array(64);
  let mcu = 0;
  let eobrun = 0;
  const restartEvery = restartInterval || 0;

  for (let row = 0; row < mcusPerColumn; row += 1) {
    for (let column = 0; column < mcusPerRow; column += 1) {
      if (restartEvery && mcu > 0 && mcu % restartEvery === 0) {
        reader.reset();
        // Skip a restart marker (RSTn).
        while (reader.pos < bytes.length && !(bytes[reader.pos] === 0xff
          && bytes[reader.pos + 1] >= 0xd0 && bytes[reader.pos + 1] <= 0xd7)) reader.pos += 1;
        reader.pos += 2;
        for (const entry of components) entry.component.prediction = 0;
      }
      mcu += 1;

      for (const entry of components) {
        const { component } = entry;
        const quant = quantization[component.quant];
        for (let v = 0; v < component.v; v += 1) {
          for (let h = 0; h < component.h; h += 1) {
            quantised.fill(0);
            // DC
            const dcSize = decodeHuffman(reader, entry.dc);
            component.prediction += dcSize === 0 ? 0 : reader.receiveExtend(dcSize);
            quantised[0] = component.prediction * quant[0];

            // AC
            let k = 1;
            while (k < 64) {
              const symbol = decodeHuffman(reader, entry.ac);
              const run = symbol >> 4;
              const size = symbol & 0x0f;
              if (size === 0) {
                if (run === 15) { k += 16; continue; }
                break; // EOB
              }
              k += run;
              if (k > 63) break;
              const value = reader.receiveExtend(size);
              // The quant table was un-zigzagged when read, so index it by the
              // natural coefficient index, not by the zigzag position.
              quantised[ZIGZAG[k]] = value * quant[ZIGZAG[k]];
              k += 1;
            }
            const pixels = IDCT(quantised);
            // Place the block into the component plane.
            const blockX = (column * component.h + h) * 8;
            const blockY = (row * component.v + v) * 8;
            for (let y = 0; y < 8; y += 1) {
              const planeRow = (blockY + y) * entry.planeWidth + blockX;
              for (let x = 0; x < 8; x += 1) entry.plane[planeRow + x] = pixels[y * 8 + x];
            }
          }
        }
      }
      void componentCount;
    }
  }

  // Planes are stored at each component's own sample resolution. To reach full
  // resolution, a component with h=1 in a hMax=2 image needs ×2 repetition —
  // the scale is "how many full-res pixels per component sample".
  frame.planes = components.map((entry) => ({
    data: entry.plane,
    width: entry.planeWidth,
    height: entry.planeHeight,
    xScale: hMax / entry.component.h,
    yScale: vMax / entry.component.v,
  }));
  frame.singleComponent = components.length === 1;

  // Where the entropy-coded segment ended.
  return reader.markerHit ? reader.pos - 2 : bytes.length - 2;
}

/** Planar sample lookup with box-filtered upsampling to full resolution. */
function samplePlane(plane, x, y) {
  const { data, width, height, xScale, yScale } = plane;
  const sx = Math.min(width - 1, Math.max(0, Math.floor(x / xScale)));
  const sy = Math.min(height - 1, Math.max(0, Math.floor(y / yScale)));
  return data[sy * width + sx];
}

function toRgba(frame, bytes) {
  const { width, height, planes } = frame;
  const rgba = new Uint8Array(width * height * 4);

  if (frame.singleComponent || planes.length === 1) {
    const plane = planes[0];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = Math.max(0, Math.min(255, Math.round(samplePlane(plane, x, y) + 128)));
        const out = (y * width + x) * 4;
        rgba[out] = value;
        rgba[out + 1] = value;
        rgba[out + 2] = value;
        rgba[out + 3] = 255;
      }
    }
    return { width, height, rgba };
  }

  const [luma, cb, cr] = planes;
  // Components may be subsampled differently; samplePlane handles per-plane h/v.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const Y = samplePlane(luma, x, y) + 128;
      const Cb = samplePlane(cb, x, y);
      const Cr = samplePlane(cr, x, y);
      const out = (y * width + x) * 4;
      rgba[out] = Math.max(0, Math.min(255, Math.round(Y + 1.402 * Cr)));
      rgba[out + 1] = Math.max(0, Math.min(255, Math.round(Y - 0.344136 * Cb - 0.714136 * Cr)));
      rgba[out + 2] = Math.max(0, Math.min(255, Math.round(Y + 1.772 * Cb)));
      rgba[out + 3] = 255;
    }
  }
  void bytes;
  return { width, height, rgba };
}
