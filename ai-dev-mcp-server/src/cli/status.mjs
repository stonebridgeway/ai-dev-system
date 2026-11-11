/**
 * `ai-dev status` — the state of this install in a few lines a person reads:
 * ok, degraded or failed and why, the local model, the search index, the AI
 * clients connected, the settings' problems and the health checks. It is the
 * desktop app's Status screen and tray colour (`system_status`), for a
 * terminal; `ai-dev doctor` prints the full health check as JSON.
 *
 * Exit codes: 0 ok or degraded, 1 failed, 2 a usage mistake.
 */
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { tildify } from "./context.mjs";
import { cut, lineWidth, withTools } from "./tools.mjs";

export function usage() {
  return [
    "Usage: ai-dev status [--quick] [--json]",
    "",
    "The state of this install: ok, degraded or failed and why, the local model, the search",
    "index, the AI clients connected, the settings' problems and the health checks.",
    "  --quick   leave the health checks out: only what is on disk",
    "  --json    print the result as JSON",
    "",
    "Exit 0 when it works (ok, or degraded: something optional is missing), 1 when it does not."
  ].join("\n");
}

/** The state as lines: a heading, one line per part, then each check that is not ok. */
export function renderStatus(status, width = 100) {
  const index = status.index;
  const model = status.model;
  const lines = [
    `AI Dev ${status.version} · ${status.status}: ${status.summary}`,
    `  install   ${status.install.kind} · ${tildify(status.install.root)}`,
    `  vault     ${tildify(status.install.vault_root)}`,
    `  model     ${model.installed ? `installed · ${tildify(model.dir)}` : model.supported === false ? `not available here: ${model.support_reason}` : "not installed: `ai-dev model install` gets it (about 600 MB), word search works without it"}`,
    `  index     ${index.exists ? `${index.documents} documents, ${index.dense_documents} with vectors${index.dense_pending ? `, ${index.dense_pending} waiting` : ""}${index.fresh ? "" : " · out of date: `ai-dev reindex`"}` : "not built: `ai-dev setup` builds it"}`,
    `  clients   ${status.clients.connected} of ${status.clients.found} found connected${status.clients.found > status.clients.connected ? ": `ai-dev clients install`" : ""}`
  ];
  for (const problem of status.settings_problems) lines.push(`  settings  ${cut(problem, width - 12)}`);
  const counts = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of status.checks) counts[check.status] = (counts[check.status] ?? 0) + 1;
  if (status.checks.length) {
    lines.push(`  checks    ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail${counts.skipped ? `, ${counts.skipped} skipped` : ""}`);
    for (const check of status.checks.filter((item) => item.status === "warn" || item.status === "fail")) {
      lines.push(`    ${check.status.padEnd(5)}${cut(`${check.name}: ${check.summary}`, width - 9)}`);
    }
  }
  return lines;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values } = parseCommandLine(argv, { command: "status", options: { json: { type: "boolean" }, quick: { type: "boolean" } } });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  return withTools(async ({ call }) => {
    const status = await call("system_status", { checks: !values.quick });
    if (values.json) io.out(JSON.stringify(status, null, 2));
    else for (const line of renderStatus(status, lineWidth(io))) io.out(line);
    return status.status === "failed" ? EXIT.failed : EXIT.ok;
  });
}
