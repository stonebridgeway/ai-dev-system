import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SUBSET_VALUE_BYTES,
  createJsonSubsetScanner,
  readJsonSubset
} from "./json-subset.mjs";

const CLAUDE_JSON_PATTERNS = [["mcpServers"], ["projects", "/home/a/atlas", "mcpServers"]];

/** `~/.claude.json` as Claude Code writes it: two wanted keys, and history. */
function claudeJson({ historyEntries = 2 } = {}) {
  return JSON.stringify({
    numStartups: 137,
    installMethod: "native",
    mcpServers: {
      "ai-dev": { command: "node", args: ["/opt/ai-dev/src/server.mjs"], env: { AI_DEV_VAULT: "${VAULT}" } }
    },
    projects: {
      "/home/a/atlas": {
        allowedTools: [],
        mcpServers: { docs: { type: "http", url: "https://docs.example.invalid/mcp" } },
        history: Array.from({ length: historyEntries }, (_, index) => ({ display: `question ${index} with {braces} and "quotes"`, pastedContents: {} }))
      },
      "/home/a/beta": {
        history: Array.from({ length: historyEntries }, (_, index) => ({ display: `beta ${index}` }))
      }
    },
    tipsHistory: { "ide-hotkey": 4 }
  }, null, 2);
}

function scan(text, patterns = CLAUDE_JSON_PATTERNS, options) {
  const scanner = createJsonSubsetScanner(patterns, options);
  // Seven characters at a time: a chunk boundary can land anywhere, including
  // the middle of a key, a string value or an escape sequence.
  for (let index = 0; index < text.length; index += 7) scanner.push(text.slice(index, index + 7));
  return scanner.finish();
}

test("the two wanted keys come back and nothing else does", () => {
  const result = scan(claudeJson());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.truncated, []);
  assert.equal(result.root, "{");
  assert.deepEqual(result.values.map((item) => item.path), [
    ["mcpServers"],
    ["projects", "/home/a/atlas", "mcpServers"]
  ]);
  assert.deepEqual(result.values[0].value, {
    "ai-dev": { command: "node", args: ["/opt/ai-dev/src/server.mjs"], env: { AI_DEV_VAULT: "${VAULT}" } }
  });
  assert.deepEqual(result.values[1].value, { docs: { type: "http", url: "https://docs.example.invalid/mcp" } });
});

test("the history is streamed past, not parsed, however large it is", async (t) => {
  // The measurement from Д-17: a file where the two wanted keys are a rounding
  // error next to the conversation history.
  const big = claudeJson({ historyEntries: 20_000 });
  assert.ok(big.length > 2_000_000, `expected a large fixture, got ${big.length} bytes`);
  const result = scan(big);
  assert.deepEqual(result.errors, []);
  assert.equal(result.values.length, 2);
  // What was kept is the two small objects, not a share of the file.
  const kept = JSON.stringify(result.values).length;
  assert.ok(kept < 1_000, `kept ${kept} bytes of a ${big.length}-byte file`);
  assert.equal(result.bytes, big.length, "the whole file was read, and dropped as it went");

  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "json-subset-")), "claude.json");
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }));
  await fs.writeFile(file, big, "utf8");
  const streamed = await readJsonSubset(file, CLAUDE_JSON_PATTERNS);
  assert.equal(streamed.exists, true);
  assert.equal(streamed.found.length, 2);
  assert.deepEqual(streamed.errors, []);
  assert.equal(streamed.bytes, big.length);
});

test("a project nobody asked about is never buffered", () => {
  const result = scan(claudeJson(), [["projects", "/home/a/atlas", "mcpServers"]]);
  assert.deepEqual(result.values.map((item) => item.path), [["projects", "/home/a/atlas", "mcpServers"]]);
  // The wildcard form is what finds every project's block; the exact form is
  // what the inventory uses, so the other projects are not even recognised.
  const wildcard = scan(claudeJson(), [["projects", "*", "mcpServers"]]);
  assert.deepEqual(wildcard.values.map((item) => item.path), [["projects", "/home/a/atlas", "mcpServers"]]);
});

test("every JSON value shape survives a chunk boundary", () => {
  const document = JSON.stringify({
    object: { a: 1 },
    array: [1, "two", { three: 3 }, [4]],
    text: 'a "quoted" value, with a comma and {braces}',
    escaped: 'back\\slash and a "quote"',
    number: -12.5e3,
    yes: true,
    nothing: null,
    empty: {},
    emptyArray: [],
    emptyText: ""
  });
  const patterns = [["object"], ["array"], ["text"], ["escaped"], ["number"], ["yes"], ["nothing"], ["empty"], ["emptyArray"], ["emptyText"]];
  const result = scan(document, patterns);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    Object.fromEntries(result.values.map((item) => [item.path[0], item.value])),
    JSON.parse(document)
  );
  // A one-character-at-a-time push must agree with a single push.
  const single = createJsonSubsetScanner(patterns);
  single.push(document);
  assert.deepEqual(single.finish().values, result.values);
});

test("a key that only looks like the wanted one is not it", () => {
  const document = JSON.stringify({
    notes: "mcpServers is documented in the README",
    nested: { mcpServers: { wrong: { command: "no" } } },
    list: [{ mcpServers: { alsoWrong: { command: "no" } } }],
    mcpServers: { right: { command: "yes" } }
  });
  const result = scan(document, [["mcpServers"]]);
  assert.deepEqual(result.values.map((item) => item.value), [{ right: { command: "yes" } }]);
});

test("a value larger than the limit is reported rather than buffered", () => {
  const document = JSON.stringify({ mcpServers: { big: { args: ["x".repeat(5_000)] } } });
  const result = scan(document, [["mcpServers"]], { maxValueBytes: 500 });
  assert.deepEqual(result.values, []);
  assert.deepEqual(result.truncated, ["mcpServers"]);
  assert.ok(MAX_SUBSET_VALUE_BYTES > 1_000_000);
});

test("a file that is not the object it was looking for says so", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "json-subset-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(scan("[1, 2, 3]", [["mcpServers"]]).root, "[");
  assert.equal(scan("", [["mcpServers"]]).root, "");

  // Truncated JSON: the value never closes, so it is reported, not guessed at.
  const cut = scan('{"mcpServers": {"a": {"command": "node"', [["mcpServers"]]);
  assert.deepEqual(cut.values, []);
  assert.deepEqual(cut.truncated, ["mcpServers"]);
  // …and the document itself is reported as cut off. Without this the caller
  // reads a half-written file as "this machine declares no servers" (Д-25).
  assert.equal(cut.errors.length, 1);
  assert.match(cut.errors[0], /ends in the middle/);
  assert.match(cut.errors[0], /unknown rather than absent/);

  // A file cut at three different places, and one that is whole.
  for (const text of ['{"mcpServers":', '{"mcpServers": {"a": {"command": "np', '{"mcpServers": {"a": {}},']) {
    const partial = scan(text, [["mcpServers"]]);
    assert.match(partial.errors[0] ?? "", /ends in the middle/, `not reported as cut off: ${text}`);
  }
  const whole = scan('{"mcpServers": {"a": {"command": "node"}}, "projects": {}}', [["mcpServers"]]);
  assert.deepEqual(whole.errors, [], "a whole document is not accused of ending early");
  assert.equal(whole.values.length, 1);

  // Something that starts like an object and then is not: whatever parsed, plus
  // the error.
  const broken = scan('{"mcpServers": {oops}}', [["mcpServers"]]);
  assert.deepEqual(broken.values, []);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], /^mcpServers: /);

  const missing = await readJsonSubset(path.join(directory, "nope.json"), CLAUDE_JSON_PATTERNS);
  assert.deepEqual(missing, { found: [], bytes: 0, truncated: [], errors: [], root: "", exists: false });

  // A directory is not a file, and that is an error rather than a throw.
  const failed = await readJsonSubset(directory, CLAUDE_JSON_PATTERNS);
  assert.equal(failed.exists, true);
  assert.equal(failed.found.length, 0);
  assert.equal(failed.errors.length, 1);
});
