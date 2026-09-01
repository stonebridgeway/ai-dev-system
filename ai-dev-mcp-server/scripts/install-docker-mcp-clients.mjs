#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../src/core/direct-execution.mjs";

export const SUPPORTED_DOCKER_CLIENTS = new Set(["codex", "cursor", "gemini", "vscode", "claude"]);

function parseArgs(argv) {
  const options = { apply: false, clients: [...SUPPORTED_DOCKER_CLIENTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (["--clients", "--launcher", "--launcher-env", "--claude-launcher", "--runtime-container", "--image", "--project-path", "--home", "--app-data", "--platform"].includes(argument)) {
      options[argument.slice(2).replaceAll("-", "_")] = String(argv[index + 1] || "");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  options.clients = String(options.clients || "")
    .split(",")
    .map((client) => client.trim().toLowerCase())
    .filter(Boolean);
  const unsupported = options.clients.filter((client) => !SUPPORTED_DOCKER_CLIENTS.has(client));
  if (unsupported.length) throw new Error(`Unsupported clients: ${unsupported.join(", ")}`);
  for (const key of ["image", "project_path"]) {
    if (!options[key] && !options.help) throw new Error(`Missing required argument: --${key.replaceAll("_", "-")}`);
  }
  if (!options.launcher && !options.launcher_env && !options.help) {
    throw new Error("Missing required argument: --launcher or --launcher-env");
  }
  return options;
}

export function resolveLauncher(options, platform = process.platform) {
  const source = options.launcher || (options.launcher_env ? process.env[options.launcher_env] : "");
  if (!source) throw new Error("Docker launcher path is empty.");
  return (platform === "win32" ? path.win32 : path.posix).resolve(source);
}

export function localPaths({
  home = os.homedir(),
  appData,
  platform = process.platform
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolvedAppData = appData || (platform === "darwin"
    ? pathApi.join(home, "Library", "Application Support")
    : platform === "win32"
      ? process.env.APPDATA || pathApi.join(home, "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || pathApi.join(home, ".config"));
  return {
    home,
    appData: resolvedAppData,
    codex: pathApi.join(home, ".codex", "config.toml"),
    cursor: pathApi.join(home, ".cursor", "mcp.json"),
    gemini: pathApi.join(home, ".gemini", "settings.json"),
    vscode: pathApi.join(resolvedAppData, "Code", "User", "mcp.json"),
    claude: pathApi.join(home, ".claude.json"),
    claudeDesktop: pathApi.join(resolvedAppData, "Claude", "claude_desktop_config.json")
  };
}

export function clientInstallTargets(client, paths) {
  if (client === "claude") {
    return [
      { client: "claude-code", target: paths.claude },
      { client: "claude-desktop", target: paths.claudeDesktop }
    ];
  }
  return [{ client, target: paths[client] }];
}

export function windowsClaudeDesktopStoreConfigPath(packageRoot) {
  return path.win32.join(packageRoot, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
}

async function installedWindowsClaudeDesktopTargets(platform) {
  if (platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const packagesRoot = path.win32.join(process.env.LOCALAPPDATA, "Packages");
  let packages;
  try {
    packages = await fs.readdir(packagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets = [];
  for (const entry of packages) {
    if (!entry.isDirectory() || !entry.name.startsWith("Claude_")) continue;
    const target = windowsClaudeDesktopStoreConfigPath(path.win32.join(packagesRoot, entry.name));
    try {
      await fs.access(target);
      targets.push({ client: "claude-desktop-msix", target });
    } catch {
      // An installed MSIX Claude profile may not exist until its first launch.
    }
  }
  return targets;
}

async function localClientInstallTargets(client, paths, platform) {
  const targets = [...clientInstallTargets(client, paths)];
  if (client === "claude") targets.push(...await installedWindowsClaudeDesktopTargets(platform));
  const seen = new Set();
  return targets.filter(({ target }) => {
    const identity = platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function buildDockerClientServerConfig(client, {
  launcher,
  claudeLauncher,
  runtimeContainer,
  image,
  projectPath,
  platform = process.platform
}) {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const resolvedLauncher = pathApi.resolve(
    client === "claude" && windows && claudeLauncher ? claudeLauncher : launcher
  );
  const launcherIsAscii = /^[\x00-\x7F]+$/.test(resolvedLauncher);
  const launcherIsExecutable = windows && pathApi.extname(resolvedLauncher).toLowerCase() === ".exe";
  const config = {
    command: launcherIsExecutable ? resolvedLauncher : windows ? "powershell.exe" : "/bin/sh",
    args: launcherIsExecutable
      ? []
      : windows
      ? launcherIsAscii
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedLauncher]
        : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& $env:AI_DEV_MCP_LAUNCHER"]
      : [resolvedLauncher],
    env: {
      AI_DEV_IMAGE: image,
      AI_DEV_PROJECT_PATH: pathApi.resolve(projectPath),
      ...(windows ? { AI_DEV_MCP_LAUNCHER: resolvedLauncher } : {}),
      ...(!windows && runtimeContainer ? { AI_DEV_RUNTIME_CONTAINER: runtimeContainer } : {})
    }
  };
  return client === "vscode" ? { type: "stdio", ...config } : config;
}

export function mergeDockerClientDocument(client, current, serverConfig) {
  const document = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  const key = client === "vscode" ? "servers" : "mcpServers";
  document[key] = {
    ...(document[key] && typeof document[key] === "object" ? document[key] : {}),
    "ai-dev": serverConfig
  };
  return document;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function buildCodexMcpSection(serverConfig, eol = "\n") {
  const args = serverConfig.args.map(tomlString).join(", ");
  const env = Object.entries(serverConfig.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ");
  return [
    "[mcp_servers.ai-dev]",
    `command = ${tomlString(serverConfig.command)}`,
    `args = [${args}]`,
    `env = { ${env} }`,
    "startup_timeout_sec = 120",
    "tool_timeout_sec = 3600"
  ].join(eol);
}

export function mergeCodexDocument(current, serverConfig) {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const section = buildCodexMcpSection(serverConfig, eol);
  const header = /^\[mcp_servers\.ai-dev\]\s*$/m;
  const match = header.exec(current);
  if (!match) return `${current.trimEnd()}${current.trim() ? `${eol}${eol}` : ""}${section}${eol}`;
  const following = /^\[[^\r\n]+\]\s*$/gm;
  following.lastIndex = match.index + match[0].length;
  const next = following.exec(current);
  const end = next ? next.index : current.length;
  return `${current.slice(0, match.index)}${section}${eol}${current.slice(end)}`;
}

async function readJsonDocument(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot parse ${target}: ${error.message}`);
  }
}

async function readTextDocument(target) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function backupSuffix() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

async function writeWithBackup(target, next, apply) {
  const current = await readTextDocument(target);
  if (current === next) return { status: "current", backup: null };
  if (!apply) return { status: "would-update", backup: null };
  await fs.mkdir(path.dirname(target), { recursive: true });
  let backup = null;
  if (current) {
    backup = `${target}.backup-${backupSuffix()}`;
    await fs.copyFile(target, backup);
  }
  await fs.writeFile(target, next, "utf8");
  return { status: "updated", backup };
}

async function installDockerClient(client, target, options, resultClient = client) {
  const config = buildDockerClientServerConfig(client, options);
  if (client === "codex") {
    const next = mergeCodexDocument(await readTextDocument(target), config);
    return { client: resultClient, target, ...(await writeWithBackup(target, next, options.apply)) };
  }
  const current = await readJsonDocument(target);
  const next = `${JSON.stringify(mergeDockerClientDocument(client, current, config), null, 2)}\n`;
  return { client: resultClient, target, ...(await writeWithBackup(target, next, options.apply)) };
}

export async function installDockerMcpClients(options) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const launcher = resolveLauncher(options, platform);
  const claudeLauncher = options.claude_launcher ? pathApi.resolve(options.claude_launcher) : undefined;
  const projectPath = pathApi.resolve(options.project_path || options.projectPath);
  try {
    await fs.access(launcher);
  } catch {
    throw new Error(`Docker launcher is missing: ${launcher}`);
  }
  if (claudeLauncher) {
    try {
      await fs.access(claudeLauncher);
    } catch {
      throw new Error(`Claude MCP launcher is missing: ${claudeLauncher}`);
    }
  }
  const paths = localPaths({ ...options, appData: options.app_data || options.appData });
  const runtimeContainer = options.runtime_container || options.runtimeContainer;
  const normalized = { ...options, launcher, claudeLauncher, runtimeContainer, projectPath, platform };
  const clients = options.clients || [...SUPPORTED_DOCKER_CLIENTS];
  const results = [];
  for (const client of clients) {
    for (const destination of await localClientInstallTargets(client, paths, platform)) {
      results.push(await installDockerClient(client, destination.target, normalized, destination.client));
    }
  }
  return { status: options.apply ? "applied" : "dry-run", transport: "docker-stdio", clients: results };
}

function usage() {
  return [
    "Install the Docker AI Dev MCP launcher for local AI clients.",
    "",
    "Usage:",
    "  node scripts/install-docker-mcp-clients.mjs --apply --launcher <run-mcp> --image <image> --project-path <folder> [--runtime-container <name>] [--clients codex,cursor,gemini,vscode,claude]"
  ].join("\n");
}

if (await isDirectExecution(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.stdout.write(options.help ? `${usage()}\n` : `${JSON.stringify(await installDockerMcpClients(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
