import assert from "node:assert/strict";
import test from "node:test";
import {
  SECURITY_FINDING_KINDS,
  SECURITY_SEVERITIES,
  normalizeSeverity,
  parseCargoAudit,
  parseGitleaks,
  parseNpmAudit,
  parsePipAudit,
  parseSemgrep,
  parseTrivy,
  severityFromCvssScore
} from "./security-scan-parsers.mjs";

// Fixtures are the real documents these tools print, trimmed to the fields the
// parsers read. Nothing here runs a scanner: the point of the adapters is that
// the mapping can be checked without six binaries installed.

const NPM_AUDIT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: "lodash",
      severity: "high",
      isDirect: true,
      via: [{
        source: 1065,
        name: "lodash",
        dependency: "lodash",
        title: "Prototype Pollution in lodash",
        url: "https://github.com/advisories/GHSA-p6mc-m468-83gg",
        severity: "high",
        range: "<4.17.21"
      }],
      range: "<4.17.21",
      fixAvailable: true
    },
    "@scope/app": {
      name: "@scope/app",
      severity: "high",
      // A package that is only affected through lodash: `via` names the
      // package, not an advisory.
      via: ["lodash"],
      range: "*",
      fixAvailable: false
    },
    minimist: {
      name: "minimist",
      severity: "critical",
      via: [{ source: 1179, name: "minimist", title: "Prototype Pollution", url: "https://github.com/advisories/GHSA-xvch-5gv4-984h", severity: "critical", range: "<1.2.6" }],
      fixAvailable: false
    }
  },
  metadata: { vulnerabilities: { critical: 1, high: 1, total: 2 } }
});

const PIP_AUDIT = JSON.stringify({
  dependencies: [
    { name: "flask", version: "0.5", vulns: [{ id: "PYSEC-2019-179", fix_versions: ["1.0"], description: "Flask before 1.0 has a denial of service issue." }] },
    { name: "requests", version: "2.31.0", vulns: [] }
  ]
});

const CARGO_AUDIT = JSON.stringify({
  vulnerabilities: {
    found: true,
    count: 2,
    list: [
      {
        advisory: { id: "RUSTSEC-2020-0071", title: "Potential segfault in the time crate", severity: "medium" },
        package: { name: "time", version: "0.1.44" }
      },
      {
        advisory: { id: "RUSTSEC-2021-0079", title: "Integer overflow in hyper", cvss: 9.1 },
        package: { name: "hyper", version: "0.14.6" }
      }
    ]
  }
});

// Split so the repository's own secret gate does not read the fixture as a
// leaked key. It is AWS's documented example value.
const FAKE_AWS_KEY = `AKIA${"IOSFODNN7"}${"EXAMPLE"}`;

const GITLEAKS = JSON.stringify([
  {
    RuleID: "aws-access-token",
    Description: "AWS Access Key",
    File: "deploy/terraform/main.tf",
    StartLine: 42,
    Commit: "9f3b0c1d2e4f5a6b7c8d9e0f",
    Secret: FAKE_AWS_KEY
  },
  { ruleID: "generic-api-key", description: "Generic API Key", file: "src/config.py", startLine: 7 }
]);

const SEMGREP = JSON.stringify({
  results: [
    { check_id: "python.lang.security.audit.exec-detected", path: "src/runner.py", start: { line: 12 }, extra: { severity: "ERROR", message: "Detected the use of exec()." } },
    { check_id: "generic.secrets.security.detected-generic-secret", path: "src/config.py", start: { line: 3 }, extra: { severity: "WARNING", message: "Possible hardcoded secret." } },
    { check_id: "javascript.lang.best-practice.leftover-debugging", path: "web/app.js", start: { line: 88 }, extra: { severity: "INFO", message: "Leftover debugging statement." } }
  ],
  errors: []
});

const TRIVY = JSON.stringify({
  SchemaVersion: 2,
  Results: [
    {
      Target: "package-lock.json",
      Class: "lang-pkgs",
      Type: "npm",
      Vulnerabilities: [{ VulnerabilityID: "CVE-2021-23337", PkgName: "lodash", InstalledVersion: "4.17.20", FixedVersion: "4.17.21", Severity: "HIGH", Title: "Command injection in lodash" }]
    },
    {
      Target: "Dockerfile",
      Class: "config",
      Misconfigurations: [{ ID: "DS002", Severity: "HIGH", Title: "Image user should not be root", Message: "Specify at least 1 USER command.", CauseMetadata: { StartLine: 1 } }]
    },
    {
      Target: ".env.production",
      Class: "secret",
      Secrets: [{ RuleID: "stripe-secret-key", Severity: "CRITICAL", Title: "Stripe Secret Key", StartLine: 4, Match: "sk_live_***" }]
    }
  ]
});

test("every finding a parser produces has the shape the gate reads", () => {
  const all = [
    ...parseNpmAudit(NPM_AUDIT),
    ...parsePipAudit(PIP_AUDIT),
    ...parseCargoAudit(CARGO_AUDIT),
    ...parseGitleaks(GITLEAKS),
    ...parseSemgrep(SEMGREP),
    ...parseTrivy(TRIVY)
  ];
  assert.ok(all.length >= 12, `expected findings from all six adapters, got ${all.length}`);
  for (const item of all) {
    assert.deepEqual(Object.keys(item).sort(), ["file", "kind", "line", "message", "rule", "severity", "tool"]);
    assert.ok(SECURITY_SEVERITIES.includes(item.severity), `${item.tool}: ${item.severity}`);
    assert.ok(SECURITY_FINDING_KINDS.includes(item.kind), `${item.tool}: ${item.kind}`);
    assert.equal(typeof item.line, "number");
    assert.ok(item.message.length > 0, `${item.tool}: empty message`);
    assert.equal(item.message.includes("\n"), false);
  }
});

test("npm audit: one finding per advisory, not per affected package", () => {
  const findings = parseNpmAudit(NPM_AUDIT);
  assert.deepEqual(findings.map((item) => item.rule), ["GHSA-p6mc-m468-83gg", "GHSA-xvch-5gv4-984h"]);
  assert.deepEqual(findings.map((item) => item.severity), ["high", "critical"]);
  assert.equal(findings[0].file, "package-lock.json");
  assert.match(findings[0].message, /lodash <4\.17\.21: Prototype Pollution in lodash \(a fix is available\)/);
  assert.equal(findings.every((item) => item.kind === "dependency"), true);
});

test("pip-audit reports no severity, so its findings warn rather than block", () => {
  const findings = parsePipAudit(PIP_AUDIT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "unknown");
  assert.equal(findings[0].rule, "PYSEC-2019-179");
  assert.match(findings[0].message, /flask 0\.5: .*\(fixed in 1\.0\)/);
  // Older pip-audit emits the dependency list at the top level.
  assert.equal(parsePipAudit(JSON.stringify([{ name: "flask", version: "0.5", vulns: [{ id: "PYSEC-1" }] }])).length, 1);
});

test("cargo audit takes the stated severity, then a CVSS score, then neither", () => {
  const findings = parseCargoAudit(CARGO_AUDIT);
  assert.deepEqual(findings.map((item) => item.severity), ["medium", "critical"]);
  assert.deepEqual(findings.map((item) => item.rule), ["RUSTSEC-2020-0071", "RUSTSEC-2021-0079"]);
  assert.equal(findings[0].file, "Cargo.lock");
  const ungraded = parseCargoAudit(JSON.stringify({ vulnerabilities: { list: [{ advisory: { id: "RUSTSEC-2024-0001", title: "x" }, package: { name: "p", version: "1" } }] } }));
  assert.equal(ungraded[0].severity, "unknown");
});

test("gitleaks findings are critical and never carry the secret itself", () => {
  const findings = parseGitleaks(GITLEAKS);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((item) => item.severity), ["critical", "critical"]);
  assert.equal(findings[0].file, "deploy/terraform/main.tf");
  assert.equal(findings[0].line, 42);
  assert.match(findings[0].message, /commit 9f3b0c1d.*Rotate it/);
  assert.equal(findings[1].file, "src/config.py", "the lower-case spelling of the report is read too");
  for (const item of findings) {
    assert.equal(item.message.includes(FAKE_AWS_KEY), false, "the report goes into task evidence");
  }
});

test("semgrep severities map onto the vocabulary, and stay sast", () => {
  const findings = parseSemgrep(SEMGREP);
  assert.deepEqual(findings.map((item) => item.severity), ["high", "medium", "info"]);
  assert.equal(findings.every((item) => item.kind === "sast"), true);
  assert.equal(findings[0].file, "src/runner.py");
  assert.equal(findings[0].line, 12);
});

test("trivy is graded per finding, because one report holds three kinds", () => {
  const findings = parseTrivy(TRIVY);
  assert.deepEqual(findings.map((item) => item.kind), ["dependency", "misconfig", "secret"]);
  assert.deepEqual(findings.map((item) => item.severity), ["high", "high", "critical"]);
  assert.equal(findings[0].rule, "CVE-2021-23337");
  assert.equal(findings[2].file, ".env.production");
  const licensed = parseTrivy(JSON.stringify({ Results: [{ Target: "x", Licenses: [{ PkgName: "p", Name: "GPL-3.0", Severity: "MEDIUM", Category: "restricted", FilePath: "p/LICENSE" }] }] }));
  assert.deepEqual(licensed, [{ tool: "trivy fs", kind: "misconfig", severity: "medium", file: "p/LICENSE", line: 0, message: "p: license GPL-3.0", rule: "license/restricted" }]);
});

test("output a parser cannot read is no findings, never a throw", () => {
  for (const parse of [parseNpmAudit, parsePipAudit, parseCargoAudit, parseGitleaks, parseSemgrep, parseTrivy]) {
    assert.deepEqual(parse(""), []);
    assert.deepEqual(parse(undefined), []);
    assert.deepEqual(parse("not json at all"), []);
    assert.deepEqual(parse("{"), []);
    assert.deepEqual(parse("[]"), []);
    assert.deepEqual(parse(JSON.stringify({ unexpected: true })), []);
  }
  // A warning line before the document is common and is recovered from.
  assert.equal(parseSemgrep(`METRICS: Using configs from the Registry\n${SEMGREP}`).length, 3);
});

test("severity words and CVSS scores land on the vocabulary", () => {
  assert.equal(normalizeSeverity("CRITICAL"), "critical");
  assert.equal(normalizeSeverity("Error"), "high");
  assert.equal(normalizeSeverity("moderate"), "medium");
  assert.equal(normalizeSeverity("warning"), "medium");
  assert.equal(normalizeSeverity("informational"), "info");
  assert.equal(normalizeSeverity("catastrophic"), "unknown");
  assert.equal(normalizeSeverity(undefined), "unknown");
  assert.deepEqual([9.8, 7.5, 4.0, 1.2, 0, NaN].map(severityFromCvssScore), ["critical", "high", "medium", "low", "unknown", "unknown"]);
});
