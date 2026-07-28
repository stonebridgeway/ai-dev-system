import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  callTool,
  shutdownBgeWorkers
} from "../src/mcp-stdio.mjs";

const vaultRoot = path.resolve(process.env.AI_DEV_VAULT_ROOT || "/data/ai-dev-system");

async function tool(name, arguments_ = {}) {
  const result = await callTool(name, arguments_);
  if (result?.isError) {
    throw new Error(`${name}: ${result.content?.[0]?.text || "tool failed"}`);
  }
}

try {
  for (const relative of [
    "01-system",
    "02-knowledge/Projects",
    "02-knowledge/Task Runs",
    "03-skills-catalog/registries",
    "09-mcp",
    "10-inbox",
    "99-archive"
  ]) {
    await fs.mkdir(path.join(vaultRoot, relative), { recursive: true });
  }
  if (!await fs.access(path.join(vaultRoot, "03-skills-catalog", "registries", "skills.index.json"))
    .then(() => true)
    .catch(() => false)) {
    await tool("rebuild_index");
  }
  if (!await fs.access(path.join(vaultRoot, "01-system", "System Dashboard.md"))
    .then(() => true)
    .catch(() => false)) {
    await tool("rebuild_system_dashboard");
  }
  if (!await fs.access(path.join(vaultRoot, "09-mcp", "runtime-distribution.json"))
    .then(() => true)
    .catch(() => false)) {
    await tool("prepare_runtime_distribution");
  }
} finally {
  shutdownBgeWorkers();
}
