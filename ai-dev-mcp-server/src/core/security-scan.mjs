/**
 * Running the security scanners a project already has installed.
 *
 * Six adapters (PLAN.md, stage 3.3): `npm audit`, `pip-audit`, `cargo audit`,
 * `gitleaks`, `semgrep` and `trivy fs`. Each one knows three things — how to
 * tell whether its binary is there, whether this project is the kind it has
 * anything to say about, and how to read its output — and nothing else. The
 * findings come back in one shape (`security-scan-parsers.mjs`) so
 * `verify_task` can grade them without knowing which tool produced them.
 *
 * Two rules shape the whole module:
 *
 * - **A missing scanner is a `skipped` result with a reason, never an error.**
 *   Nobody installs all six. A scan that fails because `trivy` is absent would
 *   teach an agent to stop running scans.
 * - **A scanner that needs the network says so instead of hanging.** Five of
 *   the six fetch an advisory database. Offline they fail slowly and in their
 *   own way, so they are skipped up front when the run is declared offline, and
 *   a run that came back with nothing and an errno is read as "offline", not as
 *   a scan failure. `verify_task` therefore cannot be held up by a missing
 *   network. That reading is deliberately narrow: findings are never evidence
 *   about the network, because a scan that retracts itself over a word in its
 *   own report fails open while looking clean.
 *
 * The gate: critical and high `dependency` and `secret` findings block; every
 * other finding, and every severity a scanner did not state, warns. A blocked
 * verification has to name a fixable thing, and "semgrep's auto rule pack has
 * an opinion about this line" is not that.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { locateExecutable, runProcess } from "./process-runner.mjs";
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

/** Severities that stop a verification, for a finding kind that is allowed to. */
export const BLOCKING_SEVERITIES = Object.freeze(["critical", "high"]);

/** Finding kinds a `block` may come from. */
export const BLOCKING_KINDS = Object.freeze(["dependency", "secret"]);

/** How long any one scanner gets. A scanner that overstays is reported, not awaited. */
export const SCANNER_TIMEOUT_MS = 180_000;

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
    network: true,
    parse: parseNpmAudit,
    // npm audit exits 1 when it finds something, which is the normal case here.
    successExitCodes: [0, 1],
    purpose: "known vulnerabilities in the npm dependency tree"
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
 */
const OFFLINE_OUTPUT = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b|\bgetaddrinfo\b|network is unreachable|temporary failure in name resolution|could not resolve host|npm error network\b/i;

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
    return `This project has none of ${scanner.markers.join(", ")}, so ${scanner.tool} has nothing to read.`;
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
async function runOneScanner(scanner, { projectRoot, offline, timeoutMs, runner, locate, reportDir, semgrepConfig }) {
  const started = Date.now();
  const base = { id: scanner.id, tool: scanner.tool, purpose: scanner.purpose };
  const binary = await locate(scanner.executable).catch(() => "");
  let markerFound = "";
  for (const marker of scanner.markers) {
    if (await pathExists(path.join(projectRoot, marker))) {
      markerFound = marker;
      break;
    }
  }
  const network = scannerNeedsNetwork(scanner, { semgrepLocal: semgrepConfig.local });
  const skipped = skipReasonFor(scanner, { binary, markerFound, offline, network });
  if (skipped) return { ...base, status: "skipped", reason: skipped, findings: [], duration_ms: 0 };

  const args = expandArgs(scanner.args, {
    report: scanner.report === "file" ? path.join(reportDir, `${scanner.id}.json`) : "",
    config: semgrepConfig.config
  });
  let result;
  try {
    result = await runner({ executable: binary || scanner.executable, args, cwd: projectRoot, timeoutMs });
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
  const findings = scanner.parse(raw);
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
  if (!exitOk && !findings.length) {
    return {
      ...base,
      status: "error",
      reason: `${scanner.tool} exited ${result.exitCode} without a report: ${outputTail(result)}`,
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
 * Whether a finding is one a verification may be stopped for.
 *
 * @param {{ kind: string, severity: string }} item
 * @returns {boolean}
 */
export function findingBlocks(item) {
  return BLOCKING_KINDS.includes(String(item?.kind ?? "")) && BLOCKING_SEVERITIES.includes(String(item?.severity ?? ""));
}

/**
 * The scan's verdict: `block`, `warn`, or `pass`.
 *
 * A scanner that was skipped or errored never blocks — that is the whole point
 * of the skip — but it is counted, so a run where nothing could be checked
 * reads as `pass` with `checked: 0` rather than as a clean bill of health.
 *
 * @param {{ findings: object[], scanners: object[] }} scan
 * @returns {"block" | "warn" | "pass"}
 */
export function securityScanStatus({ findings = [], scanners = [] } = {}) {
  if (findings.some(findingBlocks)) return "block";
  if (findings.length) return "warn";
  if (scanners.some((scanner) => scanner.status === "error")) return "warn";
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
      results.push(await runOneScanner(scanner, {
        projectRoot: root,
        offline: isOffline,
        timeoutMs,
        runner,
        locate,
        reportDir,
        semgrepConfig
      }));
    }
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const findings = results
    .flatMap((result) => result.findings)
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
  for (const scanner of scan.scanners) {
    const detail = scanner.status === "ok" ? `${scanner.findings} finding(s)` : scanner.reason;
    lines.push(`- **${scanner.tool}** — ${scanner.status}: ${detail}`);
  }
  if (scan.findings.length) {
    lines.push("", "## Findings", "");
    for (const item of scan.findings.slice(0, 50)) {
      const where = item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : "";
      lines.push(`- \`${item.severity}\` **${item.kind}** [${item.tool}${item.rule ? ` ${item.rule}` : ""}]${where} — ${item.message}`);
    }
    if (scan.findings.length > 50) lines.push(`- …and ${scan.findings.length - 50} more.`);
  }
  return `${lines.join("\n")}\n`;
}
