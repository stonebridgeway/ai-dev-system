/**
 * `ai-dev backup` and `ai-dev restore` — AI Dev's data as one `.zip`, and back.
 *
 * In 2.x both were PowerShell scripts that worked only inside the owner's full
 * vault; `ai-dev backup` refused every system but Windows, and a clone or a
 * package had no backup at all. These run wherever
 * Node does, for every layout: the vault this install reads and the runtime's
 * `state/`, each file with its sha256 (`core/backup-archive.mjs`).
 */
import path from "node:path";
import { createBackup, restoreBackup } from "../core/backup-archive.mjs";
import { CliUsageError, EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { currentInstallLayout, hint } from "../core/install-layout.mjs";
import { formatBytes } from "../core/disk-space.mjs";
import { tildify } from "./context.mjs";

const USAGE = {
  backup: [
    "Usage: ai-dev backup [label] [--to <folder>] [--json]",
    "",
    "Write ai-dev-system_<time>_<label>.zip and its .sha256: the vault this install",
    "reads and AI Dev's state (tasks, sessions, usage, instincts, client records),",
    "every file with its sha256. Indexes, caches, models and dependencies are left",
    "out: setup rebuilds them.",
    "  --to <folder>   where the archive goes (default: <AI Dev home>/backups)",
    "  --json          print the result as JSON"
  ],
  restore: [
    "Usage: ai-dev restore <archive.zip> --confirm [--to <folder>] [--overwrite] [--json]",
    "",
    "Put a backup back: the vault part into the vault this install reads, the state",
    "part into AI Dev's state folder. The archive is checked against its .sha256 and",
    "every file against the manifest; nothing is written over an existing file unless",
    "--overwrite says so, and that is checked before the first file is written.",
    "  --confirm       required: a restore writes into your data",
    "  --to <folder>   lay the archive out under this folder instead (an archive the",
    "                  2.x PowerShell script made holds a whole vault and needs it)",
    "  --overwrite     replace files that are there",
    "  --json          print the result as JSON"
  ]
};

/** @param {string} name */
export function usage(name) {
  return USAGE[name].join("\n");
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 * @param {"backup"|"restore"} name
 */
export async function run(argv, io, name) {
  const options = name === "backup"
    ? { to: { type: "string" }, json: { type: "boolean" } }
    : { to: { type: "string" }, confirm: { type: "boolean" }, overwrite: { type: "boolean" }, json: { type: "boolean" } };
  const { values, positionals } = parseCommandLine(argv, {
    command: name,
    options,
    positionals: name === "backup" ? { max: 1, names: "label" } : { min: 1, max: 1, names: "archive" }
  });
  if (values.help) {
    io.out(usage(name));
    return EXIT.ok;
  }
  // Whatever 2.x left in AI_DEV_HOME/.ai-dev or ~/.codex moves first: a backup
  // of the runtime tree must find the state where the server now keeps it.
  const { prepareRuntimeHome } = await import("../core/runtime-home-migration.mjs");
  await prepareRuntimeHome({ env: io.env });
  const layout = currentInstallLayout();
  const runtimeRoot = layout.runtimeRoot;
  // Where the server keeps its state: AI_DEV_STATE_ROOT moves it.
  const stateRoot = io.env.AI_DEV_STATE_ROOT ? path.resolve(io.env.AI_DEV_STATE_ROOT) : path.join(runtimeRoot, "state");

  if (name === "backup") {
    const destination = values.to ? path.resolve(values.to) : path.join(runtimeRoot, "backups");
    const result = await createBackup({
      contentRoot: layout.contentRoot,
      runtimeRoot,
      stateRoot,
      destination,
      label: positionals[0] || "manual",
      layout: layout.kind
    });
    if (values.json) {
      io.out(JSON.stringify({ status: "created", ...result }, null, 2));
      return EXIT.ok;
    }
    io.out(`Backup: ${tildify(result.archive)} (${result.files} file(s), ${formatBytes(result.bytes)} before compression).`);
    io.out(`SHA-256: ${result.sha256}`);
    io.out(`It holds ${tildify(layout.contentRoot)} and ${tildify(stateRoot)}.`);
    if (result.skipped.length) io.out(`Left out: ${result.skipped.length} link(s) or oversized file(s), the first ${result.skipped[0].path} (${result.skipped[0].reason}).`);
    io.out(`To put it back: ${hint("npm run ai-dev -- restore")} "${result.archive}" --confirm`);
    return EXIT.ok;
  }

  if (!values.confirm) {
    throw new CliUsageError("`ai-dev restore` writes into your data: add --confirm to go ahead. See `ai-dev help restore`.");
  }
  const archive = path.resolve(positionals[0]);
  const result = await restoreBackup({
    archive,
    contentRoot: layout.contentRoot,
    runtimeRoot,
    stateRoot,
    target: values.to ? path.resolve(values.to) : "",
    overwrite: Boolean(values.overwrite)
  });
  if (values.json) {
    io.out(JSON.stringify({ status: "restored", archive, ...result }, null, 2));
    return EXIT.ok;
  }
  io.out(`Restored ${result.restored} file(s) from ${tildify(archive)} into ${result.places.map((place) => tildify(place)).join(" and ")}.`);
  io.out(`Indexes and registries are rebuilt from them: ${hint("npm run setup")}`);
  return EXIT.ok;
}
