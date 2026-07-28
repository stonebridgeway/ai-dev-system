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
  const [tools, resources, templates, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts()
  ]);
  const presetResult = await client.callTool({
    name: "list_search_presets",
    arguments: {}
  });
  if (presetResult.isError || !presetResult.structuredContent?.result) {
    throw new Error("Structured tool result was not returned over stdio.");
  }
  const requiredTools = [
    "prepare_project",
    "project_identity",
    "begin_task",
    "compile_project_context",
    "project_context_status",
    "verify_task",
    "complete_task",
    "start_project_pilot",
    "record_project_pilot_review",
    "project_pilot_status",
    "run_frontend_qa",
    "frontend_product_builder",
    "prepare_frontend_product",
    "plan_frontend_references",
    "register_frontend_references",
    "reference_factory_status",
    "record_frontend_concept_jury",
    "frontend_product_gate",
    "run_visual_reference_qa",
    "record_visual_review",
    "run_skill_routing_eval",
    "skill_outcome_status",
    "rebuild_skill_outcomes",
    "sync_skill_overlays",
    "rebuild_system_dashboard",
    "system_dashboard_status",
    "prepare_runtime_distribution",
    "runtime_distribution_status"
  ];
  const toolNames = new Set(tools.tools.map((item) => item.name));
  const missingTools = requiredTools.filter((name) => !toolNames.has(name));
  if (missingTools.length) throw new Error(`Missing required tools: ${missingTools.join(", ")}`);
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
