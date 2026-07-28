import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexMcpSection,
  buildDockerClientServerConfig,
  clientInstallTargets,
  localPaths,
  mergeCodexDocument,
  mergeDockerClientDocument,
  resolveLauncher,
  windowsClaudeDesktopStoreConfigPath
} from "./install-docker-mcp-clients.mjs";

const options = {
  launcher: "C:\\tools\\ai-dev\\docker\\run-mcp.ps1",
  image: "ai-dev-system:local",
  projectPath: "C:\\Dev"
};

test("Docker client configuration uses the local stdio launcher and project mount", () => {
  const vscode = buildDockerClientServerConfig("vscode", options);
  const cursor = buildDockerClientServerConfig("cursor", options);
  assert.equal(vscode.type, "stdio");
  assert.equal(cursor.type, undefined);
  assert.equal(cursor.command, "powershell.exe");
  assert.deepEqual(cursor.args, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    options.launcher
  ]);
  assert.equal(cursor.env.AI_DEV_IMAGE, options.image);
  assert.equal(cursor.env.AI_DEV_PROJECT_PATH, options.projectPath);
  assert.equal(cursor.env.AI_DEV_MCP_LAUNCHER, options.launcher);
});

test("Windows configurations preserve Unicode launchers through an environment variable", () => {
  const unicodeLauncher = "C:\\Users\\dev\\Документы\\ai-dev\\docker\\run-mcp.ps1";
  const config = buildDockerClientServerConfig("claude", {
    ...options,
    launcher: unicodeLauncher
  });
  assert.deepEqual(config.args, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "& $env:AI_DEV_MCP_LAUNCHER"
  ]);
  assert.equal(config.env.AI_DEV_MCP_LAUNCHER, unicodeLauncher);
});

test("Claude can use a dedicated fast-start executable", () => {
  const claudeLauncher = "C:\\ProgramData\\AI-Dev-System\\ClaudeMcpProxy.exe";
  const claude = buildDockerClientServerConfig("claude", { ...options, claudeLauncher });
  const cursor = buildDockerClientServerConfig("cursor", { ...options, claudeLauncher });
  assert.equal(claude.command, claudeLauncher);
  assert.deepEqual(claude.args, []);
  assert.equal(claude.env.AI_DEV_MCP_LAUNCHER, claudeLauncher);
  assert.equal(cursor.args.at(-1), options.launcher);
});

test("Docker JSON configuration preserves unrelated MCP servers", () => {
  const merged = mergeDockerClientDocument("cursor", {
    mcpServers: { existing: { command: "existing.exe" } },
    keep: true
  }, buildDockerClientServerConfig("cursor", options));
  assert.equal(merged.keep, true);
  assert.equal(merged.mcpServers.existing.command, "existing.exe");
  assert.equal(merged.mcpServers["ai-dev"].env.AI_DEV_PROJECT_PATH, options.projectPath);
});

test("Unix clients use the shell launcher and native configuration roots", () => {
  const config = buildDockerClientServerConfig("cursor", {
    launcher: "/opt/ai-dev/docker/run-mcp.sh",
    image: "ai-dev-system:local",
    projectPath: "/home/dev/Projects",
    runtimeContainer: "ai-dev-system-runtime-1000",
    platform: "darwin"
  });
  const macPaths = localPaths({ home: "/Users/dev", platform: "darwin" });
  const linuxPaths = localPaths({ home: "/home/dev", platform: "linux" });
  const customLinuxPaths = localPaths({
    home: "/home/dev",
    appData: "/tmp/xdg-config",
    platform: "linux"
  });
  assert.equal(config.command, "/bin/sh");
  assert.deepEqual(config.args, ["/opt/ai-dev/docker/run-mcp.sh"]);
  assert.equal(config.env.AI_DEV_RUNTIME_CONTAINER, "ai-dev-system-runtime-1000");
  assert.equal(macPaths.vscode, "/Users/dev/Library/Application Support/Code/User/mcp.json");
  assert.equal(linuxPaths.vscode, "/home/dev/.config/Code/User/mcp.json");
  assert.equal(customLinuxPaths.vscode, "/tmp/xdg-config/Code/User/mcp.json");
});

test("Unix configuration preserves cold docker-run fallback without a runtime container", () => {
  const config = buildDockerClientServerConfig("claude", {
    launcher: "/opt/ai-dev/docker/run-mcp.sh",
    image: "ai-dev-system:local",
    projectPath: "/home/dev/Projects",
    platform: "linux"
  });
  assert.equal(config.env.AI_DEV_RUNTIME_CONTAINER, undefined);
  assert.deepEqual(config.args, ["/opt/ai-dev/docker/run-mcp.sh"]);
});

test("Claude installs preserve separate Code and Desktop configuration targets", () => {
  const windowsPaths = localPaths({
    home: "C:\\Users\\dev",
    appData: "C:\\Users\\dev\\AppData\\Roaming",
    platform: "win32"
  });
  const targets = clientInstallTargets("claude", windowsPaths);
  assert.deepEqual(targets, [
    { client: "claude-code", target: "C:\\Users\\dev\\.claude.json" },
    {
      client: "claude-desktop",
      target: "C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json"
    }
  ]);
  const document = mergeDockerClientDocument("claude", {
    mcpServers: { existing: { command: "existing.exe" } }
  }, buildDockerClientServerConfig("claude", options));
  assert.equal(document.mcpServers.existing.command, "existing.exe");
  assert.equal(document.mcpServers["ai-dev"].command, "powershell.exe");
});

test("Launcher path can be read from an environment variable without losing Unicode", () => {
  const variable = "AI_DEV_TEST_LAUNCHER";
  const previous = process.env[variable];
  process.env[variable] = "C:\\Users\\dev\\Документы\\ai-dev\\docker\\run-mcp.ps1";
  try {
    assert.equal(
      resolveLauncher({ launcher_env: variable }, "win32"),
      "C:\\Users\\dev\\Документы\\ai-dev\\docker\\run-mcp.ps1"
    );
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("Microsoft Store Claude Desktop profile uses its isolated configuration path", () => {
  assert.equal(
    windowsClaudeDesktopStoreConfigPath("C:\\Users\\dev\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc"),
    "C:\\Users\\dev\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json"
  );
});

test("Codex configuration appends and replaces only the ai-dev MCP section", () => {
  const config = buildDockerClientServerConfig("codex", options);
  const initial = "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
  const once = mergeCodexDocument(initial, config);
  const twice = mergeCodexDocument(once, { ...config, env: { ...config.env, AI_DEV_IMAGE: "new-image" } });
  assert.match(once, new RegExp(buildCodexMcpSection(config).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(twice, /AI_DEV_IMAGE = "new-image"/);
  assert.equal((twice.match(/\[mcp_servers\.ai-dev\]/g) || []).length, 1);
  assert.match(twice, /\[mcp_servers\.other\]/);
});
