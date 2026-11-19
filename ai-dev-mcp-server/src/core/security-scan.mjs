/**
 * Running the security scanners a project already has installed.
 *
 * Ten adapters: `npm audit`, `pnpm audit`, `yarn audit`, `bun audit`,
 * `osv-scanner`, `pip-audit`, `cargo audit`, `gitleaks`, `semgrep` and
 * `trivy fs`. Each one knows three things — how to tell whether its binary is
 * there, whether this project is the kind it has anything to say about, and
 * how to read its output — and nothing else.
 * The findings come back in one shape (`security-scan-parsers.mjs`) so
 * `verify_task` can grade them without knowing which tool produced them.
 *
 * A package manager's audit runs in every directory, up to two levels down,
 * that holds its lockfile: a repository with `frontend/` and `backend/` has two
 * dependency trees and neither is at the root. Two scanners reporting the same
 * advisory for the same package are one finding (`mergeDuplicateFindings`).
 *
 * Two rules shape the whole module:
 *
 * - **A missing scanner is a `skipped` result with a reason, never an error.**
 *   Nobody installs all ten. A scan that fails because `trivy` is absent would
 *   teach an agent to stop running scans. A run where *none* of them could run
 *   is still not a failure — it is `unchecked`, which passes without claiming
 *   anything was checked.
 * - **A scanner that needs the network says so instead of hanging.** All but
 *   two fetch an advisory database. Offline they fail slowly and in their
 *   own way, so they are skipped up front when the run is declared offline, and
 *   a run that came back with nothing and an errno is read as "offline", not as
 *   a scan failure. `verify_task` therefore cannot be held up by a missing
 *   network. That reading is deliberately narrow: findings are never evidence
 *   about the network, because a scan that retracts itself over a word in its
 *   own report fails open while looking clean.
 *
 * The gate: critical and high `dependency`, `malware` and `secret` findings
 * block; every other finding, and every severity a scanner did not state, warns. A blocked
 * verification has to name a fixable thing, and "semgrep's auto rule pack has
 * an opinion about this line" is not that.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { locateExecutable, runProcess } from "./process-runner.mjs";
import { mergeDuplicateFindings } from "./security-scan-findings.mjs";
import { RECOGNIZED_REPORTS, parseBunAudit, parseOsvScanner, parsePnpmAudit, parseYarnAudit } from "./security-scan-js-parsers.mjs";
import { LOCKFILE_SEARCH_DEPTH, markerDirectories, yarnAuditArgs } from "./security-scan-lockfiles.mjs";
import {
  SECURITY_FINDING_KINDS,
  SECURITY_SEVERITIES,
  parseCargoAudit,
  parseGitleaks,
  parseNpmAudit,
  parsePipAudit,
  parseSemgrep,
  parseTrivy
} from "./security-scan-parsers.mjs";

export { SECURITY_FINDING_KINDS, SECURITY_SEVERITIES };
export { LOCKFILE_SEARCH_DEPTH, markerDirectories, mergeDuplicateFindings, yarnAuditArgs };

/** Severities that stop a verification, for a finding kind that is allowed to. */
export const BLOCKING_SEVERITIES = Object.freeze(["critical", "high"]);

/** Finding kinds a `block` may come from. */
export const BLOCKING_KINDS = Object.freeze(["dependency", "malware", "secret"]);

/** How long any one scanner gets. A scanner that overstays is reported, not awaited. */
export const SCANNER_TIMEOUT_MS = 180_000;

/** How long an availability probe gets. It only asks a tool for its version. */
export const SCANNER_PROBE_TIMEOUT_MS = 10_000;

/** Yarn 1 exits with a bitmask of the severities it found (1 info … 16 critical). */
const YARN_CLASSIC_EXIT_CODES = Object.freeze(Array.from({ length: 32 }, (_, index) => index));

/**
 * The scanner catalogue.
 *
 * `markers` is what makes the scanner relevant: `cargo audit` has nothing to
 * say about a repository with no `Cargo.lock`, and running it anyway produces a
 * confusing error rather than a finding. An empty `markers` list means the
 * scanner applies to any repository.
 *
 * `network` is whether the scanner fetches an advisory database or a rule pack.
 * `report: "file"` is for a scanner that writes its JSON to a path instead of
 * stdout.
 */
export const SECURITY_SCANNERS = Object.freeze([
  {
    id: "npm_audit",
    tool: "npm audit",
    executable: "npm",
    args: ["audit", "--json"],
    markers: ["package-lock.json", "npm-shrinkwrap.json"],
    nested: true,
    network: true,
    parse: parseNpmAudit,
    // npm audit exits 1 when it finds something, which is the normal case here.
    successExitCodes: [0, 1],
    purpose: "known vulnerabilities and malware advisories in the npm dependency tree"
  },
  {
    id: "pnpm_audit",
    tool: "pnpm audit",
    executable: "pnpm",
    args: ["audit", "--json"],
    markers: ["pnpm-lock.yaml"],
    nested: true,
    network: true,
    parse: parsePnpmAudit,
    successExitCodes: [0, 1],
    purpose: "known vulnerabilities and malware advisories in the pnpm dependency tree"
  },
  {
    id: "yarn_audit",
    tool: "yarn audit",
    executable: "yarn",
    args: ["audit", "--json"],
    argsFor: yarnAuditArgs,
    markers: ["yarn.lock"],
    nested: true,
    network: true,
    parse: parseYarnAudit,
    successExitCodes: YARN_CLASSIC_EXIT_CODES,
    purpose: "known vulnerabilities and malware advisories in the Yarn dependency tree"
  },
  {
    id: "bun_audit",
    tool: "bun audit",
    executable: "bun",
    args: ["audit", "--json"],
    markers: ["bun.lock", "bun.lockb"],
    nested: true,
    network: true,
    parse: parseBunAudit,
    successExitCodes: [0, 1],
    purpose: "known vulnerabilities and malware advisories in the Bun dependency tree"
  },
  {
    id: "osv_scanner",
    tool: "osv-scanner",
    executable: "osv-scanner",
    // `--recursive` finds every lockfile below the root, whatever its package
    // manager; `--allow-no-lockfiles` makes a repository without one a clean
    // run instead of exit 128.
    args: ["scan", "source", "--recursive", "--allow-no-lockfiles", "--format", "json", "."],
    markers: [],
    network: true,
    parse: parseOsvScanner,
    successExitCodes: [0, 1],
    purpose: "OSV advisories and OpenSSF malicious-package reports against every lockfile"
  },
  {
    id: "pip_audit",
    tool: "pip-audit",
    executable: "pip-audit",
    args: ["--format", "json", "--progress-spinner", "off"],
    markers: ["requirements.txt", "pyproject.toml", "Pipfile.lock", "poetry.lock"],
    network: true,
    parse: parsePipAudit,
    successExitCodes: [0, 1],
    purpose: "known vulnerabilities in installed Python packages"
  },
  {
    id: "cargo_audit",
    tool: "cargo audit",
    executable: "cargo",
    args: ["audit", "--json"],
    markers: ["Cargo.lock"],
    network: true,
    parse: parseCargoAudit,
    successExitCodes: [0, 1],
    // `cargo` is Rust's package manager; `cargo audit` is a plugin installed
    // separately with `cargo install cargo-audit`. Finding `cargo` on the PATH
    // therefore proves nothing about this scanner, and a machine with Rust and
    // no plugin was told the scanner was installed. A
    // scanner that is a subcommand of something else declares the probe that
    // answers the question instead of being believed on its executable.
    probeArgs: ["audit", "--version"],
    purpose: "RUSTSEC advisories against Cargo.lock"
  },
  {
    id: "gitleaks",
    tool: "gitleaks",
    executable: "gitleaks",
    args: ["detect", "--no-banner", "--redact", "--report-format", "json", "--report-path", "{report}"],
    markers: [],
    network: false,
    report: "file",
    parse: parseGitleaks,
    successExitCodes: [0, 1],
    purpose: "credentials committed to the repository or its history"
  },
  {
    id: "semgrep",
    tool: "semgrep",
    executable: "semgrep",
    args: ["scan", "--json", "--quiet", "--config", "{config}", "--metrics", "off"],
    markers: [],
    // Only with the hosted rule packs. A project that keeps its own rules in
    // `.semgrep.yml` is scanned offline, which `semgrepConfigFor` decides.
    network: "config",
    parse: parseSemgrep,
    successExitCodes: [0, 1],
    purpose: "static-analysis rules over the source"
  },
  {
    id: "trivy_fs",
    tool: "trivy fs",
    executable: "trivy",
    args: ["fs", "--format", "json", "--quiet", "--scanners", "vuln,secret,misconfig", "."],
    markers: [],
    network: true,
    parse: parseTrivy,
    successExitCodes: [0],
    purpose: "dependency vulnerabilities, secrets and misconfiguration over the tree"
  }
]);

/** Local semgrep rule files, in the order semgrep itself documents them. */
const SEMGREP_LOCAL_CONFIGS = Object.freeze([".semgrep.yml", ".semgrep.yaml", "semgrep.yml", "semgrep.yaml", ".semgrep"]);

/**
 * Output that means "there was no network", whatever the scanner calls it.
 *
 * Machine tokens only: errno names, the resolver call, the kernel's and npm's
 * own wording for a dead socket. No ordinary word goes in here. An advisory
 * titled "…cache-key and proxy interpretation differentials" used to match the
 * bare word `proxy` and turn fourteen real findings of this repository, five of
 * them high, into "npm audit could not reach the network" — a scan that failed
 * open while reading as a clean bill of health.
 *
 * `osv-scanner` is Go, and says it differently: the resolver's `dial tcp …: no
 * such host`, and its own `max retries exceeded: attempt 4: request failed`
 * when the API answered nothing usable — measured behind a proxy that refuses
 * api.osv.dev, where the report is an empty `results` list and the exit 127.
 */
const OFFLINE_OUTPUT = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b|\bgetaddrinfo\b|network is unreachable|temporary failure in name resolution|could not resolve host|npm error network\b|\bdial tcp\b[^\n]*(?:no such host|i\/o timeout|connection refused)|max retries exceeded: attempt \d+: request failed\b/i;

async function pathExists(target) {
  return fs.stat(target).then(() => true).catch(() => false);
}

/**
 * Whether this run may reach the network.
 *
 * There is no way to ask the operating system, so the answer comes from the
 * caller, then from the environment (`AI_DEV_OFFLINE`), and is `false` —
 * "assume the network is there" — otherwise. Being wrong in that direction
 * costs one scanner's timeout, and the output check turns the failure into a
 * `skipped` result anyway.
 *
 * @param {boolean | undefined} requested
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function resolveOffline(requested, env = process.env) {
  if (typeof requested === "boolean") return requested;
  const flag = String(env.AI_DEV_OFFLINE ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(flag);
}

/**
 * The semgrep rule set to scan with: the project's own file when it has one,
 * otherwise the hosted `auto` pack, which needs the network.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ config: string, local: boolean }>}
 */
export async function semgrepConfigFor(projectRoot) {
  for (const candidate of SEMGREP_LOCAL_CONFIGS) {
    if (await pathExists(path.join(projectRoot, candidate))) return { config: candidate, local: true };
  }
  return { config: "auto", local: false };
}

/**
 * The scanners a request names.
 *
 * `auto` is every scanner in the catalogue; the caller can also name ids. An id
 * nobody recognises is an error — a silently ignored scanner name reads as "it
 * ran and found nothing".
 *
 * @param {string[] | string} [requested]
 * @returns {typeof SECURITY_SCANNERS}
 */
export function selectScanners(requested = "auto") {
  const names = Array.isArray(requested)
    ? requested.map((item) => String(item ?? "").trim()).filter(Boolean)
    : String(requested ?? "auto").split(",").map((item) => item.trim()).filter(Boolean);
  if (!names.length || names.includes("auto") || names.includes("all")) return SECURITY_SCANNERS;
  const known = new Map(SECURITY_SCANNERS.map((scanner) => [scanner.id, scanner]));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length) {
    throw new Error(`Unknown scanner${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${[...known.keys()].join(", ")}, or "auto".`);
  }
  return names.map((name) => known.get(name));
}

/**
 * Why a scanner will not run here, or "" when it will.
 *
 * @param {object} scanner
 * @param {{ binary: string, markerFound: string, offline: boolean, network: boolean }} state
 * @returns {string}
 */
export function skipReasonFor(scanner, { binary, markerFound, offline, network }) {
  if (!binary) {
    return `${scanner.executable} is not installed or not on the PATH, so ${scanner.tool} could not look for ${scanner.purpose}.`;
  }
  if (scanner.markers.length && !markerFound) {
    const where = scanner.nested ? ` at its root or up to ${LOCKFILE_SEARCH_DEPTH} levels below it` : "";
    return `This project has none of ${scanner.markers.join(", ")}${where}, so ${scanner.tool} has nothing to read.`;
  }
  if (network && offline) {
    return `${scanner.tool} needs to fetch ${scanner.id === "semgrep" ? "its rule pack" : "an advisory database"} and this run is offline. Its findings are unknown, not absent — run it again with a network, or keep local rules in the repository.`;
  }
  return "";
}

function scannerNeedsNetwork(scanner, { semgrepLocal }) {
  if (scanner.network === "config") return !semgrepLocal;
  return Boolean(scanner.network);
}

function expandArgs(args, replacements) {
  return args.map((argument) => String(argument).replace(/\{(\w+)\}/g, (whole, key) => (
    Object.hasOwn(replacements, key) ? replacements[key] : whole
  )));
}

function outputTail(result, limit = 400) {
  return `${result?.stderr || result?.stdout || ""}`.trim().split("\n").slice(-4).join(" ").slice(0, limit);
}

/**
 * The one line of a failed run worth quoting: the first thing the scanner said
 * went wrong. Never a slice of the report — a tail of `npm audit --json` is a
 * fragment of somebody's dependency tree, which explains nothing.
 *
 * @param {{ stderr?: string }} result
 * @param {string} report - What the scanner printed or wrote as its report.
 * @returns {string}
 */
function firstProblemLine(result, report, limit = 200) {
  const source = String(result?.stderr ?? "").trim() || String(report ?? "").trim();
  const lines = source.split("\n").map((item) => item.trim()).filter(Boolean);
  // In a report the first line is usually a brace. The line that names the
  // errno is the one that says anything.
  const line = lines.find((item) => OFFLINE_OUTPUT.test(item)) ?? lines[0] ?? "";
  return line.replace(/\s+/g, " ").slice(0, limit);
}

/**
 * Run one scanner and read its output.
 *
 * @param {object} scanner
 * @param {object} input
 * @returns {Promise<object>}
 */
async function runOneScanner(scanner, { projectRoot, directory = projectRoot, offline, timeoutMs, runner, locate, reportDir, semgrepConfig }) {
  const started = Date.now();
  const base = { id: scanner.id, tool: scanner.tool, purpose: scanner.purpose };
  const binary = await locate(scanner.executable).catch(() => "");
  let markerFound = "";
  for (const marker of scanner.markers) {
    if (await pathExists(path.join(directory, marker))) {
      markerFound = marker;
      break;
    }
  }
  const network = scannerNeedsNetwork(scanner, { semgrepLocal: semgrepConfig.local });
  const skipped = skipReasonFor(scanner, { binary, markerFound, offline, network });
  if (skipped) return { ...base, status: "skipped", reason: skipped, findings: [], duration_ms: 0 };

  const args = expandArgs(scanner.argsFor ? await scanner.argsFor(directory) : scanner.args, {
    report: scanner.report === "file" ? path.join(reportDir, `${scanner.id}.json`) : "",
    config: semgrepConfig.config
  });
  let result;
  try {
    result = await runner({ executable: binary || scanner.executable, args, cwd: directory, timeoutMs });
  } catch (error) {
    return {
      ...base,
      status: "error",
      reason: `${scanner.tool} could not be started: ${error?.message ?? error}`,
      findings: [],
      duration_ms: Date.now() - started
    };
  }
  if (result.timedOut) {
    return {
      ...base,
      status: "skipped",
      reason: `${scanner.tool} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped. Its findings are unknown, not absent.`,
      findings: [],
      duration_ms: Date.now() - started
    };
  }

  let raw = result.stdout ?? "";
  if (scanner.report === "file") {
    const reportPath = args[args.indexOf("--report-path") + 1];
    raw = await fs.readFile(reportPath, "utf8").catch(() => result.stdout ?? "");
  }
  const where = path.relative(projectRoot, directory).split(path.sep).join("/");
  // A finding from a lockfile below the root names that lockfile, not the
  // bare file name every directory shares.
  const findings = scanner.parse(raw, { projectRoot: directory }).map((item) => (
    where && item.file && !item.file.includes("/") ? { ...item, file: `${where}/${item.file}` } : item
  ));
  const exitOk = scanner.successExitCodes.includes(result.exitCode ?? -1);
  // Offline is decided by the failure channel, never by what the scanner
  // found. A scanner that came back with findings reached whatever it needed
  // to reach, so its findings stand and no word inside them can retract the
  // run. Only a run that produced nothing can be a run the network ate — and
  // then the report is read too, because npm prints its own network failure as
  // a JSON document on stdout under `--json` and still exits 1.
  if (network && !findings.length && (OFFLINE_OUTPUT.test(result.stderr ?? "") || OFFLINE_OUTPUT.test(raw))) {
    return {
      ...base,
      status: "skipped",
      reason: `${scanner.tool} exited ${result.exitCode ?? "without an exit code"} without reaching the network: ${firstProblemLine(result, raw)}. Its findings are unknown, not absent.`,
      findings: [],
      duration_ms: Date.now() - started
    };
  }
  const recognized = RECOGNIZED_REPORTS[scanner.id];
  const unrecognized = recognized && result.exitCode !== 0 && !findings.length && !recognized(raw);
  if ((!exitOk || unrecognized) && !findings.length) {
    return {
      ...base,
      status: "error",
      reason: `${scanner.tool} exited ${result.exitCode} without a report: ${unrecognized ? firstProblemLine(result, raw) : outputTail(result)}`,
      findings: [],
      duration_ms: Date.now() - started
    };
  }
  return {
    ...base,
    status: "ok",
    reason: "",
    findings,
    truncated: Boolean(result.truncated),
    duration_ms: Date.now() - started
  };
}

/**
 * One scanner's runs over several directories, as the one result the report
 * has a line for. An error in any directory is an error — findings from the
 * others still count, and the reason names the directory that failed.
 *
 * @param {object[]} runs - Each with the `directory` it ran in.
 * @returns {object}
 */
function combineRuns(runs) {
  if (runs.length === 1) {
    const [{ directory, ...only }] = runs;
    return directory === "." ? only : { ...only, directories: [directory] };
  }
  const status = runs.some((run) => run.status === "error")
    ? "error"
    : runs.some((run) => run.status === "ok") ? "ok" : "skipped";
  const problems = runs.filter((run) => run.status !== "ok").map((run) => `${run.directory}: ${run.reason}`);
  return {
    id: runs[0].id,
    tool: runs[0].tool,
    purpose: runs[0].purpose,
    status,
    reason: problems.join(" "),
    findings: runs.flatMap((run) => run.findings),
    truncated: runs.some((run) => run.truncated),
    directories: runs.map((run) => run.directory),
    duration_ms: runs.reduce((total, run) => total + (run.duration_ms ?? 0), 0)
  };
}

/**
 * Whether a finding is one a verification may be stopped for.
 *
 * @param {{ kind: string, severity: string }} item
 * @returns {boolean}
 */
export function findingBlocks(item) {
  return BLOCKING_KINDS.includes(String(item?.kind ?? "")) && BLOCKING_SEVERITIES.includes(String(item?.severity ?? ""));
}

/**
 * The scan's verdict: `block`, `warn`, `unchecked`, or `pass`.
 *
 * A scanner that was skipped or errored never blocks — that is the whole point
 * of the skip. But a run where not one of them could run proves nothing, and
 * calling that `pass` made "security: pass" mean "checked and clean" when it
 * meant "nobody looked": `checked: 0` was the only thing that said otherwise
 * and nothing read it. Such a run is `unchecked`.
 *
 * `unchecked` still does not block — the rule that a missing scanner cannot
 * stop a verification is unchanged — it only stops the run claiming a result it
 * does not have.
 *
 * @param {{ findings: object[], scanners: object[] }} scan
 * @returns {"block" | "warn" | "unchecked" | "pass"}
 */
export function securityScanStatus({ findings = [], scanners = [] } = {}) {
  if (findings.some(findingBlocks)) return "block";
  if (findings.length) return "warn";
  if (scanners.some((scanner) => scanner.status === "error")) return "warn";
  if (!scanners.some((scanner) => scanner.status === "ok")) return "unchecked";
  return "pass";
}

/**
 * Run the selected scanners over a project.
 *
 * @param {string} projectRoot - Absolute repository path.
 * @param {object} [options]
 * @param {string[]|string} [options.scanners] - Ids, or `auto`.
 * @param {boolean} [options.offline] - Skip network scanners up front.
 * @param {number} [options.timeoutMs] - Per scanner.
 * @param {Function} [options.runner] - Process runner (injected by tests).
 * @param {Function} [options.locate] - Executable locator (injected by tests).
 * @returns {Promise<object>}
 */
export async function runSecurityScan(projectRoot, {
  scanners: requested = "auto",
  offline,
  timeoutMs = SCANNER_TIMEOUT_MS,
  runner = runProcess,
  locate = locateExecutable
} = {}) {
  const root = path.resolve(projectRoot);
  const selected = selectScanners(requested);
  const isOffline = resolveOffline(offline);
  const semgrepConfig = await semgrepConfigFor(root);
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-security-"));
  let results;
  try {
    results = [];
    for (const scanner of selected) {
      const found = scanner.nested && scanner.markers.length ? await markerDirectories(root, scanner.markers) : [];
      const runs = [];
      for (const directory of found.length ? found : [root]) {
        const run = await runOneScanner(scanner, {
          projectRoot: root,
          directory,
          offline: isOffline,
          timeoutMs,
          runner,
          locate,
          reportDir,
          semgrepConfig
        });
        runs.push({ ...run, directory: path.relative(root, directory).split(path.sep).join("/") || "." });
      }
      results.push(combineRuns(runs));
    }
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const findings = mergeDuplicateFindings(results.flatMap((result) => result.findings))
    .sort((left, right) => (
      SECURITY_SEVERITIES.indexOf(left.severity) - SECURITY_SEVERITIES.indexOf(right.severity) ||
      left.tool.localeCompare(right.tool) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line
    ));
  const bySeverity = Object.fromEntries(SECURITY_SEVERITIES.map((severity) => [
    severity,
    findings.filter((item) => item.severity === severity).length
  ]));
  const scan = {
    project_path: root,
    offline: isOffline,
    semgrep_config: semgrepConfig,
    scanners: results.map(({ findings: _findings, ...rest }) => ({ ...rest, findings: _findings.length })),
    findings,
    summary: {
      checked: results.filter((result) => result.status === "ok").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "error").length,
      findings: findings.length,
      blocking: findings.filter(findingBlocks).length,
      by_severity: bySeverity
    }
  };
  return { ...scan, status: securityScanStatus({ findings, scanners: results }) };
}

/**
 * The scan as the report an agent reads in a checkpoint.
 *
 * @param {object} scan - From {@link runSecurityScan}.
 * @returns {string}
 */
export function renderSecurityScanMarkdown(scan) {
  const lines = [`# Security scan: ${scan.status}`, ""];
  lines.push(`${scan.summary.checked} scanner(s) ran, ${scan.summary.skipped} skipped, ${scan.summary.failed} failed. ${scan.summary.findings} finding(s), ${scan.summary.blocking} blocking.`, "");
  if (scan.status === "unchecked") {
    lines.push("Nothing was checked: no scanner ran here, so this project has not been found clean — it has not been looked at. Install at least one (gitleaks needs no network).", "");
  }
  for (const scanner of scan.scanners) {
    const detail = scanner.status === "ok" ? `${scanner.findings} finding(s)` : scanner.reason;
    lines.push(`- **${scanner.tool}** — ${scanner.status}: ${detail}`);
  }
  if (scan.findings.length) {
    lines.push("", "## Findings", "");
    for (const item of scan.findings.slice(0, 50)) {
      const where = item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : "";
      const also = item.confirmed_by?.length ? `, also ${item.confirmed_by.join(", ")}` : "";
      lines.push(`- \`${item.severity}\` **${item.kind}** [${item.tool}${item.rule ? ` ${item.rule}` : ""}${also}]${where} — ${item.message}`);
    }
    if (scan.findings.length > 50) lines.push(`- …and ${scan.findings.length - 50} more.`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The scanners that have something to say with no network at all: gitleaks
 * reads the repository and its history, and semgrep does too when the project
 * keeps its own rules (`semgrepConfigFor`). The others fetch an advisory
 * database or a hosted rule pack.
 */
export const OFFLINE_CAPABLE_SCANNERS = Object.freeze(["gitleaks", "semgrep"]);

/**
 * Whether one scanner can actually run on this machine, and why not when it
 * cannot.
 *
 * For a scanner that is its own binary, being on the PATH is the whole
 * question. For a scanner that is a subcommand of something else, it is not:
 * `cargo` is on the PATH of every Rust machine and `cargo audit` is a plugin
 * most of them have never installed. Such a scanner carries `probeArgs`, and
 * the probe — the tool asked for its own version, argv array, `shell: false`,
 * seconds not minutes — decides.
 *
 * The probe runs in a temporary directory rather than in a project: it asks a
 * version, and it must not be able to read, or be confused by, whatever
 * repository the caller happens to be looking at.
 *
 * @param {object} scanner - One entry of {@link SECURITY_SCANNERS}.
 * @param {object} [options]
 * @param {Function} [options.locate] - Executable locator (injected by tests).
 * @param {Function} [options.runner] - Process runner (injected by tests).
 * @param {number} [options.timeoutMs]
 * @param {string} [options.cwd]
 * @returns {Promise<{ id: string, tool: string, executable: string, installed: boolean, reason?: string }>}
 */
export async function scannerAvailability(scanner, {
  locate = locateExecutable,
  runner = runProcess,
  timeoutMs = SCANNER_PROBE_TIMEOUT_MS,
  cwd = os.tmpdir()
} = {}) {
  const entry = { id: scanner.id, tool: scanner.tool, executable: scanner.executable };
  const binary = await locate(scanner.executable).catch(() => "");
  if (!binary) {
    return { ...entry, installed: false, reason: `${scanner.executable} is not installed or not on the PATH.` };
  }
  if (!scanner.probeArgs?.length) return { ...entry, installed: true };

  const probe = await runner({
    executable: scanner.executable,
    args: [...scanner.probeArgs],
    cwd,
    timeoutMs
  }).catch((error) => ({ ok: false, stderr: String(error?.message ?? error), stdout: "" }));
  if (probe?.ok) return { ...entry, installed: true };

  const said = firstOutputLine(`${probe?.stderr ?? ""}\n${probe?.stdout ?? ""}`);
  const because = probe?.timedOut ? "it did not answer in time" : said || "it answered with an error";
  return {
    ...entry,
    installed: false,
    // The distinction worth stating: this machine has the host tool and is one
    // `cargo install cargo-audit` away, which is not the same gap as not having
    // Rust at all.
    reason: `${scanner.executable} is installed but \`${scanner.tool}\` is not — ${because}`
  };
}

/** Everything the scanners in the catalogue answer about this machine. */
export async function securityScannerAvailability(options = {}) {
  return Promise.all(SECURITY_SCANNERS.map((scanner) => scannerAvailability(scanner, options)));
}

/** The first line of some command output worth quoting, or "". */
function firstOutputLine(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 160) ?? "";
}

/**
 * Whether this machine can check anything at all, for `system_health_check`.
 *
 * Not critical: a machine with no scanner installed is a machine where
 * `run_security_scan` comes back `unchecked`, which is a gap worth naming and
 * not a broken system. It is named here because the scan itself is only run on
 * demand, and the published image ships with one of them at most — so
 * without this check the gap is invisible until a task asks for a scan.
 *
 * @param {Array<{ id: string, tool: string, executable: string, installed: boolean }>} availability
 * @returns {{ status: string, summary: string, details: object }}
 */
export function evaluateSecurityScanners(availability) {
  const all = Array.isArray(availability) ? availability : [];
  const installed = all.filter((item) => item.installed);
  const missing = all.filter((item) => !item.installed);
  const details = {
    installed: installed.map((item) => item.id),
    missing: missing.map((item) => item.id),
    offline_capable: installed.filter((item) => OFFLINE_CAPABLE_SCANNERS.includes(item.id)).map((item) => item.id),
    // Why each absent scanner is absent, when the answer is more than "it is
    // not on the PATH" — "you have cargo but not cargo-audit" is a different
    // gap, and a different fix, from "you have no Rust".
    missing_reasons: Object.fromEntries(
      missing.filter((item) => item.reason).map((item) => [item.id, item.reason])
    )
  };
  if (!installed.length) {
    return {
      status: "warn",
      summary: `None of the ${all.length} security scanners is installed, so run_security_scan comes back unchecked. Install gitleaks: it is the cheapest of them and needs no network.`,
      details
    };
  }
  return {
    status: "ok",
    summary: `${installed.length} of ${all.length} security scanners installed: ${details.installed.join(", ")}.`,
    details
  };
}
