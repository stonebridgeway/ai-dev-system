import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSafeCommand, validateProjectExecutable } from "./command-policy.mjs";

const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const PACKAGE_MANAGER_ENTRYPOINTS = Object.freeze({
  npm: ["node_modules/npm/bin/npm-cli.js", "node/node_modules/npm/bin/npm-cli.js"],
  pnpm: [
    "node_modules/pnpm/bin/pnpm.mjs",
    "node_modules/pnpm/bin/pnpm.cjs",
    "node/node_modules/pnpm/bin/pnpm.mjs",
    "node/node_modules/pnpm/bin/pnpm.cjs"
  ],
  yarn: ["node_modules/yarn/bin/yarn.js", "node/node_modules/yarn/bin/yarn.js"]
});

async function fileExists(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function findExecutableOnPath(executable) {
  if (path.isAbsolute(executable)) return executable;
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd"]
    : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, executable.toLowerCase().endsWith(extension) ? executable : `${executable}${extension}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return "";
}

function ancestorDirectories(start, levels = 5) {
  const output = [];
  let current = path.resolve(start);
  for (let index = 0; index < levels; index += 1) {
    output.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return output;
}

async function findPackageManagerEntrypoint(manager, roots) {
  for (const root of roots) {
    for (const relativeEntry of PACKAGE_MANAGER_ENTRYPOINTS[manager]) {
      const entrypoint = path.resolve(root, relativeEntry);
      if (await fileExists(entrypoint)) return entrypoint;
    }
  }
  return "";
}

export async function resolveSpawnInvocation(executable, args = []) {
  if (process.platform !== "win32") return { executable, args, adapter: "direct" };
  const manager = path.basename(executable).toLowerCase().replace(/\.(?:cmd|exe)$/, "");
  if (manager === "node" && !path.isAbsolute(executable)) {
    return { executable: process.execPath, args, adapter: "current-node-runtime" };
  }
  if (!Object.hasOwn(PACKAGE_MANAGER_ENTRYPOINTS, manager)) {
    return { executable, args, adapter: "direct" };
  }
  const resolved = await findExecutableOnPath(executable);
  if (resolved.toLowerCase().endsWith(".exe")) {
    return { executable: resolved, args, adapter: "package-manager-executable" };
  }
  const roots = new Set([
    ...ancestorDirectories(path.dirname(resolved || executable)),
    ...ancestorDirectories(path.dirname(process.execPath))
  ]);
  const entrypoint = await findPackageManagerEntrypoint(manager, roots);
  if (entrypoint) {
    return {
      executable: process.execPath,
      args: [entrypoint, ...args],
      adapter: `${manager}-node-entrypoint`,
      packageManagerEntrypoint: entrypoint
    };
  }
  if (manager === "npm") {
    const pnpmEntrypoint = await findPackageManagerEntrypoint("pnpm", roots);
    if (pnpmEntrypoint) {
      return {
        executable: process.execPath,
        args: [pnpmEntrypoint, ...args],
        adapter: "npm-via-pnpm-node-entrypoint",
        packageManagerEntrypoint: pnpmEntrypoint
      };
    }
  }
  throw new Error(`Could not resolve a shell-free ${manager} entrypoint from PATH or the bundled runtime.`);
}

async function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function collectBounded(target, chunk, state, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, maxBytes - state.bytes);
  if (remaining > 0) target.push(buffer.subarray(0, remaining));
  state.bytes += buffer.length;
  if (state.bytes > maxBytes) state.truncated = true;
}

export function buildSpawnEnvironment(invocation, extraEnv = {}) {
  const environment = { ...process.env, ...extraEnv };
  const extraPathKey = Object.keys(extraEnv).find((key) => key.toLowerCase() === "path");
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const currentPath = String(
    (extraPathKey ? extraEnv[extraPathKey] : process.env[inheritedPathKey]) || ""
  );
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.PATH = [
    path.dirname(process.execPath),
    currentPath
  ].filter(Boolean).join(path.delimiter);
  if (String(invocation?.adapter || "").includes("pnpm")) {
    environment.pnpm_config_verify_deps_before_run = "false";
  }
  return environment;
}

export async function runProcess({
  executable,
  args = [],
  cwd,
  timeoutMs = 120_000,
  maxOutputBytes = DEFAULT_OUTPUT_LIMIT,
  env = {}
}) {
  const startedAt = Date.now();
  const stdout = [];
  const stderr = [];
  const outputState = { bytes: 0, truncated: false };
  let timedOut = false;
  const invocation = await resolveSpawnInvocation(executable, args);
  const child = spawn(invocation.executable, invocation.args, {
    cwd: path.resolve(cwd),
    env: buildSpawnEnvironment(invocation, env),
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => collectBounded(stdout, chunk, outputState, maxOutputBytes));
  child.stderr.on("data", (chunk) => collectBounded(stderr, chunk, outputState, maxOutputBytes));

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child).catch(() => undefined);
  }, Math.max(1, timeoutMs));
  timeout.unref?.();

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => clearTimeout(timeout));

  return {
    ...result,
    invocation,
    ok: !timedOut && result.exitCode === 0,
    timedOut,
    truncated: outputState.truncated,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    durationMs: Date.now() - startedAt
  };
}

export async function runPolicyCommand({
  command,
  projectRoot,
  purpose = "quality",
  timeoutMs,
  maxOutputBytes,
  env
}) {
  const parsed = validateProjectExecutable(
    parseSafeCommand(command, { purpose }),
    projectRoot
  );
  const result = await runProcess({
    executable: parsed.executable,
    args: parsed.args,
    cwd: projectRoot,
    timeoutMs,
    maxOutputBytes,
    env
  });
  return { command: parsed, ...result };
}
