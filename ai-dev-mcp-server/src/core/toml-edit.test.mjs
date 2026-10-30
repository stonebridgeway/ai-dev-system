import assert from "node:assert/strict";
import test from "node:test";
import { parseTomlLite } from "./toml-lite.mjs";
import {
  TomlEditError,
  inlineDefinitions,
  removeTables,
  renderTable,
  scanToml,
  tablesUnder,
  tomlString,
  tomlValue,
  upsertTables
} from "./toml-edit.mjs";

const PREFIX = ["mcp_servers", "ai-dev"];
const SECTION = renderTable(PREFIX, {
  command: "/usr/bin/node",
  args: ["/opt/ai-dev/bin/ai-dev.mjs", "mcp"],
  startup_timeout_sec: 120,
  tool_timeout_sec: 3600
});

function servers(text) {
  const { data, warnings } = parseTomlLite(text);
  assert.deepEqual(warnings, []);
  return data.mcp_servers ?? {};
}

test("a table with a subtable is replaced whole, so the result defines the server once", () => {
  const original = [
    "[mcp_servers.ai-dev]",
    "command = \"/bin/sh\"",
    "args = [\"/old/run-mcp.sh\"]",
    "",
    "[mcp_servers.ai-dev.env]",
    "AI_DEV_IMAGE = \"old\"",
    "",
    "[mcp_servers.github]",
    "command = \"gh\"",
    ""
  ].join("\n");
  const written = upsertTables(original, PREFIX, SECTION);
  assert.equal(written, `${SECTION}\n[mcp_servers.github]\ncommand = "gh"\n`);
  assert.deepEqual(Object.keys(servers(written)), ["ai-dev", "github"]);
  assert.equal(servers(written)["ai-dev"].env, undefined);
});

test("the name is found in every spelling TOML allows", () => {
  for (const header of ["[mcp_servers.\"ai-dev\"]", "[mcp_servers.'ai-dev']", "[ mcp_servers . ai-dev ]", "[\"mcp_servers\".ai-dev] # mine"]) {
    const original = `model = "o3"\n\n${header}\ncommand = "/bin/sh"\n`;
    const written = upsertTables(original, PREFIX, SECTION);
    assert.equal(written, `model = "o3"\n\n${SECTION}`, header);
    assert.equal(removeTables(written, PREFIX), "model = \"o3\"\n", header);
  }
});

test("a [ inside a string, a multi-line string or a multi-line array is not a header", () => {
  const original = [
    "model = \"gpt-5\"",
    "[mcp_servers.github]",
    "command = \"gh\"",
    "args = [",
    "  \"x\",",
    "  [\"[mcp_servers.ai-dev]\"],",
    "]",
    "note = \"\"\"",
    "[mcp_servers.ai-dev]",
    "\"\"\"",
    "literal = '''",
    "[mcp_servers.ai-dev]'''",
    "quote = \"\\\"[mcp_servers.ai-dev]\"",
    "",
    "# a comment that stays where it is",
    ""
  ].join("\n");
  assert.equal(tablesUnder(scanToml(original), PREFIX).length, 0);
  const written = upsertTables(original, PREFIX, SECTION);
  assert.equal(written, `${original}\n${SECTION}`, "appended one blank line down");
  assert.equal(upsertTables(written, PREFIX, SECTION), written, "again: unchanged");
  assert.equal(removeTables(written, PREFIX), original, "removed: the original, byte for byte");
  assert.deepEqual(Object.keys(servers(written)), ["github", "ai-dev"]);
});

test("removing tables keeps the blank lines tidy at the start, the middle and the end", () => {
  assert.equal(removeTables("[mcp_servers.ai-dev-system]\ncommand = \"n\"\n\n[profiles.x]\nmodel = \"y\"\n", ["mcp_servers", "ai-dev-system"]),
    "[profiles.x]\nmodel = \"y\"\n");
  assert.equal(removeTables("a = 1\n\n[mcp_servers.ai-dev]\nc = 1\n\n# about b\n[b]\nd = 2\n", PREFIX), "a = 1\n\n# about b\n[b]\nd = 2\n");
  assert.equal(removeTables("a = 1\n[mcp_servers.ai-dev]\nc = 1\n", PREFIX), "a = 1\n");
  assert.equal(removeTables("a = 1\n", PREFIX), "a = 1\n", "absent: unchanged");
});

test("tables that share the blank line between them are cut whole, and the next header keeps its [", () => {
  const removed = removeTables([
    "model = \"o3\"",
    "[mcp_servers.ai-dev]",
    "command = \"/bin/sh\"",
    "",
    "[mcp_servers.ai-dev.env]",
    "AI_DEV_IMAGE = \"old\"",
    "[mcp_servers.github]",
    "command = \"gh\"",
    ""
  ].join("\n"), PREFIX);
  assert.equal(removed, "model = \"o3\"\n[mcp_servers.github]\ncommand = \"gh\"\n");
  assert.deepEqual(Object.keys(servers(removed)), ["github"]);
  const upserted = upsertTables([
    "[mcp_servers.ai-dev]",
    "c = 1",
    "[mcp_servers.ai-dev.a]",
    "x = 1",
    "",
    "[mcp_servers.ai-dev.b]",
    "y = 2",
    "# keep",
    "[other]",
    "z = 3",
    ""
  ].join("\n"), PREFIX, SECTION);
  assert.equal(upserted, `${SECTION}# keep\n[other]\nz = 3\n`);
  assert.deepEqual(parseTomlLite(upserted).data.other, { z: 3 });
});

test("an edit that would break the file or touch another table is refused, and nothing is returned to write", () => {
  // A section that is not one table of the prefix: the guard, not the cut, stops it.
  for (const section of ["[mcp_servers.ai-dev]\ncommand = \"n\"\n[other]\n", "[mcp_servers.ai-dev]\ncommand = \n\"n\"\n", "[mcp_servers.github]\n"]) {
    for (const text of ["", "model = \"o3\"\n", "[mcp_servers.ai-dev]\nc = 1\n"]) {
      assert.throws(() => upsertTables(text, PREFIX, section), (error) => error instanceof TomlEditError
        && /editing \[mcp_servers\.ai-dev\] here would (?:leave a file that cannot be read \(line \d+: [^)]+\)|change other tables); this file is left as it is/.test(error.message), JSON.stringify([text, section]));
    }
  }
});

test("a byte order mark is not a blank line: it stays when the first table goes", () => {
  assert.equal(removeTables("\uFEFF[mcp_servers.ai-dev]\nc = 1\n\n[b]\nd = 2\n", PREFIX), "\uFEFF[b]\nd = 2\n");
  assert.equal(removeTables("\uFEFF\n[mcp_servers.ai-dev]\nc = 1\n", PREFIX), "\uFEFF");
  assert.equal(upsertTables("\uFEFF", PREFIX, SECTION), `\uFEFF\n${SECTION}`);
});

test("CRLF files get CRLF, a file without a final newline gets one before the append", () => {
  const crlf = "model = \"o3\"\r\n";
  const written = upsertTables(crlf, PREFIX, renderTable(PREFIX, { command: "n" }, scanToml(crlf).eol));
  assert.equal(written, "model = \"o3\"\r\n\r\n[mcp_servers.ai-dev]\r\ncommand = \"n\"\r\n");
  assert.equal(upsertTables("model = \"o3\"", PREFIX, SECTION), `model = "o3"\n\n${SECTION}`);
  assert.equal(upsertTables("", PREFIX, SECTION), SECTION);
});

test("a server written as keys rather than a table is reported, not rewritten", () => {
  for (const [text, line] of [
    ["[mcp_servers]\nai-dev = { command = \"x\" }\n", 2],
    ["mcp_servers.ai-dev.command = \"x\"\n", 1],
    ["mcp_servers = { ai-dev = { command = \"x\" } }\n", 1],
    ["[mcp_servers]\n\"ai-dev\".command = \"x\"\n", 2]
  ]) {
    assert.equal(inlineDefinitions(scanToml(text), PREFIX).length, 1, text);
    assert.throws(() => upsertTables(text, PREFIX, SECTION), (error) => error instanceof TomlEditError && error.line === line
      && /is written as a key, not as a \[mcp_servers\.ai-dev\] table; this file is left as it is/.test(error.message), text);
  }
  assert.equal(inlineDefinitions(scanToml(`${SECTION}env = { A = "b" }\n`), PREFIX).length, 0, "keys inside the table are its own");
});

test("strings and headers that never close are refused with their line", () => {
  assert.throws(() => scanToml("a = \"open\n"), /line 1: a string is never closed/);
  assert.throws(() => scanToml("a = 'open\n"), /line 1: a string is never closed/);
  assert.throws(() => scanToml("a = \"\"\"\nnever closed\n"), /line 2: a multi-line string is never closed/);
  assert.throws(() => scanToml("[mcp_servers.ai-dev\n"), /line 1: a table header is never closed/);
  assert.throws(() => scanToml("= 1\n"), /line 1: expected a key/);
  assert.throws(() => scanToml("a 1\n"), /line 1: expected '=' after a key/);
});

test("values come out as TOML a strict reader accepts", () => {
  assert.equal(tomlString("C:\\Program Files\\nodejs\\node.exe"), "\"C:\\\\Program Files\\\\nodejs\\\\node.exe\"");
  assert.equal(tomlString("a\"b\u0001\u007f\n"), "\"a\\\"b\\u0001\\u007F\\n\"");
  assert.equal(tomlValue({ A_B: "x", "a b": 1, ok: true, list: [] }), "{ A_B = \"x\", \"a b\" = 1, ok = true, list = [] }");
  assert.equal(tomlValue({}), "{}");
  assert.throws(() => tomlValue(null), /no way to write null/);
  assert.throws(() => tomlValue(Number.NaN), /no way to write number/);
  assert.equal(renderTable(["mcp_servers", "a.b"], { x: undefined, y: 1 }), "[mcp_servers.\"a.b\"]\ny = 1\n");
});
