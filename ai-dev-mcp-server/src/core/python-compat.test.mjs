import assert from "node:assert/strict";
import test from "node:test";
import {
  codePointLength,
  collapseWhitespace,
  decodePythonText,
  encodeUtf8,
  isPythonWhitespace,
  parsePythonJson,
  pythonCasefold,
  pythonFloatRepr,
  pythonLog,
  pythonRepr,
  pythonRound,
  pythonStr,
  pythonStrip,
  pythonSum,
  pythonTruthy,
  PythonFloat,
  sliceCodePoints,
  splitLines
} from "./python-compat.mjs";

// Every expected value below is what CPython 3.13 printed for the same input.
const fromHex = (hex) => Buffer.from(hex, "hex").readDoubleBE(0);

test("whitespace is exactly the 29 code points str.isspace() accepts", () => {
  const python = [0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  const found = [];
  for (let code = 0; code <= 0x10ffff; code += 1) if (isPythonWhitespace(code)) found.push(code);
  assert.deepEqual(found, python);
  assert.equal(isPythonWhitespace(0xfeff), false, "JavaScript's \\s has U+FEFF; Python's does not");
});

test("strip and collapse use Python's whitespace", () => {
  assert.equal(pythonStrip("\x1f\x85 a b \ufeff\u3000"), "a b \ufeff");
  assert.equal(pythonStrip(" \t\n "), "");
  assert.equal(collapseWhitespace("a\x1c\x1d b\u2028\n\nc\ufeffd"), "a b c\ufeffd");
});

test("splitlines knows eleven line boundaries and drops one empty last line", () => {
  assert.deepEqual(
    splitLines("a\nb\r\nc\rd\x0be\x0cf\x1cg\x1dh\x1ei\x1fj\x85k\u2028l\u2029m\n"),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i\x1fj", "k", "l", "m"]
  );
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n"), [""]);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
});

test("length and slices count code points, not UTF-16 units", () => {
  assert.equal(codePointLength("a\u{1F600}b"), 3);
  assert.equal(sliceCodePoints("a\u{1F600}b\u{1F601}c", 3), "a\u{1F600}b");
  assert.equal(sliceCodePoints("abc", 10), "abc");
  assert.equal(codePointLength("\ud800x"), 2, "a lone surrogate is one code point");
});

test("text is read as utf-8-sig with replacement and universal newlines", () => {
  const cases = [
    ["efbbbf68690d0a74686572650d78", "hi\nthere\nx"],
    ["61c08062", "a\ufffd\ufffdb"],
    ["61eda08062", "a\ufffd\ufffd\ufffdb"],
    ["61e282", "a\ufffd"],
    ["61f58062", "a\ufffd\ufffdb"],
    ["61f490808062", "a\ufffd\ufffd\ufffd\ufffdb"],
    ["fffe", "\ufffd\ufffd"],
    ["61e2822862", "a\ufffd(b"],
    ["f09f98", "\ufffd"],
    ["efbbbfefbbbf78", "\ufeffx"]
  ];
  for (const [bytes, text] of cases) assert.equal(decodePythonText(Buffer.from(bytes, "hex")), text, bytes);
});

test("encoding replaces a lone surrogate with ?", () => {
  assert.equal(encodeUtf8("a\ud800b\udc00").toString("hex"), "613f623f");
  assert.equal(encodeUtf8("\u{1F600}").toString("hex"), "f09f9880");
});

test("floats print as repr() does", () => {
  const cases = [["3ff0000000000000", "1.0"], ["3fe0000000000000", "0.5"], ["3ee4f8b588e368f1", "1e-05"],
    ["3f1a36e2eb1c432d", "0.0001"], ["4341c37937e08000", "1e+16"], ["43118b54f22aeb00", "1234567890123456.0"],
    ["3e8421f5f40d8376", "1.5e-07"], ["3fbf9add1091c895", "0.12345678"], ["3e45798ee2308c3a", "1e-08"],
    ["442b1ae4d6e2ef50", "2.5e+20"], ["8000000000000000", "-0.0"], ["0000000000000000", "0.0"],
    ["4059000000000000", "100.0"], ["405edd2f1a9fbe77", "123.456"], ["4480f0cf064dd592", "1e+22"],
    ["0000000000000001", "5e-324"], ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["becb43526527a205", "-3.25e-06"], ["3fd3333333333334", "0.30000000000000004"]];
  for (const [bits, repr] of cases) assert.equal(pythonFloatRepr(fromHex(bits)), repr);
});

test("round(x, 8) rounds the exact value, ties to even", () => {
  const random = [["4.523795535098186e-07", "4.5e-07"], ["0.0008568630063847495", "0.00085686"],
    ["1.500073694960491e-08", "2e-08"], ["0.06316492005848218", "0.06316492"], ["0.19020826279792913", "0.19020826"],
    ["4.997731522067916e-07", "5e-07"], ["8.498876137532195e-08", "8e-08"], ["0.9956916416561992", "0.99569164"],
    ["0.28903994731420213", "0.28903995"], ["0.00040039980491849103", "0.0004004"]];
  const ties = [["0.001953125", "0.00195312"], ["0.005859375", "0.00585938"], ["0.009765625", "0.00976562"],
    ["0.013671875", "0.01367188"], ["0.048828125", "0.04882812"], ["0.123046875", "0.12304688"],
    ["-0.005859375", "-0.00585938"], ["-0.009765625", "-0.00976562"], ["2.001953125", "2.00195312"]];
  for (const [value, rounded] of [...random, ...ties]) assert.equal(pythonRound(Number(value), 8), Number(rounded), value);
  assert.notEqual(Number((0.001953125).toFixed(8)), pythonRound(0.001953125, 8), "toFixed sends a tie up");
  // round(x, 0) between 1e15 and 2 ** 52, as CPython 3.13 prints it.
  for (const [value, rounded] of [
    [1e15 + 0.5, 1000000000000000.0], [1e15 + 1.5, 1000000000000002.0], [1e15 + 0.25, 1000000000000000.0],
    [2 ** 51 + 0.5, 2251799813685248.0], [-(1e15 + 0.5), -1000000000000000.0], [4503599627370495.5, 4503599627370496.0]
  ]) assert.equal(pythonRound(value, 0), rounded, String(value));
  assert.equal(pythonRound(2 ** 53 + 2, 0), 2 ** 53 + 2, "past 2 ** 52 a double is its own rounding");
});

test("sum() compensates as CPython 3.12+ does", () => {
  assert.equal(pythonSum(Array(10).fill(0.1)), 1);
  assert.equal(pythonSum([1e16, 1, -1e16]), 1);
  assert.equal([1e16, 1, -1e16].reduce((a, b) => a + b, 0), 0, "a plain loop loses the 1");
  assert.equal(pythonSum([]), 0);
});

test("log(n) is glibc's, which is correctly rounded where V8's is not", () => {
  const python = { 2: "3fe62e42fefa39ef", 3: "3ff193ea7aad030b", 48: "400ef8383c50bb75", 74: "4011375cd6fcab1d",
    185: "4014e1a4f518c72b", 1000: "401ba18a998fffa0", 65537: "40262e44fef939f0" };
  for (const [n, bits] of Object.entries(python)) assert.equal(pythonLog(Number(n)), fromHex(bits), n);
  assert.notEqual(Math.log(3), pythonLog(3), "the case this function exists for");
  assert.equal(pythonLog(1), 0);
});

test("casefold() folds as Python does, past what toLowerCase() does", () => {
  const python = { "Stra\u00dfe": "strasse", "\u1e9e": "ss", "\u03a3\u0391\u03a3": "\u03c3\u03b1\u03c3", "\u03c2": "\u03c3",
    "\u0130stanbul": "i\u0307stanbul", "\u0131i": "\u0131i", "\ufb01": "fi", "\u0149": "\u02bcn",
    "\uab70\u13f8": "\u13a0\u13f0", "\u13a0": "\u13a0", "\u00b5": "\u03bc", "\u212a": "k", "\u01c4": "\u01c6",
    "\u0390": "\u03b9\u0308\u0301" };
  for (const [input, folded] of Object.entries(python)) assert.equal(pythonCasefold(input), folded, input);
});

test("str() of a JSON value keeps Python's int, float, list and dict", () => {
  const values = parsePythonJson('[87.0, 87, 87.5, 1e5, 1E-7, -0, 12345678901234567890, true, null, "a\'b", "q\\"x", ["x", 1, 2.0, null, false], {"k": "v\\n", "n": 1.25}, "\\u00a0\\u00ad\\u0085\\u2028tab\\t\\u0007\\u007f\\ud800", "\\ud83d\\ude00", ["it\'s", "say \\"hi\\"", "both \' and \\""]]');
  assert.deepEqual(values.map(pythonStr), [
    "87.0", "87", "87.5", "100000.0", "1e-07", "0", "12345678901234567890", "True", "None", "a'b", "q\"x",
    "['x', 1, 2.0, None, False]", "{'k': 'v\\n', 'n': 1.25}",
    "\u00a0\u00ad\u0085\u2028tab\t\u0007\u007f\ud800", "\u{1F600}",
    "[\"it's\", 'say \"hi\"', 'both \\' and \"']"
  ]);
  assert.equal(pythonRepr(["\u00a0", "\u0007", "\ud800", "\u2028", "\u{1F600}", "\u00e9", "\\"].map(String)),
    "['\\xa0', '\\x07', '\\ud800', '\\u2028', '\u{1F600}', '\u00e9', '\\\\']");
});

test("truth values are Python's", () => {
  for (const falsy of [null, undefined, 0, 0n, "", [], {}, false, new PythonFloat(0)]) assert.equal(pythonTruthy(falsy), false);
  for (const truthy of [1, "0", [0], { a: 0 }, true, new PythonFloat(0.5), Number.NaN]) assert.equal(pythonTruthy(truthy), true);
});
