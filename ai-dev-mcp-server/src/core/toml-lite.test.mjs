import assert from "node:assert/strict";
import test from "node:test";
import { parseTomlLite } from "./toml-lite.mjs";

test("reads the Codex MCP section this server's own installer writes", () => {
  const { data, warnings } = parseTomlLite([
    "model = \"gpt-5\"",
    "",
    "# the launcher this repository installs",
    "[mcp_servers.ai-dev]",
    "command = \"node\"",
    "args = [\"/srv/ai-dev/src/server.mjs\", \"--stdio\"]",
    "env = { AI_DEV_VAULT_ROOT = \"/vault\", AI_DEV_TOKEN = \"${AI_DEV_TOKEN}\" }",
    "startup_timeout_sec = 120",
    "tool_timeout_sec = 3600",
    ""
  ].join("\n"));
  assert.deepEqual(warnings, []);
  assert.equal(data.model, "gpt-5");
  assert.deepEqual(data.mcp_servers["ai-dev"], {
    command: "node",
    args: ["/srv/ai-dev/src/server.mjs", "--stdio"],
    env: { AI_DEV_VAULT_ROOT: "/vault", AI_DEV_TOKEN: "${AI_DEV_TOKEN}" },
    startup_timeout_sec: 120,
    tool_timeout_sec: 3600
  });
});

test("reads quoted and dotted keys, arrays of tables, and every scalar it claims to", () => {
  const { data, warnings } = parseTomlLite([
    "[mcp_servers.\"remote-docs\"]",
    "url = 'https://docs.example.com/mcp'   # literal string, comment ignored",
    "enabled = true",
    "disabled = false",
    "weight = -1.5e2",
    "big = 1_000",
    "started = 2026-09-12T10:00:00Z",
    "tags = [",
    "  \"docs\",   # trailing comma and comments inside arrays",
    "  \"search\",",
    "]",
    "limits.requests = 10",
    "escaped = \"a\\tb\\u0041\\\\c\\\"d\"",
    "block = \"\"\"",
    "first",
    "second\"\"\"",
    "literal_block = '''raw \\n stays'''",
    "",
    "[[profiles]]",
    "name = \"fast\"",
    "",
    "[[profiles]]",
    "name = \"careful\"",
    ""
  ].join("\n"));
  assert.deepEqual(warnings, []);
  const server = data.mcp_servers["remote-docs"];
  assert.equal(server.url, "https://docs.example.com/mcp");
  assert.equal(server.enabled, true);
  assert.equal(server.disabled, false);
  assert.equal(server.weight, -150);
  assert.equal(server.big, 1000);
  assert.equal(server.started, "2026-09-12T10:00:00Z", "a date is kept as its text");
  assert.deepEqual(server.tags, ["docs", "search"]);
  assert.deepEqual(server.limits, { requests: 10 });
  assert.equal(server.escaped, "a\tbA\\c\"d");
  assert.equal(server.block, "first\nsecond");
  assert.equal(server.literal_block, "raw \\n stays");
  assert.deepEqual(data.profiles, [{ name: "fast" }, { name: "careful" }]);
});

test("a malformed line is a warning with its line number, and the rest of the file still parses", () => {
  const { data, warnings } = parseTomlLite([
    "[mcp_servers.first]",
    "command = \"node\"",
    "broken_string = \"never closed",
    "no_equals_here",
    "pinned = true extra",
    "",
    "[mcp_servers.second]",
    "command = \"python\"",
    ""
  ].join("\n"));
  assert.equal(data.mcp_servers.first.command, "node");
  assert.equal(data.mcp_servers.second.command, "python", "parsing resumes at the next table");
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /^line 3: unterminated string$/);
  assert.match(warnings[1], /^line 4: expected "=" after the key$/);
  assert.match(warnings[2], /^line 5: ignored trailing text after the value/);
  assert.equal(data.mcp_servers.first.pinned, true, "the part of the line it could read is kept");
});

test("a header or a container it cannot make sense of does not corrupt the keys around it", () => {
  const { data, warnings } = parseTomlLite([
    "[unterminated",
    "orphan = 1",
    "[tui]",
    "theme = \"dark\"",
    "items = [1, 2",
    "inline = { a = 1, b = ",
    "after = \"kept\"",
    ""
  ].join("\n"));
  assert.equal(data.orphan, undefined, "keys under a header we could not read are dropped, not misfiled");
  assert.equal(data.tui.theme, "dark");
  assert.equal(data.tui.items, undefined);
  assert.equal(data.tui.after, "kept");
  assert.ok(warnings.length >= 2);
  assert.match(warnings[0], /line 1: expected "\]" after the key/);
});

test("empty and non-string input produce an empty document", () => {
  assert.deepEqual(parseTomlLite(""), { data: {}, warnings: [] });
  assert.deepEqual(parseTomlLite(undefined), { data: {}, warnings: [] });
  assert.deepEqual(parseTomlLite("# only a comment\n"), { data: {}, warnings: [] });
  assert.deepEqual(parseTomlLite("key = \"value\"\r\n").data, { key: "value" });
});
