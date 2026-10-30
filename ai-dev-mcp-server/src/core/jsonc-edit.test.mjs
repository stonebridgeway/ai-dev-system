import assert from "node:assert/strict";
import test from "node:test";
import {
  JsoncSyntaxError,
  describeJsonc,
  isEmptyObjectAt,
  readJsonc,
  readMember,
  removeMember,
  setMember
} from "./jsonc-edit.mjs";

const ENTRY = { command: "/usr/bin/node", args: ["/opt/ai-dev/bin/ai-dev.mjs", "mcp"] };

test("a member set next to other servers goes last in their style, and removing it gives the original back", () => {
  const original = "{\n  \"mcpServers\": {\n    \"github\": {\n      \"command\": \"gh\"\n    }\n  },\n  \"theme\": \"dark\"\n}\n";
  const written = setMember(original, ["mcpServers"], "ai-dev", ENTRY);
  assert.equal(written, [
    "{",
    "  \"mcpServers\": {",
    "    \"github\": {",
    "      \"command\": \"gh\"",
    "    },",
    "    \"ai-dev\": {",
    "      \"command\": \"/usr/bin/node\",",
    "      \"args\": [",
    "        \"/opt/ai-dev/bin/ai-dev.mjs\",",
    "        \"mcp\"",
    "      ]",
    "    }",
    "  },",
    "  \"theme\": \"dark\"",
    "}",
    ""
  ].join("\n"));
  assert.deepEqual(readMember(written, ["mcpServers"], "ai-dev"), ENTRY);
  assert.equal(removeMember(written, ["mcpServers"], "ai-dev"), original);
});

test("comments, trailing commas, CRLF and tabs survive an edit untouched", () => {
  const original = "{\r\n\t// servers I use\r\n\t\"mcpServers\": {\r\n\t\t\"x\": { \"command\": \"y\" }, /* keep */\r\n\t},\r\n}\r\n";
  const written = setMember(original, ["mcpServers"], "ai-dev", ENTRY);
  assert.ok(written.includes("\t// servers I use\r\n"));
  assert.ok(written.includes("/* keep */"));
  assert.ok(!/[^\r]\n/.test(written), "every line break stays CRLF");
  assert.ok(written.includes("\r\n\t\t\"ai-dev\": {\r\n\t\t\t\"command\""), "indented with tabs, one level per step");
  assert.deepEqual(readJsonc(written).mcpServers["ai-dev"], ENTRY);
  assert.equal(removeMember(written, ["mcpServers"], "ai-dev"), original);
});

test("a comment after a member's value stays with that member, on insert and on remove", () => {
  const original = "{\n  \"mcpServers\": {\n    \"github\": {} // GitHub\n  }\n}\n";
  const written = setMember(original, ["mcpServers"], "ai-dev", { command: "n" });
  assert.equal(written, "{\n  \"mcpServers\": {\n    \"github\": {}, // GitHub\n    \"ai-dev\": {\n      \"command\": \"n\"\n    }\n  }\n}\n");
  assert.equal(removeMember(written, ["mcpServers"], "ai-dev"), original);

  const trailing = "{\n  \"servers\": {\n    \"x\": { \"command\": \"y\" }, /* keep */\n  },\n}\n";
  const withOurs = setMember(trailing, ["servers"], "ai-dev", { command: "n" });
  assert.ok(withOurs.includes("\"x\": { \"command\": \"y\" }, /* keep */\n    \"ai-dev\": {"), withOurs);
  assert.deepEqual(readJsonc(withOurs).servers["ai-dev"], { command: "n" });
  assert.equal(removeMember(withOurs, ["servers"], "ai-dev"), trailing);

  // Written by the earlier insert, which left the comment on the member it came after.
  assert.equal(removeMember("{\n  \"mcpServers\": {\n    \"github\": {}, // GitHub\n    \"ai-dev\": { \"command\": \"n\" }\n  }\n}\n", ["mcpServers"], "ai-dev"),
    "{\n  \"mcpServers\": {\n    \"github\": {} // GitHub\n  }\n}\n");
  // In the middle: its own comment goes with it, its neighbours keep theirs.
  assert.equal(removeMember("{\n  \"a\": 1, // A\n  \"ai-dev-system\": { \"command\": \"old\" }, // 2.x\n  \"b\": 2 // B\n}\n", [], "ai-dev-system"),
    "{\n  \"a\": 1, // A\n  \"b\": 2 // B\n}\n");
  // Members that share a line are cut as before.
  assert.equal(removeMember("{\"mcpServers\":{\"a\":1,\"ai-dev\":{\"command\":\"n\"}}}", ["mcpServers"], "ai-dev"), "{\"mcpServers\":{\"a\":1}}");
});

test("a missing container is created, an empty file becomes a document, an empty object gets one member", () => {
  const themed = setMember("{\n    \"theme\": \"dark\"\n}\n", ["mcpServers"], "ai-dev", ENTRY);
  assert.deepEqual(readJsonc(themed), { theme: "dark", mcpServers: { "ai-dev": ENTRY } });
  assert.match(themed, /\n {4}"mcpServers": \{\n {8}"ai-dev": \{\n {12}"command"/, "the file's four-space step is used");

  assert.deepEqual(readJsonc(setMember("", ["servers"], "ai-dev", ENTRY)), { servers: { "ai-dev": ENTRY } });
  assert.deepEqual(readJsonc(setMember("  \n", ["servers"], "ai-dev", ENTRY)), { servers: { "ai-dev": ENTRY } });
  const commentOnly = setMember("// nothing yet\n", ["servers"], "ai-dev", ENTRY);
  assert.ok(commentOnly.startsWith("// nothing yet\n{"));
  assert.deepEqual(readJsonc(commentOnly), { servers: { "ai-dev": ENTRY } });

  const empty = setMember("{\n  \"mcpServers\": {}\n}\n", ["mcpServers"], "ai-dev", ENTRY);
  assert.deepEqual(readJsonc(empty), { mcpServers: { "ai-dev": ENTRY } });
  assert.equal(removeMember(empty, ["mcpServers"], "ai-dev"), "{\n  \"mcpServers\": {}\n}\n");
  assert.ok(isEmptyObjectAt(removeMember(empty, ["mcpServers"], "ai-dev"), ["mcpServers"]));
});

test("an existing member is replaced where it stands; a one-line object stays on one line", () => {
  const original = "{\n  \"mcpServers\": {\n    \"ai-dev\": { \"command\": \"old\" },\n    \"z\": {}\n  }\n}\n";
  const written = setMember(original, ["mcpServers"], "ai-dev", ENTRY);
  assert.deepEqual(Object.keys(readJsonc(written).mcpServers), ["ai-dev", "z"]);
  assert.deepEqual(readMember(written, ["mcpServers"], "ai-dev"), ENTRY);

  const inline = setMember("{\"mcpServers\": {\"a\": 1}}", ["mcpServers"], "ai-dev", ENTRY);
  assert.equal(inline, `{"mcpServers": {"a": 1, "ai-dev": ${JSON.stringify(ENTRY)}}}`);
  assert.equal(removeMember(inline, ["mcpServers"], "ai-dev"), "{\"mcpServers\": {\"a\": 1}}");
});

test("removing the first of several members takes its lines and leaves the others as they were", () => {
  const original = "{\n  \"mcpServers\": {\n    \"ai-dev-system\": {\n      \"command\": \"node\"\n    },\n    \"other\": {}\n  }\n}\n";
  assert.equal(removeMember(original, ["mcpServers"], "ai-dev-system"), "{\n  \"mcpServers\": {\n    \"other\": {}\n  }\n}\n");
  assert.equal(removeMember("{\"a\": 1, \"b\": 2}", [], "a"), "{\"b\": 2}");
  assert.equal(removeMember("{\"a\": 1}", [], "a"), "{}");
  assert.equal(removeMember("{ // c\n \"a\": 1\n}", [], "a"), "{ // c\n \n}");
  // Duplicates all go: JSON readers keep the last, and the last may be the stale one.
  assert.equal(removeMember("{\"a\": 1, \"b\": 2, \"a\": 3}", [], "a"), "{\"b\": 2}");
  assert.equal(removeMember("{\"b\": 2}", [], "a"), "{\"b\": 2}", "absent: unchanged");
  assert.equal(removeMember("{\"b\": 2}", ["mcpServers"], "a"), "{\"b\": 2}", "no container: unchanged");
});

test("a broken document is refused with where it breaks, and nothing is half-edited", () => {
  for (const [text, said] of [
    ["{\n  \"mcpServers\": {\n", /line 3, column 1: expected a "quoted" member name/],
    ["{\"a\": tru}", /unexpected "t" where a value should be/],
    ["{\"a\": 1} x", /unexpected text after the end of the document/],
    ["{\"a\": \"line\nbreak\"}", /a string holds a character JSON does not allow/],
    ["{/* never closed", /a \/\* comment is never closed/],
    ["[1, 2]", /the document is a JSON array, not an object/],
    ["{\"mcpServers\": null}", /"mcpServers" is a JSON null, not an object/]
  ]) {
    assert.throws(() => setMember(text, ["mcpServers"], "ai-dev", ENTRY), (error) => error instanceof JsoncSyntaxError && said.test(error.message), text);
  }
  assert.throws(() => describeJsonc(`${"[".repeat(600)}${"]".repeat(600)}`), /a JSON array|nested too deeply/);
  assert.throws(() => readJsonc(`{"a": ${"[".repeat(600)}${"]".repeat(600)}}`), /nested too deeply/);
});

test("values read back as JSON.parse reads them, `__proto__` included, and a BOM is kept", () => {
  const text = "﻿{\"a\": [1, -2.5e3, true, false, null, \"\\u00e9\\n\"], \"__proto__\": {\"x\": 1}}";
  const value = readJsonc(text);
  assert.deepEqual(value.a, JSON.parse(text.slice(1)).a);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, "__proto__").value, { x: 1 });
  assert.ok(setMember(text, ["mcpServers"], "ai-dev", ENTRY).startsWith("﻿{"));
  assert.equal(readMember(text, ["nope"], "a"), undefined);
  assert.equal(readMember("", ["mcpServers"], "a"), undefined);
});

test("a large document is edited without materialising it", () => {
  const projects = {};
  for (let index = 0; index < 20_000; index += 1) projects[`/home/u/p${index}`] = { history: [{ display: "x".repeat(100) }] };
  const original = JSON.stringify({ projects, mcpServers: { other: { command: "o" } } }, null, 2);
  const started = Date.now();
  const written = setMember(original, ["mcpServers"], "ai-dev", ENTRY);
  assert.ok(Date.now() - started < 5000);
  assert.equal(written.slice(0, original.length - 200), original.slice(0, original.length - 200));
  assert.equal(removeMember(written, ["mcpServers"], "ai-dev"), original);
});
