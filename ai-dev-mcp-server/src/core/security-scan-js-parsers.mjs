/**
 * Reading the JavaScript package managers' audits and `osv-scanner`.
 *
 * `npm audit` only ever ran where there was a `package-lock.json`, so a
 * project on pnpm, Yarn or Bun had no dependency scan at all unless `trivy`
 * happened to be installed. Each of those package managers has its own audit,
 * and all of them ask the npm registry's advisory endpoint — the one that also
 * serves GitHub's malware advisories ("Malware in axios", measured 2026-09-27).
 * `osv-scanner` reads every lockfile format there is and adds OSV's `MAL-`
 * reports from the OpenSSF malicious-packages feed, which is far larger than
 * the malware GitHub publishes.
 *
 * Four formats, all measured against real output on 2026-09-27:
 *
 * - `pnpm audit --json` and Yarn 1's `yarn audit --json` carry npm's legacy
 *   (v6) advisory objects — pnpm as one document, Yarn 1 as one
 *   `auditAdvisory` line each.
 * - Yarn 2+'s `yarn npm audit --json` prints one line per advisory:
 *   `{ value: <package>, children: { ID, Issue, URL, Severity, … } }`.
 * - `bun audit --json` prints the registry's bulk response as it came:
 *   `{ <package>: [advisory, …] }`, without the installed version.
 * - `osv-scanner scan source --format json` groups aliases of one
 *   vulnerability (a GHSA and its CVE) and grades a group by CVSS score.
 *
 * Same contract as `security-scan-parsers.mjs`: pure, never throws, output it
 * cannot read is no findings.
 */
import path from "node:path";
import {
  MALWARE_REMEDIATION,
  advisoryId,
  isMalwareAdvisory,
  makeFinding,
  normalizeSeverity,
  parseJsonDocument,
  severityFromCvssScore
} from "./security-scan-parsers.mjs";
import { compareVersions, parseVersion, satisfies } from "./semver-lite.mjs";

/** Every JSON document on its own line, for the tools that print one per line. */
function jsonLines(text) {
  const documents = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      documents.push(JSON.parse(trimmed));
    } catch {
      // A line that is not a whole document is progress output, not a finding.
    }
  }
  return documents;
}

/** The lowest version a `>=x` patched range names, or "" when it names none. */
function lowestPatched(patched) {
  const match = /^\s*>=?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(String(patched ?? ""));
  return match ? match[1] : "";
}

/**
 * One advisory about one installed version, as the npm-family audits report it.
 *
 * @param {object} input
 * @returns {object}
 */
function packageFinding({ tool, file, name, version = "", title, severity, vulnerable = "", fixedIn = "", rule, aliases = [] }) {
  const malware = isMalwareAdvisory({ title, ids: [rule, ...aliases] });
  const label = `${name || "dependency"}${version ? ` ${version}` : ""}${vulnerable ? ` (${vulnerable})` : ""}`;
  return makeFinding({
    tool,
    kind: malware ? "malware" : "dependency",
    severity: malware ? "critical" : severity,
    file,
    message: malware
      ? `${label}: ${title || "malware"}. ${MALWARE_REMEDIATION}`
      : `${label}: ${title || "known vulnerability"}${fixedIn ? ` (fixed in ${fixedIn})` : ""}`,
    rule,
    details: { package: name, version, vulnerable, fixed_in: fixedIn, aliases }
  });
}

/** Findings from npm's legacy advisory objects, one per installed version. */
function fromLegacyAdvisories(advisories, { tool, file }) {
  const findings = [];
  const seen = new Set();
  for (const advisory of advisories) {
    if (!advisory || typeof advisory !== "object") continue;
    const name = String(advisory.module_name ?? "");
    const rule = advisory.github_advisory_id || advisoryId(advisory.url, advisory.id);
    const versions = [...new Set((Array.isArray(advisory.findings) ? advisory.findings : []).map((item) => String(item?.version ?? "")).filter(Boolean))];
    for (const version of versions.length ? versions : [""]) {
      const key = `${rule}:${name}:${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(packageFinding({
        tool,
        file,
        name,
        version,
        title: advisory.title,
        severity: advisory.severity,
        vulnerable: advisory.vulnerable_versions ?? "",
        fixedIn: lowestPatched(advisory.patched_versions),
        rule,
        aliases: Array.isArray(advisory.cves) ? advisory.cves : []
      }));
    }
  }
  return findings;
}

/**
 * `pnpm audit --json`. Exits 1 when it finds something.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parsePnpmAudit(stdout) {
  const advisories = parseJsonDocument(stdout)?.advisories;
  if (!advisories || typeof advisories !== "object") return [];
  return fromLegacyAdvisories(Object.values(advisories), { tool: "pnpm audit", file: "pnpm-lock.yaml" });
}

/**
 * Yarn 1's `yarn audit --json` and Yarn 2+'s `yarn npm audit --json`, which
 * share nothing but the one-document-per-line framing. Both are read, so the
 * adapter does not have to be right about which Yarn a project uses.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parseYarnAudit(stdout) {
  const lines = jsonLines(stdout);
  const legacy = lines.filter((line) => line?.type === "auditAdvisory").map((line) => line?.data?.advisory);
  const findings = fromLegacyAdvisories(legacy, { tool: "yarn audit", file: "yarn.lock" });
  const seen = new Set();
  for (const line of lines) {
    const entry = line?.children;
    if (!entry || typeof entry !== "object" || typeof line.value !== "string") continue;
    // Yarn 2+ lists deprecated packages in the same stream, as
    // `"ID": "left-pad (deprecation)"`. A deprecation is not a vulnerability,
    // and `--no-deprecations` only exists in recent Yarn 4, so they are
    // dropped here rather than asked away.
    if (/\(deprecation\)\s*$/.test(String(entry.ID ?? ""))) continue;
    const rule = advisoryId(entry.URL, entry.ID);
    const versions = Array.isArray(entry["Tree Versions"]) && entry["Tree Versions"].length ? entry["Tree Versions"].map(String) : [""];
    for (const version of versions) {
      const key = `${rule}:${line.value}:${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(packageFinding({
        tool: "yarn audit",
        file: "yarn.lock",
        name: line.value,
        version,
        title: entry.Issue,
        severity: entry.Severity,
        vulnerable: entry["Vulnerable Versions"] ?? "",
        rule
      }));
    }
  }
  return findings;
}

/**
 * Whether a run's output is this tool's report at all.
 *
 * Every one of these audits exits non-zero when it finds something, so a
 * non-zero exit with no findings is either a report whose findings were all
 * filtered out or a tool that failed and said so in prose. Measured: Yarn 1
 * asked for Yarn 2+'s `yarn npm audit` prints `error Command "npm" not found.`
 * and exits 1 — a code its bitmask counts as "found something", which read as
 * a clean scan. A run is only believed when its output has the report's shape.
 * Exit 0 with nothing printed is Yarn 2+'s clean report.
 */
export const RECOGNIZED_REPORTS = Object.freeze({
  pnpm_audit: (raw) => {
    const report = parseJsonDocument(raw);
    return Boolean(report && typeof report === "object" && report.advisories && typeof report.advisories === "object");
  },
  yarn_audit: (raw) => jsonLines(raw).some((line) => line?.type === "auditSummary" || line?.type === "auditAdvisory" || (line?.children && typeof line.value === "string")),
  bun_audit: (raw) => {
    const report = parseJsonDocument(raw);
    return Boolean(report && typeof report === "object" && !Array.isArray(report) && Object.values(report).every(Array.isArray));
  },
  osv_scanner: (raw) => Array.isArray(parseJsonDocument(raw)?.results)
});

/**
 * `bun audit --json`: the registry's bulk response, keyed by package. Bun does
 * not say which version is installed; the fix plan reads it from `bun.lock`.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parseBunAudit(stdout) {
  const report = parseJsonDocument(stdout);
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  const findings = [];
  for (const [name, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories)) continue;
    for (const advisory of advisories) {
      if (!advisory || typeof advisory !== "object" || !advisory.title) continue;
      const score = Number(advisory.cvss?.score);
      findings.push(packageFinding({
        tool: "bun audit",
        file: "bun.lock",
        name,
        title: advisory.title,
        severity: advisory.severity ?? (score > 0 ? severityFromCvssScore(score) : ""),
        vulnerable: advisory.vulnerable_versions ?? "",
        rule: advisoryId(advisory.url, advisory.id)
      }));
    }
  }
  return findings;
}

/**
 * The npm-style range an OSV `affected` entry describes for one package, and
 * the version that fixes the interval the installed version sits in.
 *
 * OSV writes a range as events — `introduced`, then `fixed` or
 * `last_affected` — and a list of exact `versions` for reports such as
 * malware, where there is no range to speak of.
 *
 * @param {object[]} affected
 * @param {{ name: string, ecosystem: string, version: string }} target
 * @returns {{ vulnerable: string, fixedIn: string, fixKnown: boolean }}
 */
export function osvRangeFor(affected, { name, ecosystem, version }) {
  const alternatives = [];
  let fixedIn = "";
  let fixKnown = false;
  const semverLike = Boolean(parseVersion(version));
  for (const entry of Array.isArray(affected) ? affected : []) {
    if (entry?.package?.name !== name || (ecosystem && entry?.package?.ecosystem !== ecosystem)) continue;
    for (const range of Array.isArray(entry.ranges) ? entry.ranges : []) {
      if (!["SEMVER", "ECOSYSTEM"].includes(range?.type)) continue;
      let introduced = null;
      for (const event of Array.isArray(range.events) ? range.events : []) {
        if (event.introduced !== undefined) {
          introduced = String(event.introduced);
          continue;
        }
        const upper = event.fixed !== undefined ? `<${event.fixed}` : event.last_affected !== undefined ? `<=${event.last_affected}` : "";
        if (!upper || introduced === null) continue;
        const interval = `${introduced === "0" ? ">=0.0.0-0" : `>=${introduced}`} ${upper}`;
        alternatives.push(interval);
        if (semverLike && satisfies(version, interval)) {
          fixKnown = event.fixed !== undefined;
          if (fixKnown) fixedIn = String(event.fixed);
        }
        introduced = null;
      }
      if (introduced !== null) {
        // Introduced and never fixed: every later version is affected.
        const open = introduced === "0" ? ">=0.0.0-0" : `>=${introduced}`;
        alternatives.push(open);
      }
    }
    for (const exact of Array.isArray(entry.versions) && !(entry.ranges ?? []).length ? entry.versions : []) {
      alternatives.push(`=${exact}`);
    }
  }
  return { vulnerable: alternatives.join(" || "), fixedIn, fixKnown };
}

function worstSeverity(words) {
  const order = ["critical", "high", "medium", "low", "info", "unknown"];
  return words.map(normalizeSeverity).sort((left, right) => order.indexOf(left) - order.indexOf(right))[0] ?? "unknown";
}

/**
 * `osv-scanner scan source --format json`.
 *
 * One finding per alias group per package version, so a GHSA and the CVE it
 * republishes are one finding. The rule is the malware id when the group is
 * malware, then the GitHub id, then whatever the group led with. Paths are
 * made relative to the project when the caller says where that is.
 *
 * @param {string} stdout
 * @param {{ projectRoot?: string }} [context]
 * @returns {object[]}
 */
export function parseOsvScanner(stdout, { projectRoot = "" } = {}) {
  const results = parseJsonDocument(stdout)?.results;
  if (!Array.isArray(results)) return [];
  const findings = [];
  for (const result of results) {
    const source = String(result?.source?.path ?? "");
    const relative = projectRoot && source && path.isAbsolute(source) ? path.relative(projectRoot, source) : source;
    const file = relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : source;
    for (const entry of Array.isArray(result?.packages) ? result.packages : []) {
      const name = String(entry?.package?.name ?? "");
      const version = String(entry?.package?.version ?? "");
      const ecosystem = String(entry?.package?.ecosystem ?? "");
      const vulnerabilities = new Map((Array.isArray(entry?.vulnerabilities) ? entry.vulnerabilities : []).map((item) => [item?.id, item]));
      const groups = Array.isArray(entry?.groups) && entry.groups.length
        ? entry.groups
        : [...vulnerabilities.keys()].map((id) => ({ ids: [id], aliases: [id] }));
      for (const group of groups) {
        const ids = (Array.isArray(group?.ids) ? group.ids : []).map(String);
        const aliases = [...new Set([...ids, ...(Array.isArray(group?.aliases) ? group.aliases : []).map(String)])];
        const members = ids.map((id) => vulnerabilities.get(id)).filter(Boolean);
        if (!members.length) continue;
        const malware = isMalwareAdvisory({ ids: aliases, title: members.find((item) => item.summary)?.summary ?? "" });
        const rule = aliases.find((id) => malware && /^MAL-/.test(id)) ?? aliases.find((id) => /^GHSA-/.test(id)) ?? ids[0];
        const ranges = members.map((item) => osvRangeFor(item.affected, { name, ecosystem, version }));
        // Every advisory of the group has to be fixed by the version named.
        const fixedIn = ranges.every((item) => item.fixKnown)
          ? ranges.map((item) => item.fixedIn).sort(compareVersions).at(-1)
          : "";
        const score = Number.parseFloat(group?.max_severity);
        const severity = malware
          ? "critical"
          : Number.isFinite(score) && score > 0
            ? severityFromCvssScore(score)
            : worstSeverity(members.map((item) => item?.database_specific?.severity ?? ""));
        const title = members.find((item) => item.summary)?.summary ?? String(members[0]?.details ?? "").split("\n")[0];
        findings.push(packageFinding({
          tool: "osv-scanner",
          file,
          name,
          version,
          title,
          severity,
          vulnerable: ranges.map((item) => item.vulnerable).filter(Boolean).join(" || "),
          fixedIn,
          rule,
          aliases
        }));
      }
    }
  }
  return findings;
}
