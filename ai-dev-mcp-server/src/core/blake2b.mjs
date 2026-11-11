/**
 * BLAKE2b (RFC 7693) with a chosen digest length, unkeyed.
 *
 * The search index hashes every semantic feature with Python's
 * `hashlib.blake2b(value, digest_size=8)`. The digest length is part of
 * BLAKE2b's parameter block, so that is not the first eight bytes of
 * BLAKE2b-512, and OpenSSL — Node's `crypto` — offers BLAKE2b only at 64 bytes
 * (`ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH` for anything else). An index the
 * Node writer builds has to put each feature in the dimension the Python reader
 * expects, and an index 2.x built has to keep meaning what it meant, so this is
 * the same function, in 64-bit arithmetic on pairs of 32-bit words.
 */

// The initialisation vector as little-endian [low, high] 32-bit pairs.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
]);

// Message word schedule for the twelve rounds, doubled to index 32-bit pairs.
const SIGMA = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3
].map((index) => index * 2);

const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a] += v[b], 64-bit. */
function add64(a, b) {
  const low = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (low >= 0x100000000 ? 1 : 0);
  v[a] = low;
}

/** v[a] += (high:low), 64-bit. */
function add64Word(a, low, high) {
  const sum = v[a] + low;
  v[a + 1] = v[a + 1] + high + (sum >= 0x100000000 ? 1 : 0);
  v[a] = sum;
}

/** The mixing function G on the pairs at a, b, c, d with message words x and y. */
function mix(a, b, c, d, x, y) {
  add64(a, b);
  add64Word(a, m[x], m[x + 1]);
  // d = (d ^ a) >>> 32
  let low = v[d] ^ v[a];
  let high = v[d + 1] ^ v[a + 1];
  v[d] = high;
  v[d + 1] = low;
  add64(c, d);
  // b = (b ^ c) >>> 24
  low = v[b] ^ v[c];
  high = v[b + 1] ^ v[c + 1];
  v[b] = (low >>> 24) ^ (high << 8);
  v[b + 1] = (high >>> 24) ^ (low << 8);
  add64(a, b);
  add64Word(a, m[y], m[y + 1]);
  // d = (d ^ a) >>> 16
  low = v[d] ^ v[a];
  high = v[d + 1] ^ v[a + 1];
  v[d] = (low >>> 16) ^ (high << 16);
  v[d + 1] = (high >>> 16) ^ (low << 16);
  add64(c, d);
  // b = (b ^ c) >>> 63
  low = v[b] ^ v[c];
  high = v[b + 1] ^ v[c + 1];
  v[b] = (high >>> 31) ^ (low << 1);
  v[b + 1] = (low >>> 31) ^ (high << 1);
}

function compress(state, block, counter, last) {
  for (let i = 0; i < 16; i += 1) {
    v[i] = state[i];
    v[i + 16] = IV[i];
  }
  v[24] ^= counter >>> 0;
  v[25] ^= Math.floor(counter / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i += 1) {
    const at = i * 4;
    m[i] = (block[at] | (block[at + 1] << 8) | (block[at + 2] << 16) | (block[at + 3] << 24)) >>> 0;
  }
  for (let round = 0; round < 12; round += 1) {
    const s = round * 16;
    mix(0, 8, 16, 24, SIGMA[s], SIGMA[s + 1]);
    mix(2, 10, 18, 26, SIGMA[s + 2], SIGMA[s + 3]);
    mix(4, 12, 20, 28, SIGMA[s + 4], SIGMA[s + 5]);
    mix(6, 14, 22, 30, SIGMA[s + 6], SIGMA[s + 7]);
    mix(0, 10, 20, 30, SIGMA[s + 8], SIGMA[s + 9]);
    mix(2, 12, 22, 24, SIGMA[s + 10], SIGMA[s + 11]);
    mix(4, 14, 16, 26, SIGMA[s + 12], SIGMA[s + 13]);
    mix(6, 8, 18, 28, SIGMA[s + 14], SIGMA[s + 15]);
  }
  for (let i = 0; i < 16; i += 1) state[i] ^= v[i] ^ v[i + 16];
}

/**
 * BLAKE2b of `input` with a digest of `length` bytes (1–64), as Python's
 * `hashlib.blake2b(input, digest_size=length)`.
 *
 * @param {Uint8Array} input
 * @param {number} [length]
 * @returns {Uint8Array}
 */
export function blake2b(input, length = 64) {
  if (!Number.isInteger(length) || length < 1 || length > 64) throw new RangeError("BLAKE2b digest length is 1 to 64 bytes.");
  const state = new Uint32Array(IV);
  state[0] ^= 0x01010000 ^ length;
  const block = new Uint8Array(128);
  let counter = 0;
  let offset = 0;
  // Every full block but the last is compressed as it fills; the last one,
  // full or not, is compressed with the final flag.
  while (input.length - offset > 128) {
    block.set(input.subarray(offset, offset + 128));
    counter += 128;
    compress(state, block, counter, false);
    offset += 128;
  }
  block.fill(0);
  block.set(input.subarray(offset));
  counter += input.length - offset;
  compress(state, block, counter, true);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = state[i >> 2] >>> (8 * (i & 3));
  return out;
}
