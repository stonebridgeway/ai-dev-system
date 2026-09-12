import {
  DEFAULT_RULE_TARGETS,
  RULE_TARGETS,
  RULES_RELATIVE_DIR,
  describeRuleCatalog,
  installProjectRules
} from "../core/rules-library.mjs";
import { packsForStack } from "../core/rules-catalog.mjs";
import { PROJECT_RULES_PATH, distillProjectRules } from "../core/rules-distill.mjs";

/**
 * Engineering rules tools: install always-on common rules plus stack packs into
 * a repository as `.ai-dev/rules` (canonical), `.claude/rules` (Claude Code,
 * path-scoped), `.cursor/rules` (Cursor), and an AGENTS.md section.
 *
 * @param {{ resolveProjectIdentity: Function, detectProject: Function, markSearchIndexDirty?: Function }} host
 */
export function createRulesTools(host) {
  return {
    definitions: [
      {
        name: "list_rule_packs",
        description: "List the engineering rules catalog: always-on common rules and per-stack packs with the file globs they apply to.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Optional: also report which packs the detected stack would select." }
          }
        }
      },
      {
        name: "install_project_rules",
        description: "Install engineering rules into a repository: canonical .ai-dev/rules (common + packs chosen from the detected stack), Claude Code .claude/rules projections with paths frontmatter, Cursor .cursor/rules .mdc files, and an Engineering Rules section in AGENTS.md. The opt-in claude-md target writes @-imports of the common rules into CLAUDE.md instead of copying them into .claude/rules; use it instead of the claude target, not alongside it. Existing hand-edited files are kept unless overwrite=true.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            packs: { type: "array", items: { type: "string" }, default: [], description: "Explicit pack ids; auto-detected from the stack when empty." },
            targets: { type: "array", items: { type: "string", enum: RULE_TARGETS }, default: DEFAULT_RULE_TARGETS, description: "ai-dev (canonical), claude (.claude/rules copies), claude-md (@-imports in CLAUDE.md; use instead of claude), cursor, agents-md." },
            overwrite: { type: "boolean", default: false },
            dry_run: { type: "boolean", default: false }
          },
          required: ["project_path"]
        }
      },
      {
        name: "distill_project_rules",
        description: `Read a repository's own conventions — module system, Node built-in import style, Python import style, source and test file naming, where tests live, which test runner, how failures are raised, whether caught errors are acted on — and write them to ${PROJECT_RULES_PATH} as a draft. Every statement carries the counts it came from, and a convention the repository splits on is reported as split rather than turned into a rule. This complements install_project_rules (which installs the rules this system holds); it does not replace it, and it never overwrites an existing file unless overwrite=true.`,
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            max_files: { type: "number", default: 1500, description: "How many source files to read." },
            overwrite: { type: "boolean", default: false, description: "Replace an existing draft. A file whose `status: draft` line is gone has been confirmed by a person; overwriting that discards their edits." },
            dry_run: { type: "boolean", default: false, description: "Report the draft without writing it." }
          },
          required: ["project_path"]
        }
      }
    ],
    handlers: {
      async distill_project_rules(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const project = await host.detectProject(identity.project_root).catch(() => ({}));
        const result = await distillProjectRules(identity.project_root, {
          projectName: project.project_name ?? "",
          maxFiles: Number(args.max_files) > 0 ? Number(args.max_files) : undefined,
          overwrite: Boolean(args.overwrite),
          dryRun: Boolean(args.dry_run)
        });
        if (["written", "updated"].includes(result.action)) host.markSearchIndexDirty?.("project rules distilled");
        const nextStep = {
          written: `Read ${PROJECT_RULES_PATH}, keep the lines that are real, then drop its \`status: draft\` line. Until then nothing loads it.`,
          updated: `The draft was regenerated. Re-read ${PROJECT_RULES_PATH} before confirming it.`,
          planned: "Nothing was written. Re-run without dry_run to write the draft.",
          kept_draft: `${PROJECT_RULES_PATH} already holds a draft and was left alone. Pass overwrite=true to regenerate it.`,
          kept_confirmed: `${PROJECT_RULES_PATH} no longer says \`status: draft\`, so someone has confirmed it. It was left alone; pass overwrite=true only if you mean to discard their edits.`
        }[result.action];
        return { ...result, project_path: identity.project_root, next_step: nextStep };
      },
      async list_rule_packs(args) {
        const catalog = describeRuleCatalog();
        let detected = null;
        if (args.project_path) {
          const identity = await host.resolveProjectIdentity(args.project_path);
          const project = await host.detectProject(identity.project_root);
          detected = {
            project_path: identity.project_root,
            stack: project.stack ?? [],
            project_types: project.project_types ?? [],
            packs: packsForStack(project.stack ?? [], project.project_types ?? [])
          };
        }
        return { ...catalog, targets: RULE_TARGETS, default_targets: DEFAULT_RULE_TARGETS, canonical_dir: RULES_RELATIVE_DIR, detected };
      },
      async install_project_rules(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const project = await host.detectProject(identity.project_root);
        const result = await installProjectRules({
          projectRoot: identity.project_root,
          stack: project.stack ?? [],
          projectTypes: project.project_types ?? [],
          packs: args.packs?.length ? args.packs : undefined,
          targets: args.targets?.length ? args.targets : DEFAULT_RULE_TARGETS,
          overwrite: Boolean(args.overwrite),
          dryRun: Boolean(args.dry_run)
        });
        if (!args.dry_run && (result.written.length || result.updated.length)) {
          host.markSearchIndexDirty?.("project rules installed");
        }
        const doubled = result.targets.includes("claude") && result.targets.includes("claude-md");
        return {
          action: args.dry_run ? "rules_planned" : "rules_installed",
          project_path: identity.project_root,
          detected_stack: project.stack ?? [],
          ...result,
          warnings: doubled
            ? ["claude and claude-md both load the common rules: .claude/rules copies them, CLAUDE.md imports them. Keep one."]
            : [],
          next_step: args.dry_run
            ? "Re-run without dry_run to write the files."
            : `Commit ${RULES_RELATIVE_DIR} (and the harness projections you use) so every agent session loads the same rules.`
        };
      }
    },
    readOnly: ["list_rule_packs"]
  };
}
