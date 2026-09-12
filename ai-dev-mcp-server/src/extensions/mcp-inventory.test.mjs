import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createMcpInventoryTools } from "./mcp-inventory.mjs";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp-inventory/", import.meta.url));

function registry(overrides = {}) {
  return createExtensionTools(
    {
      resolveProjectIdentity: async (projectPath) => ({ project_root: path.resolve(projectPath), project_id: "project-test" }),
      findProjectCard: async () => { throw new Error("No project card registered."); },
      updateProjectCard: async () => ({ updated: true }),
      ...overrides
    },
    [createMcpInventoryTools]
  );
}

test("list_mcp_servers reports the fixture project and says what to do about it", async () => {
  const tools = registry();
  assert.deepEqual(tools.readOnly, ["list_mcp_servers"]);
  const report = await tools.handlers.get("list_mcp_servers")({ project_path: FIXTURE });
  assert.equal(report.project_path, path.resolve(FIXTURE));
  assert.equal(report.summary.servers, 6);
  assert.equal(report.summary.block, 0);
  assert.match(report.next_step, /^5 findings to review/);
});

test("a credential in a config file drives the next step, and an empty project says so", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-inventory-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const tools = registry();

  const empty = await tools.handlers.get("list_mcp_servers")({ project_path: root });
  assert.match(empty.next_step, /No MCP server is declared/);

  await fs.writeFile(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { billing: { command: "node", args: ["b.mjs"], env: { BILLING_TOKEN: `live${"_9f3c2b81aa04"}` } } } }, null, 2),
    "utf8"
  );
  const withSecret = await tools.handlers.get("list_mcp_servers")({ project_path: root });
  assert.equal(withSecret.summary.block, 1);
  assert.match(withSecret.next_step, /Move 1 credential out of \.mcp\.json/);
  assert.match(withSecret.next_step, /rotate it/);

  await fs.writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { billing: { command: "node", args: ["b.mjs"], env: { BILLING_TOKEN: "${BILLING_TOKEN}" } } } }, null, 2), "utf8");
  const clean = await tools.handlers.get("list_mcp_servers")({ project_path: root });
  assert.equal(clean.summary.block, 0);
  assert.match(clean.next_step, /^1 server declared, nothing to act on\./);
});

test("user-scope reading is off unless the caller asks for it", async (t) => {
  // The tool reads the current user's home, so the test gives it one of its own
  // rather than the developer's.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-inventory-home-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(async () => {
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "user-wide": { command: "node", args: ["u.mjs"] } } }), "utf8");

  const tools = registry();
  const report = await tools.handlers.get("list_mcp_servers")({ project_path: FIXTURE });
  assert.equal(report.user_scope, false);
  assert.equal(report.servers.some((server) => server.name === "user-wide"), false);

  const asked = await tools.handlers.get("list_mcp_servers")({ project_path: FIXTURE, include_user_scope: true });
  assert.equal(asked.user_scope, true);
  assert.equal(asked.sources.length, report.sources.length + 4);
  assert.equal(asked.servers.some((server) => server.name === "user-wide"), true);
});


test("scan_agent_config grades the harness and writes the grade into the project card", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(*)"], deny: [] } }), "utf8");

  const calls = [];
  const tools = registry({
    findProjectCard: async (name) => { calls.push(["findProjectCard", name]); return { name: "Atlas" }; },
    updateProjectCard: async (args) => { calls.push(["updateProjectCard", args]); return { updated: true }; }
  });
  assert.deepEqual(tools.readOnly, ["list_mcp_servers"], "the scan writes to the card, so it is not read-only");

  const scan = await tools.handlers.get("scan_agent_config")({ project_path: root });
  assert.equal(scan.grade, "D");
  assert.equal(scan.status, "block");
  assert.ok(scan.findings.some((item) => item.rule === "settings_allow_any_command"));
  assert.match(scan.next_step, /^Grade D: 1 setting\(s\) remove a check/);
  const [, cardArgs] = calls.find(([name]) => name === "updateProjectCard");
  assert.equal(cardArgs.name, "Atlas");
  assert.equal(cardArgs.section, "Agent Configuration");
  assert.equal(cardArgs.mode, "replace");
  assert.match(cardArgs.content, /- Grade: \*\*D\*\*/);
  assert.deepEqual(scan.card, { updated: true });

  // A project with no card is not a reason to fail the scan.
  const cardless = await registry().handlers.get("scan_agent_config")({ project_path: root });
  assert.equal(cardless.grade, "D");
  assert.equal(cardless.card.updated, false);
  assert.match(cardless.card.error, /No project card registered/);

  // And the card can be left alone entirely.
  const untouched = registry({ updateProjectCard: async () => { throw new Error("must not be called"); } });
  const quiet = await untouched.handlers.get("scan_agent_config")({ project_path: root, update_card: false });
  assert.equal(quiet.card, null);
});
