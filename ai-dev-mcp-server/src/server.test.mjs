import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolvePythonCommand } from "./core/python-command.mjs";
import { callTool, usageLedger } from "./mcp-stdio.mjs";
import { createAiDevServer, progressReporter, sessionToolCounts } from "./server.mjs";

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
  // The two UI UX Pro Max tools run the dataset's own Python script, the only
  // tools here that need an interpreter. Without one they answer with what to
  // install, and nothing else needs it — the suite included.
  const python = spawnSync(resolvePythonCommand(), ["--version"], { encoding: "utf8", shell: false, windowsHide: true });
  if (!python.error && python.status === 0 && /Python 3/.test(`${python.stdout}${python.stderr}`)) {
    assert.equal(uiUxKnowledge.isError, false);
    assert.equal(uiUxKnowledge.structuredContent?.result?.source?.skill, "ui-ux-pro-max");
    assert.equal(uiUxKnowledge.structuredContent?.result?.result?.count, 1);
    assert.equal(designSystem.isError, false);
    assert.ok(designSystem.structuredContent?.result?.design_system?.style);
    assert.equal(designSystem.structuredContent?.result?.persistence, null);
  } else if (python.error?.code === "ENOENT") {
    for (const answer of [uiUxKnowledge, designSystem]) {
      assert.equal(answer.isError, true);
      assert.match(answer.content[0].text, /run a Python helper, and no Python was found here .*AI_DEV_PYTHON/);
    }
  } else {
    t.diagnostic(`the UI UX tools were not checked: ${resolvePythonCommand()} --version did not answer as Python 3`);
  }
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

test("a tool error that knows the next step says it under the error", async (t) => {
  // A repository AI Dev has not prepared has no quality gate; the refusal used to stop at "not found".
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-no-gate-"));
  const { client, server } = await connectedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(project, { recursive: true, force: true });
  });
  const answer = await client.callTool({ name: "run_quality_gate", arguments: { project_path: project, update_registry: false } });
  assert.equal(answer.isError, true);
  const [first, second] = answer.content[0].text.split("\n");
  assert.match(first, /^Quality gate file not found: .*quality-gate\.md$/);
  assert.match(second, /^prepare_project writes \.ai-dev\/quality-gate\.md from the project's own scripts/);
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

test("a tool's progress reaches the client as one rising count across its phases, and a cancelled call stops", async () => {
  const sent = [];
  let clock = 0;
  const reporter = progressReporter({ _meta: { progressToken: "p1" }, sendNotification: async (notification) => sent.push(notification.params) }, { now: () => clock });
  await reporter.begin("Starting rebuild_search_index");
  for (const done of [64, 128]) {
    clock += 200;
    reporter.onProgress({ phase: "indexing", done, total: 300 });
  }
  clock += 10;
  reporter.onProgress({ phase: "indexing", done: 192, total: 300 });
  clock += 200;
  reporter.onProgress({ phase: "embedding", done: 0, total: 40 });
  clock += 200;
  reporter.onProgress({ phase: "embedding", done: 40, total: 40 });
  reporter.end("Completed rebuild_search_index");
  assert.deepEqual(sent.map((params) => [params.progress, params.total]), [[0, 1], [64, 301], [128, 301], [300, 341], [340, 341], [341, 341]],
    "throttled to every 100 ms but the last of a phase, never falling back, and at 100% only when the call is done");
  assert.ok(sent.every((params) => params.progressToken === "p1"));
  assert.match(sent[1].message, /indexing 64 of 300 document\(s\) \(21%\)/);
  assert.match(sent[4].message, /embedding 40 of 40 document\(s\)/);
  assert.equal(sent[5].message, "Completed rebuild_search_index");

  const silent = progressReporter({ sendNotification: async () => assert.fail("no token, no notifications") });
  await silent.begin("x");
  assert.equal(silent.onProgress, undefined);
  silent.end("y");
});

test("a session's capability profiles come from its own client, not from the process serving it", async (t) => {
  const everything = sessionToolCounts("");
  const core = sessionToolCounts("core");
  assert.equal(everything.tools_listed, everything.tools_total);
  assert.ok(core.tools_listed < core.tools_total);
  assert.deepEqual(core.profiles, ["core"]);
  assert.deepEqual(sessionToolCounts("core,nonsense").unknown_profiles, ["nonsense"]);
  // The desktop app's tools are listed to the session that names them, and
  // counted apart: an unset AI_DEV_PROFILES does not list them.
  const control = sessionToolCounts("all,control");
  assert.equal(control.tools_opt_in, 16);
  assert.equal(control.tools_listed, everything.tools_total + 16);
  assert.equal(everything.tools_opt_in, 0);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAiDevServer({ profiles: "core" });
  const client = new Client({ name: "profiles", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.equal((await client.listTools()).tools.length, core.tools_listed);
});

test("stdin closed right after a call: the call is answered, then the server exits", async () => {
  const server = path.join(path.dirname(new URL(import.meta.url).pathname), "server.mjs");
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const line = (value) => `${JSON.stringify(value)}\n`;
  child.stdin.end([
    line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    line({ jsonrpc: "2.0", method: "notifications/initialized" }),
    line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_projects", arguments: {} } })
  ].join(""));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`still running 30 s after stdin closed; stdout: ${out.slice(0, 200)}`)); }, 30_000);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(code, 0);
  const answers = out.split("\n").filter(Boolean).map((text) => JSON.parse(text));
  assert.ok(answers.some((answer) => answer.id === 1 && answer.result?.instructions), "initialize was answered");
  assert.ok(answers.some((answer) => answer.id === 2 && answer.result), "the call read before the end was answered");
});

