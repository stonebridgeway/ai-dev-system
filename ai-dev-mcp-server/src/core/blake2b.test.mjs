import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { blake2b } from "./blake2b.mjs";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const utf8 = (value) => Buffer.from(value, "utf8");

// Digests from CPython's `hashlib.blake2b(value.encode(), digest_size=N)`, at
// the lengths that straddle BLAKE2b's 128-byte block.
const PYTHON_VECTORS = [
  { value: "", d8: "e4a6a0577479b2b4", d32: "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8" },
  { value: "abc", d8: "d8bb14d833d59559", d32: "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319" },
  { value: "ng:rev", d8: "36197867c1fc6ea6", d32: "e5a92018c38fd9cd69f83077ec6ac0c4823644747030f5e9acecb429bdcd4126" },
  { value: "alias:bug", d8: "46a5c4bb4956f3c5", d32: "577bb4bb82d99f5c2c1805d5820a27215cd8a5e136b479dc4869cd6d27134933" },
  { value: "ошибка", d8: "4284db730af99215", d32: "1b15bcd0f567701c9dcf73f9efd4cdeec04521faac2da38b0f54dbe257748141" },
  { value: "x".repeat(127), d8: "8e70a0af447c4ffc", d32: "32afe327aece2cc8275e868be2ea929410f47bcfbac87d8197d92c972a290d3d" },
  { value: "x".repeat(128), d8: "901ce374e8e12402", d32: "164ffb7089bae6f5a62fb0795e751dc9e88eac92e1a5b2fafe93a25abf2d9c3b" },
  { value: "x".repeat(129), d8: "18de14b9d8eea5a3", d32: "03b0758fa71d249c846c2304a2b9996e6ae66ffa7e5528f9e612e089a360fc8d" },
  { value: "проверка ".repeat(50), d8: "59d5244b8f724387", d32: "81bc89079fd1db9c117a9aca3fe50b4e931c53dfa1225238f43df24d4db0a66b" }
];

test("8- and 32-byte digests are Python's, across block boundaries", () => {
  for (const { value, d8, d32 } of PYTHON_VECTORS) {
    assert.equal(hex(blake2b(utf8(value), 8)), d8, `${value.length} chars`);
    assert.equal(hex(blake2b(utf8(value), 32)), d32, `${value.length} chars`);
  }
});

test("a short digest is its own function, not a prefix of BLAKE2b-512", () => {
  const full = crypto.createHash("blake2b512").update(utf8("ng:rev")).digest("hex");
  assert.notEqual(hex(blake2b(utf8("ng:rev"), 8)), full.slice(0, 16));
});

test("the 64-byte digest is OpenSSL's BLAKE2b-512 at every length up to three blocks", () => {
  const random = crypto.randomBytes(400);
  for (let length = 0; length <= 400; length += 1) {
    const input = random.subarray(0, length);
    assert.equal(hex(blake2b(input)), crypto.createHash("blake2b512").update(input).digest("hex"), `${length} bytes`);
  }
});

test("RFC 7693 appendix A", () => {
  assert.equal(
    hex(blake2b(utf8("abc"))),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1"
      + "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
  );
});

test("the digest length is 1 to 64 bytes", () => {
  for (const length of [0, 65, 1.5, Number.NaN]) {
    assert.throws(() => blake2b(utf8("x"), length), RangeError);
  }
  assert.equal(blake2b(utf8("x"), 1).length, 1);
});
