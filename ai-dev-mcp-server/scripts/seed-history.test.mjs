import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { SEED_HISTORY_FILE } from "../src/core/seed-sync.mjs";
import { SEED_HISTORY_BASE, computeSeedHistory, hasSeedHistory, seedKeys } from "./seed-history.mjs";

// The history ships in the package and the image; git is where it comes from.
// A shallow clone (CI's) has not got the 2.x commits, so there the test skips.
const skip = hasSeedHistory() ? false : "this clone does not have the 2.x seed's history";

test("the shipped seed history is what git says for the 2.x line", { skip }, async () => {
  const shipped = JSON.parse(await fs.readFile(SEED_HISTORY_FILE, "utf8"));
  const computed = await computeSeedHistory();
  assert.equal(shipped.base, SEED_HISTORY_BASE);
  assert.deepEqual(shipped.pairs, computed.pairs, "run `node scripts/seed-history.mjs --write`");
});

test("every file of the seed a 2.x volume can hold is known to the history by itself, whatever the current manifest says", { skip }, async () => {
  const history = new Set(JSON.parse(await fs.readFile(SEED_HISTORY_FILE, "utf8")).pairs);
  const at2x = seedKeys([SEED_HISTORY_BASE]);
  assert.ok(at2x.size > 1000, `the seed at the base has ${at2x.size} files`);
  const unknown = [...at2x].filter((key) => !history.has(key));
  assert.deepEqual(unknown, []);
});
