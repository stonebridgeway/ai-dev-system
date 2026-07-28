#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../src/core/direct-execution.mjs";

const SUPPORTED_CLIENTS = new Set(["cursor", "gemini", "vscode", "claude"]);

function parseArgs(argv) {
  const options = { apply: false, clients: [...SUPPORTED_CLIENTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--clients") {
      options.clients = String(argv[index + 1] || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const unsupported = options.clients.filter((client) => !SUPPORTED_CLIENTS.has(client));
  if (unsupported.length) throw new Error(`Unsupported clients: ${unsupported.join(", ")}`);
  return options;
}

function portablePaths({
  home = os.homedir(),
  appData = process.env.APPDATA || path.join(home, "AppData", "Roaming"),
  nodeExecutable = process.execPath
} = {}) {
  const linkedVaultRoot = path.join(home, ".codex", "links", "ai-dev-system");
  const serverPath = path.join(
    linkedVaultRoot,
    "09-mcp",
    "ai-dev-mcp-server",
    "src",
    "server.mjs"
  );
  const pythonExecutable = path.resolve(
    path.dirname(nodeExecutable),
    "..",
    "..",
    "python",
    process.platform === "win32" ? "python.exe" : "bin/python"
  );
  return {
    home,
    appData,
    linkedVaultRoot,
    serverPath,
    nodeExecutable,
    pythonExecutable
  };
}

export function buildClientServerConfig(client, paths = portablePaths()) {
  const config = {
    command: paths.nodeExecutable,
    args: [paths.serverPath],
    env: {
      AI_DEV_VAULT_ROOT: paths.linkedVaultRoot,
      AI_DEV_PYTHON: paths.pythonExecutable
    }
  };
  return ["vscode", "claude"].includes(client)
    ? { type: "stdio", ...config }
    : config;
}

export function mergeClientDocument(client, current, serverConfig) {
  const document = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  const key = client === "vscode" ? "servers" : "mcpServers";
  document[key] = {
    ...(document[key] && typeof document[key] === "object" ? document[key] : {}),
    "ai-dev-system": serverConfig
  };
  return document;
}

function clientTargets(paths) {
  return {
    cursor: path.join(paths.home, ".cursor", "mcp.json"),
    gemini: path.join(paths.home, ".gemini", "settings.json"),
    vscode: path.join(paths.appData, "Code", "User", "mcp.json"),
    claude: path.join(paths.home, ".claude.json")
  };
}

async function readJsonDocument(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot parse ${target}: ${error.message}`);
  }
}

function backupSuffix() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

async function installClient(client, target, paths, { apply }) {
  const current = await readJsonDocument(target);
  const next = mergeClientDocument(client, current, buildClientServerConfig(client, paths));
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (currentText === nextText) return { client, target, status: "current" };
  if (!apply) return { client, target, status: "would-update" };

  await fs.mkdir(path.dirname(target), { recursive: true });
  let backup = null;
  try {
    await fs.access(target);
    backup = `${target}.backup-${backupSuffix()}`;
    await fs.copyFile(target, backup);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(target, nextText, "utf8");
  return { client, target, status: "updated", backup };
}

export async function installLocalMcpClients(options = {}) {
  const paths = portablePaths(options);
  const targets = clientTargets(paths);
  const missing = [];
  for (const [label, candidate] of [
    ["Node.js", paths.nodeExecutable],
    ["MCP entrypoint", paths.serverPath],
    ["AI Dev vault link", paths.linkedVaultRoot]
  ]) {
    try {
      await fs.access(candidate);
    } catch {
      missing.push(`${label}: ${candidate}`);
    }
  }
  if (missing.length) throw new Error(`Required local paths are missing:\n${missing.join("\n")}`);

  const results = [];
  for (const client of options.clients || [...SUPPORTED_CLIENTS]) {
    results.push(await installClient(client, targets[client], paths, options));
  }
  return {
    status: options.apply ? "applied" : "dry-run",
    transport: "stdio",
    server: paths.serverPath,
    clients: results
  };
}

function usage() {
  return [
    "Install the local AI Dev MCP server for common AI clients.",
    "",
    "Usage:",
    "  node scripts/install-local-mcp-clients.mjs [--apply] [--clients cursor,gemini,vscode,claude]",
    "",
    "Without --apply the command only reports planned changes."
  ].join("\n");
}

if (await isDirectExecution(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(await installLocalMcpClients(options), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
