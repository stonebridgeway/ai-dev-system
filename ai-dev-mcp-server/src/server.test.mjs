import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAiDevServer } from "./server.mjs";

async function connectedPair() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAiDevServer();
  const client = new Client(
    { name: "ai-dev-system-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("SDK runtime exposes tools, resources, prompts, and structured results", async (t) => {
  const { client, server } = await connectedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.ok(tools.tools.length <= 25);
  assert.ok(tools.tools.every((item) => item.outputSchema));
  assert.equal(tools.tools.find((item) => item.name === "project")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "run_quality_gate")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((item) => item.name === "ui_ux")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "frontend_product")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "diagram")?.annotations?.readOnlyHint, true);

  const resources = await client.listResources();
  assert.ok(resources.resources.some((item) => item.uri === "ai-dev://system/control-center"));
  const controlCenter = await client.readResource({ uri: "ai-dev://system/control-center" });
  assert.match(controlCenter.contents[0].text, /AI Dev Control Center/i);

  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((item) => item.name === "format_project_for_ai"));
  assert.ok(prompts.prompts.some((item) => item.name === "build_frontend_product"));
  assert.ok(prompts.prompts.some((item) => item.name === "generate_frontend_references"));
  assert.ok(prompts.prompts.some((item) => item.name === "build_architecture_diagram"));
  const referencePrompt = await client.getPrompt({
    name: "generate_frontend_references",
    arguments: {
      project_path: "C:\\repo",
      task: "Generate references for a logistics dashboard",
      surface: "application"
    }
  });
  assert.match(referencePrompt.messages[0].content.text, /action=plan_references/);
  const frontendPrompt = await client.getPrompt({
    name: "build_frontend_product",
    arguments: {
      project_path: "C:\\repo",
      task: "Redesign the landing page",
      mode: "redesign"
    }
  });
  assert.match(frontendPrompt.messages[0].content.text, /action=gate/);
  const prompt = await client.getPrompt({
    name: "start_engineering_task",
    arguments: { project_path: "C:\\repo", task: "Исправить форму" }
  });
  assert.match(prompt.messages[0].content.text, /begin_task/);
  const diagramPrompt = await client.getPrompt({
    name: "build_architecture_diagram",
    arguments: { project_path: "C:\\repo", scenario: "Payment architecture", output_path: "docs/diagrams/architecture.html" }
  });
  assert.match(diagramPrompt.messages[0].content.text, /action=deliver/);

  const presets = await client.callTool({ name: "system", arguments: { action: "list_auto_commands" } });
  assert.equal(presets.isError, false);
  assert.ok(presets.structuredContent?.result);

  const uiUxKnowledge = await client.callTool({
    name: "ui_ux",
    arguments: { action: "query", query: "keyboard focus", domain: "ux", max_results: 1 }
  });
  assert.equal(uiUxKnowledge.isError, false);
  assert.equal(uiUxKnowledge.structuredContent?.result?.source?.skill, "ui-ux-pro-max");
  assert.equal(uiUxKnowledge.structuredContent?.result?.result?.count, 1);

  const designSystem = await client.callTool({
    name: "ui_ux",
    arguments: {
      action: "design_system",
      query: "B2B analytics dashboard, accessible and trustworthy",
      project_name: "Test Product",
      variance: 5,
      motion: 3,
      density: 7
    }
  });
  assert.equal(designSystem.isError, false);
  assert.ok(designSystem.structuredContent?.result?.design_system?.style);
  assert.equal(designSystem.structuredContent?.result?.persistence, null);
});

test("SDK runtime rejects invalid tool arguments before dispatch", async (t) => {
  const { client, server } = await connectedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const unknownArgument = await client.callTool({
    name: "system",
    arguments: { action: "match_auto_command", request: "prepare project", bogus_param: true }
  });
  assert.equal(unknownArgument.isError, true);
  assert.match(unknownArgument.content[0].text, /additional properties/i);

  const wrongLimitType = await client.callTool({
    name: "system",
    arguments: { action: "match_auto_command", request: "prepare project", limit: "2" }
  });
  assert.equal(wrongLimitType.isError, true);
  assert.match(wrongLimitType.content[0].text, /integer/i);

  const invalidStatus = await client.callTool({
    name: "list_tasks",
    arguments: { status: "bogus" }
  });
  assert.equal(invalidStatus.isError, true);
  assert.match(invalidStatus.content[0].text, /allowed values/i);
});
