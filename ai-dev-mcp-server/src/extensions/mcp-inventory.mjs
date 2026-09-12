/**
 * The MCP surface over the agent harness: what servers this repository wires
 * into its agents, and what the rest of its configuration lets an agent do
 * without being asked.
 *
 * The reading lives in `src/core/mcp-inventory.mjs` and
 * `src/core/agent-config-scan.mjs`; this module resolves the project and turns
 * each report into the one sentence a caller should act on.
 */
import { renderAgentConfigMarkdown, scanAgentConfig } from "../core/agent-config-scan.mjs";
import { listMcpServers } from "../core/mcp-inventory.mjs";

function nextStep(report) {
  const { block, warn } = report.summary;
  if (block) {
    const files = [...new Set(report.findings.filter((finding) => finding.severity === "block").map((finding) => finding.path))];
    return `Move ${block} credential${block === 1 ? "" : "s"} out of ${files.join(", ")} into the environment and reference them as \${VAR}. A value that has been committed is already in every clone: rotate it, do not just delete the line.`;
  }
  if (warn) return `${warn} finding${warn === 1 ? "" : "s"} to review before trusting this set of servers; nothing is a credential in cleartext.`;
  if (!report.summary.servers) return "No MCP server is declared for this repository. install_local_mcp_clients (or the client's own settings) registers one; a project with none is not a finding.";
  return `${report.summary.servers} server${report.summary.servers === 1 ? "" : "s"} declared, nothing to act on.`;
}

/**
 * @param {{ resolveProjectIdentity: Function }} host
 */
export function createMcpInventoryTools(host) {
  return {
    definitions: [
      {
        name: "scan_agent_config",
        description: "Grade a repository's agent harness from A to F: CLAUDE.md and AGENTS.md that run a command on load or tell the agent to stop asking, .claude/settings.json that pre-approves Bash(*) or sets bypassPermissions, hook commands that splice a variable into a shell, subagents with no tool limit, and everything list_mcp_servers finds (unpinned npx packages, credentials in cleartext). Findings are { rule, severity, file, line, message }; a blocking finding is one that removes a check rather than widening one, and caps the grade at D. Writes the grade into the project card's Agent Configuration section.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            include_user_scope: { type: "boolean", default: false, description: "Also read the current user's own MCP config files. They apply to this project too, but they are outside the repository." },
            update_card: { type: "boolean", default: true, description: "Write the grade into the project card. Pass false to scan without touching the vault." }
          },
          required: ["project_path"]
        }
      },
      {
        name: "list_mcp_servers",
        description: "Inventory the MCP servers a repository wires into its agents: .mcp.json, .claude/settings.json (and settings.local.json), .cursor/mcp.json, .vscode/mcp.json, .gemini/settings.json and .codex/config.toml. Reports each server once with the files that declare it, its transport, the environment variables it substitutes and whether they are set, and whether Claude Code starts it without asking. Findings: a credential written out in a config file blocks; a plain-HTTP endpoint, an unpinned npx package, a shell-wrapped command, an entry no client can start, a config that cannot be read, or the same name defined differently in two files warn.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            include_user_scope: {
              type: "boolean",
              default: false,
              description: "Also read the current user's own config files (~/.claude.json including its per-project block, ~/.cursor/mcp.json, ~/.gemini/settings.json, ~/.codex/config.toml). They apply to this project too, but they are outside the repository and belong to the person running the server. ~/.claude.json is streamed key by key rather than parsed: the same file holds Claude Code's conversation history, and the report says how much it streamed."
            }
          },
          required: ["project_path"]
        }
      }
    ],
    handlers: {
      async scan_agent_config(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const scan = await scanAgentConfig(identity.project_root, {
          includeUserScope: Boolean(args.include_user_scope)
        });
        const markdown = renderAgentConfigMarkdown(scan);
        // The grade belongs in the project card, which is keyed by project
        // name. A project that has no card yet is not a reason to fail the
        // scan — the report is the answer, the card is where it is kept.
        let card = null;
        if (args.update_card !== false) {
          card = await host.findProjectCard(identity.project_root)
            .then((found) => host.updateProjectCard({
              name: found.name,
              section: "Agent Configuration",
              mode: "replace",
              content: markdown,
              update_index: false
            }))
            .catch((error) => ({ updated: false, error: error instanceof Error ? error.message : String(error) }));
        }
        return {
          ...scan,
          markdown,
          card,
          next_step: scan.block
            ? `Grade ${scan.grade}: ${scan.block} setting(s) remove a check rather than narrow one. Fix those first — a bypass in a committed file applies to everyone who opens this repository.`
            : scan.warn
              ? `Grade ${scan.grade}: nothing removes a check outright, but ${scan.warn} setting(s) widen one. Narrow them, or record in the project card why they stand.`
              : `Grade ${scan.grade}: nothing here removes or widens a check an agent would otherwise get.`
        };
      },
      async list_mcp_servers(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const report = await listMcpServers({
          projectRoot: identity.project_root,
          includeUserScope: Boolean(args.include_user_scope)
        });
        return { ...report, project_path: identity.project_root, next_step: nextStep(report) };
      }
    },
    readOnly: ["list_mcp_servers"]
  };
}
