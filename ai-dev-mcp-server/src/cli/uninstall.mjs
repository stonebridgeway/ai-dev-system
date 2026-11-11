/**
 * `ai-dev uninstall [--clients] [--data] [--yes] [--json]` — take the desktop
 * app's runtime off this computer. The Windows uninstaller runs it before it
 * removes the program's folder, with what the person answered to its two
 * questions, and reads the exit status (`desktop/build/installer.nsh`); on
 * macOS and Linux a person runs it before removing the app. The work is
 * `core/bundle-uninstall.mjs`.
 */
import os from "node:os";
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { uninstallBundle } from "../core/bundle-uninstall.mjs";
import { tildify } from "./context.mjs";
import { renderResults } from "./clients.mjs";

/** Something was left only because it is in use: close the AI clients and run it again. */
export const EXIT_IN_USE = 3;

/** The data was kept: its folder is not one `--data` deletes. */
export const EXIT_DATA_KEPT = 4;

export function usage() {
  return [
    "Usage: ai-dev uninstall [--clients] [--data] [--yes] [--json]",
    "",
    "Take the desktop app's runtime off this computer: stop the daemon, remove the runtime",
    "copies in <runtime home>/app and the link AI clients run. The Windows uninstaller runs this",
    "before it removes the program; on macOS and Linux, run it before you remove the app.",
    "Without --yes it only says what it would do.",
    "",
    "  --clients  also take the ai-dev entry out of each AI client whose entry runs this install;",
    "             an entry of another install (a clone, npx, Docker) stays",
    "  --data     also delete the runtime home with everything in it: the vault AI Dev keeps,",
    "             the tasks and session history, the local model, the search index, the backups,",
    "             the settings. Not while a runtime copy is in use, and not a folder that holds",
    "             anything AI Dev did not make, at its top or inside models, cache or backups",
    "  --yes      do it",
    "  --json     print the result as JSON",
    "",
    `Exit status: ${EXIT.ok} done; ${EXIT.failed} something failed; ${EXIT_IN_USE} something is in use (close the AI`,
    `clients and run it again); ${EXIT_DATA_KEPT} the data was kept, as the output says.`
  ].join("\n");
}

function render(result, io) {
  const home = os.homedir();
  const would = result.apply ? "" : "Would: ";
  for (const daemon of result.daemons) {
    if (daemon.stopped && !daemon.gone) io.out(`Stopped the daemon, pid ${daemon.pid}.`);
    else if (!daemon.stopped) io.out(`The daemon, pid ${daemon.pid}, did not stop: ${daemon.reason ?? "it is still running"}.`);
  }
  if (result.clients.length) {
    io.out(`${would}AI clients:`);
    for (const line of renderResults(result.clients, { home })) io.out(line);
  }
  for (const folder of result.copies.removed) io.out(`${would}Removed the runtime ${tildify(folder, home)}.`);
  for (const { folder, reason } of result.copies.left) io.out(`Left the runtime ${tildify(folder, home)}: ${reason}.`);
  if (result.link === "removed" || result.link === "would-remove") io.out(`${would}Removed the link AI clients run.`);
  if (result.stale_links.length) io.out(`Removed ${result.stale_links.length} link(s) an update that stopped half-way left beside it.`);
  const data = result.data;
  if (data.asked) {
    const folder = tildify(result.runtime_home, home);
    const target = data.target ? `${tildify(data.target, home)}, which ${folder} links to, with everything in it, and the link` : `${folder} and everything in it`;
    if (data.reason) io.out(`Kept ${data.target ? tildify(data.target, home) : folder}: ${data.reason}${/[.!?]$/.test(data.reason) ? "" : "."}`);
    else if (data.absent) io.out(`Nothing to delete: ${folder} is not there.`);
    else io.out(`${would}Deleted ${target}.`);
  }
  if (!result.apply) io.out("Nothing changed: run it again with --yes.");
}

/** The exit status the uninstaller reads: in use before failed, so a Retry is offered whenever one can help. */
export function exitStatus(result) {
  const busy = result.copies.left.some((left) => left.busy) || result.data.busy === true;
  const failed = result.copies.left.some((left) => !left.busy)
    || result.daemons.some((daemon) => !daemon.stopped)
    || result.clients.some((client) => client.status === "failed")
    || (result.data.asked && result.apply && !result.data.removed && !result.data.busy && !result.data.refused);
  if (busy) return EXIT_IN_USE;
  if (failed) return EXIT.failed;
  return result.data.refused ? EXIT_DATA_KEPT : EXIT.ok;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  const { values } = parseCommandLine(argv, {
    command: "uninstall",
    options: { clients: { type: "boolean" }, data: { type: "boolean" }, yes: { type: "boolean" }, json: { type: "boolean" } }
  });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  const result = await uninstallBundle({ env: io.env, clients: values.clients === true, data: values.data === true, apply: values.yes === true });
  if (values.json) io.out(JSON.stringify(result, null, 2));
  else render(result, io);
  return exitStatus(result);
}
