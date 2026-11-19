#!/usr/bin/env node
/**
 * Render `docs/TOOLS.md` from the live MCP tool list.
 *
 *   node scripts/render-tool-reference.mjs           # rewrite the document
 *   node scripts/render-tool-reference.mjs --check   # fail if it is stale
 *
 * The name, purpose (tool description), read-only flag and required arguments
 * all come from the tool definitions themselves, so the document cannot drift
 * from the server. The only hand-written part is `GROUPS` below: it decides the
 * order of the sections and answers "when do I reach for these?". A tool that
 * is not listed in exactly one group fails both modes — adding a tool means
 * saying where it belongs.
 *
 * The same rule applies to the capability profiles in `src/core/tool-profiles.mjs`,
 * which decide what a narrowed `tools/list` advertises: a new tool that belongs
 * to no profile would silently be listed in every session, so it fails here too.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { tools } from "../src/mcp-stdio.mjs";
import { READ_ONLY_TOOL_NAMES } from "../src/server.mjs";
import { TOOL_PROFILES, auditProfileCoverage, profileOfTool } from "../src/core/tool-profiles.mjs";
import { renderControlApi } from "./render-control-api.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "docs", "TOOLS.md");
const generator = "scripts/render-tool-reference.mjs";

const GROUPS = [
  {
    title: "Knowledge and search",
    when: "Looking something up before writing code, or keeping the search index and the vault notes current.",
    tools: [
      "search_knowledge",
      "read_knowledge",
      "query_ui_ux_knowledge",
      "search_all",
      "hybrid_search",
      "list_search_presets",
      "preset_search",
      "explain_search",
      "run_search_eval",
      "embed_texts",
      "embedding_status",
      "search_index_status",
      "rebuild_search_index",
      "search_projects",
      "search_notes",
      "search_skill_registry",
      "rebuild_index",
      "write_knowledge_note",
      "append_knowledge_note",
      "render_knowledge_galaxy"
    ]
  },
  {
    title: "Skill registry and routing",
    when: "Choosing which skill should drive a task, importing skills, or auditing the registry's health.",
    tools: [
      "search_skills",
      "read_skill",
      "recommend_skills",
      "list_skill_groups",
      "browse_skill_group",
      "list_skill_cards",
      "search_skill_cards",
      "read_skill_card",
      "sync_skill_cards",
      "list_skill_overlays",
      "upsert_skill_overlay",
      "sync_skill_overlays",
      "rebuild_skill_taxonomy",
      "validate_skill_library",
      "run_skill_routing_eval",
      "skill_outcome_status",
      "rebuild_skill_outcomes",
      "import_skill_repo"
    ]
  },
  {
    title: "Projects and context",
    when: "First contact with a repository, and every time the compiled context pack needs to catch up with it.",
    tools: [
      "bootstrap_project",
      "prepare_project",
      "project_identity",
      "list_projects",
      "read_project",
      "register_project",
      "analyze_project",
      "sync_project_card",
      "update_project_card",
      "refresh_project_map",
      "refresh_project_memory",
      "compile_project_context",
      "project_context_status",
      "list_auto_commands",
      "match_auto_command",
      "read_auto_command"
    ]
  },
  {
    title: "Task lifecycle",
    when: "The spine of a unit of work: open a task, checkpoint it, prove it, close it.",
    tools: [
      "begin_task",
      "get_task",
      "list_tasks",
      "checkpoint_task",
      "run_quality_gate",
      "verify_task",
      "complete_task",
      "prepare_pull_request",
      "coverage_gaps",
      "start_project_pilot",
      "record_project_pilot_review",
      "project_pilot_status"
    ]
  },
  {
    title: "Epics",
    when: "A task too big for one arc. `decompose_task` opens its children as real tasks with an order between them, and the parent stays open until every one of them is closed.",
    tools: ["decompose_task", "epic_status"]
  },
  {
    title: "Plan gate",
    when: "Before starting anything large or risky. `begin_task` marks such a task `plan_required` and gives it an extra acceptance criterion that stays pending — and so keeps `complete_task` shut — until `plan_task` records a plan.",
    tools: ["plan_task", "plan_status"]
  },
  {
    title: "Task worktrees",
    when: "Running a task in isolation, so an unfinished change never sits in the user's main checkout.",
    tools: ["begin_task_in_worktree", "list_task_worktrees", "plan_worktree_cleanup", "remove_task_worktree"]
  },
  {
    title: "Task snapshots",
    when: "Undoing a turn. `checkpoint_task` snapshots the working tree on its own, so there is usually something to go back to; these tools add one on demand, show what can be returned to, and put the files back.",
    tools: ["snapshot_task", "list_task_snapshots", "rollback_task"]
  },
  {
    title: "Change hygiene and project rules",
    when: "Reviewing a diff before claiming it is done, and installing the engineering rules an agent should follow in this repository.",
    tools: ["verify_change_hygiene", "run_security_scan", "plan_security_fixes", "list_rule_packs", "install_project_rules", "distill_project_rules"]
  },
  {
    title: "Memory and learning",
    when: "Carrying knowledge across sessions: why a choice was made, how this user likes to work, and where the last session stopped.",
    tools: [
      "record_decision",
      "list_decisions",
      "save_session",
      "resume_session",
      "list_sessions",
      "context_budget_status",
      "record_instinct",
      "propose_instincts",
      "list_instincts",
      "update_instinct",
      "evolve_instincts",
      "export_instincts",
      "import_instincts",
      "prune_state"
    ]
  },
  {
    title: "Agent hooks and policy",
    when: "Setting up (or inspecting) the hook pack that guards commands and file writes in Claude Code and Cursor, and editing the project rules it enforces.",
    tools: ["install_agent_hooks", "agent_hooks_status", "list_policy_rules", "upsert_policy_rule", "remove_policy_rule"]
  },
  {
    title: "Agent harness inventory",
    when: "Auditing which MCP servers this repository wires into its agents, over which transports, and whether any credential is sitting in a config file.",
    tools: ["list_mcp_servers", "scan_agent_config"]
  },
  {
    title: "Usage and cost",
    when: "Reporting what a session spent, and reading the ledger back per project, model or task.",
    tools: ["record_usage", "usage_report"]
  },
  {
    title: "Frontend product and QA",
    when: "Building or reviewing a user-facing surface: brief, directions, design system, references and the accessibility/visual gates.",
    tools: [
      "frontend_product_builder",
      "prepare_frontend_product",
      "update_frontend_product_brief",
      "record_frontend_directions",
      "approve_frontend_direction",
      "record_frontend_concept_jury",
      "approve_frontend_design_system",
      "generate_ui_ux_design_system",
      "plan_frontend_references",
      "register_frontend_references",
      "reference_factory_status",
      "run_visual_reference_qa",
      "record_visual_review",
      "run_frontend_qa",
      "frontend_product_gate"
    ]
  },
  {
    title: "Archify diagrams",
    when: "Producing a diagram deliverable — validate and render locally, then deliver with a server-owned receipt that `verify_task` can trust.",
    tools: [
      "archify_doctor",
      "archify_guide",
      "archify_brands",
      "archify_validate",
      "archify_render",
      "archify_deliver",
      "archify_visual_check",
      "archify_compare",
      "archify_migrate"
    ]
  },
  {
    title: "System health and distribution",
    when: "Checking that the installation itself is sound, and preparing the runtime for another machine.",
    tools: [
      "system_health_check",
      "rebuild_system_dashboard",
      "system_dashboard_status",
      "prepare_runtime_distribution",
      "runtime_distribution_status"
    ]
  },
  {
    title: "Control API",
    when: "Driving the install from an app or a script: its state, setting it up, the local model, the clients, logs, settings and an overview. Listed only to a session that names the `control` profile; their answers follow docs/CONTROL-API.md.",
    tools: [
      "system_status",
      "setup_run",
      "model_install",
      "model_import",
      "model_verify",
      "model_remove",
      "clients_list",
      "clients_install",
      "clients_remove",
      "logs_tail",
      "settings_get",
      "settings_set",
      "custom_skills_list",
      "custom_skills_add",
      "custom_skills_remove",
      "workspace_overview"
    ]
  }
];

/**
 * @param {{ inputSchema?: { properties?: Record<string, unknown>, required?: string[] } }} tool
 * @returns {string} Required argument names, or an em dash when the tool takes none.
 */
function requiredArguments(tool) {
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  if (required.length === 0) return "—";
  return required.map((name) => `\`${name}\``).join(", ");
}

/**
 * Tool descriptions are free text and may contain a pipe, which would split a
 * Markdown table cell.
 *
 * @param {string} text
 * @returns {string}
 */
function cell(text) {
  return String(text || "").replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
}

/**
 * @returns {{ markdown: string, problems: string[] }}
 */
function render() {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const readOnly = new Set(READ_ONLY_TOOL_NAMES);
  const problems = [];
  const seen = new Set();
  for (const group of GROUPS) {
    for (const name of group.tools) {
      if (!byName.has(name)) problems.push(`${group.title}: lists "${name}", which the server does not expose.`);
      if (seen.has(name)) problems.push(`${group.title}: lists "${name}" a second time.`);
      seen.add(name);
    }
  }
  for (const tool of tools) {
    if (!seen.has(tool.name)) problems.push(`"${tool.name}" belongs to no group; add it to GROUPS in ${generator}.`);
  }

  const profiles = auditProfileCoverage(tools.map((tool) => tool.name));
  for (const name of profiles.missing) {
    problems.push(`"${name}" belongs to no capability profile; add it to TOOL_PROFILES in src/core/tool-profiles.mjs.`);
  }
  for (const name of profiles.unknown) {
    problems.push(`TOOL_PROFILES lists "${name}", which the server does not expose.`);
  }
  for (const name of profiles.duplicated) {
    problems.push(`TOOL_PROFILES files "${name}" under more than one profile.`);
  }

  const lines = [
    "# MCP tool reference",
    "",
    `Generated by \`${generator}\` from the server's own tool definitions — do not edit by hand.`,
    "Run `node scripts/render-tool-reference.mjs` after adding or renaming a tool;",
    "CI runs the same script with `--check`.",
    "",
    `**${tools.length} tools** in ${GROUPS.length} groups, ${readOnly.size} of them read-only.`,
    "",
    "Read-only tools carry `readOnlyHint` in their MCP annotations: a client that asks",
    "for permission per call can let them through without prompting.",
    "",
    "## Capability profiles",
    "",
    "The groups below organise this document. **Capability profiles** organise the",
    "server: `AI_DEV_PROFILES` narrows what `tools/list` advertises to the slices a",
    "session will actually use, so a model does not carry schema text for tools it is",
    "never going to call. Unset, every profile is on and nothing is hidden.",
    "",
    "Narrowing affects the listing only — `tools/call` still accepts every tool by name.",
    "",
    "| Profile | Tools | What it adds |",
    "| --- | --- | --- |",
    ...TOOL_PROFILES.map((profile) => {
      const note = profile.always ? " *(always on)*" : "";
      return `| \`${profile.id}\` | ${profile.tools.length} | ${cell(profile.summary)}${note} |`;
    }),
    "",
    "## Contents",
    ""
  ];
  for (const group of GROUPS) {
    const anchor = group.title.toLowerCase().replaceAll(/[^a-z0-9 ]/g, "").replaceAll(" ", "-");
    lines.push(`- [${group.title}](#${anchor}) — ${group.tools.length} tool${group.tools.length === 1 ? "" : "s"}`);
  }
  for (const group of GROUPS) {
    lines.push("", `## ${group.title}`, "", `**When to call:** ${group.when}`, "");
    lines.push("| Tool | Profile | Read-only | Required arguments | What it does |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const name of group.tools) {
      const tool = byName.get(name);
      if (!tool) continue;
      const flag = readOnly.has(name) ? "yes" : "no";
      const profile = profileOfTool(name) ?? "—";
      lines.push(`| \`${name}\` | \`${profile}\` | ${flag} | ${requiredArguments(tool)} | ${cell(tool.description)} |`);
    }
  }
  lines.push("");
  return { markdown: `${lines.join("\n")}`, problems };
}

const check = process.argv.includes("--check");
const { markdown, problems } = render();
if (problems.length) {
  console.error(["Tool reference is out of sync:", ...problems.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}

// The control tools' own document: their inputs and the answers they promise.
const control = renderControlApi(tools.filter((tool) => profileOfTool(tool.name) === "control"), new Set(READ_ONLY_TOOL_NAMES));
const documents = [
  { file: target, name: "docs/TOOLS.md", markdown },
  { file: path.join(root, "docs", "CONTROL-API.md"), name: "docs/CONTROL-API.md", markdown: control }
];
let stale = false;
for (const document of documents) {
  const current = await fs.readFile(document.file, "utf8").catch(() => null);
  if (check) {
    if (current === document.markdown) {
      console.log(JSON.stringify({ status: "current", document: document.name, tools: tools.length }, null, 2));
    } else {
      console.error(`${document.name} is ${current === null ? "missing" : "stale"}. Run \`node ${generator}\` and commit the result.`);
      stale = true;
    }
  } else if (current === document.markdown) {
    console.log(JSON.stringify({ status: "unchanged", document: document.name, tools: tools.length }, null, 2));
  } else {
    await fs.mkdir(path.dirname(document.file), { recursive: true });
    await fs.writeFile(document.file, document.markdown, "utf8");
    console.log(JSON.stringify({ status: "written", document: document.name, tools: tools.length }, null, 2));
  }
}
if (stale) process.exit(1);
