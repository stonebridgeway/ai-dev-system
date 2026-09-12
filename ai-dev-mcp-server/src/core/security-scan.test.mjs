import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLOCKING_KINDS,
  BLOCKING_SEVERITIES,
  SECURITY_SCANNERS,
  findingBlocks,
  renderSecurityScanMarkdown,
  resolveOffline,
  runSecurityScan,
  securityScanStatus,
  selectScanners,
  semgrepConfigFor,
  skipReasonFor
} from "./security-scan.mjs";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/security-scan/", import.meta.url));

async function tempProject(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  return root;
}

/**
 * A process runner that answers from fixtures instead of running anything.
 * `outputs` is keyed by scanner executable; a scanner with no entry answers
 * empty. The calls are recorded so the argv each adapter builds is checked too.
 */
function fakeRunner(outputs = {}, { calls = [] } = {}) {
  return async ({ executable, args, cwd, timeoutMs }) => {
    calls.push({ executable, args, cwd, timeoutMs });
    const fixture = outputs[path.basename(executable)] ?? {};
    if (fixture.write) {
      const reportPath = args[args.indexOf("--report-path") + 1];
      await fs.writeFile(reportPath, fixture.write, "utf8");
    }
    return {
      exitCode: fixture.exitCode ?? 0,
      signal: null,
      ok: (fixture.exitCode ?? 0) === 0,
      timedOut: Boolean(fixture.timedOut),
      truncated: false,
      stdout: fixture.stdout ?? "",
      stderr: fixture.stderr ?? "",
      durationMs: 1
    };
  };
}

/** Only these executables exist on the fixture machine. */
function fakeLocator(installed) {
  return async (executable) => (installed.includes(executable) ? `/usr/bin/${executable}` : "");
}

const NPM_REPORT = JSON.stringify({
  vulnerabilities: {
    minimist: {
      name: "minimist",
      severity: "critical",
      via: [{ source: 1179, name: "minimist", title: "Prototype Pollution", url: "https://github.com/advisories/GHSA-xvch-5gv4-984h", severity: "critical", range: "<1.2.6" }],
      fixAvailable: true
    }
  }
});
const GITLEAKS_REPORT = JSON.stringify([
  { RuleID: "aws-access-token", Description: "AWS Access Key", File: "infra/main.tf", StartLine: 12 }
]);
const SEMGREP_REPORT = JSON.stringify({
  results: [{ check_id: "python.lang.security.audit.exec-detected", path: "app.py", start: { line: 3 }, extra: { severity: "ERROR", message: "Detected exec()." } }]
});

test("the catalogue is well formed: six adapters, each able to say why it did not run", () => {
  assert.equal(SECURITY_SCANNERS.length, 6);
  assert.deepEqual(SECURITY_SCANNERS.map((scanner) => scanner.id), [
    "npm_audit", "pip_audit", "cargo_audit", "gitleaks", "semgrep", "trivy_fs"
  ]);
  for (const scanner of SECURITY_SCANNERS) {
    assert.ok(scanner.executable, `${scanner.id}: needs an executable to look for`);
    assert.ok(typeof scanner.parse === "function", `${scanner.id}: needs a parser`);
    assert.ok(Array.isArray(scanner.markers), `${scanner.id}: markers must be a list, empty for "any project"`);
    assert.ok(scanner.purpose, `${scanner.id}: a skip reason has to say what was not looked for`);
    assert.ok(scanner.successExitCodes.includes(0));
    assert.match(
      skipReasonFor(scanner, { binary: "", markerFound: "", offline: false, network: false }),
      new RegExp(`${scanner.executable} is not installed`)
    );
  }
});

test("named scanners are resolved, and a name nobody knows is an error", () => {
  assert.deepEqual(selectScanners("auto").length, 6);
  assert.deepEqual(selectScanners([]).length, 6);
  assert.deepEqual(selectScanners(undefined).length, 6);
  assert.deepEqual(selectScanners(["gitleaks", "semgrep"]).map((item) => item.id), ["gitleaks", "semgrep"]);
  assert.deepEqual(selectScanners("gitleaks,trivy_fs").map((item) => item.id), ["gitleaks", "trivy_fs"]);
  assert.throws(() => selectScanners(["bandit"]), /Unknown scanner: bandit\. Known: npm_audit/);
});

test("a scanner that is missing, inapplicable or offline is skipped with a reason, not an error", async (t) => {
  const root = await tempProject(t, { "package-lock.json": "{}" });
  const scan = await runSecurityScan(root, {
    runner: fakeRunner({ npm: { stdout: NPM_REPORT, exitCode: 1 } }),
    locate: fakeLocator(["npm", "cargo"])
  });

  const byId = Object.fromEntries(scan.scanners.map((scanner) => [scanner.id, scanner]));
  assert.equal(byId.npm_audit.status, "ok");
  assert.equal(byId.pip_audit.status, "skipped");
  assert.match(byId.pip_audit.reason, /pip-audit is not installed or not on the PATH/);
  // cargo is installed, but there is no Cargo.lock to read.
  assert.equal(byId.cargo_audit.status, "skipped");
  assert.match(byId.cargo_audit.reason, /none of Cargo\.lock/);
  assert.equal(byId.gitleaks.status, "skipped");
  assert.equal(byId.trivy_fs.status, "skipped");
  assert.equal(scan.summary.checked, 1);
  assert.equal(scan.summary.skipped, 5);
  assert.equal(scan.summary.failed, 0);

  const offline = await runSecurityScan(root, {
    offline: true,
    runner: fakeRunner({ npm: { stdout: NPM_REPORT } }),
    locate: fakeLocator(["npm", "gitleaks", "pip-audit", "semgrep", "trivy"])
  });
  const offlineById = Object.fromEntries(offline.scanners.map((scanner) => [scanner.id, scanner]));
  assert.equal(offlineById.npm_audit.status, "skipped");
  assert.match(offlineById.npm_audit.reason, /needs to fetch an advisory database and this run is offline.*findings are unknown, not absent/s);
  assert.match(offlineById.semgrep.reason, /needs to fetch its rule pack/);
  // gitleaks reads the repository, so it works offline.
  assert.equal(offlineById.gitleaks.status, "ok");
  assert.equal(offline.status, "pass", "nothing found and nothing could fail");
});

test("a network failure in the output is read as offline, not as a broken scan", async (t) => {
  const root = await tempProject(t, { "package-lock.json": "{}" });
  const scan = await runSecurityScan(root, {
    runner: fakeRunner({ npm: { exitCode: 1, stderr: "npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org/-/npm/v1/security/audits failed" } }),
    locate: fakeLocator(["npm"])
  });
  const [npmAudit] = scan.scanners.filter((scanner) => scanner.id === "npm_audit");
  assert.equal(npmAudit.status, "skipped");
  assert.match(npmAudit.reason, /exited 1 without reaching the network/);
  assert.match(npmAudit.reason, /npm error code ENOTFOUND/, "the first line of stderr, not a slice of the report");
  assert.equal(scan.status, "pass");
});

test("a real report is read as findings, whatever words the advisories use", async (t) => {
  const root = await tempProject(t, { "package-lock.json": "{}" });
  const report = await fs.readFile(path.join(FIXTURES, "npm-audit-report.json"), "utf8");
  assert.match(report, /proxy/i, "the fixture is only interesting while it names a proxy");

  const scan = await runSecurityScan(root, {
    scanners: ["npm_audit"],
    runner: fakeRunner({ npm: { exitCode: 1, stdout: report } }),
    locate: fakeLocator(["npm"])
  });
  assert.equal(scan.scanners[0].status, "ok");
  assert.equal(scan.summary.findings, 14);
  assert.equal(scan.summary.blocking, 5);
  assert.equal(scan.status, "block");

  // The same report with the word every advisory title happens to share taken
  // out. A scan may not change its mind about the network over its own prose.
  const renamed = await runSecurityScan(root, {
    scanners: ["npm_audit"],
    runner: fakeRunner({ npm: { exitCode: 1, stdout: report.replace(/proxy/gi, "pxy") } }),
    locate: fakeLocator(["npm"])
  });
  assert.deepEqual(renamed.summary, scan.summary);
});

test("npm's own offline report — JSON on stdout, exit 1 — is skipped, not read as clean", async (t) => {
  const root = await tempProject(t, { "package-lock.json": "{}" });
  // Measured: `npm audit --json --registry=http://127.0.0.1:9/`. The failure is
  // a JSON document on stdout, so the exit code and the report shape both look
  // ordinary; only the errno says what happened.
  const stdout = JSON.stringify({
    message: "request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9",
    error: { summary: "", detail: "" }
  });
  const scan = await runSecurityScan(root, {
    scanners: ["npm_audit"],
    runner: fakeRunner({
      npm: { exitCode: 1, stdout, stderr: "npm warn audit request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9\nnpm error audit endpoint returned an error" }
    }),
    locate: fakeLocator(["npm"])
  });
  assert.equal(scan.scanners[0].status, "skipped");
  assert.match(scan.scanners[0].reason, /exited 1 without reaching the network/);
  assert.match(scan.scanners[0].reason, /ECONNREFUSED/, "the reason names what failed");
  assert.equal(scan.summary.checked, 0, "a scan that proved nothing counts nothing as checked");

  // The same failure with nothing on stderr: the reason comes from the line of
  // the report that names the errno, not from the opening brace.
  const quiet = await runSecurityScan(root, {
    scanners: ["npm_audit"],
    runner: fakeRunner({ npm: { exitCode: 1, stdout: JSON.stringify({ message: "request to https://registry.npmjs.org/ failed, reason: connect ECONNREFUSED", error: {} }, null, 2) } }),
    locate: fakeLocator(["npm"])
  });
  assert.equal(quiet.scanners[0].status, "skipped");
  assert.match(quiet.scanners[0].reason, /ECONNREFUSED/);
});

test("a scanner that overstays its timeout is skipped, so verify_task is never held up", async (t) => {
  const root = await tempProject(t, {});
  const scan = await runSecurityScan(root, {
    scanners: ["gitleaks"],
    timeoutMs: 5_000,
    runner: fakeRunner({ gitleaks: { timedOut: true, exitCode: null } }),
    locate: fakeLocator(["gitleaks"])
  });
  assert.equal(scan.scanners[0].status, "skipped");
  assert.match(scan.scanners[0].reason, /did not finish within 5s and was stopped/);
  assert.equal(scan.status, "pass");
});

test("a scanner that failed for its own reasons is an error, and warns without blocking", async (t) => {
  const root = await tempProject(t, { ".semgrep.yml": "rules: [" });
  const scan = await runSecurityScan(root, {
    scanners: ["semgrep"],
    runner: fakeRunner({ semgrep: { exitCode: 7, stderr: "Invalid rule schema in .semgrep.yml line 4" } }),
    locate: fakeLocator(["semgrep"]),
    offline: true
  });
  assert.equal(scan.scanners[0].status, "error");
  assert.match(scan.scanners[0].reason, /exited 7 without a report: Invalid rule schema/);
  assert.equal(scan.summary.failed, 1);
  assert.equal(scan.status, "warn", "a scanner that broke is a warning, never a block");

  const unstartable = await runSecurityScan(root, {
    scanners: ["gitleaks"],
    runner: async () => { throw new Error("EACCES"); },
    locate: fakeLocator(["gitleaks"])
  });
  assert.equal(unstartable.scanners[0].status, "error");
  assert.match(unstartable.scanners[0].reason, /could not be started: EACCES/);
});

test("critical and high dependency and secret findings block; everything else warns", async (t) => {
  const root = await tempProject(t, { "package-lock.json": "{}", "app.py": "exec('x')" });
  const calls = [];
  const scan = await runSecurityScan(root, {
    runner: fakeRunner({
      npm: { stdout: NPM_REPORT, exitCode: 1 },
      gitleaks: { write: GITLEAKS_REPORT, exitCode: 1 },
      semgrep: { stdout: SEMGREP_REPORT }
    }, { calls }),
    locate: fakeLocator(["npm", "gitleaks", "semgrep"])
  });

  assert.equal(scan.status, "block");
  assert.equal(scan.summary.blocking, 2, "the npm advisory and the committed key");
  assert.equal(scan.summary.findings, 3);
  // Worst first, so a report read top-down starts with what has to be fixed.
  assert.deepEqual(scan.findings.map((item) => item.severity), ["critical", "critical", "high"]);
  assert.deepEqual(scan.summary.by_severity.critical, 2);

  const semgrepFinding = scan.findings.find((item) => item.tool === "semgrep");
  assert.equal(findingBlocks(semgrepFinding), false, "a static-analysis hit is a lead, not a blocker");
  assert.equal(securityScanStatus({ findings: [semgrepFinding], scanners: [] }), "warn");
  assert.equal(securityScanStatus({ findings: [], scanners: [] }), "pass");

  // gitleaks writes its report to a file, so the runner is given a path.
  const gitleaksCall = calls.find((call) => call.executable.endsWith("gitleaks"));
  assert.ok(gitleaksCall.args.includes("--report-path"));
  assert.ok(gitleaksCall.args.includes("--redact"), "the secret must not land in the report");
  assert.equal(gitleaksCall.cwd, path.resolve(root));

  const markdown = renderSecurityScanMarkdown(scan);
  assert.match(markdown, /^# Security scan: block/);
  assert.match(markdown, /3 scanner\(s\) ran, 3 skipped, 0 failed\. 3 finding\(s\), 2 blocking\./);
  assert.match(markdown, /`critical` \*\*secret\*\* \[gitleaks aws-access-token\] infra\/main\.tf:12/);
  assert.match(markdown, /\*\*pip-audit\*\* — skipped/);
});

test("semgrep uses the project's own rules when it has them, and is then an offline scanner", async (t) => {
  const bare = await tempProject(t, {});
  assert.deepEqual(await semgrepConfigFor(bare), { config: "auto", local: false });

  const local = await tempProject(t, { ".semgrep.yml": "rules: []" });
  assert.deepEqual(await semgrepConfigFor(local), { config: ".semgrep.yml", local: true });

  const calls = [];
  const scan = await runSecurityScan(local, {
    scanners: ["semgrep"],
    offline: true,
    runner: fakeRunner({ semgrep: { stdout: SEMGREP_REPORT } }, { calls }),
    locate: fakeLocator(["semgrep"])
  });
  assert.equal(scan.scanners[0].status, "ok", "local rules need no network");
  assert.ok(calls[0].args.includes(".semgrep.yml"));
  assert.equal(calls[0].args.includes("auto"), false);
  assert.deepEqual(scan.semgrep_config, { config: ".semgrep.yml", local: true });
});

test("offline comes from the caller, then the environment, then is assumed false", () => {
  assert.equal(resolveOffline(true, {}), true);
  assert.equal(resolveOffline(false, { AI_DEV_OFFLINE: "1" }), false);
  assert.equal(resolveOffline(undefined, { AI_DEV_OFFLINE: "1" }), true);
  assert.equal(resolveOffline(undefined, { AI_DEV_OFFLINE: "yes" }), true);
  assert.equal(resolveOffline(undefined, { AI_DEV_OFFLINE: "0" }), false);
  assert.equal(resolveOffline(undefined, {}), false);
});

test("the gate's vocabulary is the one the plan states", () => {
  assert.deepEqual(BLOCKING_SEVERITIES, ["critical", "high"]);
  assert.deepEqual(BLOCKING_KINDS, ["dependency", "secret"]);
  assert.equal(findingBlocks({ kind: "dependency", severity: "high" }), true);
  assert.equal(findingBlocks({ kind: "dependency", severity: "medium" }), false);
  assert.equal(findingBlocks({ kind: "dependency", severity: "unknown" }), false);
  assert.equal(findingBlocks({ kind: "misconfig", severity: "critical" }), false);
  assert.equal(findingBlocks({}), false);
});
