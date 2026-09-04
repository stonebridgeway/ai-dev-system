import { ARCHIFY_TYPES } from "./core/archify.mjs";

export function buildToolDefinitions({
  CONCEPT_JURY_DIMENSIONS,
  FRONTEND_PRODUCT_MODES,
  PILOT_DIMENSIONS,
  PILOT_TASK_TYPES,
  PRODUCT_DESIGN_SCORECARD_DIMENSIONS,
  REFERENCE_FACTORY_GENERATORS,
  REFERENCE_FACTORY_SURFACES,
  UI_UX_PRO_MAX_DOMAINS,
  UI_UX_PRO_MAX_STACKS
}) {
  const ARCHIFY_EVIDENCE_SCHEMA = {
    type: "array",
    default: [],
    description: "Archify deliverables backing acceptance criteria. Pass the `evidence` object returned by archify_deliver / archify_visual_check verbatim.",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["archify_deliver", "archify_visual_check"] },
        html_path: { type: "string" },
        spec_sha256: { type: "string" },
        artifact_sha256: { type: "string" },
        quality: { type: "string" },
        errors: { type: "number" },
        warnings: { type: "number" },
        checks_passed: { type: "number" },
        check_count: { type: "number" },
        status: { type: "string" },
        containment_status: { type: "string" }
      },
      required: ["kind", "html_path"]
    }
  };
  return [
  {
    name: "search_knowledge",
    description: "Search Markdown knowledge files in the AI Dev System vault.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "read_knowledge",
    description: "Read a Markdown knowledge file by path relative to the AI Dev System root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "search_skills",
    description: "Search the machine skill registry, including custom, design, and Membrane skills.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
        source: { type: "string" },
        group: { type: "string", description: "Optional taxonomy group id or alias, such as frontend or backend." },
        subgroup: { type: "string", description: "Optional taxonomy subgroup id." },
        maturity: { type: "string" },
        trust_level: { type: "string" },
        quality_status: { type: "string" },
        min_quality: { type: "number", default: 0 }
      },
      required: ["query"]
    }
  },
  {
    name: "read_skill",
    description: "Read a skill by name from the combined skill registry.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        source: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "recommend_skills",
    description: "Recommend a minimal project-aware set of skills for a development, design, integration, review, or quality task.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        limit: { type: "number", default: 3, maximum: 3 },
        project: { type: "string" },
        project_path: { type: "string" },
        membrane_policy: { type: "string", default: "auto" },
        include_membrane: { type: "boolean", default: false },
        preferred_groups: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Optional preferred taxonomy groups. Automatic task-based group routing is still applied."
        }
      },
      required: ["task"]
    }
  },
  {
    name: "query_ui_ux_knowledge",
    description: "Query the pinned local UI UX Pro Max dataset for focused product, UX, style, color, typography, chart, icon, motion, web, or stack guidance. Results are recommendations, not visual proof.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "A concrete UI/UX question or product context."
        },
        domain: {
          type: "string",
          enum: [...UI_UX_PRO_MAX_DOMAINS],
          description: "Optional knowledge domain. Do not combine with stack."
        },
        stack: {
          type: "string",
          enum: [...UI_UX_PRO_MAX_STACKS],
          description: "Optional implementation stack. Do not combine with domain."
        },
        max_results: {
          type: "number",
          minimum: 1,
          maximum: 10,
          default: 3
        }
      },
      required: ["query"]
    }
  },
  {
    name: "generate_ui_ux_design_system",
    description: "Generate a product-specific UI/UX design-system draft from the pinned local dataset. Optionally persist it only to .ai-dev/frontend/design-system.md inside a validated project. Rendering and browser QA remain required.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Product type, industry, audience, main task, tone, density, motion, and constraints."
        },
        project_name: { type: "string", maxLength: 120 },
        variance: { type: "number", minimum: 1, maximum: 10 },
        motion: { type: "number", minimum: 1, maximum: 10 },
        density: { type: "number", minimum: 1, maximum: 10 },
        project_path: {
          type: "string",
          description: "Absolute project root. Required only when persist=true."
        },
        persist: { type: "boolean", default: false },
        overwrite: { type: "boolean", default: false }
      },
      required: ["query"]
    }
  },
  {
    name: "list_skill_groups",
    description: "List the skill taxonomy domains, subgroup counts, related domains, examples, and Obsidian group notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional query for finding a domain by intent." },
        include_empty: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "browse_skill_group",
    description: "Browse and rank skills inside one taxonomy group and optional subgroup before reading a full skill.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string" },
        subgroup: { type: "string" },
        query: { type: "string" },
        source: { type: "string" },
        maturity: { type: "string" },
        trust_level: { type: "string" },
        quality_status: { type: "string" },
        min_quality: { type: "number", default: 0 },
        limit: { type: "number", default: 30 }
      },
      required: ["group"]
    }
  },
  {
    name: "rebuild_skill_taxonomy",
    description: "Reclassify the current skill registry, regenerate group indexes and Obsidian MOC notes, and optionally refresh curated skill cards.",
    inputSchema: {
      type: "object",
      properties: {
        sync_cards: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "validate_skill_library",
    description: "Validate source SKILL.md files with Schema v2, source-aware quality scoring, relationship checks, and duplicate analysis; optionally write the Obsidian quality dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Optional source substring such as custom or membrane." },
        group: { type: "string", description: "Optional taxonomy group or alias." },
        min_score: { type: "number", default: 0 },
        include_duplicates: { type: "boolean", default: true },
        include_semantic_duplicates: { type: "boolean", default: false, description: "Use BGE-M3 only to refine lexically suspicious non-Membrane pairs." },
        duplicate_threshold: { type: "number", default: 0.82 },
        max_issues: { type: "number", default: 200 },
        write_report: { type: "boolean", default: true },
        refresh_registry: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "sync_skill_overlays",
    description: "Create or refresh local source-policy overlays that normalize routing without modifying upstream SKILL.md files.",
    inputSchema: {
      type: "object",
      properties: {
        rebuild_registry: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "list_skill_overlays",
    description: "Read skill normalization policies, specific overrides, coverage, priorities, and orphan targets.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        name: { type: "string" }
      }
    }
  },
  {
    name: "upsert_skill_overlay",
    description: "Add a reviewed local metadata override for one registered skill and optionally rebuild generated registries.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        name: { type: "string" },
        reviewer: { type: "string" },
        rebuild_registry: { type: "boolean", default: true },
        overlay: {
          type: "object",
          additionalProperties: false,
          properties: {
            display_name: { type: "string" },
            description: { type: "string" },
            use_when: { type: "string" },
            do_not_use_when: { type: "array", items: { type: "string" } },
            aliases: { type: "array", items: { type: "string" } },
            categories: { type: "array", items: { type: "string" } },
            primary_group: { type: "string" },
            subgroups: { type: "array", items: { type: "string" } },
            task_types: { type: "array", items: { type: "string" } },
            frameworks: { type: "array", items: { type: "string" } },
            languages: { type: "array", items: { type: "string" } },
            requires: { type: "array", items: { type: "string" } },
            conflicts: { type: "array", items: { type: "string" } },
            maturity: { type: "string" },
            trust_level: { type: "string" },
            routing_priority: { type: "string", enum: ["high", "normal", "low", "disabled"] },
            normalization_status: { type: "string" },
            notes: { type: "string" }
          }
        }
      },
      required: ["source", "name", "overlay"]
    }
  },
  {
    name: "run_skill_routing_eval",
    description: "Run bilingual golden intent-routing cases, enforce a maximum of three selected skills, and report missing or forbidden skill selections.",
    inputSchema: {
      type: "object",
      properties: {
        cases_path: {
          type: "string",
          description: "Optional benchmark JSON path inside the AI Dev System vault."
        },
        case_ids: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        write_report: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "sync_skill_cards",
    description: "Generate or refresh human-readable skill cards for custom, design, external, and optionally Membrane skills.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        source: { type: "string" },
        names: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        name: { type: "string" },
        include_membrane: { type: "boolean", default: false },
        max_cards: { type: "number", default: 200 }
      }
    }
  },
  {
    name: "list_skill_cards",
    description: "List generated skill cards, optionally filtered by query, source, or categories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        group: { type: "string" },
        subgroup: { type: "string" },
        maturity: { type: "string" },
        trust_level: { type: "string" },
        quality_status: { type: "string" },
        min_quality: { type: "number", default: 0 },
        limit: { type: "number", default: 50 }
      }
    }
  },
  {
    name: "search_skill_cards",
    description: "Search generated skill cards by task intent before reading the full skill.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        group: { type: "string" },
        subgroup: { type: "string" },
        maturity: { type: "string" },
        trust_level: { type: "string" },
        quality_status: { type: "string" },
        min_quality: { type: "number", default: 0 },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "read_skill_card",
    description: "Read one generated skill card by skill name and optional source.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        source: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "search_index_status",
    description: "Inspect search-index freshness against current vault/project sources, including added, changed, deleted, and pending dense documents.",
    inputSchema: {
      type: "object",
      properties: {
        include_external_project_files: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "rebuild_search_index",
    description: "Rebuild the local SQLite FTS search index for knowledge notes, project cards, project AI-dev files, and skill metadata.",
    inputSchema: {
      type: "object",
      properties: {
        include_external_project_files: { type: "boolean", default: true },
        dense_embeddings: { type: "boolean", default: false },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" },
        dense_batch_size: { type: "number", default: 8 },
        dense_text_limit: { type: "number", default: 1200 },
        dense_include_membrane: { type: "boolean", default: false },
        dense_incremental: { type: "boolean", default: true },
        preserve_dense: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "search_all",
    description: "Search the self-refreshing local SQLite FTS index across knowledge, projects, workflows, quality notes, and skills.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", default: "all" },
        limit: { type: "number", default: 10 },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        }
      },
      required: ["query"]
    }
  },
  {
    name: "hybrid_search",
    description: "Hybrid semantic plus keyword search across knowledge, projects, workflows, quality notes, and skills. Optional preset applies task-specific weights and scope defaults.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        preset: { type: "string", default: "balanced" },
        scope: { type: "string" },
        limit: { type: "number" },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        semantic_weight: { type: "number" },
        keyword_weight: { type: "number" },
        dense_weight: { type: "number" },
        intent_routing: { type: "boolean", description: "Prepend up to three deterministic custom-skill candidates for development intent." },
        rerank: { type: "boolean", default: true, description: "Apply Search Ranking v2 intent, scope, curation, and hard-negative reranking." },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      },
      required: ["query"]
    }
  },
  {
    name: "list_search_presets",
    description: "List task-specific search presets with default scopes and keyword/sparse/dense weights.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "preset_search",
    description: "Run hybrid search through a named preset such as balanced, code, docs, skills, projects, debug, frontend, or quality.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        preset: { type: "string", default: "balanced" },
        explain: { type: "boolean", default: false },
        scope: { type: "string" },
        limit: { type: "number" },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        semantic_weight: { type: "number" },
        keyword_weight: { type: "number" },
        dense_weight: { type: "number" },
        intent_routing: { type: "boolean" },
        rerank: { type: "boolean", default: true },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      },
      required: ["query"]
    }
  },
  {
    name: "explain_search",
    description: "Explain why hybrid_search ranked results the way it did, including preset, keyword, sparse semantic, dense BGE-M3, and adjustment signals.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        preset: { type: "string", default: "balanced" },
        scope: { type: "string" },
        limit: { type: "number" },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        semantic_weight: { type: "number" },
        keyword_weight: { type: "number" },
        dense_weight: { type: "number" },
        intent_routing: { type: "boolean" },
        rerank: { type: "boolean", default: true },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      },
      required: ["query"]
    }
  },
  {
    name: "run_search_eval",
    description: "Run golden search evaluation cases against preset/hybrid search and report pass/fail ranking quality.",
    inputSchema: {
      type: "object",
      properties: {
        cases_path: {
          type: "string",
          description: "Optional path to a JSON cases file. Relative to the AI Dev System root unless absolute inside the vault."
        },
        case_ids: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        presets: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        include_dense: { type: "boolean", default: true },
        rerank: { type: "boolean", default: true },
        max_cases: { type: "number", default: 50 },
        fail_fast: { type: "boolean", default: false },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      }
    }
  },
  {
    name: "embed_texts",
    description: "Generate local BGE-M3 embeddings for short texts using the installed CPU backend.",
    inputSchema: {
      type: "object",
      properties: {
        texts: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        text: { type: "string" },
        prefix: { type: "string", default: "" },
        normalize: { type: "boolean", default: true },
        batch_size: { type: "number", default: 8 },
        precision: { type: "number", default: 6 },
        include_embeddings: { type: "boolean", default: true },
        model_dir: { type: "string" },
        device: { type: "string", default: "cpu" },
        timeout_ms: { type: "number", default: 180000 },
        use_worker: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "embedding_status",
    description: "Inspect the local BGE-M3 embedding backend, model files, search index, and warm worker state without loading the model.",
    inputSchema: {
      type: "object",
      properties: {
        model_dir: { type: "string" },
        device: { type: "string", default: "cpu" }
      }
    }
  },
  {
    name: "system_health_check",
    description: "Run an AI Dev System health check for vault paths, search index, skill/project registries, search presets, BGE-M3 backend, worker state, and optional search smoke tests.",
    inputSchema: {
      type: "object",
      properties: {
        include_search_smoke: { type: "boolean", default: true },
        include_dense_smoke: { type: "boolean", default: false },
        include_embedding_status: { type: "boolean", default: true },
        include_registry: { type: "boolean", default: true },
        include_skill_cards: { type: "boolean", default: true },
        include_projects: { type: "boolean", default: true },
        include_auto_commands: { type: "boolean", default: true },
        include_presets: { type: "boolean", default: true },
        include_search_eval: { type: "boolean", default: false },
        smoke_limit: { type: "number", default: 2 }
      }
    }
  },
  {
    name: "rebuild_system_dashboard",
    description: "Regenerate the Obsidian System Dashboard and machine snapshot from live MCP, skill, project, search, outcome, pilot, and overlay state.",
    inputSchema: {
      type: "object",
      properties: {
        rebuild_search: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "system_dashboard_status",
    description: "Compare the generated System Dashboard fingerprint with current runtime and registry sources.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "prepare_runtime_distribution",
    description: "Validate and document the local-first runtime, launchers, recovery scripts, secret-free profile, and blocked-by-default future VPS boundary.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "runtime_distribution_status",
    description: "Inspect local runtime readiness, distribution freshness, recovery commands, and whether remote transport remains safely disabled.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "search_projects",
    description: "Search registered project cards and indexed repo-local AI-dev files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "search_notes",
    description: "Search indexed AI Dev System Markdown notes, optionally restricted to folders.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        scope: { type: "string", default: "knowledge" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "search_skill_registry",
    description: "Search the indexed skill registry with optional source and category filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "rebuild_index",
    description: "Rebuild machine-readable and Markdown skill registries from skills stored in the vault.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "import_skill_repo",
    description: "Clone or update a GitHub skill repository into the vault and rebuild the skill index.",
    inputSchema: {
      type: "object",
      properties: {
        repository_url: { type: "string" },
        source_group: { type: "string", default: "external" },
        name: { type: "string" },
        update_if_exists: { type: "boolean", default: false }
      },
      required: ["repository_url"]
    }
  },
  {
    name: "bootstrap_project",
    description: "Create agent-ready project files in any local repository: AGENTS.md, .ai-dev/project-brief.md, .ai-dev/project-map.md, and .ai-dev/quality-gate.md.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        overwrite: { type: "boolean", default: false },
        include_project_brief: { type: "boolean", default: true },
        include_project_map: { type: "boolean", default: true },
        include_quality_gate: { type: "boolean", default: true },
        include_frontend_product: { type: "boolean", default: true }
      },
      required: ["project_path"]
    }
  },
  {
    name: "prepare_project",
    description: "Full project preparation: create AGENTS.md and .ai-dev files, sync the Obsidian project card, and rebuild the search index.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        description: { type: "string" },
        overwrite: { type: "boolean", default: false },
        include_project_brief: { type: "boolean", default: true },
        include_project_map: { type: "boolean", default: true },
        include_quality_gate: { type: "boolean", default: true },
        include_frontend_product: { type: "boolean", default: true },
        sync_registry: { type: "boolean", default: true },
        rebuild_search: { type: "boolean", default: true }
      },
      required: ["project_path"]
    }
  },
  {
    name: "frontend_product_builder",
    description: "Route frontend product work through one orchestrator and at most three compatible skills, then report the current design-first implementation gate.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        mode: { type: "string", enum: [...FRONTEND_PRODUCT_MODES] },
        task: { type: "string" }
      },
      required: ["project_path"]
    }
  },
  {
    name: "plan_frontend_references",
    description: "Plan Reference Factory concept images or approved-direction baseline coverage without pretending the MCP server can invoke ImageGen or Figma itself.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        task: { type: "string" },
        stage: { type: "string", enum: ["auto", "concepts", "coverage"], default: "auto" },
        surface: { type: "string", enum: [...REFERENCE_FACTORY_SURFACES] },
        generator: { type: "string", enum: [...REFERENCE_FACTORY_GENERATORS], default: "imagegen" },
        direction_count: { type: "number", minimum: 2, maximum: 3, default: 3 },
        artifact_budget: { type: "number", minimum: 4, maximum: 64, default: 32 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "register_frontend_references",
    description: "Validate generated PNG signatures, dimensions, hashes, prompt binding, and visual-inspection evidence, then register them in Frontend Product Quality v2.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        manifest_id: { type: "string" },
        outputs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              artifact_id: { type: "string" },
              path: { type: "string" },
              prompt_sha256: { type: "string" },
              inspection: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "reject"] },
                  method: { type: "string", enum: ["view_image", "browser", "figma"] },
                  observations: { type: "string" },
                  blocking_findings: { type: "array", items: { type: "string" } }
                },
                required: ["status", "method", "observations"]
              }
            },
            required: ["artifact_id", "path", "prompt_sha256", "inspection"]
          }
        }
      },
      required: ["project_path", "manifest_id", "outputs"]
    }
  },
  {
    name: "reference_factory_status",
    description: "Read the current Reference Factory stage, manifest state, selected skills, blockers, and next action.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" }
      },
      required: ["project_path"]
    }
  },
  {
    name: "prepare_frontend_product",
    description: "Create the mandatory Frontend Product Quality v2 brief, design system, UI inventory, visual acceptance, anti-slop policy, references directory, and machine state.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        mode: { type: "string", enum: [...FRONTEND_PRODUCT_MODES], default: "new" },
        implementer: { type: "string" },
        context: {
          type: "object",
          properties: {
            product_name: { type: "string" },
            product_type: { type: "string" },
            audience: { type: "string" },
            primary_task: { type: "string" },
            business_goal: { type: "string" },
            tone_of_voice: { type: "string" },
            real_data_source: { type: "string" },
            content_source: { type: "string" },
            brand_constraints: { type: "string" },
            accessibility_target: { type: "string" },
            screen_scope: { type: "array", items: { type: "string" } },
            required_states: { type: "array", items: { type: "string" } },
            forbidden_patterns: { type: "array", items: { type: "string" } }
          }
        },
        overwrite: { type: "boolean", default: false }
      },
      required: ["project_path"]
    }
  },
  {
    name: "update_frontend_product_brief",
    description: "Update structured product context, real references, and approved anti-slop exceptions; invalidates prior visual and design-system approvals.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        context: {
          type: "object",
          properties: {
            product_name: { type: "string" },
            product_type: { type: "string" },
            audience: { type: "string" },
            primary_task: { type: "string" },
            business_goal: { type: "string" },
            tone_of_voice: { type: "string" },
            real_data_source: { type: "string" },
            content_source: { type: "string" },
            brand_constraints: { type: "string" },
            accessibility_target: { type: "string" },
            screen_scope: { type: "array", items: { type: "string" } },
            required_states: { type: "array", items: { type: "string" } },
            forbidden_patterns: { type: "array", items: { type: "string" } }
          }
        },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              kind: { type: "string", enum: ["local-image", "figma", "url"] },
              role: { type: "string", enum: ["baseline", "candidate", "inspiration"], default: "baseline" },
              direction_id: { type: "string" },
              value: { type: "string" },
              purpose: { type: "string" },
              routes: { type: "array", items: { type: "string" } },
              viewports: { type: "array", items: { type: "string" } },
              states: { type: "array", items: { type: "string" } }
            },
            required: ["id", "label", "kind", "value", "purpose"]
          }
        },
        anti_slop_exceptions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rule_id: { type: "string" },
              rationale: { type: "string" },
              approver: { type: "string" }
            },
            required: ["rule_id", "rationale", "approver"]
          }
        }
      },
      required: ["project_path", "context", "references"]
    }
  },
  {
    name: "record_frontend_directions",
    description: "Record exactly two or three product-specific visual directions backed by Figma or local image artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        directions: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              rationale: { type: "string" },
              reference_ids: { type: "array", items: { type: "string" } },
              artifacts: { type: "array", items: { type: "string" } },
              tradeoffs: { type: "array", items: { type: "string" } }
            },
            required: ["id", "name", "rationale", "reference_ids", "artifacts"]
          }
        }
      },
      required: ["project_path", "directions"]
    }
  },
  {
    name: "approve_frontend_direction",
    description: "Approve one of the recorded visual directions after product context, references, and all direction artifacts pass validation.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        direction_id: { type: "string" },
        approver: { type: "string" },
        evidence: { type: "string" }
      },
      required: ["project_path", "direction_id", "approver", "evidence"]
    }
  },
  {
    name: "record_frontend_concept_jury",
    description: "Record an independent, dimension-level comparison of every visual direction and recommend exactly one candidate before Reference Factory approval.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        reviewer: { type: "string" },
        independent_from_implementer: { type: "boolean" },
        comparison: { type: "string" },
        direction_reviews: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              direction_id: { type: "string" },
              decision: { type: "string", enum: ["recommend", "reserve", "reject"] },
              strengths: { type: "array", minItems: 1, items: { type: "string" } },
              risks: { type: "array", items: { type: "string" } },
              dimensions: {
                type: "object",
                properties: Object.fromEntries(CONCEPT_JURY_DIMENSIONS.map((dimension) => [
                  dimension.id,
                  {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["pass", "fail"] },
                      score: { type: "integer", minimum: 1, maximum: 5 },
                      evidence: { type: "string" }
                    },
                    required: ["status", "score", "evidence"]
                  }
                ])),
                required: CONCEPT_JURY_DIMENSIONS.map((dimension) => dimension.id),
                additionalProperties: false
              }
            },
            required: ["direction_id", "decision", "strengths", "risks", "dimensions"]
          }
        }
      },
      required: [
        "project_path",
        "reviewer",
        "independent_from_implementer",
        "comparison",
        "direction_reviews"
      ]
    }
  },
  {
    name: "approve_frontend_design_system",
    description: "Approve completed frontend design documents and establish their hashes plus a pre-code git baseline. Rejects application changes made before approval.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        approver: { type: "string" },
        evidence: { type: "string" }
      },
      required: ["project_path", "approver", "evidence"]
    }
  },
  {
    name: "frontend_product_gate",
    description: "Check the design-first implementation gate or the strict visual handoff gate without changing project files.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        gate: { type: "string", enum: ["implementation", "handoff"], default: "implementation" }
      },
      required: ["project_path"]
    }
  },
  {
    name: "run_visual_reference_qa",
    description: "Run strict desktop/mobile Playwright QA against approved visual baselines, capture every required UI state, evaluate anti-slop rules, and wait for independent visual review.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        app_subdir: { type: "string" },
        url: { type: "string" },
        dev_command: { type: "string" },
        start_dev_server: { type: "boolean", default: true },
        routes: { type: "array", items: { type: "string" }, default: ["/"] },
        viewports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              width: { type: "number" },
              height: { type: "number" }
            },
            required: ["name", "width", "height"]
          }
        },
        scenarios: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              state: { type: "string" },
              route: { type: "string", default: "/" },
              capture_screenshot: { type: "boolean", default: true },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    action: { type: "string" },
                    selector: { type: "string" },
                    value: {},
                    text: { type: "string" },
                    key: { type: "string" },
                    contains: { type: "string" },
                    timeout_ms: { type: "number" }
                  },
                  required: ["action"]
                }
              }
            },
            required: ["name", "state", "actions"]
          }
        },
        max_pixel_diff_ratio: { type: "number", default: 0.01 },
        allowed_http_errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "number" },
              url_pattern: { type: "string" }
            },
            required: ["status", "url_pattern"]
          }
        },
        server_ready_timeout_ms: { type: "number", default: 60000 },
        navigation_timeout_ms: { type: "number", default: 30000 },
        timeout_ms: { type: "number", default: 300000 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "record_visual_review",
    description: "Record independent, hash-bound inspection of every screenshot, baseline, and diff plus a ten-dimension Product Design Scorecard. No overall score is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        reviewer: { type: "string" },
        reviewer_role: { type: "string" },
        inspections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              inspection_method: { type: "string", enum: ["browser", "view_image", "human"] },
              observations: { type: "string" }
            },
            required: ["path", "inspection_method", "observations"]
          }
        },
        scorecard: {
          type: "object",
          properties: Object.fromEntries(PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => [
            dimension.id,
            {
              type: "object",
              properties: {
                status: { type: "string", enum: ["pass", "fail"] },
                score: { type: "integer", minimum: 1, maximum: 5 },
                evidence: { type: "string" },
                findings: { type: "array", items: { type: "string" } }
              },
              required: ["status", "score", "evidence", "findings"]
            }
          ])),
          required: PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => dimension.id),
          additionalProperties: false
        }
      },
      required: ["project_path", "reviewer", "inspections", "scorecard"]
    }
  },
  {
    name: "list_auto_commands",
    description: "List repeatable AI Dev System command workflows such as prepare repository, start feature, investigate bug, review code, improve frontend, and update knowledge.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "match_auto_command",
    description: "Match a natural-language user request to the best AI Dev System auto-command workflows.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" },
        limit: { type: "number", default: 3 }
      },
      required: ["request"]
    }
  },
  {
    name: "read_auto_command",
    description: "Read the full runbook for one AI Dev System auto-command by name or alias.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "project_identity",
    description: "Resolve an absolute path or nested package to one canonical local project identity, Git root, aliases, and sanitized repository identity.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" }
      },
      required: ["project_path"]
    }
  },
  {
    name: "list_projects",
    description: "List registered project cards stored in the AI Dev System Obsidian vault.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "read_project",
    description: "Read one registered project card by name, slug, or project path.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "register_project",
    description: "Register a local project in the Obsidian project registry without modifying the repository.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", default: "registered" },
        notes: { type: "string" },
        overwrite: { type: "boolean", default: false },
        update_index: { type: "boolean", default: true }
      },
      required: ["project_path"]
    }
  },
  {
    name: "sync_project_card",
    description: "Refresh a rich Obsidian project card with stack, commands, quality status, project-map timestamp, risks, active tasks, and recommended skills.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        project_path: { type: "string" },
        project_name: { type: "string" },
        description: { type: "string" },
        status: { type: "string" },
        create_if_missing: { type: "boolean", default: true },
        update_index: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "update_project_card",
    description: "Append or replace a section in a registered project card stored in Obsidian.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        section: { type: "string", default: "Notes" },
        content: { type: "string" },
        mode: { type: "string", default: "append" },
        update_index: { type: "boolean", default: true }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "refresh_project_map",
    description: "Rescan a local project and refresh only its .ai-dev/project-map.md, optionally updating the Obsidian project registry.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        overwrite: { type: "boolean", default: true },
        update_registry: { type: "boolean", default: true },
        register_if_missing: { type: "boolean", default: false }
      },
      required: ["project_path"]
    }
  },
  {
    name: "refresh_project_memory",
    description: "Refresh a project's AI memory cache: .ai-dev/project-brief.md, .ai-dev/project-map.md, Obsidian project card, and search index.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        overwrite: { type: "boolean", default: true },
        update_registry: { type: "boolean", default: true },
        register_if_missing: { type: "boolean", default: true },
        rebuild_search: { type: "boolean", default: true }
      },
      required: ["project_path"]
    }
  },
  {
    name: "run_quality_gate",
    description: "Run safe verification commands from a project's .ai-dev/quality-gate.md and return a structured report.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        labels: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        dry_run: { type: "boolean", default: false },
        timeout_ms: { type: "number", default: 120000 },
        max_commands: { type: "number", default: 6 },
        diagram_specs: { type: "string", description: "Optional project-relative glob for Archify diagram specs; disabled when omitted." },
        continue_on_failure: { type: "boolean", default: true },
        update_registry: { type: "boolean", default: true },
        register_if_missing: { type: "boolean", default: false }
      },
      required: ["project_path"]
    }
  },
  {
    name: "run_frontend_qa",
    description: "Run browser-based frontend QA with Playwright: desktop/mobile screenshots, interaction scenarios, console/network errors, overflow, axe accessibility, and visual regression baselines.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        app_subdir: { type: "string", description: "Safe project-relative frontend directory such as frontend or apps/web." },
        url: { type: "string" },
        dev_command: { type: "string" },
        start_dev_server: { type: "boolean", default: true },
        routes: {
          type: "array",
          items: { type: "string" },
          default: ["/"]
        },
        viewports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              width: { type: "number" },
              height: { type: "number" }
            }
          },
          default: []
        },
        scenarios: {
          type: "array",
          description: "Optional route-bound interaction journeys. Supported actions: click, fill, press, check, uncheck, select, hover, wait_for, wait, expect_visible, expect_text, expect_url.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              state: { type: "string", description: "Stable UI state name such as loading, empty, error, or success." },
              route: { type: "string", default: "/" },
              capture_screenshot: { type: "boolean", default: true },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    action: { type: "string" },
                    selector: { type: "string" },
                    value: {},
                    text: { type: "string" },
                    key: { type: "string" },
                    contains: { type: "string" },
                    timeout_ms: { type: "number" }
                  },
                  required: ["action"]
                }
              }
            },
            required: ["name", "actions"]
          },
          default: []
        },
        check_console: { type: "boolean", default: true },
        check_overflow: { type: "boolean", default: true },
        check_accessibility_basic: { type: "boolean", default: true },
        check_accessibility_axe: { type: "boolean", default: true },
        check_anti_slop: { type: "boolean", default: false },
        anti_slop_exceptions: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  rule_id: { type: "string" },
                  rationale: { type: "string" },
                  approver: { type: "string" }
                },
                required: ["rule_id"]
              }
            ]
          }
        },
        required_states: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        check_visual_regression: { type: "boolean", default: true },
        visual_baseline_dir: { type: "string", description: "Project-relative baseline directory, or an absolute path inside approved artifact roots." },
        update_visual_baselines: { type: "boolean", default: false, description: "Explicitly replace visual baselines with this run's screenshots." },
        max_pixel_diff_ratio: { type: "number", default: 0.01 },
        scenario_timeout_ms: { type: "number", default: 10000 },
        load_project_config: { type: "boolean", default: true },
        config_path: { type: "string", default: ".ai-dev/frontend-qa.json" },
        take_screenshots: { type: "boolean", default: true },
        screenshot_dir: { type: "string" },
        artifact_location: { type: "string", enum: ["system", "project"], default: "system" },
        allowed_http_errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "number" },
              url_pattern: { type: "string" }
            },
            required: ["status", "url_pattern"]
          },
          default: []
        },
        write_report: { type: "boolean", default: true },
        update_registry: { type: "boolean", default: true },
        register_if_missing: { type: "boolean", default: false },
        server_ready_timeout_ms: { type: "number", default: 60000 },
        navigation_timeout_ms: { type: "number", default: 30000 },
        timeout_ms: { type: "number", default: 300000 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "analyze_project",
    description: "Analyze a repository or monorepo recursively and return components, stacks, commands, source/test roots, entry points, API/data surfaces, CI, and quality gaps.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        max_depth: { type: "number", default: 4, minimum: 1, maximum: 6 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "compile_project_context",
    description: "Compile a bounded, task-specific project context pack with canonical identity, rules, routed skills, relevant commands, selected source excerpts, risks, and freshness evidence.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        task: { type: "string" },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        max_source_files: { type: "integer", minimum: 1, maximum: 30, default: 12 },
        max_chars: { type: "integer", minimum: 8000, maximum: 60000, default: 24000 },
        persist: { type: "boolean", default: true }
      },
      required: ["project_path", "task"]
    }
  },
  {
    name: "project_context_status",
    description: "Read the latest persisted project context pack and report whether its source-state fingerprint is still current.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" }
      },
      required: ["project_path"]
    }
  },
  {
    name: "begin_task",
    description: "Start a bounded engineering task with a compiled task-specific context pack, at most three routed skills, explicit acceptance criteria, risk, and a Git-bound baseline.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        task: { type: "string" },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          default: []
        }
      },
      required: ["project_path", "task"]
    }
  },
  {
    name: "get_task",
    description: "Read one task lifecycle record by id.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"]
    }
  },
  {
    name: "list_tasks",
    description: "List recent task lifecycle records, optionally filtered by project path or status.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        status: { type: "string" },
        limit: { type: "number", default: 20 }
      }
    }
  },
  {
    name: "skill_outcome_status",
    description: "Inspect verification-bound real task outcomes and empirical validation thresholds for routed custom skills.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "rebuild_skill_outcomes",
    description: "Rebuild terminal Skill Outcome Analytics v2 records from completed task lifecycle files while preserving verification-attempt history.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "start_project_pilot",
    description: "Start a measured real-project pilot with canonical project identity and an explicit baseline before implementation.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        title: { type: "string" },
        task_type: { type: "string", enum: PILOT_TASK_TYPES },
        task_id: { type: "string" },
        implementer: { type: "string" },
        baseline: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["existing-product", "previous-result", "manual", "none-available"]
            },
            notes: { type: "string" },
            evidence: { type: "array", items: { type: "string" }, default: [] }
          },
          required: ["kind"]
        }
      },
      required: ["project_path", "title", "task_type", "baseline"]
    }
  },
  {
    name: "record_project_pilot_review",
    description: "Record an independent dimension-level pilot review and attach human-confirmed acceptance or rejection to terminal skill outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        pilot_id: { type: "string" },
        verdict: { type: "string", enum: ["accepted", "needs_revision", "rejected"] },
        reviewer: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["human", "independent-agent"] },
            name: { type: "string" },
            independent_from_implementer: { type: "boolean" },
            human_confirmed: { type: "boolean" }
          },
          required: ["kind", "name", "independent_from_implementer"]
        },
        revision_count: { type: "number" },
        duration_minutes: { type: "number" },
        dimensions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", enum: PILOT_DIMENSIONS },
              status: { type: "string", enum: ["pass", "warn", "fail", "not_applicable"] },
              score: {
                oneOf: [
                  { type: "number" },
                  { type: "null" }
                ]
              },
              evidence: { type: "array", items: { type: "string" }, default: [] },
              findings: { type: "array", items: { type: "string" }, default: [] }
            },
            required: ["name", "status", "evidence"]
          }
        },
        notes: { type: "string" }
      },
      required: [
        "pilot_id",
        "verdict",
        "reviewer",
        "revision_count",
        "duration_minutes",
        "dimensions"
      ]
    }
  },
  {
    name: "project_pilot_status",
    description: "Inspect active and reviewed real-project pilots, human confirmation, revisions, and dimension-level scores.",
    inputSchema: {
      type: "object",
      properties: {
        pilot_id: { type: "string" },
        project_path: { type: "string" }
      }
    }
  },
  {
    name: "checkpoint_task",
    description: "Record implementation progress, changed files, and acceptance-criterion evidence before verification.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        summary: { type: "string" },
        changed_files: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        criteria: {
          type: "array",
          default: [],
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["pending", "met", "blocked", "waived"] },
              note: { type: "string" },
              evidence: { type: "array", items: { type: "string" } }
            },
            required: ["id", "status"]
          }
        },
        notes: { type: "string" }
      },
      required: ["task_id", "summary"]
    }
  },
  {
    name: "verify_task",
    description: "Run the project quality gate and optional Frontend QA, then bind machine-readable evidence to the current Git state.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        run_quality: { type: "boolean", default: true },
        quality_labels: { type: "array", items: { type: "string" }, default: [] },
        run_frontend: { type: "boolean", default: false },
        frontend_options: { type: "object", additionalProperties: true, default: {} },
        evidence: ARCHIFY_EVIDENCE_SCHEMA
      },
      required: ["task_id"]
    }
  },
  {
    name: "complete_task",
    description: "Complete a task only when all acceptance criteria are resolved and passing verification matches the current project state.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        summary: { type: "string" },
        allow_waived: { type: "boolean", default: false },
        write_report: { type: "boolean", default: true },
        evidence: ARCHIFY_EVIDENCE_SCHEMA
      },
      required: ["task_id", "summary"]
    }
  },
  {
    name: "write_knowledge_note",
    description: "Create or overwrite a Markdown note in an allowed AI Dev System knowledge folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean", default: false }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "append_knowledge_note",
    description: "Append content to a Markdown note in an allowed AI Dev System knowledge folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        heading: { type: "string" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "archify_doctor",
    description: "Check the vendored Archify CLI, Node runtime, and browser configuration.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "archify_guide",
    description: "Recommend an Archify diagram type and authoring recipe for a scenario.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: { type: "string" },
        lang: { type: "string", enum: ["en", "zh"] }
      },
      required: ["scenario"]
    }
  },
  {
    name: "archify_validate",
    description: "Validate an Archify JSON specification and return structured diagnostics without delivering an artifact.",
    inputSchema: {
      type: "object",
      properties: {
        diagram_type: { type: "string", enum: [...ARCHIFY_TYPES] },
        spec: { type: "object", description: "Inline Archify JSON IR — provide this or spec_path." },
        spec_path: { type: "string", description: "Absolute or project-relative .json specification." },
        quality: { type: "string", enum: ["standard", "showcase"], default: "showcase" },
        project_path: { type: "string", description: "Repository root used for evidence-aware architecture diagrams." },
        artifact_location: { type: "string", enum: ["system", "project"], default: "system" },
        layout_json: { type: "boolean", default: false }
      },
      required: ["diagram_type"]
    }
  },
  {
    name: "archify_render",
    description: "Render an Archify specification to HTML without the delivery quality gate.",
    inputSchema: {
      type: "object",
      properties: {
        diagram_type: { type: "string", enum: [...ARCHIFY_TYPES] },
        spec: { type: "object" }, spec_path: { type: "string" },
        quality: { type: "string", enum: ["standard", "showcase"], default: "showcase" },
        project_path: { type: "string" }, artifact_location: { type: "string", enum: ["system", "project"], default: "system" },
        output_path: { type: "string", description: "Project-relative output path when artifact_location is project." }
      }, required: ["diagram_type"]
    }
  },
  {
    name: "archify_deliver",
    description: "Render, validate, and deliver a self-contained Archify HTML artifact with SHA-256 receipt.",
    inputSchema: {
      type: "object",
      properties: {
        diagram_type: { type: "string", enum: [...ARCHIFY_TYPES] },
        spec: { type: "object" }, spec_path: { type: "string" },
        quality: { type: "string", enum: ["standard", "showcase"], default: "showcase" },
        project_path: { type: "string" }, artifact_location: { type: "string", enum: ["system", "project"], default: "system" },
        output_path: { type: "string", description: "Project-relative output path when artifact_location is project." },
        open: { type: "boolean", default: false }
      }, required: ["diagram_type"]
    }
  },
  {
    name: "archify_visual_check",
    description: "Run Archify's bounded automated browser checks. Perceptual visual review remains separate.",
    inputSchema: { type: "object", properties: { artifact_path: { type: "string" }, project_path: { type: "string" } }, required: ["artifact_path"] }
  },
  {
    name: "archify_compare",
    description: "Create a validated architecture delta HTML artifact and receipt from base and head specifications.",
    inputSchema: {
      type: "object",
      properties: {
        base_path: { type: "string" }, head_path: { type: "string" }, output_path: { type: "string" },
        quality: { type: "string", enum: ["standard", "showcase"], default: "showcase" }, project_path: { type: "string" },
        artifact_location: { type: "string", enum: ["system", "project"], default: "system" }
      }, required: ["base_path", "head_path"]
    }
  },
  {
    name: "archify_migrate",
    description: "Migrate an Archify workflow specification to schema v2 and return its change summary.",
    inputSchema: { type: "object", properties: { old_path: { type: "string" }, new_path: { type: "string" }, project_path: { type: "string" } }, required: ["old_path", "new_path"] }
  },
  {
    name: "archify_brands",
    description: "Search built-in Archify brand marks or capture a digest-pinned brand reference from an explicit URL.",
    inputSchema: { type: "object", properties: { query: { type: "string", default: "" }, capture_url: { type: "string" } } }
  }
  ];
}
