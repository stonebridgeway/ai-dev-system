import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callTool, usageLedger } from "./mcp-stdio.mjs";
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
  assert.ok(tools.tools.length >= 40);
  assert.ok(tools.tools.every((item) => item.outputSchema));
  assert.equal(tools.tools.find((item) => item.name === "read_project")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "run_quality_gate")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((item) => item.name === "query_ui_ux_knowledge")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "generate_ui_ux_design_system")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((item) => item.name === "frontend_product_builder")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "reference_factory_status")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "plan_frontend_references")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((item) => item.name === "register_frontend_references")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((item) => item.name === "frontend_product_gate")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((item) => item.name === "run_visual_reference_qa")?.annotations?.readOnlyHint, false);
  assert.ok(tools.tools.some((item) => item.name === "record_visual_review"));
  for (const name of [
    "archify_doctor", "archify_guide", "archify_validate", "archify_render", "archify_deliver",
    "archify_visual_check", "archify_compare", "archify_migrate", "archify_brands"
  ]) assert.ok(tools.tools.some((item) => item.name === name));
  for (const name of ["archify_doctor", "archify_guide", "archify_validate", "archify_brands"]) {
    assert.equal(tools.tools.find((item) => item.name === name)?.annotations?.readOnlyHint, true);
  }
  for (const name of ["archify_render", "archify_deliver", "archify_visual_check", "archify_compare", "archify_migrate"]) {
    assert.equal(tools.tools.find((item) => item.name === name)?.annotations?.readOnlyHint, false);
  }

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
  assert.match(referencePrompt.messages[0].content.text, /plan_frontend_references/);
  const frontendPrompt = await client.getPrompt({
    name: "build_frontend_product",
    arguments: {
      project_path: "C:\\repo",
      task: "Redesign the landing page",
      mode: "redesign"
    }
  });
  assert.match(frontendPrompt.messages[0].content.text, /frontend_product_gate/);
  const prompt = await client.getPrompt({
    name: "start_engineering_task",
    arguments: { project_path: "C:\\repo", task: "Исправить форму" }
  });
  assert.match(prompt.messages[0].content.text, /begin_task/);
  const diagramPrompt = await client.getPrompt({
    name: "build_architecture_diagram",
    arguments: { project_path: "C:\\repo", scenario: "Payment architecture", output_path: "docs/diagrams/architecture.html" }
  });
  assert.match(diagramPrompt.messages[0].content.text, /archify_deliver/);

  const presets = await client.callTool({ name: "list_search_presets", arguments: {} });
  assert.equal(presets.isError, false);
  assert.ok(presets.structuredContent?.result);

  const uiUxKnowledge = await client.callTool({
    name: "query_ui_ux_knowledge",
    arguments: { query: "keyboard focus", domain: "ux", max_results: 1 }
  });
  assert.equal(uiUxKnowledge.isError, false);
  assert.equal(uiUxKnowledge.structuredContent?.result?.source?.skill, "ui-ux-pro-max");
  assert.equal(uiUxKnowledge.structuredContent?.result?.result?.count, 1);

  const designSystem = await client.callTool({
    name: "generate_ui_ux_design_system",
    arguments: {
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


test("a tool that needs one of two arguments says so where a caller can read it", async (t) => {
  // A schema's `required` cannot say "project_path or task_id", so these tools
  // accepted a call that filled every required field and then refused it. The
  // alternative has to be in the description, which is what a model reads.
  const { client } = await connectedPair();
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const described = Object.fromEntries(tools.map((tool) => [tool.name, tool.description ?? ""]));

  const contracts = [
    ["record_decision", ["project_path", "task_id"]],
    ["list_decisions", ["project_path", "task_id"]],
    ["coverage_gaps", ["project_path", "task_id"]],
    ["record_instinct", ["project_path", "task_id"]],
    ["save_session", ["topic", "building"]],
    ["record_usage", ["input_tokens", "output_tokens", "cost_usd"]],
    ["archify_validate", ["spec", "spec_path"]],
    ["archify_render", ["spec", "spec_path"]],
    ["archify_deliver", ["spec", "spec_path"]]
  ];
  for (const [name, alternatives] of contracts) {
    const description = described[name];
    assert.ok(description, `${name} is not in the tool list`);
    for (const alternative of alternatives) {
      assert.ok(
        description.includes(alternative),
        `${name} refuses without one of ${alternatives.join(" / ")}, and its description never mentions ${alternative}`
      );
    }
  }
});

test("the usage ledger records every caller once: direct calls, transport calls, failures", async (t) => {
  const { client, server } = await connectedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const toolCalls = async (tool) => {
    await usageLedger.flush();
    return (await usageLedger.readEvents()).filter((event) => event.kind === "tool_call" && event.tool === tool);
  };

  // A direct call — scripts/ai-dev.mjs, the smoke scripts, a composed tool —
  // used to be invisible to usage_report because only server.mjs recorded.
  const before = (await toolCalls("list_search_presets")).length;
  await callTool("list_search_presets", {});
  const afterDirect = await toolCalls("list_search_presets");
  assert.equal(afterDirect.length, before + 1);
  assert.equal(afterDirect.at(-1).ok, true);

  const viaTransport = await client.callTool({ name: "list_search_presets", arguments: {} });
  assert.equal(viaTransport.isError, false);
  assert.equal((await toolCalls("list_search_presets")).length, before + 2, "the transport must not record a second event");

  // Project/task hints keep working now that they are read inside callTool.
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "usage-hints-"));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  await callTool("verify_change_hygiene", { project_path: projectPath });
  const scans = await toolCalls("verify_change_hygiene");
  assert.equal(scans.at(-1).project_path, projectPath);
  assert.ok(scans.at(-1).duration_ms >= 0);

  await assert.rejects(callTool("verify_change_hygiene", {}), /project_path or task_id is required/);
  const failed = (await toolCalls("verify_change_hygiene")).at(-1);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /project_path or task_id is required/);

  const errored = await client.callTool({ name: "verify_change_hygiene", arguments: {} });
  assert.equal(errored.isError, true);
  const failures = (await toolCalls("verify_change_hygiene")).filter((event) => !event.ok);
  assert.equal(failures.length, 2, "one failure per call, from whichever caller made it");
});
