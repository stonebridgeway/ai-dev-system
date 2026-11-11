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
  activeProfiles,
  callTool,
  extensionReadOnlyTools,
  shutdownBgeWorkers,
  tools as legacyTools,
  vaultRoot,
  visibleTools
} from "./mcp-stdio.mjs";
import { isDirectExecution } from "./core/direct-execution.mjs";
import { describeProgress } from "./core/progress-line.mjs";
import { prepareRuntimeHome } from "./core/runtime-home-migration.mjs";
import { createSessionEnd } from "./core/session-end.mjs";
import { DEFAULT_PROFILE_IDS, filterToolsByProfiles, findProfile, profileNotes, profileOfTool, profilesFromEnvironment } from "./core/tool-profiles.mjs";

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
  "query_ui_ux_knowledge",
  "list_skill_groups",
  "browse_skill_group",
  "list_skill_overlays",
  "list_skill_cards",
  "search_skill_cards",
  "read_skill_card",
  "runtime_distribution_status",
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

for (const name of extensionReadOnlyTools) READ_ONLY_TOOLS.add(name);

/**
 * The tools annotated with `readOnlyHint`, in a stable order. Exported so the
 * tool reference (`scripts/render-tool-reference.mjs`) documents the same set
 * the server advertises instead of keeping a second copy of it.
 *
 * @type {readonly string[]}
 */
export const READ_ONLY_TOOL_NAMES = Object.freeze([...READ_ONLY_TOOLS].sort());

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

/**
 * MCP prompt catalogue. Exported so the static quality gate can check it for
 * duplicate names the way it checks the tool list: `GetPrompt` resolves by
 * `find`, so a second entry under an existing name is silently dead.
 */
export const PROMPTS = [
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
    name: "learn_from_task",
    title: "Извлеки уроки из задачи",
    description: "After a task, turn corrections, resolved errors, repeated workflows, and decisions into durable memory: instincts, decisions, and a session handoff.",
    arguments: [
      { name: "project_path", description: "Absolute repository path.", required: true },
      { name: "task_id", description: "Task lifecycle id to learn from (optional).", required: false }
    ],
    render: ({ project_path, task_id = "" }) => [
      `Проект: ${project_path}${task_id ? `, задача: ${task_id}` : ""}`,
      "Просмотри ход работы и выдели: исправления пользователя, ошибки, которые решались одинаково дважды и больше, повторяющиеся последовательности действий, архитектурные решения.",
      "Для каждого устойчивого паттерна (3+ наблюдения или явное исправление) вызови record_instinct с коротким trigger/action, domain и note без кода и секретов; scope=project по умолчанию, global только для универсальных практик.",
      "Архитектурные выборы запиши через record_decision. Если задача продолжится в другой сессии, сохрани handoff через save_session с точным next_step и списком неудачных подходов.",
      "Не создавай инстинкты из единичных случаев и не дублируй уже существующие: сначала list_instincts, потом update_instinct action=confirm для совпадений."
    ].join("\n")
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
    // A tool with a contract (the control tools) advertises it, so an SDK
    // client checks every answer against it; the rest answer anything under `result`.
    outputSchema: tool.outputSchema ?? {
      type: "object",
      properties: { result: {} },
      required: ["result"],
      additionalProperties: false
    },
    annotations: {
      title: tool.title || toolTitle(tool.name),
      readOnlyHint: readOnly,
      destructiveHint: !readOnly && tool.annotations?.destructiveHint === true,
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

/**
 * The request's progress, as MCP `notifications/progress`.
 *
 * A tool reports `{ phase, done, total }` (or `bytes` for a download) in units
 * of its own; this turns them into one count that only rises — MCP requires
 * each notification to be larger than the last — by stacking the phases: the
 * text index written, then the documents embedded, then the closing write.
 * Before 3.0 a call said 0 of 1 when it began and 1 of 1 when it ended, and
 * nothing between. Notifications go out at most every
 * 100 ms, and not at all when the client sent no progress token.
 *
 * @param {object} extra - The SDK's request context.
 * @returns {{ begin: (message: string) => Promise<void>, onProgress: ((event: object) => void) | undefined, end: (message: string) => void }}
 */
export function progressReporter(extra, { now = Date.now } = {}) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return { begin: async () => undefined, onProgress: undefined, end: () => undefined };
  let sent = -1;
  let base = 0;
  let phase;
  let phaseTotal = 0;
  let lastAt = -Infinity;
  const send = (progress, total, message) => {
    if (!(progress > sent)) return Promise.resolve();
    sent = progress;
    return extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, ...(total > 0 ? { total: Math.max(total, progress) } : {}), message }
    }).catch(() => undefined);
  };
  return {
    begin: (message) => send(0, 1, message),
    onProgress(event = {}) {
      const total = Math.max(0, Number(event.total) || 0);
      const done = Math.max(0, Number(event.done ?? event.bytes) || 0);
      // A step of a longer run (`setup_run`) has phases of its own: one bar for all.
      const key = `${event.step ?? ""}/${event.phase ?? ""}`;
      if (key !== phase) {
        base += phaseTotal;
        phase = key;
        phaseTotal = total;
      } else {
        phaseTotal = Math.max(phaseTotal, total);
      }
      const finished = total > 0 && done >= total;
      if (!finished && now() - lastAt < 100) return;
      lastAt = now();
      // One unit is kept for the end, so 100% means the call has answered.
      send(base + Math.min(done, phaseTotal || done), base + phaseTotal + 1, describeProgress(event));
    },
    end(message) {
      const whole = Math.max(sent + 1, base + phaseTotal + 1, 1);
      send(whole, whole, message);
    }
  };
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

/**
 * The capability profiles of one session. A daemon serves clients whose
 * `AI_DEV_PROFILES` differ, so each bridge sends its own: a string, empty for
 * every profile. `null` means this process's own setting — the stdio server's.
 *
 * @param {string | null | undefined} profiles
 */
function sessionProfiles(profiles) {
  return typeof profiles === "string" ? profilesFromEnvironment({ AI_DEV_PROFILES: profiles }) : activeProfiles;
}

/** The tools one session lists. */
function sessionTools(profiles) {
  if (typeof profiles !== "string") return visibleTools();
  const active = sessionProfiles(profiles);
  return filterToolsByProfiles(legacyTools, active.ids);
}

/**
 * What the daemon tells a bridge about its session's tool list, so the bridge
 * can say on stderr what the stdio server says when profiles narrow it.
 *
 * @param {string | null} profiles
 * @returns {{ tools_listed: number, tools_total: number, tools_opt_in: number, profiles: string[], unknown_profiles: string[] }}
 *   `tools_total`: what an unset `AI_DEV_PROFILES` lists; `tools_opt_in`: the listed tools of opt-in profiles.
 */
export function sessionToolCounts(profiles) {
  const active = sessionProfiles(profiles);
  const listed = sessionTools(profiles);
  return {
    tools_listed: listed.length,
    // What an unset AI_DEV_PROFILES lists: every profile but the opt-in ones.
    tools_total: filterToolsByProfiles(legacyTools, DEFAULT_PROFILE_IDS).length,
    tools_opt_in: listed.filter((tool) => findProfile(profileOfTool(tool.name))?.optIn).length,
    profiles: active.all ? [] : active.ids,
    unknown_profiles: active.unknown
  };
}

/**
 * @param {{ profiles?: string | null }} [options] - The session's
 *   `AI_DEV_PROFILES`, when a daemon serves it; omitted, this process's own.
 */
export function createAiDevServer({ profiles = null, track = (work) => work() } = {}) {
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
        "Two protocols apply to every substantive repository task, and read_skill returns either in full.",
        "First the intent gate (skill `grill-me`): restate the request, separate known from assumed, ask only the questions whose answers change the work, and state what done means. It is supplemental and does not take one of the three routed skill slots.",
        "Then the task lifecycle (skill `ai-dev-orchestrator`): begin_task for substantive work, load no more than three routed skills, checkpoint_task for progress and decisions, and require verification evidence from verify_task before complete_task.",
        "For frontend product or visual work, use Frontend Product Quality v2 and do not allow implementation before visual direction and design-system approval.",
        "When no visual reference exists, use Reference Factory manifests; the client must actually call ImageGen or Figma and inspect every PNG before registration.",
        "Never expose or summarize password notes through MCP resources."
      ].join(" ")
    }
  );

  // Narrowed by the active capability profiles. `CallToolRequestSchema` below
  // still validates against the full list, so a client that knows a tool's name
  // can call it whether or not this listing advertised it.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: sessionTools(profiles).map(toolDefinition)
  }));

  // `track` sees each call run: a stdio session ends between calls.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => track(async () => {
    const { name, arguments: args = {} } = request.params;
    if (!legacyTools.some((tool) => tool.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    // `callTool` records the call itself, so every caller — this transport, the
    // CLI, the smoke scripts — lands in the usage ledger exactly once. All this
    // handler contributes is the transport overhead it just spent, and the
    // request's progress token and cancellation for the tools that use them.
    const progress = progressReporter(extra);
    const startedAt = Date.now();
    await progress.begin(`Starting ${name}`);
    const transportMs = Date.now() - startedAt;
    try {
      const result = structuredResult(await callTool(name, args, { transportMs, signal: extra?.signal, onProgress: progress.onProgress }));
      progress.end(`Completed ${name}`);
      return result;
    } catch (error) {
      progress.end(`Failed ${name}`);
      const message = error instanceof Error ? error.message : String(error);
      // An error that knows the next step carries it as `hint`.
      const hint = typeof error?.hint === "string" ? error.hint.trim() : "";
      return {
        content: [{
          type: "text",
          text: hint ? `${message}\n${hint}` : message
        }],
        isError: true
      };
    }
  }));

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

export async function startServer({ track } = {}) {
  await prepareRuntimeHome();
  for (const line of profileNotes(sessionToolCounts(null))) process.stderr.write(`${line}\n`);
  const server = createAiDevServer({ track });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

/**
 * Serve MCP on stdin/stdout until a signal ends the process: what
 * `node src/server.mjs` (every 2.x client config) and `ai-dev mcp` run.
 *
 * @returns {Promise<ReturnType<typeof createAiDevServer>>}
 */
export async function runStdioServer() {
  // The client closing stdin ends the session once what it asked for is
  // answered; the model's worker would keep the process — in Docker, the
  // container — running for good.
  const ending = createSessionEnd(() => shutdownBgeWorkers());
  const server = await startServer({ track: ending.track });
  process.stdin.once("end", ending.inputEnded);
  const shutdown = async (code) => {
    shutdownBgeWorkers();
    await server.close().catch(() => undefined);
    process.exit(code);
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  return server;
}

if (await isDirectExecution(import.meta.url)) {
  await runStdioServer();
}
