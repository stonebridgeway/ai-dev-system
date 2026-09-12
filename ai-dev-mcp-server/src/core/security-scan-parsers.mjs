/**
 * Reading the six security scanners' output.
 *
 * Every parser is pure: raw stdout (or the JSON report a scanner writes to a
 * file) in, a list of findings out, in one shape:
 *
 * ```js
 * { tool, kind, severity, file, line, message, rule }
 * ```
 *
 * `kind` is what the finding is about, not which tool said it: `dependency`,
 * `secret`, `sast`, `misconfig`. The gate blocks on critical and high
 * `dependency` and `secret` findings and warns about the rest, so a tool that
 * reports several kinds — `trivy fs` reports all four — is graded per finding
 * rather than as a whole.
 *
 * Parsers never throw. A scanner that printed something unexpected yields no
 * findings and the caller reports the run as an error with the raw tail, which
 * is more useful than a stack trace from a JSON parse.
 */

/** Severities a finding can carry, worst first. */
export const SECURITY_SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info", "unknown"]);

/** What a finding is about. */
export const SECURITY_FINDING_KINDS = Object.freeze(["dependency", "secret", "sast", "misconfig"]);

/**
 * Normalize a scanner's severity word.
 *
 * Anything the vocabulary does not contain becomes `unknown` rather than being
 * guessed at: `unknown` warns, and a warning that should have blocked is a
 * smaller mistake than a block nobody can justify.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSeverity(value) {
  const word = String(value ?? "").trim().toLowerCase();
  if (SECURITY_SEVERITIES.includes(word)) return word;
  if (word === "error") return "high";
  if (word === "warning" || word === "moderate") return "medium";
  if (word === "note" || word === "information" || word === "informational") return "info";
  return "unknown";
}

/** A CVSS v3 base score read as a severity band, the way the CVSS spec bands it. */
export function severityFromCvssScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value >= 9) return "critical";
  if (value >= 7) return "high";
  if (value >= 4) return "medium";
  return "low";
}

function parseJson(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    // Some scanners print a warning line before the document. Take the first
    // balanced-looking JSON value and try again, once.
    const start = source.search(/[[{]/);
    if (start <= 0) return null;
    try {
      return JSON.parse(source.slice(start));
    } catch {
      return null;
    }
  }
}

function finding({ tool, kind, severity, file = "", line = 0, message, rule = "" }) {
  return {
    tool,
    kind,
    severity: normalizeSeverity(severity),
    file: String(file ?? ""),
    line: Number.isFinite(Number(line)) ? Math.max(0, Math.trunc(Number(line))) : 0,
    message: String(message ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    rule: String(rule ?? "")
  };
}

function advisoryId(url, fallback) {
  const match = /\/(GHSA-[0-9a-z-]+|CVE-\d{4}-\d+)/i.exec(String(url ?? ""));
  return match ? match[1] : String(fallback ?? "");
}

/**
 * `npm audit --json` (npm 7+, `auditReportVersion: 2`).
 *
 * The report is keyed by package name; each entry's `via` holds either the
 * advisories themselves or the names of packages that pull them in. Only the
 * objects are advisories, so only they become findings — otherwise one
 * vulnerable transitive dependency is reported once per package that depends
 * on it.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parseNpmAudit(stdout) {
  const report = parseJson(stdout);
  const vulnerabilities = report?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") return [];
  const findings = [];
  const seen = new Set();
  for (const entry of Object.values(vulnerabilities)) {
    for (const via of Array.isArray(entry?.via) ? entry.via : []) {
      if (!via || typeof via !== "object") continue;
      const rule = advisoryId(via.url, via.source);
      const key = `${rule}:${via.name ?? entry?.name ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding({
        tool: "npm audit",
        kind: "dependency",
        severity: via.severity ?? entry?.severity,
        file: "package-lock.json",
        message: `${via.name ?? entry?.name ?? "dependency"}${via.range ? ` ${via.range}` : ""}: ${via.title ?? "known vulnerability"}${entry?.fixAvailable ? " (a fix is available)" : ""}`,
        rule
      }));
    }
  }
  return findings;
}

/**
 * `pip-audit --format json`.
 *
 * pip-audit reports no severity at all — the PyPI advisory feed it reads does
 * not carry one — so every finding here is `unknown` and therefore warns. That
 * is a real limit of this scanner, not a gap in the mapping: to have Python
 * advisories block, run `trivy fs`, which grades them.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parsePipAudit(stdout) {
  const report = parseJson(stdout);
  const dependencies = Array.isArray(report) ? report : report?.dependencies;
  if (!Array.isArray(dependencies)) return [];
  const findings = [];
  for (const dependency of dependencies) {
    for (const vulnerability of Array.isArray(dependency?.vulns) ? dependency.vulns : []) {
      const fixes = Array.isArray(vulnerability?.fix_versions) ? vulnerability.fix_versions : [];
      findings.push(finding({
        tool: "pip-audit",
        kind: "dependency",
        severity: "unknown",
        file: "requirements.txt",
        message: `${dependency?.name ?? "dependency"} ${dependency?.version ?? ""}: ${vulnerability?.description ?? vulnerability?.id ?? "known vulnerability"}${fixes.length ? ` (fixed in ${fixes.join(", ")})` : ""}`,
        rule: vulnerability?.id ?? ""
      }));
    }
  }
  return findings;
}

/**
 * `cargo audit --json`.
 *
 * RUSTSEC advisories carry a CVSS vector rather than a band, and often
 * neither, so the severity comes from `advisory.severity` when present, then
 * from a numeric CVSS score, and is `unknown` otherwise.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parseCargoAudit(stdout) {
  const report = parseJson(stdout);
  const list = report?.vulnerabilities?.list;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const advisory = entry?.advisory ?? {};
    const severity = advisory.severity
      ? normalizeSeverity(advisory.severity)
      : severityFromCvssScore(typeof advisory.cvss === "number" ? advisory.cvss : NaN);
    return finding({
      tool: "cargo audit",
      kind: "dependency",
      severity,
      file: "Cargo.lock",
      message: `${entry?.package?.name ?? advisory.package ?? "crate"} ${entry?.package?.version ?? ""}: ${advisory.title ?? "known vulnerability"}`,
      rule: advisory.id ?? ""
    });
  });
}

/**
 * `gitleaks detect --report-format json`.
 *
 * The report is a flat array of leaks. The matched secret itself is never
 * copied into the message: this report is written into task evidence and read
 * back in checkpoints, so it names the rule, the file and the line and leaves
 * the value where it was found.
 *
 * @param {string} report
 * @returns {object[]}
 */
export function parseGitleaks(report) {
  const leaks = parseJson(report);
  if (!Array.isArray(leaks)) return [];
  return leaks.map((leak) => finding({
    tool: "gitleaks",
    // A committed credential is the one finding that is always worth stopping
    // for, and gitleaks grades nothing, so its severity is fixed here.
    kind: "secret",
    severity: "critical",
    file: leak?.File ?? leak?.file ?? "",
    line: leak?.StartLine ?? leak?.startLine ?? 0,
    message: `${leak?.Description ?? leak?.description ?? "Secret detected"}${leak?.Commit ? ` (commit ${String(leak.Commit).slice(0, 8)})` : ""}. Rotate it, then remove it from the history.`,
    rule: leak?.RuleID ?? leak?.ruleID ?? ""
  }));
}

/**
 * `semgrep --json`.
 *
 * Semgrep's ERROR / WARNING / INFO become high / medium / info. Findings are
 * `sast`, so they warn: a static-analysis hit is a lead, and a rule pack
 * nobody in the project chose would otherwise be able to stop a task.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parseSemgrep(stdout) {
  const report = parseJson(stdout);
  const results = report?.results;
  if (!Array.isArray(results)) return [];
  return results.map((result) => finding({
    tool: "semgrep",
    kind: "sast",
    severity: result?.extra?.severity,
    file: result?.path ?? "",
    line: result?.start?.line ?? 0,
    message: result?.extra?.message ?? result?.check_id ?? "semgrep finding",
    rule: result?.check_id ?? ""
  }));
}

/**
 * `trivy fs --format json`.
 *
 * One report holds up to four kinds of finding per target, and each is graded
 * separately: package vulnerabilities and secrets can block, misconfiguration
 * and license findings warn.
 *
 * @param {string} stdout
 * @returns {object[]}
 */
export function parseTrivy(stdout) {
  const report = parseJson(stdout);
  const results = report?.Results ?? report?.results;
  if (!Array.isArray(results)) return [];
  const findings = [];
  for (const result of results) {
    const target = result?.Target ?? result?.target ?? "";
    for (const vulnerability of result?.Vulnerabilities ?? []) {
      findings.push(finding({
        tool: "trivy fs",
        kind: "dependency",
        severity: vulnerability?.Severity,
        file: target,
        message: `${vulnerability?.PkgName ?? "package"} ${vulnerability?.InstalledVersion ?? ""}: ${vulnerability?.Title ?? vulnerability?.VulnerabilityID ?? "known vulnerability"}${vulnerability?.FixedVersion ? ` (fixed in ${vulnerability.FixedVersion})` : ""}`,
        rule: vulnerability?.VulnerabilityID ?? ""
      }));
    }
    for (const secret of result?.Secrets ?? []) {
      findings.push(finding({
        tool: "trivy fs",
        kind: "secret",
        severity: secret?.Severity ?? "critical",
        file: target,
        line: secret?.StartLine ?? 0,
        message: `${secret?.Title ?? "Secret detected"}. Rotate it, then remove it from the history.`,
        rule: secret?.RuleID ?? ""
      }));
    }
    for (const misconfiguration of result?.Misconfigurations ?? []) {
      findings.push(finding({
        tool: "trivy fs",
        kind: "misconfig",
        severity: misconfiguration?.Severity,
        file: target,
        line: misconfiguration?.CauseMetadata?.StartLine ?? 0,
        message: misconfiguration?.Message || misconfiguration?.Title || "misconfiguration",
        rule: misconfiguration?.ID ?? misconfiguration?.AVDID ?? ""
      }));
    }
    for (const license of result?.Licenses ?? []) {
      findings.push(finding({
        tool: "trivy fs",
        kind: "misconfig",
        severity: license?.Severity,
        file: license?.FilePath || target,
        message: `${license?.PkgName ?? "package"}: license ${license?.Name ?? "unknown"}`,
        rule: license?.Category ? `license/${license.Category}` : "license"
      }));
    }
  }
  return findings;
}
