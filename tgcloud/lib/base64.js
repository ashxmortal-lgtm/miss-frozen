const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

export function bytesToBase64(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return '';
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = Number(bytes[i]) & 0xff;
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? Number(bytes[i + 1]) & 0xff : 0;
    const c = hasC ? Number(bytes[i + 2]) & 0xff : 0;
    output += ALPHABET[a >> 2];
    output += ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    output += hasB ? ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : '=';
    output += hasC ? ALPHABET[c & 0x3f] : '=';
  }
  return output;
}
