import path from "node:path";
import {
  CURSOR_HOOKS_FORMATS,
  CURSOR_HOOKS_FORMAT_VERSION,
  HOOK_PROFILES,
  HOOK_TARGETS,
  HOOKS_RELATIVE_DIR,
  POLICY_RELATIVE_PATH,
  agentHooksStatus,
  installAgentHooks
} from "../core/agent-hooks.mjs";
import {
  POLICY_RULE_ACTIONS,
  POLICY_RULE_EVENTS,
  listPolicyRules,
  removePolicyRule,
  upsertPolicyRule
} from "../core/policy-rules.mjs";

/** The rule as `agent_hooks_status` shows it: what fires, and what is broken. */
function statusRule(rule) {
  return {
    id: rule.id,
    event: rule.event,
    effective_action: rule.effective_action,
    enabled: rule.enabled,
    pattern: rule.pattern,
    message: rule.message,
    problems: rule.problems
  };
}

/** The guard re-reads `.ai-dev/policy.json` on every tool call, so an edit is live at once. */
const POLICY_APPLIES = "The guard reads .ai-dev/policy.json on every command and file write, so the change is live without restarting the client. Commit the file so the rule travels with the repository.";

/**
 * Agent hooks tools: install deterministic client-side guards (Claude Code /
 * Cursor hooks, and git hooks through core.hooksPath) that complement the MCP
 * server: block --no-verify and destructive commands, protect secrets and
 * linter configs, auto-format, inject the last handoff on session start,
 * capture session summaries, advise on strategic compaction, and hold a commit
 * or a push to the same rules whoever makes it.
 *
 * The project's own rules live in `.ai-dev/policy.json`, which the guard reads
 * on every call. `list_policy_rules`, `upsert_policy_rule` and
 * `remove_policy_rule` edit that block through the checks in
 * `src/core/policy-rules.mjs` instead of by hand, so a rule that would never
 * fire cannot be written in the first place.
 *
 * @param {{ resolveProjectIdentity: Function, serverRoot: string, markSearchIndexDirty?: Function }} host
 */
export function createHookTools(host) {
  return {
    definitions: [
      {
        name: "install_agent_hooks",
        description: "Install the AI Dev agent hooks into a repository: self-contained scripts under .ai-dev/hooks, a hookify-style .ai-dev/policy.json, and registrations in .claude/settings.json (Claude Code), .cursor/hooks.json (Cursor) and/or git hooks through core.hooksPath (target \"git\": pre-commit refuses a staged secret or conflict marker, pre-push reads the active task's latest verification). Re-running refreshes the scripts and keeps custom policy rules.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            targets: { type: "array", items: { type: "string", enum: HOOK_TARGETS }, default: ["claude"] },
            profile: { type: "string", enum: HOOK_PROFILES, default: "standard", description: "minimal: guards + session capture; standard: + session start context, formatting, compaction advice, stop checks; strict: standard + push/amend warnings + fact forcing (the first edit of a file and the first destructive command have to state their grounding)." },
            overwrite: { type: "boolean", default: false, description: "Also reset .ai-dev/policy.json to defaults." },
            cursor_format_version: { type: "number", enum: CURSOR_HOOKS_FORMATS, default: CURSOR_HOOKS_FORMAT_VERSION, description: "Format version of .cursor/hooks.json to write. Cursor 3.x still reads version 1; a new format gets its own adapter rather than a rewrite of this one." },
            dry_run: { type: "boolean", default: false }
          },
          required: ["project_path"]
        }
      },
      {
        name: "agent_hooks_status",
        description: "Report which AI Dev hooks, policy, and harness registrations are installed in a repository, including every .ai-dev/policy.json rule with what the guard would actually do with it.",
        inputSchema: {
          type: "object",
          properties: { project_path: { type: "string" } },
          required: ["project_path"]
        }
      },
      {
        name: "list_policy_rules",
        description: "List the guard rules in .ai-dev/policy.json with the guard's own reading of each: whether it is enabled, whether a match blocks or only warns, and what stops it from working — a pattern that does not compile, an event the guard never evaluates, or a stored example the pattern no longer matches.",
        inputSchema: {
          type: "object",
          properties: { project_path: { type: "string" } },
          required: ["project_path"]
        }
      },
      {
        name: "upsert_policy_rule",
        description: "Add a guard rule to .ai-dev/policy.json, or update the one that already carries the id, without hand-editing JSON. The pattern is compiled the way the guard compiles it (case-insensitive), checked against the rules already in the file, and run against the example the caller provides: a new rule, or a changed pattern, is refused unless it actually fires on that example. An update is a patch, so { id, enabled: false } disables a rule.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            rule: {
              type: "object",
              description: "id is required. event, pattern, action and message are required for a new rule; on an update, whatever is left out keeps its current value.",
              properties: {
                id: { type: "string", description: "Slug the guard prints on a match and remove_policy_rule takes, e.g. block-prod-migrations." },
                event: { type: "string", enum: POLICY_RULE_EVENTS, description: "bash: shell commands. file: writes, matched against the path, a newline, then the new content. all: both." },
                pattern: { type: "string", description: "Regular expression, compiled case-insensitively. A quantified group holding an unbounded quantifier ((a+)+) is refused: it stalls the guard on a long line." },
                action: { type: "string", enum: POLICY_RULE_ACTIONS, description: "block refuses the tool call; warn lets it through with the message attached." },
                message: { type: "string", description: "What the agent should do instead. The guard prints it verbatim." },
                enabled: { type: "boolean", default: true },
                example: { type: "string", description: "A snippet the rule must match. Required for a new rule or a changed pattern, and stored with the rule so a later list_policy_rules re-checks it — keep it synthetic, it is committed with the repository." },
                example_path: { type: "string", description: "For a file rule: the path the example content would be written to, since the guard matches the path too." },
                counter_example: { type: "string", description: "A snippet the rule must NOT match. Refused if it does, which catches a pattern that grew too broad." }
              },
              required: ["id"]
            },
            dry_run: { type: "boolean", default: false, description: "Run every check and report the result without writing the file." }
          },
          required: ["project_path", "rule"]
        }
      },
      {
        name: "remove_policy_rule",
        description: "Remove a guard rule from .ai-dev/policy.json by id. Use upsert_policy_rule with { id, enabled: false } to keep the rule but stop it firing.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            id: { type: "string" }
          },
          required: ["project_path", "id"]
        }
      }
    ],
    handlers: {
      async install_agent_hooks(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const result = await installAgentHooks({
          projectRoot: identity.project_root,
          hooksSourceDir: path.join(host.serverRoot, "hooks"),
          targets: args.targets?.length ? args.targets : ["claude"],
          profile: args.profile || "standard",
          overwrite: Boolean(args.overwrite),
          cursorFormatVersion: args.cursor_format_version || CURSOR_HOOKS_FORMAT_VERSION,
          dryRun: Boolean(args.dry_run)
        });
        return {
          action: args.dry_run ? "hooks_planned" : "hooks_installed",
          project_path: identity.project_root,
          hooks_dir: HOOKS_RELATIVE_DIR,
          policy_path: POLICY_RELATIVE_PATH,
          ...result,
          next_step: [
            ...result.warnings.map((warning) => `Resolve by hand: ${warning}`),
            args.dry_run
              ? "Re-run without dry_run to write the files."
              : "Restart the client (or start a new session) so the hooks load; tune .ai-dev/policy.json rules and profile as needed. Commit .ai-dev/hooks, .ai-dev/policy.json, and the harness registration files."
          ].join(" ")
        };
      },
      async agent_hooks_status(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const status = await agentHooksStatus(identity.project_root);
        const policy = await listPolicyRules(identity.project_root);
        return {
          ...status,
          policy_rules: policy.counts.total,
          policy_rule_counts: policy.counts,
          policy_problems: policy.problems,
          rules: policy.rules.map(statusRule)
        };
      },
      async list_policy_rules(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        return listPolicyRules(identity.project_root);
      },
      async upsert_policy_rule(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const result = await upsertPolicyRule({
          projectRoot: identity.project_root,
          rule: args.rule,
          dryRun: Boolean(args.dry_run)
        });
        return {
          project_path: identity.project_root,
          ...result,
          next_step: [
            ...result.warnings.map((warning) => `Check by hand: ${warning}`),
            args.dry_run ? "Nothing was written. Re-run without dry_run to store the rule." : POLICY_APPLIES
          ].join(" ")
        };
      },
      async remove_policy_rule(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const result = await removePolicyRule({ projectRoot: identity.project_root, id: args.id });
        return { project_path: identity.project_root, ...result, next_step: POLICY_APPLIES };
      }
    },
    readOnly: ["agent_hooks_status", "list_policy_rules"]
  };
}
