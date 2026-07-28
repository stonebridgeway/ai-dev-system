import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.resolve(scriptRoot, "..", "..", "docker", "run-mcp.sh");
const shell = process.env.AI_DEV_TEST_SH || (process.platform === "win32" ? "" : "/bin/sh");

function shellPath(value) {
  if (process.platform !== "win32") return value;
  return value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

if (!shell) {
  process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "POSIX shell unavailable" })}\n`);
  process.exit(0);
}

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-unix-launcher-"));
const dockerFixture = path.join(fixtureRoot, "docker");
const backendFixture = path.join(fixtureRoot, "backend.sh");

try {
  await fs.writeFile(dockerFixture, [
    "#!/bin/sh",
    "set -eu",
    "if [ \"$1\" != \"exec\" ]; then exit 64; fi",
    "exec sh \"$AI_DEV_FAKE_BACKEND\""
  ].join("\n") + "\n", { mode: 0o755 });
  await fs.writeFile(backendFixture, [
    "#!/bin/sh",
    "set -eu",
    "while IFS= read -r line; do",
    "  case \"$line\" in",
    "    *'\"method\":\"initialize\"'*)",
    "      printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"fake-backend\",\"version\":\"1\"}}}'",
    "      ;;",
    "    *'\"method\":\"tools/list\"'*)",
    "      printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"fixture_tool\",\"inputSchema\":{\"type\":\"object\"}}]}}'",
    "      ;;",
    "  esac",
    "done"
  ].join("\n") + "\n", { mode: 0o755 });
  await fs.chmod(dockerFixture, 0o755);
  await fs.chmod(backendFixture, 0o755);

  const startedAt = Date.now();
  const child = spawn(shell, [shellPath(launcher)], {
    env: {
      ...process.env,
      PATH: `${shellPath(fixtureRoot)}:${process.env.PATH || ""}`,
      AI_DEV_RUNTIME_CONTAINER: "fixture-runtime",
      AI_DEV_FAKE_BACKEND: shellPath(backendFixture)
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let stderr = "";
  let initializeMs;
  let toolCount;

  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Unix launcher smoke timed out.")), 5000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1 && initializeMs === undefined) {
          initializeMs = Date.now() - startedAt;
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {}
          })}\n`);
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {}
          })}\n`);
        } else if (message.id === 2) {
          toolCount = message.result?.tools?.length;
          child.stdin.end();
        }
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Unix launcher exited with ${code}: ${stderr.trim()}`));
      else resolve();
    });
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "unix-launcher-smoke", version: "1" }
    }
  })}\n`);

  await completed;
  assert.ok(initializeMs < 500, `initialize took ${initializeMs}ms`);
  assert.equal(toolCount, 1);
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    initialize_ms: initializeMs,
    forwarded_tools: toolCount
  }, null, 2)}\n`);
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
