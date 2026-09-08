const CORE_PROFILE = "core";
const FULL_PROFILE = "full";

const actionProperty = {
  type: "string",
  description: "Select the operation to perform.",
  minLength: 1
};

const stringProperty = { type: "string" };
const limitProperty = { type: "integer", minimum: 1, maximum: 50, default: 10 };

function schema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function coreTool(name, title, description, inputSchema = schema({}), readOnly = false) {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly }
  };
}

export function buildCoreToolDefinitions() {
  return [
    coreTool("trust_project", "Trust project", "Allow AI Dev to execute repository verification and development commands on this machine.", schema({ project_path: { type: "string", minLength: 1 } }, ["project_path"])),
    coreTool("search", "Search", "Search local knowledge, skills, projects, notes, or skill cards. Use scope, preset, and explain to refine the lookup.", schema({
      query: { type: "string", minLength: 1 },
      scope: { type: "string", enum: ["all", "knowledge", "skills", "projects", "notes", "cards"] },
      preset: { type: "string", enum: ["balanced", "code", "docs", "skills", "projects", "debug", "frontend", "quality"] },
      limit: limitProperty,
      project: stringProperty,
      source: stringProperty,
      categories: { type: "array", items: stringProperty },
      folders: { type: "array", items: stringProperty },
      explain: { type: "boolean", default: false }
    }, ["query"]), true),
    coreTool("search_index", "Search index", "Inspect or maintain the local search and embedding index.", schema({
      action: { ...actionProperty, enum: ["status", "rebuild", "eval", "embed", "embedding_status"] },
      query: stringProperty,
      include_external_project_files: { type: "boolean" },
      dense_embeddings: { type: "boolean" },
      preserve_dense: { type: "boolean" },
      text: { type: "array", items: stringProperty },
      model_dir: stringProperty,
      model_device: stringProperty
    }), true),
    coreTool("recommend_skills", "Recommend skills", "Recommend up to three relevant skills for a concrete task.", schema({
      task: { type: "string", minLength: 1 },
      project: stringProperty,
      project_path: stringProperty,
      limit: { type: "integer", minimum: 1, maximum: 3, default: 3 },
      include_membrane: { type: "boolean" },
      membrane_policy: stringProperty
    }, ["task"]), true),
    coreTool("read_skill", "Read skill", "Read one skill from the local registry.", schema({ name: { type: "string", minLength: 1 }, source: stringProperty }, ["name"]), true),
    coreTool("skills_admin", "Skills administration", "Manage the skill registry, taxonomy, overlays, cards, groups, and routing evaluations.", schema({
      action: { ...actionProperty, enum: ["rebuild_index", "rebuild_taxonomy", "validate", "sync_overlays", "list_overlays", "upsert_overlay", "routing_eval", "sync_cards", "list_cards", "search_cards", "read_card", "list_groups", "browse_group", "import_repo"] },
      name: stringProperty,
      source: stringProperty,
      query: stringProperty,
      group: stringProperty,
      subgroup: stringProperty,
      limit: limitProperty,
      include_duplicates: { type: "boolean" },
      include_semantic_duplicates: { type: "boolean" },
      write_report: { type: "boolean" },
      rebuild_registry: { type: "boolean" },
      sync_cards: { type: "boolean" },
      skill_name: stringProperty,
      repository_url: stringProperty
    }), true),
    coreTool("ui_ux", "UI and UX knowledge", "Query UI/UX knowledge or generate a design system from the local UI/UX source.", schema({
      action: { ...actionProperty, enum: ["query", "design_system"] },
      query: { type: "string", minLength: 1 },
      domain: stringProperty,
      stack: stringProperty,
      project_name: stringProperty,
      variance: { type: "integer", minimum: 0, maximum: 10 },
      motion: { type: "integer", minimum: 0, maximum: 10 },
      density: { type: "integer", minimum: 0, maximum: 10 },
      max_results: { type: "integer", minimum: 1, maximum: 50 }
    }, ["query"]), true),
    coreTool("system", "System operations", "Inspect system health and runtime state, refresh dashboards, or resolve auto-command runbooks.", schema({
      action: { ...actionProperty, enum: ["health", "rebuild_dashboard", "dashboard_status", "prepare_distribution", "distribution_status", "list_auto_commands", "match_auto_command", "read_auto_command"] },
      request: stringProperty,
      name: stringProperty,
      rebuild_search: { type: "boolean" },
      include_search_smoke: { type: "boolean" },
      include_embedding_status: { type: "boolean" },
      include_search_eval: { type: "boolean" },
      include_presets: { type: "boolean" },
      limit: limitProperty
    }), true),
    coreTool("project", "Project operations", "Inspect, register, prepare, and refresh project context and project cards.", schema({
      action: { ...actionProperty, enum: ["identity", "list", "read", "register", "sync", "update", "refresh_map", "refresh_memory", "analyze", "compile_context", "context_status", "bootstrap"] },
      project_path: stringProperty,
      project_name: stringProperty,
      name: stringProperty,
      description: stringProperty,
      status: stringProperty,
      notes: stringProperty,
      relative_path: stringProperty,
      content: stringProperty,
      overwrite: { type: "boolean" },
      max_depth: { type: "integer", minimum: 0, maximum: 8 },
      task: stringProperty,
      acceptance_criteria: { type: "array", items: stringProperty }
    }), true),
    coreTool("prepare_project", "Prepare project", "Create or refresh the bounded AI project context and quality-gate files.", schema({
      project_path: { type: "string", minLength: 1 },
      project_name: stringProperty,
      overwrite: { type: "boolean" },
      include_project_brief: { type: "boolean" },
      include_project_map: { type: "boolean" },
      include_quality_gate: { type: "boolean" },
      register_project: { type: "boolean" },
      rebuild_search: { type: "boolean" }
    }, ["project_path"])),
    coreTool("begin_task", "Begin task", "Start a bounded engineering task with context, acceptance criteria, and a Git-bound baseline.", schema({ project_path: stringProperty, project_name: stringProperty, task: stringProperty, acceptance_criteria: { type: "array", items: stringProperty } }, ["project_path", "task"])),
    coreTool("checkpoint_task", "Checkpoint task", "Record implementation progress and acceptance-criterion evidence.", schema({ task_id: stringProperty, summary: stringProperty, notes: stringProperty, changed_files: { type: "array", items: stringProperty }, criteria: { type: "array", items: { type: "object", additionalProperties: true } } }, ["task_id", "summary"])),
    coreTool("verify_task", "Verify task", "Run the project quality gate and bind evidence to the current repository state.", schema({ task_id: stringProperty, run_quality: { type: "boolean" }, run_frontend: { type: "boolean" }, frontend_options: { type: "object", additionalProperties: true }, quality_labels: { type: "array", items: stringProperty }, evidence: { type: "array", items: { type: "object", additionalProperties: true } } }, ["task_id"])),
    coreTool("complete_task", "Complete task", "Complete a task only when its current verification evidence satisfies every criterion.", schema({ task_id: stringProperty, summary: stringProperty, write_report: { type: "boolean" } }, ["task_id"])),
    coreTool("get_task", "Get task", "Read one task lifecycle record.", schema({ task_id: { type: "string", minLength: 1 } }, ["task_id"]), true),
    coreTool("list_tasks", "List tasks", "List task lifecycle records for the project.", schema({ project_path: stringProperty, status: { type: "string", enum: ["", "active", "complete", "blocked"] }, limit: limitProperty }), true),
    coreTool("run_quality_gate", "Run quality gate", "Run the repository's relevant quality checks.", schema({ project_path: { type: "string", minLength: 1 }, labels: { type: "array", items: stringProperty }, max_commands: { type: "integer", minimum: 1, maximum: 20 } }, ["project_path"])),
    coreTool("run_frontend_qa", "Run frontend QA", "Run browser-based frontend quality checks when a project exposes a runnable frontend.", schema({ project_path: { type: "string", minLength: 1 }, route: stringProperty, dev_command: stringProperty }), false),
    coreTool("frontend_product", "Frontend product", "Prepare, validate, and review a design-first frontend product workflow.", schema({
      action: { ...actionProperty, enum: ["builder", "plan_references", "register_references", "reference_status", "prepare", "update_brief", "record_directions", "approve_direction", "record_concept_jury", "approve_design_system", "gate", "visual_qa", "record_visual_review"] },
      project_path: stringProperty,
      task: stringProperty,
      mode: stringProperty,
      stage: stringProperty,
      direction_id: stringProperty,
      gate: stringProperty,
      references: { type: "array", items: { type: "object", additionalProperties: true } },
      screenshots: { type: "array", items: stringProperty }
    }), true),
    coreTool("pilot", "Project pilot", "Start, review, and inspect measured project or skill pilots.", schema({ action: { ...actionProperty, enum: ["start", "record_review", "status", "skill_outcomes", "rebuild_outcomes"] }, project_path: stringProperty, pilot_id: stringProperty, task_id: stringProperty, title: stringProperty, review: { type: "object", additionalProperties: true } }), true),
    coreTool("knowledge", "Knowledge", "Read, write, or append a Markdown knowledge note in an allowed folder.", schema({ action: { ...actionProperty, enum: ["read", "write", "append"] }, path: { type: "string", minLength: 1 }, content: stringProperty, heading: stringProperty, overwrite: { type: "boolean" } })),
    coreTool("diagram", "Architecture diagram", "Validate, render, deliver, compare, or inspect an architecture diagram.", schema({ action: { ...actionProperty, enum: ["doctor", "guide", "validate", "render", "deliver", "visual_check", "compare", "migrate", "brands"] }, project_path: stringProperty, scenario: stringProperty, spec: { type: "object", additionalProperties: true }, spec_path: stringProperty, artifact_path: stringProperty, artifact_location: { type: "string", enum: ["system", "project"] }, quality: { type: "string", enum: ["standard", "showcase"] }, output_path: stringProperty, url: stringProperty, old_path: stringProperty, new_path: stringProperty, query: stringProperty }), true)
  ];
}

const SEARCH_SCOPE_TOOLS = {
  knowledge: "search_knowledge",
  skills: "search_skills",
  projects: "search_projects",
  notes: "search_notes",
  cards: "search_skill_cards",
  all: "search_all"
};

const ACTIONS = {
  search_index: {
    status: "search_index_status",
    rebuild: "rebuild_search_index",
    eval: "run_search_eval",
    embed: "embed_texts",
    embedding_status: "embedding_status"
  },
  skills_admin: {
    rebuild_index: "rebuild_index",
    rebuild_taxonomy: "rebuild_skill_taxonomy",
    validate: "validate_skill_library",
    sync_overlays: "sync_skill_overlays",
    list_overlays: "list_skill_overlays",
    upsert_overlay: "upsert_skill_overlay",
    routing_eval: "run_skill_routing_eval",
    sync_cards: "sync_skill_cards",
    list_cards: "list_skill_cards",
    search_cards: "search_skill_cards",
    read_card: "read_skill_card",
    list_groups: "list_skill_groups",
    browse_group: "browse_skill_group",
    import_repo: "import_skill_repo"
  },
  system: {
    health: "system_health_check",
    rebuild_dashboard: "rebuild_system_dashboard",
    dashboard_status: "system_dashboard_status",
    prepare_distribution: "prepare_runtime_distribution",
    distribution_status: "runtime_distribution_status",
    list_auto_commands: "list_auto_commands",
    match_auto_command: "match_auto_command",
    read_auto_command: "read_auto_command"
  },
  project: {
    identity: "project_identity",
    list: "list_projects",
    read: "read_project",
    register: "register_project",
    sync: "sync_project_card",
    update: "update_project_card",
    refresh_map: "refresh_project_map",
    refresh_memory: "refresh_project_memory",
    analyze: "analyze_project",
    compile_context: "compile_project_context",
    context_status: "project_context_status",
    bootstrap: "bootstrap_project"
  },
  frontend_product: {
    builder: "frontend_product_builder",
    plan_references: "plan_frontend_references",
    register_references: "register_frontend_references",
    reference_status: "reference_factory_status",
    prepare: "prepare_frontend_product",
    update_brief: "update_frontend_product_brief",
    record_directions: "record_frontend_directions",
    approve_direction: "approve_frontend_direction",
    record_concept_jury: "record_frontend_concept_jury",
    approve_design_system: "approve_frontend_design_system",
    gate: "frontend_product_gate",
    visual_qa: "run_visual_reference_qa",
    record_visual_review: "record_visual_review"
  },
  pilot: {
    start: "start_project_pilot",
    record_review: "record_project_pilot_review",
    status: "project_pilot_status",
    skill_outcomes: "skill_outcome_status",
    rebuild_outcomes: "rebuild_skill_outcomes"
  },
  knowledge: {
    read: "read_knowledge",
    write: "write_knowledge_note",
    append: "append_knowledge_note"
  },
  diagram: {
    doctor: "archify_doctor",
    guide: "archify_guide",
    validate: "archify_validate",
    render: "archify_render",
    deliver: "archify_deliver",
    visual_check: "archify_visual_check",
    compare: "archify_compare",
    migrate: "archify_migrate",
    brands: "archify_brands"
  }
};

function withoutAction(args = {}) {
  const { action: _action, ...rest } = args;
  return rest;
}

export function resolveToolProfile(legacyTools) {
  return process.env.AI_DEV_TOOL_PROFILE?.toLowerCase() === FULL_PROFILE
    ? legacyTools
    : buildCoreToolDefinitions();
}

export function resolveCoreToolCall(name, args = {}) {
  if (name === "search") {
    if (args.explain) return { name: "explain_search", args: withoutAction(args) };
    if (args.preset) return { name: "preset_search", args: withoutAction(args) };
    return { name: SEARCH_SCOPE_TOOLS[args.scope || "all"] || "search_all", args: withoutAction(args) };
  }
  if (name === "search_index") return { name: ACTIONS.search_index[args.action || "status"], args: withoutAction(args) };
  if (name === "ui_ux") return { name: args.action === "design_system" ? "generate_ui_ux_design_system" : "query_ui_ux_knowledge", args: withoutAction(args) };
  const actionMap = ACTIONS[name];
  if (actionMap) {
    const target = actionMap[args.action || Object.keys(actionMap)[0]];
    if (!target) throw new Error(`Unknown action "${args.action}" for ${name}. Allowed: ${Object.keys(actionMap).join(", ")}`);
    return { name: target, args: withoutAction(args) };
  }
  return null;
}

export { CORE_PROFILE, FULL_PROFILE };
