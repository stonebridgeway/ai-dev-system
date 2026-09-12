import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClientServerConfig,
  mergeClientDocument,
  portablePaths
} from "./install-local-mcp-clients.mjs";

const paths = {
  nodeExecutable: "C:\\runtime\\node.exe",
  serverPath: "C:\\vault\\server.mjs",
  linkedVaultRoot: "C:\\vault",
  pythonExecutable: "C:\\runtime\\python.exe"
};

test("client config uses stdio and shared local paths", () => {
  const vscode = buildClientServerConfig("vscode", paths);
  const gemini = buildClientServerConfig("gemini", paths);
  assert.equal(vscode.type, "stdio");
  assert.equal(gemini.type, undefined);
  assert.equal(vscode.command, paths.nodeExecutable);
  assert.deepEqual(vscode.args, [paths.serverPath]);
  assert.equal(vscode.env.AI_DEV_VAULT_ROOT, paths.linkedVaultRoot);
});

test("a checkout without a vault registers its own server and no vault root", (t) => {
  // The layout a new user has: this repository, cloned, and nothing else. The
  // server path used to be computed as `<vault>/09-mcp/ai-dev-mcp-server/…`,
  // which resolved to `<home>/09-mcp/…` and made `npm run clients:install` —
  // the one command the README gives — refuse to install anything.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-clients-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const resolved = portablePaths({ home: empty, vaultRoot: "" });
  const serverHere = path.resolve(fileURLToPath(new URL("../src/server.mjs", import.meta.url)));
  assert.equal(resolved.serverPath, serverHere);
  assert.ok(fs.existsSync(resolved.serverPath), "the entrypoint it registers has to exist");
  assert.equal(resolved.linkedVaultRoot, "");
  const config = buildClientServerConfig("claude", resolved);
  assert.deepEqual(config.args, [serverHere]);
  assert.equal("AI_DEV_VAULT_ROOT" in config.env, false, "no vault means no guess at one");
  assert.ok(config.env.AI_DEV_PYTHON);
});

test("a vault install keeps the vault's own copy of the server", (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const inVault = path.join(vault, "09-mcp", "ai-dev-mcp-server", "src");
  fs.mkdirSync(inVault, { recursive: true });
  fs.writeFileSync(path.join(inVault, "server.mjs"), "// vault copy\n");
  const resolved = portablePaths({ home: vault, vaultRoot: vault });
  assert.equal(resolved.serverPath, path.join(inVault, "server.mjs"));
  assert.equal(buildClientServerConfig("claude", resolved).env.AI_DEV_VAULT_ROOT, vault);
});

test("client document merge preserves existing servers", () => {
  const current = {
    mcpServers: {
      existing: { command: "existing.exe" }
    },
    unrelated: true
  };
  const merged = mergeClientDocument(
    "cursor",
    current,
    buildClientServerConfig("cursor", paths)
  );
  assert.equal(merged.unrelated, true);
  assert.equal(merged.mcpServers.existing.command, "existing.exe");
  assert.equal(merged.mcpServers["ai-dev-system"].command, paths.nodeExecutable);
});

test("VS Code uses its native servers root", () => {
  const merged = mergeClientDocument(
    "vscode",
    { inputs: [] },
    buildClientServerConfig("vscode", paths)
  );
  assert.deepEqual(merged.inputs, []);
  assert.equal(merged.servers["ai-dev-system"].type, "stdio");
});
