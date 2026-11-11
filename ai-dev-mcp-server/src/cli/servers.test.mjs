import assert from "node:assert/strict";
import test from "node:test";
import { serverLines } from "./servers.mjs";

const listed = {
  servers: [
    { name: "ai-dev", command: "/home/me/.ai-dev/app/current/node/bin/node", args: ["/home/me/.ai-dev/app/current/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"], origins: [{ client: "claude-code" }, { client: "cursor" }] },
    { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], origins: [{ client: "claude-code" }] }
  ],
  findings: [{ severity: "warn", server: "github", message: "npx -y @modelcontextprotocol/server-github fetches and runs whatever the registry serves at start-up, with the install prompt answered in advance. Pin the version (@modelcontextprotocol/server-github@1.2.3) or vendor the server." }]
};

test("every line fits the terminal: a server's command is cut beside its clients, a finding wraps at words", () => {
  for (const width of [60, 80, 108]) {
    const lines = serverLines(listed, { width });
    for (const line of lines) assert.ok(line.length < width, `${width}: ${line.length} ${JSON.stringify(line)}`);
    assert.match(lines[0], /\(claude-code, cursor\)$/, "the clients close the server's line");
    const finding = lines.slice(2);
    assert.ok(finding.length > 1 && finding[0].startsWith("  warn · github: ") && finding.slice(1).every((line) => line.startsWith("    ")));
    assert.equal(finding.join(" ").replace(/\s+/g, " ").trim(), `warn · github: ${listed.findings[0].message}`, "nothing of the finding is lost");
  }
});

test("no servers: one line that says where else to look", () => {
  assert.deepEqual(serverLines({ servers: [], findings: [] }, { width: 80 }), ["  None in this repository's configs: --mine adds your own."]);
  assert.deepEqual(serverLines({ servers: [], findings: [] }, { width: 80, mine: true }), ["  None in these configs."]);
});
