import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildSemanticVector,
  featureDimension,
  MAX_VECTOR_FEATURES,
  semanticTerms,
  semanticVectorJson,
  tokenizeSemantic
} from "./search-semantic.mjs";

// Expected values are what `search-index/search_cli.py` computed for the same input.
const stored = (doc) => {
  const { entries, norm } = buildSemanticVector(doc);
  return [semanticVectorJson(entries), norm];
};

test("tokens are Latin and Cyrillic words split on _ + # . -, without stopwords or single letters", () => {
  assert.deepEqual(tokenizeSemantic("Agents.MD c++ C#.NET re-run x_y ЁЛКА и это"), ["agents", "md", "net", "re", "run", "ёлка"]);
});

test("terms add aliases, n-grams and crude stems in Python's order", () => {
  assert.deepEqual(semanticTerms("Testing deployed"), [
    "testing", "deployed", "alias:quality", "quality",
    "ng:tes", "ng:est", "ng:sti", "ng:tin", "ng:ing", "ng:test", "ng:esti", "ng:stin", "ng:ting", "test",
    "ng:dep", "ng:epl", "ng:plo", "ng:loy", "ng:oye", "ng:yed", "ng:depl", "ng:eplo", "ng:ploy", "ng:loye", "ng:oyed", "deploy"
  ]);
});

test("a feature's dimension is the last ten bits of its 8-byte BLAKE2b", () => {
  // blake2b(b"ng:rev", digest_size=8) = 36197867c1fc6ea6 -> 0x2a6 = 678
  assert.equal(featureDimension("ng:rev"), 0x6ea6 & 0x3ff);
  assert.equal(featureDimension("ng:rev"), 678);
});

test("repeated words weigh 1 + ln(count), and the stored JSON is the helper's byte for byte", () => {
  assert.deepEqual(stored({ title: "", categories: "", source: "", path: "", body: "deploy deploy deploy rollback rollback testing tested" }), [
    "{\"518\":0.2108106,\"452\":0.2108106,\"186\":0.2108106,\"873\":0.2108106,\"742\":0.2108106,\"273\":0.2108106,"
      + "\"585\":0.2108106,\"814\":0.2108106,\"95\":0.17008066,\"532\":0.17008066,\"859\":0.17008066,\"235\":0.17008066,"
      + "\"767\":0.17008066,\"547\":0.17008066,\"503\":0.17008066,\"226\":0.17008066,\"907\":0.17008066,\"412\":0.17008066,"
      + "\"164\":0.17008066,\"353\":0.17008066,\"264\":0.17008066,\"441\":0.17008066,\"964\":0.17008066,\"723\":0.17008066,"
      + "\"29\":0.10045238,\"123\":0.10045238,\"400\":0.10045238,\"782\":0.10045238,\"464\":0.10045238,\"664\":0.10045238,"
      + "\"1005\":0.10045238,\"862\":0.10045238,\"708\":0.10045238,\"316\":0.10045238,\"793\":0.10045238,\"949\":0.10045238,"
      + "\"331\":0.10045238,\"910\":0.10045238,\"12\":0.10045238,\"529\":0.10045238,\"779\":0.10045238,\"755\":0.10045238}",
    1
  ]);
});

test("every field counts, with its own weight", () => {
  const [json, norm] = stored({
    title: "Fix the login bug",
    categories: "debugging, testing",
    source: "custom",
    path: "03-skills-catalog/cards/fix-login.md",
    body: "Reproduce the failing login; write a regression test.\nИсправить ошибку входа — тесты, ревью."
  });
  assert.equal(norm, 1);
  assert.ok(json.startsWith("{\"918\":0.38076697,\"965\":0.2895419,\"533\":0.2895419,"), json.slice(0, 60));
  assert.equal(crypto.createHash("sha256").update(json).digest("hex"), "c3497a545908fd8d276ccd460330e95d3b5bcc41bc2e0b02e670df0ee08a4528");
});

test("a document with no features stores an empty vector of norm 0", () => {
  assert.deepEqual(stored({ title: "", categories: "", source: "", path: "", body: "" }), ["{}", 0]);
  assert.deepEqual(stored({ title: "a", body: "the and of" }), ["{}", 0]);
});

test("only the strongest features are kept", () => {
  const body = Array.from({ length: 2000 }, (_, index) => `word${index.toString(36)}x`).join(" ");
  const { entries } = buildSemanticVector({ body });
  assert.equal(entries.length, MAX_VECTOR_FEATURES);
  const squares = entries.reduce((sum, [, value]) => sum + value * value, 0);
  assert.ok(Math.abs(squares - 1) < 1e-6, String(squares));
});
