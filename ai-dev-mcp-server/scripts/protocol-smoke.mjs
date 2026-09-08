import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const serverPath = process.env.AI_DEV_MCP_SERVER_PATH
  ? path.resolve(process.env.AI_DEV_MCP_SERVER_PATH)
  : path.join(serverRoot, "src", "server.mjs");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverRoot,
  env: { ...process.env },
  stderr: "pipe"
});
const client = new Client(
  { name: "ai-dev-protocol-smoke", version: "1.0.0" },
  { capabilities: {} }
);

const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(chunk));

try {
  await client.connect(transport);
  const fullProfile = process.env.AI_DEV_TOOL_PROFILE?.toLowerCase() === "full";
  const [tools, resources, templates, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts()
  ]);
  const presetResult = await client.callTool({
    name: fullProfile ? "list_search_presets" : "system",
    arguments: fullProfile ? {} : { action: "list_auto_commands" }
  });
  if (presetResult.isError || !presetResult.structuredContent?.result) {
    throw new Error("Structured tool result was not returned over stdio.");
  }
  const coreRequiredTools = [
    "prepare_project",
    "project",
    "search",
    "search_index",
    "system",
    "begin_task",
    "verify_task",
    "complete_task",
    "run_frontend_qa",
    "frontend_product",
    "pilot",
    "diagram"
  ];
  const fullRequiredTools = [
    "search_knowledge", "search_skills", "read_skill", "prepare_project", "project_identity",
    "begin_task", "verify_task", "complete_task", "run_quality_gate", "run_frontend_qa",
    "archify_validate", "archify_deliver"
  ];
  const requiredTools = fullProfile ? fullRequiredTools : coreRequiredTools;
  const toolNames = new Set(tools.tools.map((item) => item.name));
  const missingTools = requiredTools.filter((name) => !toolNames.has(name));
  if (missingTools.length) throw new Error(`Missing required tools: ${missingTools.join(", ")}`);
  if (!fullProfile && tools.tools.length > 25) throw new Error(`Core profile exposes too many tools: ${tools.tools.length}`);
  const toolListJson = JSON.stringify(tools.tools);
  if (!fullProfile && Buffer.byteLength(toolListJson, "utf8") > 25000) {
    throw new Error(`Core tools/list is too large: ${Buffer.byteLength(toolListJson, "utf8")} bytes`);
  }
  if (!resources.resources.some((item) => item.uri === "ai-dev://system/control-center")) {
    throw new Error("Control Center resource is missing.");
  }
  if (!prompts.prompts.some((item) => item.name === "start_engineering_task")) {
    throw new Error("Engineering task prompt is missing.");
  }
  if (!prompts.prompts.some((item) => item.name === "build_frontend_product")) {
    throw new Error("Frontend Product Builder prompt is missing.");
  }
  if (!prompts.prompts.some((item) => item.name === "generate_frontend_references")) {
    throw new Error("Reference Factory prompt is missing.");
  }
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    transport: "stdio",
    tools: tools.tools.length,
    resources: resources.resources.length,
    resource_templates: templates.resourceTemplates.length,
    prompts: prompts.prompts.length,
    structured_results: true,
    required_tools: requiredTools
  }, null, 2)}\n`);
} catch (error) {
  const serverStderr = Buffer.concat(stderr).toString("utf8").trim();
  if (serverStderr) process.stderr.write(`${serverStderr}\n`);
  throw error;
} finally {
  await client.close().catch(() => {});
}
