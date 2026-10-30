import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `npm test` runs `node --test` without a file list, so Node picks files by its
// own patterns — `*.test.js`, `*-test.js`, `*_test.js`, `test-*.js`, `test.js`
// and anything under a `test/` directory, for .js, .cjs and .mjs alike. A
// script that only happens to match ran as a unit test: the upgrade scenario,
// two network installs and a git worktree included.
const NODE_TEST_PATTERN = /(?:[-_]test|^test-.*|^test)\.(?:c|m)?js$/;

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory) {
  return fs.readdirSync(directory, { recursive: true })
    .map(String)
    .filter((relative) => !relative.split(path.sep).includes("node_modules"))
    .filter((relative) => /\.(?:c|m)?js$/.test(relative));
}

test("no script or module is picked up by node --test unless it is a *.test.mjs file", () => {
  const swept = [];
  for (const directory of ["scripts", "src", "hooks"]) {
    for (const relative of sourceFiles(path.join(serverRoot, directory))) {
      const name = path.basename(relative);
      if (/\.test\.(?:c|m)?js$/.test(name)) continue;
      if (NODE_TEST_PATTERN.test(name)) swept.push(path.join(directory, relative));
    }
  }
  assert.deepEqual(swept, [], "rename these, or make them tests");
});

test("the pattern catches the name that slipped through", () => {
  for (const name of ["upgrade-test.mjs", "upgrade_test.js", "test-upgrade.cjs", "test.mjs"]) {
    assert.ok(NODE_TEST_PATTERN.test(name), name);
  }
  for (const name of ["upgrade-check.mjs", "acceptance.mjs", "latest.mjs", "contest.mjs"]) {
    assert.ok(!NODE_TEST_PATTERN.test(name), name);
  }
});
