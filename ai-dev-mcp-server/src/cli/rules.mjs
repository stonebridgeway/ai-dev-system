/**
 * `ai-dev rules <command>` — a repository's rules from a terminal: the guard
 * rules the agent hooks enforce (`.ai-dev/policy.json`), the hooks
 * themselves, and the engineering rules each AI assistant reads. Every command
 * is a tool of the server run in this process (`tools.mjs`).
 *
 * Exit codes: 0 done, 1 failed, 2 a usage mistake, 130 stopped with Ctrl-C.
 */
import path from "node:path";
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import { tildify } from "./context.mjs";
import { cut, lineWidth, withTools } from "./tools.mjs";

const SUBCOMMANDS = ["list", "add", "on", "off", "remove", "hooks", "packs", "install"];

export function usage() {
  return [
    "Usage: ai-dev rules <command> [options]      (in a repository, or with --project <path>)",
    "",
    "Guard rules: what the agent hooks block or warn about, in .ai-dev/policy.json",
    "  list                      the rules, and anything that stops one from working",
    "  add <id>                  add a rule, or change the one with that id",
    "      --pattern <regex>       what it matches (case-insensitive)",
    "      --example <text>        a sample it must match: checked before the rule is saved",
    "      --message <text>        what the agent is told to do instead",
    "      --event bash|file|all   shell commands (default), file writes, or both",
    "      --action block|warn     refuse the call (default), or let it through with the message",
    "      --counter <text>        a sample it must not match",
    "  on <id> | off <id>        switch a rule on or off",
    "  remove <id>               take a rule out                  --yes: do not ask",
    "  hooks                     whether the hooks that enforce them are installed",
    "  hooks install             install them for Claude Code     --target claude|cursor|git (repeat),",
    "                                                             --profile minimal|standard|strict",
    "",
    "Engineering rules: the conventions each AI assistant reads in the repository",
    "  packs                     the rule packs, and the ones this repository's stack picks",
    "  install                   write them: .ai-dev/rules, .claude/rules, .cursor/rules, AGENTS.md…",
    "                            --pack P, --target T (repeat), --overwrite, --dry-run",
    "",
    "  --project <path>          the repository; the current folder when left out",
    "  --json                    print the result as JSON"
  ].join("\n");
}

/** A rule on one line: on or off, block or warn, what it watches, its id and its message. */
function ruleLine(rule, width) {
  const state = rule.enabled ? rule.effective_action : "off";
  const trouble = rule.problems?.length ? `  [${rule.problems.length} problem${rule.problems.length === 1 ? "" : "s"}]` : "";
  const head = `  ${state.padEnd(6)}${rule.event.padEnd(5)}${rule.id}`;
  return `${head.padEnd(Math.max(head.length + 2, 40))}${cut(rule.message, Math.max(20, width - Math.max(head.length + 2, 40) - trouble.length))}${trouble}`;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values, positionals } = parseCommandLine(argv, {
    command: "rules",
    options: {
      json: { type: "boolean" },
      project: { type: "string" },
      pattern: { type: "string" },
      example: { type: "string" },
      message: { type: "string" },
      event: { type: "string" },
      action: { type: "string" },
      counter: { type: "string" },
      yes: { type: "boolean", short: "y" },
      target: { type: "string", multiple: true },
      pack: { type: "string", multiple: true },
      profile: { type: "string" },
      overwrite: { type: "boolean" },
      "dry-run": { type: "boolean" }
    },
    positionals: { max: 2, names: "arguments" }
  });
  if (values.help || positionals[0] === "help") {
    io.out(usage());
    return EXIT.ok;
  }
  const [command = "list", argument] = positionals;
  if (!SUBCOMMANDS.includes(command)) {
    const near = closest(command, SUBCOMMANDS);
    throw new CliUsageError(`\`ai-dev rules\` has no "${command}".${near ? ` Did you mean \`ai-dev rules ${near}\`?` : ""} It takes ${SUBCOMMANDS.join(", ")}.`);
  }
  const withId = ["add", "on", "off", "remove"].includes(command);
  if (withId && !argument) throw new CliUsageError(`It is \`ai-dev rules ${command} <id>\`. \`ai-dev rules list\` shows the ids.`);
  if (command === "hooks" && argument !== undefined && argument !== "install") throw new CliUsageError(`It is \`ai-dev rules hooks\` or \`ai-dev rules hooks install\`, not "${argument}".`);
  if (!withId && command !== "hooks" && argument !== undefined) throw new CliUsageError(`\`ai-dev rules ${command}\` takes no argument, and was given ${JSON.stringify(argument)}.`);
  for (const [flag, choices] of [["event", ["bash", "file", "all"]], ["action", ["block", "warn"]], ["profile", ["minimal", "standard", "strict"]]]) {
    if (values[flag] !== undefined && !choices.includes(values[flag])) throw new CliUsageError(`--${flag} takes ${choices.join(", ")}, not ${JSON.stringify(values[flag])}.`);
  }
  const project = path.resolve(values.project ?? process.cwd());
  const json = Boolean(values.json);
  const width = lineWidth(io);
  const print = (result, human) => {
    if (json) io.out(JSON.stringify(result, null, 2));
    else human(result);
    return EXIT.ok;
  };

  if (command === "remove" && !values.yes && !await io.ask(`Take the rule ${argument} out of ${tildify(path.join(project, ".ai-dev", "policy.json"))}?`, false)) {
    io.out(io.interactive ? "Nothing changed." : "Nothing changed: there is nobody to ask here. Add --yes to remove it.");
    return io.interactive ? EXIT.ok : EXIT.failed;
  }

  return withTools(async ({ call }) => {
    switch (command) {
      case "list":
        return print(await call("list_policy_rules", { project_path: project }), (listed) => {
          io.out(`Guard rules · ${tildify(path.join(project, listed.policy_path))}${listed.exists ? "" : " (not there yet)"}`);
          if (!listed.rules.length) io.out("  None. `ai-dev rules hooks install` writes the default ones; `ai-dev rules add <id>` adds yours.");
          for (const rule of listed.rules) io.out(ruleLine(rule, width));
          const broken = listed.rules.filter((rule) => rule.problems?.length);
          for (const rule of broken) for (const problem of rule.problems) io.out(`  ${rule.id}: ${problem}`);
          for (const problem of listed.problems ?? []) io.out(`  ${problem}`);
          io.out(`${listed.counts.enabled} of ${listed.counts.total} on: ${listed.counts.blocking} block, ${listed.counts.warning} warn.`);
        });
      case "add": {
        const rule = {
          id: argument,
          ...(values.pattern !== undefined ? { pattern: values.pattern } : {}),
          ...(values.example !== undefined ? { example: values.example } : {}),
          ...(values.message !== undefined ? { message: values.message } : {}),
          ...(values.counter !== undefined ? { counter_example: values.counter } : {}),
          event: values.event ?? undefined,
          action: values.action ?? undefined
        };
        // A new rule needs all of it; a change keeps what is left out.
        const existing = (await call("list_policy_rules", { project_path: project })).rules.find((item) => item.id === argument);
        if (!existing) {
          rule.event ??= "bash";
          rule.action ??= "block";
          const missing = ["pattern", "example", "message"].filter((name) => rule[name] === undefined);
          if (missing.length) throw new CliUsageError(`A new rule needs ${missing.map((name) => `--${name}`).join(", ")}. See \`ai-dev help rules\`.`);
        }
        for (const key of Object.keys(rule)) if (rule[key] === undefined) delete rule[key];
        return print(await call("upsert_policy_rule", { project_path: project, rule, dry_run: Boolean(values["dry-run"]) }), (result) => {
          io.out(`${result.dry_run ? "Checked, not saved" : result.action === "created" ? "Added" : "Changed"}: ${ruleLine(result.rule, width).trim()}`);
          if (result.created_policy) io.out(`  ${tildify(path.join(project, result.policy_path))} was made for it.`);
          for (const warning of result.warnings ?? []) io.out(`  ${warning}`);
        });
      }
      case "on":
      case "off":
        return print(await call("upsert_policy_rule", { project_path: project, rule: { id: argument, enabled: command === "on" } }), (result) => {
          io.out(`${argument} is ${command}.`);
          for (const warning of result.warnings ?? []) io.out(`  ${warning}`);
        });
      case "remove":
        return print(await call("remove_policy_rule", { project_path: project, id: argument }), () => io.out(`Removed ${argument}.`));
      case "hooks": {
        if (argument === "install") {
          return print(await call("install_agent_hooks", {
            project_path: project,
            ...(values.target ? { targets: values.target } : {}),
            ...(values.profile ? { profile: values.profile } : {}),
            overwrite: Boolean(values.overwrite),
            dry_run: Boolean(values["dry-run"])
          }), (result) => {
            const files = values["dry-run"] ? result.planned ?? [] : [...(result.written ?? []), ...(result.updated ?? [])];
            io.out(`${values["dry-run"] ? "Would install" : "Installed"} the agent hooks (${result.profile}, for ${result.targets.join(", ")}) in ${tildify(project)}: ${files.length} file${files.length === 1 ? "" : "s"}.`);
            if (result.skipped?.length) io.out(`  Kept: ${cut(result.skipped.join(", "), width * 2)}`);
            for (const warning of result.warnings ?? []) io.out(`  ${warning}`);
          });
        }
        return print(await call("agent_hooks_status", { project_path: project }), (status) => {
          io.out(`Agent hooks · ${tildify(project)}: ${status.installed ? `installed (${status.profile})` : "not installed: `ai-dev rules hooks install` puts them in"}.`);
          io.out(`  ${status.policy_rules} guard rule${status.policy_rules === 1 ? "" : "s"}; Claude Code entries ${status.claude_entries}, Cursor entries ${status.cursor_entries}; git hooks ${status.git_hooks_active ? "on" : "off"}.`);
        });
      }
      case "packs":
        return print(await call("list_rule_packs", { project_path: project }), (listed) => {
          io.out(`Always: ${listed.common.map((pack) => pack.id).join(", ")}`);
          io.out("Packs by stack:");
          for (const pack of listed.packs) io.out(`  ${pack.id.padEnd(14)}${pack.title}`);
          const picked = listed.detected?.packs;
          if (Array.isArray(picked)) io.out(`This repository (${listed.detected.stack?.join(", ") || "no stack recognised"}) picks: ${picked.length ? picked.join(", ") : "none of them"}.`);
        });
      case "install":
        return print(await call("install_project_rules", {
          project_path: project,
          ...(values.pack ? { packs: values.pack } : {}),
          ...(values.target ? { targets: values.target } : {}),
          overwrite: Boolean(values.overwrite),
          dry_run: Boolean(values["dry-run"])
        }), (result) => {
          io.out(`${result.dry_run || result.action === "rules_planned" ? "Would write" : "Wrote"} the engineering rules for ${result.detected_stack?.join(", ") || "this repository"} (packs: ${result.packs?.join(", ") || "common only"}).`);
          const lines = [["written", result.written], ["updated", result.updated], ["planned", result.planned], ["kept as you edited them", result.skipped]];
          for (const [what, files] of lines) if (files?.length) io.out(`  ${what}: ${cut(files.map((file) => (typeof file === "string" ? file : file.path)).join(", "), width * 2)}`);
        });
      default:
        return EXIT.usage;
    }
  });
}
