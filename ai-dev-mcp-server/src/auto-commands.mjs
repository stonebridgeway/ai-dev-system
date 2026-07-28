export const autoCommands = [
  {
    name: "format_project_for_ai",
    display_name: "оформи проект для ИИ",
    aliases: [
      "оформи проект для ии",
      "оформи проект под ии",
      "оформи репозиторий для ии",
      "оформи репозиторий под ии",
      "подключи проект к ии",
      "подключи проект к агенту",
      "инициализируй проект для агента",
      "инициализируй проект для ии",
      "собери контекст проекта",
      "сделай ai handoff проекта",
      "сделай handoff проекта",
      "отформатируй проект для ии",
      "форматни проект для ии",
      "ai project setup",
      "format project for ai",
      "make project agent ready",
      "make repository agent ready",
      "ai-ready project",
      "project handoff"
    ],
    purpose: "Turn an opened new or old repository into an AI-ready workspace with agent files, Obsidian registration, searchable context, skill routing, and a concise project brief.",
    tools: [
      "match_auto_command",
      "read_auto_command",
      "prepare_project",
      "project_identity",
      "compile_project_context",
      "project_context_status",
      "register_project",
      "read_project",
      "search_projects",
      "recommend_skills",
      "read_skill_card",
      "preset_search",
      "refresh_project_memory",
      "rebuild_search_index",
      "run_quality_gate"
    ],
    skills: ["repo-onboarding", "knowledge-curator", "code-reviewer"],
    required_context: [
      "real repository root",
      "git status",
      "AGENTS.md",
      ".ai-dev/README.md",
      ".ai-dev/project-brief.md",
      ".ai-dev/project-map.md",
      ".ai-dev/quality-gate.md",
      "Obsidian project card",
      "detected stack and commands",
      "recommended skills"
    ],
    steps: [
      "Resolve the real project root. Prefer `git rev-parse --show-toplevel`; if the folder is not a git repo, use clear project markers such as package.json, pyproject.toml, src/, app/, or README.md.",
      "Take a lightweight safety snapshot: inspect current path, git status when available, and obvious project markers. Do not clean, reset, format, or modify application code.",
      "Run prepare_project with overwrite=false, include_project_brief=true, include_project_map=true, and include_quality_gate=true. This creates or preserves AGENTS.md, .ai-dev/README.md, .ai-dev/project-brief.md, .ai-dev/project-map.md, and .ai-dev/quality-gate.md.",
      "If the repository cannot be written safely, use register_project instead and explain that repo-local agent files were not created.",
      "Read the created or existing AGENTS.md, .ai-dev/project-brief.md, .ai-dev/project-map.md, .ai-dev/quality-gate.md, and the synced Obsidian project card.",
      "Run recommend_skills for onboarding and normal development with project_path set. Prefer reading skill cards before full skills when card_path is available.",
      "Use project/search context to identify important folders, entry points, commands, tests, quality gaps, side-effectful scripts, and integration risks.",
      "Rebuild or confirm the search index through prepare_project output; if needed, run rebuild_search_index once after the project card and agent files exist.",
      "Optionally run run_quality_gate in dry_run mode or read-only mode to show available checks. Do not run commands that call external services, publish, migrate production data, or spend API credits without explicit approval.",
      "Finish with a Project Brief that mirrors .ai-dev/project-brief.md and can be pasted into a new AI chat."
    ],
    guardrails: [
      "Do not edit application code, dependencies, lockfiles, formatting, tests, or config while formatting the project for AI.",
      "Do not overwrite existing AGENTS.md or .ai-dev files without explicit permission.",
      "Do not load the whole repository into chat context. Build maps and indexes, then retrieve only relevant context through MCP/search.",
      "Do not store secrets, tokens, API keys, cookies, private environment values, or credentials in Obsidian notes.",
      "Do not run destructive commands, production migrations, publish/deploy scripts, payment/Telegram/LLM calls, or other side-effectful commands without approval.",
      "If project root detection is ambiguous, stop and ask for the intended root before writing files."
    ],
    completion_report: [
      "Project identity: name, root path, git status summary, and whether repo-local agent files were created or already existed.",
      "Stack and architecture: detected technologies, important directories, entry points, and data/service boundaries.",
      "Command map: install, dev, test, lint, typecheck, build, and quality gate commands with missing items called out.",
      "Agent memory files: AGENTS.md, .ai-dev/README.md, .ai-dev/project-brief.md, .ai-dev/project-map.md, .ai-dev/quality-gate.md, and Obsidian project card path.",
      "Recommended skills: the short list the agent should use for future feature, bugfix, review, frontend, and knowledge tasks.",
      "Risks and gaps: missing tests/checks, dangerous scripts, unclear architecture, external side effects, secrets risk, or documentation gaps.",
      "Next best command: one of `начни новую фичу`, `найди баг`, `сделай ревью`, `улучши frontend/design`, or `обнови базу знаний`."
    ]
  },
  {
    name: "prepare_repository",
    display_name: "подготовь проект",
    aliases: ["подготовь проект", "подготовить проект", "подготовь репозиторий", "подготовить репозиторий", "bootstrap repo", "repo onboarding", "prepare repository", "prepare project"],
    purpose: "Bootstrap or audit a repository so agents can work with a local AGENTS.md, project map, quality gate, and skill routing.",
    tools: ["prepare_project", "bootstrap_project", "sync_project_card", "rebuild_search_index", "recommend_skills", "search_knowledge", "read_knowledge"],
    skills: ["repo-onboarding", "knowledge-curator"],
    required_context: ["repository root", "AGENTS.md", ".ai-dev/project-map.md", ".ai-dev/quality-gate.md", "package/project scripts"],
    steps: [
      "Resolve the real project root, preferably the git root.",
      "Run prepare_project with overwrite=false unless the user explicitly allows overwriting.",
      "Read AGENTS.md, .ai-dev/project-map.md, and .ai-dev/quality-gate.md.",
      "Detect stack, important commands, risky scripts, and missing quality gates.",
      "Confirm the project card was registered or synced in Obsidian.",
      "Confirm the search index was rebuilt.",
      "Report what was created, what already existed, and the next practical improvements."
    ],
    guardrails: [
      "Do not change application code during repository preparation.",
      "Do not overwrite existing AGENTS.md or .ai-dev files without permission.",
      "Do not run commands that may call external services unless the user approves."
    ]
  },
  {
    name: "refresh_project_memory",
    display_name: "обнови память проекта",
    aliases: [
      "обнови память проекта",
      "обнови карту проекта",
      "обнови project memory",
      "обнови project brief",
      "обнови project-map",
      "пересобери память проекта",
      "пересобери контекст проекта",
      "refresh project memory",
      "update project memory",
      "refresh project brief",
      "refresh project map"
    ],
    purpose: "Refresh the cached AI handoff for an existing repository after architecture, commands, docs, quality gates, or risks have changed.",
    tools: [
      "refresh_project_memory",
      "refresh_project_map",
      "sync_project_card",
      "rebuild_search_index",
      "read_project",
      "recommend_skills"
    ],
    skills: ["repo-onboarding", "knowledge-curator", "code-reviewer"],
    required_context: [
      "repository root",
      ".ai-dev/project-brief.md",
      ".ai-dev/project-map.md",
      ".ai-dev/quality-gate.md",
      "Obsidian project card",
      "search index"
    ],
    steps: [
      "Resolve the real project root, preferably the git root.",
      "Inspect current git status and project markers without changing application code.",
      "Run refresh_project_memory with overwrite=true, update_registry=true, register_if_missing=true, and rebuild_search=true.",
      "Confirm .ai-dev/project-brief.md and .ai-dev/project-map.md were refreshed.",
      "Confirm the Obsidian project card and search index were updated.",
      "Report changed memory files, detected project profile, quality gaps, risk signals, and recommended next commands."
    ],
    guardrails: [
      "Do not edit application code, dependencies, lockfiles, tests, or formatting.",
      "Do not run external-service, deploy, migration, notification, payment, or paid-LLM scripts.",
      "Do not copy secrets or local env values into project memory.",
      "If root detection is ambiguous, ask for the intended project root before writing files."
    ],
    completion_report: [
      "Memory files refreshed: .ai-dev/project-brief.md and .ai-dev/project-map.md.",
      "Registry/search status: Obsidian card and search index updated or skipped with reason.",
      "Current project profile: frontend/backend/mobile/bot/API, stack, commands, docs, env risks.",
      "Quality gaps and risk signals.",
      "Recommended next command."
    ]
  },
  {
    name: "start_feature",
    display_name: "начни новую фичу",
    aliases: ["начни новую фичу", "добавь фичу", "реализуй фичу", "new feature", "implement feature", "build feature"],
    purpose: "Implement a product or developer feature with local project rules, focused tests, and the relevant quality gate.",
    tools: [
      "begin_task",
      "compile_project_context",
      "checkpoint_task",
      "verify_task",
      "complete_task",
      "recommend_skills",
      "search_knowledge",
      "read_skill",
      "append_knowledge_note"
    ],
    skills: ["feature-builder", "code-reviewer", "knowledge-curator"],
    required_context: ["AGENTS.md", "project map", "quality gate", "nearby implementation patterns", "tests for touched behavior"],
    steps: [
      "Call begin_task with the real repository root; inspect its bounded context pack, acceptance criteria, and routed skills.",
      "Read project rules and inspect nearby code before designing the change.",
      "Use recommend_skills and read feature-builder when behavior changes.",
      "Plan the smallest implementation that fits existing architecture.",
      "Implement in focused edits without unrelated refactors.",
      "Add or update tests for changed shared logic and user-visible behavior.",
      "Checkpoint changed files and criterion evidence, run verify_task, and complete only after current-state evidence passes.",
      "Update knowledge only for durable facts."
    ],
    guardrails: [
      "Do not introduce new dependencies without clear benefit.",
      "Do not expand scope into unrelated cleanup.",
      "Do not leave TODO placeholders in final implementation."
    ]
  },
  {
    name: "investigate_bug",
    display_name: "найди баг",
    aliases: ["найди баг", "исправь баг", "почини ошибку", "bug", "debug", "fix failure", "investigate bug"],
    purpose: "Find root cause before editing, add regression coverage where possible, and verify the fix with the narrowest useful checks.",
    tools: [
      "begin_task",
      "compile_project_context",
      "checkpoint_task",
      "verify_task",
      "complete_task",
      "recommend_skills",
      "search_knowledge",
      "read_skill"
    ],
    skills: ["bugfix-investigator", "code-reviewer"],
    required_context: ["error text", "logs or reproduction steps", "touched code path", "existing tests", "quality gate"],
    steps: [
      "Call begin_task with the exact failure signal and inspect the bounded context pack.",
      "Reproduce or reason from the exact failure signal before changing code.",
      "Trace the smallest failing path and identify root cause.",
      "Add a regression test when practical.",
      "Apply the minimal fix in the owner module.",
      "Checkpoint the regression evidence, run the failing test/check first, then verify_task and broader quality gate if risk warrants it.",
      "Report root cause, fix, and remaining risk."
    ],
    guardrails: [
      "Do not hide failures by weakening tests or broad exception handling.",
      "Do not change public behavior without naming the compatibility risk.",
      "Do not patch around symptoms when root cause is discoverable."
    ]
  },
  {
    name: "review_changes",
    display_name: "сделай ревью",
    aliases: ["сделай ревью", "проверь код", "проверь diff", "review code", "review pr", "code review"],
    purpose: "Review code, diffs, or PRs with findings first: bugs, regressions, missing tests, security risks, and maintainability risks.",
    tools: ["recommend_skills", "search_knowledge", "read_skill"],
    skills: ["code-reviewer"],
    required_context: ["diff or changed files", "project rules", "tests touched or missing", "risk areas"],
    steps: [
      "Read project rules and inspect the changed files plus nearby contracts.",
      "Prioritize correctness, regressions, security, data loss, and missing tests.",
      "Provide findings first with file and line references when available.",
      "Separate open questions from confirmed issues.",
      "Keep summary secondary and concise.",
      "Do not edit code unless the user explicitly asks to address findings."
    ],
    guardrails: [
      "Do not lead with praise or a generic summary.",
      "Do not report style preferences as defects unless they create real risk.",
      "Do not miss test gaps for changed behavior."
    ]
  },
  {
    name: "generate_frontend_references",
    display_name: "сгенерируй референсы для проекта",
    aliases: [
      "сгенерируй референсы для проекта",
      "сгенерируй референс для проекта",
      "создай визуальные референсы",
      "создай референсы интерфейса",
      "сделай референс для сайта",
      "сгенерируй дизайн референс",
      "референсов нет создай их",
      "generate frontend references",
      "generate visual references",
      "create interface references",
      "reference factory"
    ],
    purpose: "Create product-specific visual directions when no approved external reference exists, validate the generated PNG artifacts, and feed only the chosen direction into Frontend Product Quality v2.",
    tools: [
      "frontend_product_builder",
      "prepare_frontend_product",
      "update_frontend_product_brief",
      "plan_frontend_references",
      "register_frontend_references",
      "reference_factory_status",
      "record_frontend_concept_jury",
      "approve_frontend_direction",
      "approve_frontend_design_system",
      "frontend_product_gate"
    ],
    skills: ["frontend-product-builder"],
    required_context: [
      "product audience and primary task",
      "business goal",
      "real content and data sources",
      "brand constraints",
      "screen scope",
      "required states",
      "web, application, or mobile surface"
    ],
    steps: [
      "Call frontend_product_builder and use exactly its three selected skills.",
      "Prepare Frontend Product Quality when needed and complete the truthful design brief before generation.",
      "Call plan_frontend_references with stage=concepts. Use its manifest as the source of truth for prompts, sizes, output paths, and prompt hashes.",
      "Call ImageGen or Figma for every artifact job. Save PNG files at the exact output paths and inspect every image with view_image, browser, or Figma.",
      "Reject and regenerate generic, duplicated, illegible, fabricated, or off-brief images before registration.",
      "Call register_frontend_references with concrete per-image observations. It automatically registers candidate references and two or three directions.",
      "Have an independent reviewer compare every concept across all Concept Jury dimensions and record exactly one recommendation.",
      "Approve exactly the jury-recommended direction. Do not treat palette-only variants as distinct.",
      "Call plan_frontend_references with stage=coverage, generate and inspect only the approved direction, then register the baseline set.",
      "Complete and approve the project design system only after Reference Factory coverage is registered."
    ],
    guardrails: [
      "The MCP server plans and validates; it must never claim that ImageGen or Figma ran when the client did not call them.",
      "Do not register a missing, non-PNG, undersized, duplicate, uninspected, or prompt-unbound artifact.",
      "Do not invent testimonials, customers, ratings, metrics, certifications, screenshots, or product claims.",
      "Do not auto-approve a direction or design system merely because files exist.",
      "Do not approve a Reference Factory direction without a current independent Concept Jury review.",
      "Do not generate full baseline coverage for all concepts; expand only the approved direction."
    ]
  },
  {
    name: "build_frontend_product",
    display_name: "build frontend product",
    aliases: [
      "build frontend product",
      "frontend product builder",
      "design first frontend",
      "anti slop frontend",
      "create product interface",
      "build ui without ai slop"
    ],
    purpose: "Build or redesign a frontend through product context, two or three visual directions, an approved design system, implementation, strict visual comparison, and independent review.",
    tools: [
      "frontend_product_builder",
      "prepare_frontend_product",
      "update_frontend_product_brief",
      "plan_frontend_references",
      "register_frontend_references",
      "reference_factory_status",
      "record_frontend_concept_jury",
      "record_frontend_directions",
      "approve_frontend_direction",
      "approve_frontend_design_system",
      "frontend_product_gate",
      "run_visual_reference_qa",
      "record_visual_review",
      "run_quality_gate"
    ],
    skills: ["frontend-product-builder"],
    required_context: [
      "product audience and primary task",
      "business goal and real content sources",
      "two or three visual directions",
      "approved references",
      "project design system",
      "screen, viewport, and state matrix"
    ],
    steps: [
      "Call frontend_product_builder and use only its three selected compatible skills.",
      "Run prepare_frontend_product, then complete product context and register real references.",
      "When no approved references exist, use Reference Factory to plan, generate, inspect, and register two or three concept directions.",
      "Run an independent Concept Jury for generated concepts, approve its recommended direction, complete the design system, UI inventory, and visual acceptance documents, then approve the design system before editing product code.",
      "Call frontend_product_gate with gate=implementation and stop if it blocks.",
      "Implement the approved direction with real content, assets, responsive behavior, and required states.",
      "Run run_visual_reference_qa against immutable approved baselines.",
      "Have an independent reviewer inspect every screenshot, baseline, and diff, then record all ten scorecard dimensions.",
      "Pass frontend_product_gate with gate=handoff and the repository quality gate before delivery."
    ],
    guardrails: [
      "Never load or mix more than three frontend skills.",
      "Do not write frontend product code before direction and design-system approval.",
      "Do not approve a generated direction without an independent dimension-level Concept Jury comparison.",
      "Do not auto-update approved visual baselines during QA.",
      "Do not replace visual inspection with a screenshot file-exists check or one overall score.",
      "Do not waive an anti-slop rule without a product-specific rationale and approver."
    ]
  },
  {
    name: "improve_frontend_design",
    display_name: "улучши frontend/design",
    aliases: ["улучши frontend/design", "улучши frontend", "улучши дизайн", "сделай красиво", "ui polish", "frontend polish", "redesign"],
    purpose: "Improve frontend UX/UI quality with project patterns, responsive checks, state coverage, and design skills when visual quality matters.",
    tools: [
      "frontend_product_builder",
      "prepare_frontend_product",
      "update_frontend_product_brief",
      "record_frontend_directions",
      "approve_frontend_direction",
      "approve_frontend_design_system",
      "frontend_product_gate",
      "run_visual_reference_qa",
      "record_visual_review",
      "run_quality_gate",
      "query_ui_ux_knowledge"
    ],
    skills: ["frontend-product-builder"],
    required_context: ["product context", "real references", "approved direction", "project design system", "target screens and states", "visual acceptance"],
    steps: [
      "Call frontend_product_builder in redesign mode and use only its selected skills.",
      "Prepare or update the mandatory brief, references, design system, UI inventory, and visual acceptance files.",
      "Create two or three visual directions from real product constraints and approve one before code changes.",
      "Pass the implementation gate, then improve the UI using the approved system and real assets.",
      "Run strict visual reference QA for desktop, mobile, and every required state.",
      "Require independent artifact inspection and the full Product Design Scorecard.",
      "Pass the handoff and repository quality gates."
    ],
    guardrails: [
      "Do not mix several generated styles, palettes, or typography systems.",
      "Do not start implementation before visual and design-system approval.",
      "Do not claim visual verification until every artifact was actually inspected.",
      "Do not use an overall design score in place of dimension evidence."
    ]
  },
  {
    name: "maintain_beta_frontend",
    display_name: "поддержи frontend/beta",
    aliases: [
      "поддержи frontend/beta",
      "поддержи фронтенд",
      "поддержи beta frontend",
      "поправь beta frontend",
      "почини верстку",
      "поправь экран",
      "поправь компонент",
      "frontend support",
      "beta frontend task",
      "maintain frontend",
      "frontend maintenance",
      "ui support task"
    ],
    purpose: "Handle support work in an existing beta or production-like frontend with minimal safe diffs, existing patterns, and browser-aware verification.",
    tools: ["recommend_skills", "read_skill_card", "read_skill", "preset_search", "search_projects", "run_quality_gate", "run_frontend_qa"],
    skills: ["beta-frontend-maintainer", "frontend-quality-gate", "code-reviewer"],
    required_context: ["AGENTS.md", ".ai-dev/project-brief.md", ".ai-dev/project-map.md", ".ai-dev/quality-gate.md", "changed screen/component", "existing UI patterns"],
    steps: [
      "Read project AI-dev files and current git status before editing.",
      "Use recommend_skills and read beta-frontend-maintainer before implementation.",
      "Classify the task as visual, interaction, API-bound UI, copy/content, responsive, or regression.",
      "Reuse existing components, hooks, tokens, layout primitives, and API clients.",
      "Make the smallest safe diff that solves the support task.",
      "Check relevant UI states and run frontend-quality-gate plus run_frontend_qa when the visual surface changed and the app can run.",
      "Report changed files, checks, browser viewports, and any unverified assumptions."
    ],
    guardrails: [
      "Do not turn a support task into a broad redesign.",
      "Do not change backend/API contracts unless the UI task requires it.",
      "Do not edit secrets, production config, analytics, payments, auth, or deploy scripts without explicit approval.",
      "Do not claim browser, accessibility, or performance verification unless actually checked."
    ]
  },
  {
    name: "frontend_quality_gate",
    display_name: "проверь frontend quality gate",
    aliases: [
      "проверь frontend quality gate",
      "проверь фронтенд перед сдачей",
      "проверь ui перед сдачей",
      "проверь верстку",
      "frontend quality gate",
      "ui quality gate",
      "frontend qa",
      "verify frontend",
      "browser qa",
      "accessibility check",
      "responsive qa"
    ],
    purpose: "Verify frontend changes before handoff or release with static checks, browser QA, accessibility, responsive behavior, and performance-risk review.",
    tools: ["frontend_product_builder", "frontend_product_gate", "run_quality_gate", "run_visual_reference_qa", "record_visual_review", "preset_search"],
    skills: ["frontend-product-builder", "frontend-quality-gate"],
    required_context: ["changed files or screen", ".ai-dev/quality-gate.md", "package scripts", "expected behavior", "browser access if app runs"],
    steps: [
      "Read .ai-dev/quality-gate.md and project scripts.",
      "Call frontend_product_builder and read only its selected skills.",
      "Identify touched routes, components, forms, breakpoints, and user roles.",
      "Run relevant lint, typecheck, test, and build checks when available.",
      "Run run_visual_reference_qa for desktop/mobile, state screenshots, approved-baseline diffs, accessibility, and anti-slop evidence.",
      "Inspect every screenshot, baseline, and diff before calling record_visual_review.",
      "Check loading, empty, error, focus, disabled, validation, and success states when relevant.",
      "Return the handoff gate plus separate evidence for every Product Design Scorecard dimension."
    ],
    guardrails: [
      "Do not mark pass when the build is broken or the touched screen was not inspectable.",
      "Do not hide skipped browser/accessibility checks.",
      "Do not run production mutations, real payments, deploys, or destructive admin flows for QA."
    ]
  },
  {
    name: "review_landing_conversion",
    display_name: "проверь лендинг/конверсию",
    aliases: [
      "проверь лендинг/конверсию",
      "проверь лендинг",
      "улучши конверсию лендинга",
      "разбери лендинг",
      "landing conversion review",
      "review landing conversion",
      "improve landing conversion",
      "cro review",
      "landing page audit",
      "cta review"
    ],
    purpose: "Review or improve a landing page for clear offer, trust, CTA flow, proof, SEO basics, mobile readability, and ethical conversion.",
    tools: ["recommend_skills", "read_skill_card", "read_skill", "preset_search", "run_quality_gate", "run_frontend_qa"],
    skills: ["landing-conversion-reviewer", "design-taste-frontend", "frontend-quality-gate"],
    required_context: ["landing page route or files", "offer/audience/CTA if known", "brand constraints", "proof assets", "browser or screenshot verification"],
    steps: [
      "Use recommend_skills and read landing-conversion-reviewer.",
      "Identify offer, audience, conversion goal, traffic temperature, proof, and assumptions.",
      "Review above-the-fold clarity, trust, objections, CTA flow, mobile behavior, and SEO basics.",
      "If implementing, reuse the existing design system and keep claims truthful.",
      "Verify desktop/mobile and run frontend-quality-gate plus run_frontend_qa for changed page code when the app can run.",
      "Report prioritized findings or changed files, checks, and residual risks."
    ],
    guardrails: [
      "Do not invent testimonials, logos, metrics, certifications, or scarcity.",
      "Do not use dark patterns or misleading urgency.",
      "Do not optimize conversion at the cost of accessibility, truthfulness, or user trust."
    ]
  },
  {
    name: "audit_skill_library",
    display_name: "проверь библиотеку скиллов",
    aliases: [
      "проверь библиотеку скиллов",
      "проверь качество скиллов",
      "провалидируй скиллы",
      "аудит скиллов",
      "skill library audit",
      "validate skills",
      "validate skill library",
      "check skill quality"
    ],
    purpose: "Validate the complete skill catalog with Skill Schema v2, surface weak or generic entries, inspect duplicate candidates, and refresh the quality dashboard.",
    tools: ["rebuild_index", "validate_skill_library", "rebuild_search_index", "system_health_check", "search_skills", "read_skill_card"],
    skills: ["knowledge-curator", "code-reviewer"],
    required_context: ["skill source registry", "Skill Schema v2", "taxonomy", "quality report", "duplicate policy"],
    steps: [
      "Run rebuild_index when skill sources changed so every entry has current Schema v2 metadata and taxonomy.",
      "Run validate_skill_library with duplicate analysis and write_report enabled.",
      "Review local custom-skill failures first, then source-read or relationship errors, then low-specificity upstream findings.",
      "Treat exact duplicates as review candidates. Do not delete near duplicates without reading both sources and confirming ownership.",
      "Rebuild the search index after report or catalog changes so quality metadata is searchable.",
      "Run system_health_check and report schema coverage, important-skill maturity, errors, dominant findings, and duplicate counts."
    ],
    guardrails: [
      "Do not edit or delete upstream skill sources automatically because a deterministic score is low.",
      "Do not treat trust_level as proof that source instructions are secure or correct.",
      "Do not compare thousands of templated integration skills pairwise; use the generic-description signal and exact-copy policy.",
      "Do not mark the audit complete while a local custom skill fails Schema v2."
    ],
    completion_report: [
      "Registry and Schema v2 coverage.",
      "Custom-skill validated count and failures.",
      "Score distribution and dominant finding codes.",
      "Exact and near duplicate candidates.",
      "Quality report, dashboard, search-index, and health status."
    ]
  },
  {
    name: "update_knowledge_base",
    display_name: "обнови базу знаний",
    aliases: ["обнови базу знаний", "запиши в obsidian", "сохрани выводы", "обнови knowledge", "update knowledge", "write notes"],
    purpose: "Write durable project or system knowledge to Obsidian without turning transient task chatter into permanent notes.",
    tools: ["search_knowledge", "read_knowledge", "write_knowledge_note", "append_knowledge_note", "rebuild_index"],
    skills: ["knowledge-curator"],
    required_context: ["durable facts", "target note", "project card if project-specific", "source of truth"],
    steps: [
      "Extract only durable facts: commands, architecture decisions, risks, standards, and project-specific lessons.",
      "Search existing notes before creating a new one.",
      "Append to the most specific existing note when possible.",
      "Create a new note only when it has a clear long-term owner.",
      "Rebuild indexes only when skill sources or registries changed.",
      "Report the notes changed."
    ],
    guardrails: [
      "Do not store secrets, tokens, API keys, or private credentials.",
      "Do not save speculative guesses as facts.",
      "Do not duplicate the same fact across many notes."
    ]
  }
];
