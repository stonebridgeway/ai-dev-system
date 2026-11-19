/**
 * `ai-dev skills <command>` — the skill library from a terminal: find and
 * read skills, add your own (a folder, or a new one from a template), take
 * yours away, import a GitHub repository of skills, rebuild and check the
 * registry. Every command is a tool of the server run in this process
 * (`tools.mjs`), so it does what an agent's or the desktop app's call does.
 *
 * Exit codes: 0 done, 1 failed, 2 a usage mistake, 130 stopped with Ctrl-C.
 */
import os from "node:os";
import path from "node:path";
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import { tildify } from "./context.mjs";
import { cut, lineWidth, withTools } from "./tools.mjs";

const SUBCOMMANDS = ["search", "groups", "browse", "show", "mine", "add", "new", "remove", "import", "rebuild", "check"];

export function usage() {
  return [
    "Usage: ai-dev skills <command> [options]",
    "",
    "Find and read:",
    "  search <words>            skills that fit a task           --limit N, --group <group>",
    "  groups                    the groups skills are sorted into, with how many each holds",
    "  browse <group>            the skills of one group          --limit N",
    "  show <name>               print a skill                    --source S, when two have the name",
    "",
    "Your own:",
    "  mine                      the skills you added             --all: and the ones that came with AI Dev",
    "  add <folder>              add a skill: a folder with a SKILL.md, or the SKILL.md itself",
    "                                                             --name N, --replace (one of yours)",
    "  new <name> <description>  start a new skill from a template, then write its SKILL.md",
    "  remove <name>             remove a skill you added         --yes: do not ask",
    "",
    "Library:",
    "  import <github-url>       add the skills of a GitHub repository (git clone)",
    "                            --select: only skills/<name> that pass the import policy, read as data until",
    "                            reviewed; --min-quality N (75); --update: pull one imported before; --dry-run",
    "  rebuild                   rebuild the skill registry now (it also rebuilds itself when a SKILL.md changes)",
    "  check                     validate the library: structure, quality scores, duplicates   --source S",
    "",
    "  --json                    print the result as JSON",
    "",
    "A skill's name is lowercase letters, digits and hyphens. Yours live beside the ones that came with",
    "AI Dev, in the custom source of the vault; an update of AI Dev leaves them alone."
  ].join("\n");
}

/** A whole number from a flag, or a usage error. */
function wholeNumber(value, flag, { min = 1, max = 1000 } = {}) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new CliUsageError(`${flag} takes a whole number from ${min} to ${max}, not ${JSON.stringify(value)}.`);
  return number;
}

/**
 * Skills one to a line: the name in a column, then what it does and, for a
 * skill from elsewhere than the custom source, where it is from. A name too
 * long for the column has its line to itself.
 */
function printSkills(io, skills, empty) {
  if (!skills.length) {
    io.out(empty);
    return;
  }
  const width = lineWidth(io);
  const column = Math.min(30, Math.max(...skills.map((skill) => skill.name.length))) + 4;
  const room = Math.max(24, width - column);
  for (const skill of skills) {
    const from = skill.source && skill.source !== "custom" ? ` [${skill.source}]` : "";
    // A group's listing carries when to use a skill, not its description.
    const said = String(skill.description || skill.use_when || "");
    const text = `${cut(said.charAt(0).toUpperCase() + said.slice(1), room - from.length)}${from}`;
    const name = `  ${skill.name}`;
    if (name.length + 2 > column) {
      io.out(name);
      io.out(`${" ".repeat(column)}${text}`);
    } else {
      io.out(`${name.padEnd(column)}${text}`);
    }
  }
}

/** The registry's size after a change, in one line. */
function registryLine(registry) {
  return `The skill registry is rebuilt: ${registry.total} skills, ${registry.custom} in the custom source.`;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values, positionals } = parseCommandLine(argv, {
    command: "skills",
    options: {
      json: { type: "boolean" },
      limit: { type: "string" },
      group: { type: "string" },
      source: { type: "string" },
      name: { type: "string" },
      replace: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      all: { type: "boolean" },
      select: { type: "boolean" },
      update: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "min-quality": { type: "string" }
    },
    positionals: { max: Infinity, names: "arguments" }
  });
  if (values.help || positionals[0] === "help" || !positionals.length) {
    io.out(usage());
    return positionals.length || values.help ? EXIT.ok : EXIT.usage;
  }
  const [command, ...rest] = positionals;
  if (!SUBCOMMANDS.includes(command)) {
    const near = closest(command, SUBCOMMANDS);
    throw new CliUsageError(`\`ai-dev skills\` has no "${command}".${near ? ` Did you mean \`ai-dev skills ${near}\`?` : ""} It takes ${SUBCOMMANDS.join(", ")}.`);
  }
  const needs = (count, form) => {
    if (rest.length < count) throw new CliUsageError(`It is \`ai-dev skills ${form}\`. See \`ai-dev help skills\`.`);
  };
  const noMore = (count, form) => {
    if (rest.length > count) throw new CliUsageError(`\`ai-dev skills ${command}\` takes ${count ? `only ${form}` : "no arguments"}, and was given ${rest.slice(count).map((word) => JSON.stringify(word)).join(" ")} as well.`);
  };
  const json = Boolean(values.json);
  // The lines below print the short rows; --json hands over every field.
  const details = json ? { include_details: true } : {};
  const limit = wholeNumber(values.limit, "--limit", { max: 200 });

  switch (command) {
    case "search":
      needs(1, "search <words>");
      return withTools(async ({ call }) => {
        const found = await call("search_skills", { query: rest.join(" "), limit: limit ?? 10, ...(values.group ? { group: values.group } : {}), ...details });
        if (json) io.out(JSON.stringify(found, null, 2));
        else printSkills(io, found, "No skill fits those words. `ai-dev skills groups` shows what there is.");
        return EXIT.ok;
      });
    case "groups":
      noMore(0);
      return withTools(async ({ call }) => {
        const groups = await call("list_skill_groups", details);
        if (json) {
          io.out(JSON.stringify(groups, null, 2));
          return EXIT.ok;
        }
        io.out(`${groups.total_skills} skills in ${groups.groups.length} groups:`);
        const width = Math.max(...groups.groups.map((group) => group.id.length)) + 2;
        for (const group of groups.groups) io.out(`  ${group.id.padEnd(width)}${String(group.count).padStart(5)}  ${group.label}`);
        io.out();
        io.out("`ai-dev skills browse <group>` lists one.");
        return EXIT.ok;
      });
    case "browse":
      needs(1, "browse <group>");
      noMore(1, "the group");
      return withTools(async ({ call }) => {
        const found = await call("browse_skill_group", { group: rest[0], limit: limit ?? 30, ...details });
        if (json) {
          io.out(JSON.stringify(found, null, 2));
          return EXIT.ok;
        }
        io.out(`${found.group.label}: ${found.returned} of ${found.total_matches}`);
        printSkills(io, found.results, "  No skills in it.");
        return EXIT.ok;
      });
    case "show":
      needs(1, "show <name>");
      noMore(1, "the name");
      return withTools(async ({ call }) => {
        const text = await call("read_skill", { name: rest[0], ...(values.source ? { source: values.source } : {}) });
        io.out(json ? JSON.stringify({ name: rest[0], text }, null, 2) : String(text).trimEnd());
        return EXIT.ok;
      });
    case "mine":
      noMore(0);
      return withTools(async ({ call }) => {
        const listed = await call("custom_skills_list", {});
        if (json) {
          io.out(JSON.stringify(listed, null, 2));
          return EXIT.ok;
        }
        const yours = listed.skills.filter((skill) => skill.origin === "yours");
        const seed = listed.skills.filter((skill) => skill.origin === "seed");
        io.out(`Your skills · ${tildify(listed.root)}`);
        printSkills(io, yours, "  None yet: `ai-dev skills new <name> <description>` starts one, `ai-dev skills add <folder>` adds one you have.");
        if (values.all) {
          io.out();
          io.out(`Came with AI Dev (${seed.length}):`);
          printSkills(io, seed, "  None.");
        } else if (seed.length) {
          io.out();
          io.out(`${seed.length} more came with AI Dev: \`ai-dev skills mine --all\` lists them.`);
        }
        return EXIT.ok;
      });
    case "add":
      needs(1, "add <folder>");
      noMore(1, "the folder");
      return withTools(async ({ call }) => {
        const where = rest[0] === "~" || rest[0].startsWith("~/") ? path.join(os.homedir(), rest[0].slice(2)) : path.resolve(rest[0]);
        const added = await call("custom_skills_add", { source: where, ...(values.name ? { name: values.name } : {}), ...(values.replace ? { replace: true } : {}) });
        if (json) {
          io.out(JSON.stringify(added, null, 2));
          return EXIT.ok;
        }
        io.out(`${added.replaced ? "Replaced" : "Added"} ${added.name}: ${added.files} file${added.files === 1 ? "" : "s"} in ${tildify(added.folder)}.`);
        if (added.skipped.length) io.out(`Left out: ${added.skipped.join(", ")}.`);
        io.out(registryLine(added.registry));
        return EXIT.ok;
      });
    case "new":
      needs(2, "new <name> <description>");
      return withTools(async ({ call }) => {
        const created = await call("custom_skills_add", { name: rest[0], description: rest.slice(1).join(" ") });
        if (json) {
          io.out(JSON.stringify(created, null, 2));
          return EXIT.ok;
        }
        io.out(`Started ${created.name}. Write what it does in ${tildify(path.join(created.folder, "SKILL.md"))}:`);
        io.out("the registry reads the change by itself; `ai-dev skills rebuild` does it at once.");
        io.out(registryLine(created.registry));
        return EXIT.ok;
      });
    case "remove":
      needs(1, "remove <name>");
      noMore(1, "the name");
      if (!values.yes && !await io.ask(`Remove the skill ${rest[0]} and its folder?`, false)) {
        io.out(io.interactive ? "Nothing removed." : "Nothing removed: there is nobody to ask here. Add --yes to remove it.");
        return io.interactive ? EXIT.ok : EXIT.failed;
      }
      return withTools(async ({ call }) => {
        const removed = await call("custom_skills_remove", { name: rest[0], confirm: true });
        if (json) io.out(JSON.stringify(removed, null, 2));
        else io.out(`Removed ${removed.name}. ${registryLine(removed.registry)}`);
        return EXIT.ok;
      });
    case "import":
      needs(1, "import <github-url>");
      noMore(1, "the address");
      return withTools(async ({ call }) => {
        const minimum = wholeNumber(values["min-quality"], "--min-quality", { min: 0, max: 100 });
        const report = await call("import_skill_repo", {
          repository_url: rest[0],
          ...(values.group ? { source_group: values.group } : {}),
          update_if_exists: Boolean(values.update),
          select_skills: Boolean(values.select),
          dry_run: Boolean(values["dry-run"]),
          ...(minimum !== undefined ? { min_quality_score: minimum } : {})
        });
        if (json) {
          io.out(JSON.stringify(report, null, 2));
          return EXIT.ok;
        }
        io.out(`${report.action}: ${report.repository_url} → ${report.path}`);
        if (Array.isArray(report.imported_skills)) {
          const names = report.imported_skills;
          io.out(`  ${report.action === "planned" ? "Would import" : "Imported"} ${names.length} skill${names.length === 1 ? "" : "s"}${names.length ? `: ${cut(names.join(", "), lineWidth(io) * 2)}` : ""}.`);
          if (report.rejected?.length) io.out(`  ${report.rejected.length} left out by the import policy: --json lists each with its reason.`);
          if (report.instruction_policy) io.out(`  An imported skill is read as reference data until it is reviewed (${report.instruction_policy}).`);
        }
        if (report.rebuild?.total !== undefined) io.out(registryLine(report.rebuild));
        return EXIT.ok;
      });
    case "rebuild":
      noMore(0);
      return withTools(async ({ call }) => {
        const report = await call("rebuild_index", {});
        if (json) io.out(JSON.stringify(report, null, 2));
        else io.out(`${registryLine(report)} Design ${report.design}, external ${report.external}, Membrane ${report.membrane}.`);
        return EXIT.ok;
      });
    case "check":
      noMore(0);
      return withTools(async ({ call }) => {
        const report = await call("validate_skill_library", { write_report: false, max_issues: 50, ...(values.source ? { source: values.source } : {}) });
        if (json) {
          io.out(JSON.stringify(report, null, 2));
          return EXIT.ok;
        }
        const { summary } = report;
        io.out(`${summary.total} skills checked${values.source ? ` from ${values.source}` : ""}: ${summary.by_status?.pass ?? 0} pass, ${summary.by_status?.fail ?? 0} fail; average score ${summary.average_score}.`);
        const width = lineWidth(io);
        for (const issue of report.issues.slice(0, 20)) io.out(`  ${cut(`${issue.skill} (${issue.source}), ${issue.severity}: ${issue.message}`, width - 2)}`);
        if (report.issues_total > 20) io.out(`  … ${report.issues_total - 20} more: --json lists the first 50, --source custom checks the custom source only.`);
        return EXIT.ok;
      });
    default:
      return EXIT.usage;
  }
}
