#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  shutdownBgeWorkers,
  tools as legacyTools,
  vaultRoot
} from "./mcp-stdio.mjs";
import { isDirectExecution } from "./core/direct-execution.mjs";

const serverFile = fileURLToPath(import.meta.url);
const serverRoot = path.resolve(path.dirname(serverFile), "..");
// Single source of truth: the package version reported in the MCP handshake.
const VERSION = JSON.parse(
  await fs.readFile(path.join(serverRoot, "package.json"), "utf8")
).version || "0.0.0";

const READ_ONLY_TOOLS = new Set([
  "search_knowledge",
  "read_knowledge",
  "search_skills",
  "read_skill",
  "recommend_skills",
  "query_ui_ux_knowledge",
  "list_skill_groups",
  "browse_skill_group",
  "list_skill_overlays",
  "list_skill_cards",
  "search_skill_cards",
  "read_skill_card",
  "search_index_status",
  "search_all",
  "hybrid_search",
  "list_search_presets",
  "preset_search",
  "explain_search",
  "run_search_eval",
  "embed_texts",
  "embedding_status",
  "system_health_check",
  "system_dashboard_status",
  "runtime_distribution_status",
  "search_projects",
  "search_notes",
  "search_skill_registry",
  "list_auto_commands",
  "match_auto_command",
  "read_auto_command",
  "project_identity",
  "list_projects",
  "read_project",
  "analyze_project",
  "project_context_status",
  "frontend_product_builder",
  "reference_factory_status",
  "frontend_product_gate",
  "get_task",
  "list_tasks",
  "skill_outcome_status",
  "project_pilot_status",
  "archify_doctor",
  "archify_guide",
  "archify_validate",
  "archify_brands"
]);

const OPEN_WORLD_TOOLS = new Set(["import_skill_repo"]);

const FIXED_RESOURCES = [
  {
    uri: "ai-dev://system/control-center",
    name: "control-center",
    title: "AI Dev Control Center",
    description: "Primary operating page for the local AI development system.",
    mimeType: "text/markdown",
    source: path.join(vaultRoot, "01-system", "AI Dev Control Center.md"),
    priority: 1
  },
  {
    uri: "ai-dev://system/dashboard",
    name: "system-dashboard",
    title: "AI Dev System Dashboard",
    description: "Current human-readable system status and navigation.",
    mimeType: "text/markdown",
    source: path.join(vaultRoot, "01-system", "System Dashboard.md"),
    priority: 0.9
  },
  {
    uri: "ai-dev://system/architecture",
    name: "architecture",
    title: "AI Dev MCP vNext Architecture",
    description: "Runtime layers, source-of-truth contracts, and compatibility model.",
    mimeType: "text/markdown",
    source: path.join(serverRoot, "docs", "ARCHITECTURE.md"),
    priority: 0.9
  },
  {
    uri: "ai-dev://projects/index",
    name: "projects-index",
    title: "Registered Projects",
    description: "Index of projects connected to the AI Dev System.",
    mimeType: "text/markdown",
    source: path.join(vaultRoot, "02-knowledge", "Projects", "Projects Index.md"),
    priority: 0.8
  }
];

const PROMPTS = [
  {
    name: "format_project_for_ai",
    title: "Оформи проект для ИИ",
    description: "Prepare an existing or new repository for reliable work by Codex or Claude.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "task", description: "Optional first task to prepare for.", required: false }
    ],
    render: ({ project_path, task = "" }) => [
      `Оформи проект для ИИ по пути: ${project_path}.`,
      "Сначала вызови prepare_project, затем проверь созданные AGENTS.md, project-brief, project-map и quality-gate.",
      "Используй recommend_skills с лимитом 3 и верни найденные риски, пропущенные проверки и следующий безопасный шаг.",
      task ? `После подготовки начни задачу: ${task}` : ""
    ].filter(Boolean).join("\n")
  },
  {
    name: "start_engineering_task",
    title: "Начни инженерную задачу",
    description: "Start feature, bugfix, review, frontend, backend, or integration work with bounded context.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "task", description: "Concrete task or bug report.", required: true }
    ],
    render: ({ project_path, task }) => [
      `Проект: ${project_path}`,
      `Задача: ${task}`,
      "Вызови begin_task. Прочитай только выданный Project Brief, релевантные части Project Map и максимум три рекомендованных skill.",
      "Перед изменениями зафиксируй acceptance criteria и риск. После изменений вызови verify_task и complete_task только при наличии evidence."
    ].join("\n")
  },
  {
    name: "review_frontend_beta",
    title: "Проверь frontend beta",
    description: "Review a beta frontend change for regressions, visual quality, responsive behavior, and accessibility.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "scope", description: "Route, component, PR, or task scope.", required: true }
    ],
    render: ({ project_path, scope }) => [
      `Проверь frontend beta в проекте ${project_path}. Scope: ${scope}.`,
      "Начни task lifecycle, изучи существующий дизайн и ограничения проекта, затем используй frontend skills только по необходимости.",
      "Запусти run_frontend_qa для desktop/mobile и quality gate. Не объявляй результат готовым без console/network/overflow/a11y evidence и визуального просмотра скриншотов."
    ].join("\n")
  },
  {
    name: "build_frontend_product",
    title: "Build Frontend Product",
    description: "Build or redesign a frontend through design approval, visual references, independent review, and technical verification.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "task", description: "Concrete interface or product task.", required: true },
      { name: "mode", description: "new, redesign, landing, or maintenance.", required: false }
    ],
    render: ({ project_path, task, mode = "" }) => [
      `Project: ${project_path}`,
      `Frontend product task: ${task}`,
      mode ? `Mode: ${mode}` : "",
      "Call frontend_product_builder and use no more than its three selected skills.",
      "Prepare and complete the mandatory product brief, references, two or three visual directions, design system, UI inventory, and visual acceptance files.",
      "Do not edit product UI code until approve_frontend_direction, approve_frontend_design_system, and frontend_product_gate gate=implementation pass.",
      "After implementation, run run_visual_reference_qa. Inspect every screenshot, baseline, and diff through an independent reviewer and record all ten Product Design Scorecard dimensions.",
      "Finish only after frontend_product_gate gate=handoff and the repository quality gate pass."
    ].filter(Boolean).join("\n")
  },
  {
    name: "generate_frontend_references",
    title: "Generate Frontend References",
    description: "Create high-quality visual directions when the project has no approved external reference.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "task", description: "Product and interface goal.", required: true },
      { name: "surface", description: "web, application, or mobile.", required: false }
    ],
    render: ({ project_path, task, surface = "" }) => [
      `Project: ${project_path}`,
      `Reference task: ${task}`,
      surface ? `Surface: ${surface}` : "",
      "Use frontend_product_builder and keep exactly its three selected skills.",
      "Prepare Frontend Product Quality and complete truthful product context before planning.",
      "Call plan_frontend_references for concept directions. The MCP server only creates a manifest; call ImageGen or Figma for every artifact job.",
      "Save each PNG at the exact output_path, inspect every image, and call register_frontend_references with prompt hashes and concrete observations.",
      "Present the materially distinct concepts and approve one direction. Then plan and register stage=coverage for only the approved direction.",
      "Do not approve the design system until Reference Factory coverage is registered."
    ].filter(Boolean).join("\n")
  },
  {
    name: "refresh_project_context",
    title: "Обнови память проекта",
    description: "Refresh project map, brief, Obsidian card, and search index after meaningful changes.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true }
    ],
    render: ({ project_path }) => [
      `Обнови память проекта ${project_path}.`,
      "Вызови refresh_project_memory, проверь компоненты и команды, затем search_index_status.",
      "Сообщи, какие факты изменились и какие риски или quality gates остались."
    ].join("\n")
  },
  {
    name: "build_architecture_diagram",
    title: "Построй диаграмму архитектуры",
    description: "Create a verified Archify architecture diagram and finish with a delivery receipt.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "scenario", description: "Architecture to document.", required: true },
      { name: "output_path", description: "Project-relative output HTML path, for example docs/diagrams/architecture.html.", required: true }
    ],
    render: ({ project_path, scenario, output_path }) => [
      `Проект: ${project_path}`,
      `Сценарий: ${scenario}`,
      `Артефакт: ${output_path}`,
      "Вызови begin_task, затем archify_guide. Создай JSON IR и повторяй archify_validate до нулевых ошибок и предупреждений.",
      "Вызови archify_deliver с artifact_location=project, quality=showcase и output_path, затем archify_visual_check для доставленного HTML.",
      "Не смешивай deterministic delivery, automated browser evidence и perceptual review: последний остаётся отдельным человеческим или image-capable review.",
      "Заверши только с receipt; передай его в verify_task или complete_task как evidence kind=archify_deliver."
    ].join("\n")
  }
];

function toolTitle(name) {
  return name
    .split("_")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
}

function toolDefinition(tool) {
  const readOnly = READ_ONLY_TOOLS.has(tool.name);
  return {
    ...tool,
    title: tool.title || toolTitle(tool.name),
    outputSchema: {
      type: "object",
      properties: { result: {} },
      required: ["result"],
      additionalProperties: false
    },
    annotations: {
      title: tool.title || toolTitle(tool.name),
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly || /^(rebuild|sync|refresh|prepare|bootstrap|validate)/.test(tool.name),
      openWorldHint: OPEN_WORLD_TOOLS.has(tool.name)
    }
  };
}

function structuredResult(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Markdown and plain text remain strings.
  }
  return {
    ...result,
    structuredContent: { result: value },
    isError: false
  };
}

async function reportProgress(extra, progress, total, message) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message }
  });
}

async function readFixedResource(resource) {
  try {
    const text = await fs.readFile(resource.source, "utf8");
    const stats = await fs.stat(resource.source);
    return {
      contents: [{
        uri: resource.uri,
        mimeType: resource.mimeType,
        text,
        annotations: {
          audience: ["assistant", "user"],
          priority: resource.priority,
          lastModified: stats.mtime.toISOString()
        }
      }]
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new McpError(ErrorCode.InvalidParams, `Resource source is missing: ${resource.uri}`);
    }
    throw error;
  }
}

function dynamicResourceText(uri, result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new McpError(ErrorCode.InternalError, `Resource handler returned no text: ${uri}`);
  }
  return {
    contents: [{
      uri,
      mimeType: "text/markdown",
      text,
      annotations: { audience: ["assistant", "user"], priority: 0.8 }
    }]
  };
}

function promptByName(name) {
  const prompt = PROMPTS.find((item) => item.name === name);
  if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  return prompt;
}

function validatePromptArguments(prompt, args) {
  for (const item of prompt.arguments) {
    if (item.required && !String(args?.[item.name] ?? "").trim()) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt argument is required: ${item.name}`);
    }
  }
}

export function createAiDevServer() {
  const server = new Server(
    { name: "ai-dev-system", version: VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {}
      },
      instructions: [
        "Use this server as a bounded context and quality layer for local software development.",
        "Prefer begin_task for substantive work, load no more than three routed skills, and require verification evidence before completion.",
        "For frontend product or visual work, use Frontend Product Quality v2 and do not allow implementation before visual direction and design-system approval.",
        "When no visual reference exists, use Reference Factory manifests; the client must actually call ImageGen or Figma and inspect every PNG before registration.",
        "Never expose or summarize password notes through MCP resources."
      ].join(" ")
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: legacyTools.map(toolDefinition)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (!legacyTools.some((tool) => tool.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    await reportProgress(extra, 0, 1, `Starting ${name}`);
    try {
      const result = structuredResult(await callTool(name, args));
      await reportProgress(extra, 1, 1, `Completed ${name}`);
      return result;
    } catch (error) {
      await reportProgress(extra, 1, 1, `Failed ${name}`).catch(() => undefined);
      return {
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }],
        isError: true
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: FIXED_RESOURCES.map(({ source, priority, ...resource }) => resource)
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "ai-dev://projects/{name}",
        name: "registered-project",
        title: "Registered Project Card",
        description: "Read one generated project card by project name.",
        mimeType: "text/markdown"
      },
      {
        uriTemplate: "ai-dev://skills/{name}",
        name: "skill-source",
        title: "Skill Source",
        description: "Read one skill by exact registry name.",
        mimeType: "text/markdown"
      },
      {
        uriTemplate: "ai-dev://tasks/{id}",
        name: "task-lifecycle-record",
        title: "Task Lifecycle Record",
        description: "Read acceptance criteria, routed skills, checkpoints, and verification evidence for one task.",
        mimeType: "application/json"
      }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const fixed = FIXED_RESOURCES.find((item) => item.uri === uri);
    if (fixed) return readFixedResource(fixed);

    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `Invalid resource URI: ${uri}`);
    }
    const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (parsed.protocol !== "ai-dev:" || !name) {
      throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
    }
    if (parsed.hostname === "projects") {
      return dynamicResourceText(uri, await callTool("read_project", { name }));
    }
    if (parsed.hostname === "skills") {
      return dynamicResourceText(uri, await callTool("read_skill", { name }));
    }
    if (parsed.hostname === "tasks") {
      const result = await callTool("get_task", { task_id: name });
      const text = result?.content?.find((item) => item.type === "text")?.text;
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text,
          annotations: { audience: ["assistant", "user"], priority: 0.9 }
        }]
      };
    }
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ render, ...prompt }) => prompt)
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = promptByName(request.params.name);
    const args = request.params.arguments ?? {};
    validatePromptArguments(prompt, args);
    return {
      description: prompt.description,
      messages: [{
        role: "user",
        content: { type: "text", text: prompt.render(args) }
      }]
    };
  });

  return server;
}

export async function startServer() {
  const server = createAiDevServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (await isDirectExecution(import.meta.url)) {
  const server = await startServer();
  const shutdown = async (code) => {
    shutdownBgeWorkers();
    await server.close().catch(() => undefined);
    process.exit(code);
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
}
