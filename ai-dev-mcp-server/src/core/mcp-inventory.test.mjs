import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectSubstitutions,
  listMcpServers,
  mcpTransport,
  stripJsonComments
} from "./mcp-inventory.mjs";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp-inventory/", import.meta.url));

async function tempProject(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [relative, content] of Object.entries(files ?? {})) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
  }
  return root;
}

function byName(report) {
  return Object.fromEntries(report.servers.map((server) => [server.name, server]));
}

test("reads every client's config in the fixture project and reports one entry per server", async () => {
  const report = await listMcpServers({ projectRoot: FIXTURE, env: { AI_DEV_VAULT_ROOT: "/vault" } });
  assert.equal(report.summary.sources_present, 6, ".claude/settings.local.json is the one that is absent");
  assert.equal(report.summary.sources_read, 6);
  assert.equal(report.user_scope, false);
  assert.deepEqual(report.servers.map((server) => server.name), ["ai-dev", "design-docs", "half-configured", "jira", "legacy-notes", "sqlite"]);
  assert.deepEqual(report.summary.transports, { stdio: 3, http: 1, unknown: 1, sse: 1 });
  assert.equal(report.summary.block, 0, "the fixture carries no credential in cleartext");

  const servers = byName(report);
  assert.deepEqual(servers["ai-dev"].origins.map((origin) => origin.path), [".mcp.json", ".cursor/mcp.json", ".codex/config.toml"]);
  assert.deepEqual(servers["ai-dev"].env_var_names, ["AI_DEV_VAULT_ROOT", "AI_DEV_LOG"]);
  assert.deepEqual(servers["ai-dev"].substitutions, [{ location: "env.AI_DEV_VAULT_ROOT", kind: "env", variable: "AI_DEV_VAULT_ROOT", set: true }]);
  assert.deepEqual(servers["ai-dev"].findings.map((finding) => finding.id), ["unpinned_remote_package", "conflicting_definitions"]);

  assert.equal(servers["design-docs"].transport, "http");
  assert.deepEqual(servers["design-docs"].substitutions, [{ location: "headers.Authorization", kind: "env", variable: "DOCS_TOKEN", set: false }]);
  assert.deepEqual(servers["design-docs"].findings, [], "a token referenced through the environment is what right looks like");

  assert.equal(servers["legacy-notes"].transport, "sse");
  assert.deepEqual(servers["legacy-notes"].findings.map((finding) => finding.id), ["insecure_url"]);
  assert.deepEqual(servers["half-configured"].findings.map((finding) => finding.id), ["unknown_transport"]);
  assert.deepEqual(servers.sqlite.findings.map((finding) => finding.id), ["shell_wrapped"]);
  assert.deepEqual(servers.jira.substitutions.map((item) => `${item.kind}:${item.variable}`), ["input:jira-token", "editor:workspaceFolder"]);

  const cursor = report.sources.find((source) => source.path === ".cursor/mcp.json");
  assert.equal(cursor.readable, true);
  assert.match(cursor.warnings[0], /JSON with comments/);
  assert.equal(report.findings.at(-1).id, "config_parse_warning", "info findings sort last");
});

test("Claude Code's approval lists say which servers start without asking", async () => {
  const report = await listMcpServers({ projectRoot: FIXTURE, env: {} });
  const servers = byName(report);
  assert.equal(servers["ai-dev"].approval, "enabled");
  assert.equal(servers["legacy-notes"].approval, "disabled");
  assert.equal(servers["design-docs"].approval, "prompt");
  assert.equal(servers.jira.approval, null, "a server Claude Code never reads has no approval state");
});

test("enableAllProjectMcpServers is a finding of its own, and local settings are read too", async (t) => {
  const root = await tempProject(t, {
    ".mcp.json": { mcpServers: { notes: { command: "node", args: ["notes.mjs"] } } },
    ".claude/settings.json": { disabledMcpjsonServers: ["notes"] },
    ".claude/settings.local.json": { enableAllProjectMcpServers: true }
  });
  const report = await listMcpServers({ projectRoot: root, env: {} });
  assert.equal(byName(report).notes.approval, "disabled", "an explicit disable wins over enable-all");
  const finding = report.findings.find((item) => item.id === "project_servers_auto_approved");
  assert.equal(finding.severity, "warn");
  assert.equal(report.sources.filter((source) => source.exists).length, 3);
});

test("a credential written into a config file is a block finding, masked", async (t) => {
  // Built by concatenation so no token-shaped literal is committed anywhere.
  const githubToken = `ghp_${"A1b2C3d4E5".repeat(4)}`;
  const apiKey = "kx7-live-9f3c2b81aa04";
  const root = await tempProject(t, {
    ".mcp.json": {
      mcpServers: {
        github: { command: "node", args: ["gh.mjs"], env: { GITHUB_TOKEN: githubToken, GITHUB_HOST: "github.com" } },
        billing: { type: "http", url: "https://billing.example.com/mcp", headers: { "X-Api-Key": apiKey } },
        cli: { command: "billing-mcp", args: [`--api-key=${apiKey}`, "--verbose"] },
        webhook: { type: "http", url: `https://hooks.example.com/mcp?access_token=${apiKey}&team=core` }
      }
    }
  });
  const report = await listMcpServers({ projectRoot: root, env: {} });
  assert.equal(report.summary.block, 5);
  const servers = byName(report);
  assert.deepEqual(servers.github.findings.map((finding) => finding.id).sort(), ["plaintext_secret", "secret_github_token"]);
  assert.deepEqual(servers.billing.findings.map((finding) => finding.id), ["plaintext_secret"]);
  assert.equal(servers.billing.findings[0].location, "headers.X-Api-Key");
  assert.equal(servers.cli.findings[0].location, "args[0] (api-key)", "a credential on the command line is read as one too");
  assert.equal(servers.webhook.findings[0].location, "url?access_token", "a credential in the query string is read as one too");
  assert.equal(servers.webhook.url, "https://hooks.example.com/mcp?access_token=kx7…04 (21 chars)&team=core");

  const reported = JSON.stringify(report);
  assert.equal(reported.includes(githubToken), false, "the report never repeats the secret");
  assert.equal(reported.includes(apiKey), false);
  assert.match(servers.billing.findings[0].masked, /^kx7…04 \(21 chars\)$/);
  assert.equal(servers.cli.args[0], "--api-key=kx7…04 (21 chars)", "the command line is echoed with the credential masked out");
});

test("a package that is not pinned is named the way the command line names it", async (t) => {
  const root = await tempProject(t, {
    ".mcp.json": {
      mcpServers: {
        pinned: { command: "npx", args: ["-y", "mcp-server-git@1.4.0"] },
        loose: { command: "uvx", args: ["mcp-server-fetch"] },
        viaPipx: { command: "pipx", args: ["run", "mcp-server-time"] }
      }
    }
  });
  const report = await listMcpServers({ projectRoot: root, env: {} });
  const servers = byName(report);
  assert.deepEqual(servers.pinned.findings, []);
  assert.match(servers.loose.findings[0].message, /^uvx mcp-server-fetch fetches/);
  assert.match(servers.viaPipx.findings[0].message, /^pipx mcp-server-time fetches/);
});

test("a value that only looks like a credential is not one", async (t) => {
  const root = await tempProject(t, {
    ".mcp.json": {
      mcpServers: {
        quiet: {
          command: "node",
          args: ["server.mjs"],
          env: {
            API_KEY: "${API_KEY}",
            SSH_KEY_PATH: "/home/dev/.ssh/id_ed25519",
            TOKEN_FILE: "./secrets/token",
            AUTH_ENABLED: "true",
            PASSWORD: "<changeme>",
            SESSION_SECRET: "changeme",
            LOG_LEVEL: "debug"
          }
        }
      }
    }
  });
  const report = await listMcpServers({ projectRoot: root, env: { API_KEY: "set" } });
  assert.deepEqual(byName(report).quiet.findings, []);
  assert.equal(report.summary.block, 0);
});

test("user-scope configs are read only when asked, including the per-project block of ~/.claude.json", async (t) => {
  const root = await tempProject(t, { ".mcp.json": { mcpServers: { local: { command: "node", args: ["local.mjs"] } } } });
  const home = await tempProject(t, {
    ".claude.json": { mcpServers: { global: { command: "node", args: ["global.mjs"] } }, projects: { [root]: { mcpServers: { "for-this-project": { type: "http", url: "https://tools.example.com/mcp" } } } } },
    ".codex/config.toml": "[mcp_servers.codex-only]\ncommand = \"node\"\nargs = [\"codex.mjs\"]\n"
  });

  const project = await listMcpServers({ projectRoot: root, homeDir: home, env: {} });
  assert.deepEqual(project.servers.map((server) => server.name), ["local"]);
  assert.equal(project.user_scope, false);

  const withUser = await listMcpServers({ projectRoot: root, homeDir: home, env: {}, includeUserScope: true });
  assert.equal(withUser.user_scope, true);
  assert.deepEqual(withUser.servers.map((server) => server.name), ["codex-only", "for-this-project", "global", "local"]);
  assert.deepEqual(
    withUser.servers.find((server) => server.name === "for-this-project").origins.map((origin) => origin.scope),
    ["user-project"]
  );
  assert.equal(withUser.servers.find((server) => server.name === "global").origins[0].path, path.join(home, ".claude.json").replaceAll("\\", "/"));
});

test("a config that cannot be read is reported as a gap in the report, not as an empty project", async (t) => {
  const root = await tempProject(t, {
    ".mcp.json": "{ \"mcpServers\": { \"broken\": ",
    ".cursor/mcp.json": { mcpServers: { works: { command: "node", args: ["ok.mjs"] } } }
  });
  const report = await listMcpServers({ projectRoot: root, env: {} });
  assert.deepEqual(report.servers.map((server) => server.name), ["works"]);
  const source = report.sources.find((item) => item.path === ".mcp.json");
  assert.equal(source.exists, true);
  assert.equal(source.readable, false);
  assert.match(source.error, /not valid JSON/);
  const finding = report.findings.find((item) => item.id === "unreadable_config");
  assert.equal(finding.severity, "warn");
  assert.match(finding.message, /missing from this report/);

  // Not only bad JSON: anything the file system refuses to hand over.
  const blocked = await tempProject(t, {});
  await fs.mkdir(path.join(blocked, ".mcp.json"));
  const second = await listMcpServers({ projectRoot: blocked, env: {} });
  const directory = second.sources.find((item) => item.path === ".mcp.json");
  assert.equal(directory.exists, true);
  assert.equal(directory.readable, false);
  assert.ok(directory.error.length > 0);
});

test("a project with no MCP configuration at all reports nothing rather than failing", async (t) => {
  const root = await tempProject(t, {});
  const report = await listMcpServers({ projectRoot: root, env: {} });
  assert.deepEqual(report.servers, []);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.sources_present, 0);
  assert.deepEqual(report.summary.transports, {});
});

test("transports, substitutions and JSON-with-comments are read the way the clients read them", () => {
  assert.equal(mcpTransport({ command: "node" }), "stdio");
  assert.equal(mcpTransport({ type: "streamable-http", url: "https://x/mcp" }), "http");
  assert.equal(mcpTransport({ url: "https://x/mcp/sse" }), "sse");
  assert.equal(mcpTransport({ url: "https://x/sse?token=1" }), "sse");
  assert.equal(mcpTransport({ url: "https://x/mcp" }), "http");
  assert.equal(mcpTransport({ transport: "ws", url: "wss://x" }), "websocket");
  assert.equal(mcpTransport({}), "unknown");

  assert.deepEqual(collectSubstitutions("${TOKEN}"), [{ raw: "${TOKEN}", kind: "env", variable: "TOKEN" }]);
  assert.deepEqual(collectSubstitutions("${env:TOKEN}").map((item) => item.variable), ["TOKEN"]);
  assert.deepEqual(collectSubstitutions("${TOKEN:-fallback}").map((item) => item.variable), ["TOKEN"]);
  assert.deepEqual(collectSubstitutions("$HOME/bin:$PATH").map((item) => item.variable), ["HOME", "PATH"]);
  assert.deepEqual(collectSubstitutions("${input:pat}").map((item) => item.kind), ["input"]);
  assert.deepEqual(collectSubstitutions("${workspaceFolder}").map((item) => item.kind), ["editor"]);
  assert.deepEqual(collectSubstitutions("${weird thing}").map((item) => item.kind), ["unknown"]);
  assert.deepEqual(collectSubstitutions("nothing here"), []);

  assert.equal(stripJsonComments("{\"a\": \"http://x//y\" /* note */, \"b\": 1,}").trim(), "{\"a\": \"http://x//y\" , \"b\": 1}");
  assert.equal(JSON.parse(stripJsonComments("{\n// lead\n\"a\": \"it \\\" // still a string\"\n}")).a, "it \" // still a string");
  assert.equal(stripJsonComments("{\"a\": 1 /* unterminated").includes("unterminated"), false);
});


// Д-17. `~/.claude.json` declares the user's MCP servers and, in the same file,
// keeps Claude Code's conversation history for every project it has opened.
// Parsing it whole to reach two keys is the wrong amount of work; the file is
// streamed and only those two keys are kept.
test("a huge ~/.claude.json is read key by key, not parsed whole", async (t) => {
  const root = await tempProject(t, {});
  const home = await tempProject(t, {});
  const claudeJson = {
    numStartups: 200,
    mcpServers: { global: { command: "node", args: ["global.mjs"] } },
    projects: {
      [root]: {
        mcpServers: { "for-this-project": { type: "http", url: "https://tools.example.invalid/mcp" } },
        history: Array.from({ length: 12_000 }, (_, index) => ({ display: `turn ${index}: {"looks":"like json"} and a "quote"`, pastedContents: {} }))
      },
      "/home/someone/else": {
        mcpServers: { "another-project": { command: "node", args: ["other.mjs"] } },
        history: Array.from({ length: 12_000 }, (_, index) => ({ display: `other ${index}` }))
      }
    }
  };
  const text = JSON.stringify(claudeJson, null, 2);
  assert.ok(text.length > 2_000_000, `expected a large fixture, got ${text.length} bytes`);
  await fs.writeFile(path.join(home, ".claude.json"), text, "utf8");

  const report = await listMcpServers({ projectRoot: root, homeDir: home, env: {}, includeUserScope: true });
  assert.deepEqual(report.servers.map((server) => server.name).sort(), ["for-this-project", "global"]);
  assert.equal(
    report.servers.some((server) => server.name === "another-project"),
    false,
    "another project's user-scope block is not this project's, and is never even buffered"
  );
  const source = report.sources.find((item) => item.path.endsWith(".claude.json"));
  assert.equal(source.readable, true);
  assert.equal(source.server_count, 2);
  // The cost is named rather than hidden: the report says how much was streamed.
  assert.ok(source.warnings.some((warning) => /MB streamed to read 2 key\(s\)/.test(warning)), JSON.stringify(source.warnings));
  assert.ok(report.findings.some((item) => item.id === "config_parse_warning" && /MB streamed/.test(item.message)));
});

test("a ~/.claude.json that is not a JSON object is reported, not read as empty", async (t) => {
  const root = await tempProject(t, {});
  const home = await tempProject(t, {});
  await fs.writeFile(path.join(home, ".claude.json"), "not json at all\n", "utf8");
  const report = await listMcpServers({ projectRoot: root, homeDir: home, env: {}, includeUserScope: true });
  const source = report.sources.find((item) => item.path.endsWith(".claude.json"));
  assert.equal(source.readable, false);
  assert.match(source.error, /the document starts with "n", not an object/);
  assert.ok(report.findings.some((item) => item.id === "unreadable_config"));

  // A file with no servers in it is readable and empty, which is not a finding.
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 3, tipsHistory: {} }), "utf8");
  const quiet = await listMcpServers({ projectRoot: root, homeDir: home, env: {}, includeUserScope: true });
  const quietSource = quiet.sources.find((item) => item.path.endsWith(".claude.json"));
  assert.equal(quietSource.readable, true);
  assert.equal(quietSource.server_count, 0);
  assert.deepEqual(quietSource.warnings, []);
});
