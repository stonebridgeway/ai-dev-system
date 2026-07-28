import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClientServerConfig,
  mergeClientDocument
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
