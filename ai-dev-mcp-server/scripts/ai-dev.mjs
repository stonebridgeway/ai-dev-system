import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = String(process.argv[2] || "help").toLowerCase();
const arguments_ = process.argv.slice(3);

function printHelp() {
  console.log(`AI Dev System local CLI

Commands:
  start                 Start the stdio MCP server
  doctor                Run local system diagnostics
  dashboard             Regenerate the live Obsidian dashboard
  reindex               Rebuild text search while preserving dense vectors
  refresh [flags]       Refresh overlays, outcomes, search, runtime, and dashboard
  acceptance            Run the full local acceptance suite
  backup [label]        Create a local ZIP backup plus SHA-256
  distribution          Validate local/VPS distribution boundaries
`);
}

async function runPowerShell(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args
    ], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      shell: false
    });
    child.on("error", reject);
    child.on("exit", (code) => (
      code === 0 ? resolve() : reject(new Error(`PowerShell command exited with code ${code}.`))
    ));
  });
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "start") {
  await import("../src/server.mjs");
} else if (command === "acceptance") {
  await runPowerShell(path.resolve(root, "..", "scripts", "run-acceptance.ps1"));
} else if (command === "refresh") {
  process.argv.splice(2, process.argv.length - 2, ...arguments_);
  await import("./rebuild-live-state.mjs");
} else if (command === "backup") {
  await runPowerShell(
    path.resolve(root, "..", "scripts", "backup-ai-dev-system.ps1"),
    ["-Label", arguments_[0] || "cli"]
  );
} else {
  const { callTool, shutdownBgeWorkers } = await import("../src/mcp-stdio.mjs");
  try {
    let tool;
    let input;
    if (command === "doctor") {
      tool = "system_health_check";
      input = {
        include_search_smoke: true,
        include_dense_smoke: false,
        include_search_eval: false
      };
    } else if (command === "dashboard") {
      tool = "rebuild_system_dashboard";
      input = { rebuild_search: false };
    } else if (command === "reindex") {
      tool = "rebuild_search_index";
      input = {
        include_external_project_files: true,
        dense_embeddings: false,
        preserve_dense: true
      };
    } else if (command === "distribution") {
      tool = "runtime_distribution_status";
      input = {};
    } else {
      printHelp();
      process.exitCode = 1;
    }
    if (tool) {
      const result = await callTool(tool, input);
      console.log(result.content.find((item) => item.type === "text")?.text || "{}");
    }
  } finally {
    await shutdownBgeWorkers();
  }
}
