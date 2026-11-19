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
  evaluateSecurityScanners,
  findingBlocks,
  renderSecurityScanMarkdown,
  resolveOffline,
  runSecurityScan,
  scannerAvailability,
  securityScanStatus,
  securityScannerAvailability,
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

test("the catalogue is well formed: ten adapters, each able to say why it did not run", () => {
  assert.equal(SECURITY_SCANNERS.length, 10);
  assert.deepEqual(SECURITY_SCANNERS.map((scanner) => scanner.id), [
    "npm_audit", "pnpm_audit", "yarn_audit", "bun_audit", "osv_scanner", "pip_audit", "cargo_audit", "gitleaks", "semgrep", "trivy_fs"
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
  assert.deepEqual(selectScanners("auto").length, 10);
  assert.deepEqual(selectScanners([]).length, 10);
  assert.deepEqual(selectScanners(undefined).length, 10);
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
  // Neither pnpm nor osv-scanner is on this machine.
  assert.match(byId.pnpm_audit.reason, /pnpm is not installed/);
  assert.match(byId.osv_scanner.reason, /osv-scanner is not installed/);
  assert.equal(scan.summary.checked, 1);
  assert.equal(scan.summary.skipped, 9);
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
  // The one scanner on this machine never reached the network, so this run
  // checked nothing.
  assert.equal(scan.status, "unchecked");
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
  assert.equal(scan.status, "unchecked", "the only scanner was stopped, so nothing was checked");
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
  assert.equal(
    securityScanStatus({ findings: [], scanners: [{ status: "ok" }] }),
    "pass",
    "a scanner ran and found nothing"
  );

  // gitleaks writes its report to a file, so the runner is given a path.
  const gitleaksCall = calls.find((call) => call.executable.endsWith("gitleaks"));
  assert.ok(gitleaksCall.args.includes("--report-path"));
  assert.ok(gitleaksCall.args.includes("--redact"), "the secret must not land in the report");
  assert.equal(gitleaksCall.cwd, path.resolve(root));

  const markdown = renderSecurityScanMarkdown(scan);
  assert.match(markdown, /^# Security scan: block/);
  assert.match(markdown, /3 scanner\(s\) ran, 7 skipped, 0 failed\. 3 finding\(s\), 2 blocking\./);
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
  assert.deepEqual(BLOCKING_KINDS, ["dependency", "malware", "secret"]);
  assert.equal(findingBlocks({ kind: "dependency", severity: "high" }), true);
  assert.equal(findingBlocks({ kind: "malware", severity: "critical" }), true);
  assert.equal(findingBlocks({ kind: "dependency", severity: "medium" }), false);
  assert.equal(findingBlocks({ kind: "dependency", severity: "unknown" }), false);
  assert.equal(findingBlocks({ kind: "misconfig", severity: "critical" }), false);
  assert.equal(findingBlocks({}), false);
});

// A scan where not one scanner could run used to come back `pass`, and
// `verify_task` reduced that to `security_scan: pass` — "checked and clean" for
// a run in which nobody looked.
test("a scan where nothing could run is unchecked, not pass", async (t) => {
  const root = await tempProject(t, {});
  const scan = await runSecurityScan(root, {
    runner: fakeRunner({}),
    locate: fakeLocator([])
  });

  assert.equal(scan.status, "unchecked");
  assert.equal(scan.summary.checked, 0);
  assert.equal(scan.summary.skipped, SECURITY_SCANNERS.length);
  // The rule the module is built on is unchanged: a missing scanner does not
  // stop a verification. `unchecked` is not `block`.
  assert.notEqual(scan.status, "block");

  const markdown = renderSecurityScanMarkdown(scan);
  assert.match(markdown, /^# Security scan: unchecked/);
  assert.match(markdown, /has not been found clean — it has not been looked at/);

  // One scanner that ran is enough for the verdict to mean something again.
  const checked = await runSecurityScan(root, {
    scanners: ["gitleaks"],
    runner: fakeRunner({ gitleaks: { stdout: "[]" } }),
    locate: fakeLocator(["gitleaks"])
  });
  assert.equal(checked.status, "pass");
  assert.equal(checked.summary.checked, 1);
  assert.equal(/has not been looked at/.test(renderSecurityScanMarkdown(checked)), false);
});

test("a machine with no scanner installed is a warning, not a failure", () => {
  const catalogue = SECURITY_SCANNERS.map((scanner) => ({
    id: scanner.id,
    tool: scanner.tool,
    executable: scanner.executable,
    installed: false
  }));

  const none = evaluateSecurityScanners(catalogue);
  assert.equal(none.status, "warn");
  assert.match(none.summary, /None of the 10 security scanners is installed/);
  assert.match(none.summary, /gitleaks/, "the advice names the one that needs no network");
  assert.deepEqual(none.details.installed, []);
  assert.equal(none.details.missing.length, SECURITY_SCANNERS.length);

  const some = evaluateSecurityScanners(catalogue.map((item) => (
    item.id === "gitleaks" ? { ...item, installed: true } : item
  )));
  assert.equal(some.status, "ok");
  assert.match(some.summary, /1 of 10 security scanners installed: gitleaks/);
  assert.deepEqual(some.details.offline_capable, ["gitleaks"]);

  // npm is on every machine that has this server, and it needs a network.
  const onlyNpm = evaluateSecurityScanners(catalogue.map((item) => (
    item.id === "npm_audit" ? { ...item, installed: true } : item
  )));
  assert.equal(onlyNpm.status, "ok");
  assert.deepEqual(onlyNpm.details.offline_capable, [], "nothing here works under --network none");

  assert.equal(evaluateSecurityScanners(undefined).status, "warn");
});

// A machine with Rust and no plugin: `cargo` is on the PATH, `cargo audit` is
// not installed, and health used to count the scanner as present because it
// only ever asked about the executable.
const CARGO_WITHOUT_PLUGIN = "error: no such command: `audit`";

function catalogueEntry(id) {
  return SECURITY_SCANNERS.find((scanner) => scanner.id === id);
}

test("a scanner that is its own binary is available as soon as the binary is", async () => {
  const calls = [];
  const runner = async (options) => { calls.push(options); return { ok: true, stdout: "", stderr: "" }; };

  const present = await scannerAvailability(catalogueEntry("gitleaks"), {
    locate: async () => "/usr/local/bin/gitleaks",
    runner
  });
  assert.deepEqual(present, { id: "gitleaks", tool: "gitleaks", executable: "gitleaks", installed: true });
  assert.deepEqual(calls, [], "a binary that is on the PATH is not probed");

  const absent = await scannerAvailability(catalogueEntry("gitleaks"), {
    locate: async () => "",
    runner
  });
  assert.equal(absent.installed, false);
  assert.match(absent.reason, /gitleaks is not installed or not on the PATH/);
  assert.deepEqual(calls, [], "a binary that is absent is not probed either");
});

test("cargo on the PATH is not cargo audit: the subcommand is asked, not assumed", async () => {
  const calls = [];
  const cargo = catalogueEntry("cargo_audit");
  assert.deepEqual(cargo.probeArgs, ["audit", "--version"], "the probe is declared on the scanner, not special-cased");

  const withoutPlugin = await scannerAvailability(cargo, {
    locate: async () => "/home/rustacean/.cargo/bin/cargo",
    runner: async (options) => {
      calls.push(options);
      return { ok: false, exitCode: 101, timedOut: false, stdout: "", stderr: `${CARGO_WITHOUT_PLUGIN}\n` };
    }
  });
  assert.equal(withoutPlugin.installed, false, "cargo without the plugin is not cargo audit");
  assert.match(withoutPlugin.reason, /cargo is installed but `cargo audit` is not/);
  assert.match(withoutPlugin.reason, /no such command/, "the reason quotes what cargo actually said");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "cargo");
  assert.deepEqual(calls[0].args, ["audit", "--version"], "argv array, no shell string");
  assert.ok(calls[0].timeoutMs <= 30_000, "the probe waits seconds, not minutes");
  assert.ok(calls[0].cwd && calls[0].cwd !== "", "the probe runs somewhere, and not in the caller's project");

  const withPlugin = await scannerAvailability(cargo, {
    locate: async () => "/home/rustacean/.cargo/bin/cargo",
    runner: async () => ({ ok: true, exitCode: 0, stdout: "cargo-audit-audit 0.21.0\n", stderr: "" })
  });
  assert.deepEqual(withPlugin, { id: "cargo_audit", tool: "cargo audit", executable: "cargo", installed: true });
});

test("a probe that hangs or throws leaves the scanner unavailable, not the check broken", async () => {
  const cargo = catalogueEntry("cargo_audit");
  const timedOut = await scannerAvailability(cargo, {
    locate: async () => "/usr/bin/cargo",
    runner: async () => ({ ok: false, timedOut: true, stdout: "", stderr: "" })
  });
  assert.equal(timedOut.installed, false);
  assert.match(timedOut.reason, /did not answer in time/);

  const threw = await scannerAvailability(cargo, {
    locate: async () => "/usr/bin/cargo",
    runner: async () => { throw new Error("spawn EACCES"); }
  });
  assert.equal(threw.installed, false);
  assert.match(threw.reason, /spawn EACCES/);
});

test("the machine with cargo and no plugin counts one scanner, not two", async () => {
  const availability = await securityScannerAvailability({
    locate: async (executable) => (["npm", "cargo"].includes(executable) ? `/usr/bin/${executable}` : ""),
    runner: async () => ({ ok: false, exitCode: 101, stdout: "", stderr: CARGO_WITHOUT_PLUGIN })
  });
  const report = evaluateSecurityScanners(availability);
  assert.match(report.summary, /1 of 10 security scanners installed: npm_audit\./);
  assert.deepEqual(report.details.installed, ["npm_audit"]);
  assert.ok(report.details.missing.includes("cargo_audit"));
  assert.match(report.details.missing_reasons.cargo_audit, /cargo is installed but `cargo audit` is not/);
  assert.match(report.details.missing_reasons.gitleaks, /not installed or not on the PATH/);

  // The same machine once the plugin is installed.
  const withPlugin = await securityScannerAvailability({
    locate: async (executable) => (["npm", "cargo"].includes(executable) ? `/usr/bin/${executable}` : ""),
    runner: async () => ({ ok: true, exitCode: 0, stdout: "cargo-audit-audit 0.21.0", stderr: "" })
  });
  const after = evaluateSecurityScanners(withPlugin);
  assert.match(after.summary, /2 of 10 security scanners installed: npm_audit, cargo_audit\./);
  assert.equal(after.details.missing_reasons.cargo_audit, undefined);
});

// The package managers' audits only ever ran at the root, and only npm's
// existed. A repository with `frontend/` and `backend/` and no lockfile at the
// root had no dependency scan at all.
test("each package manager's audit runs in every directory that holds its lockfile", async (t) => {
  const root = await tempProject(t, {
    "frontend/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "backend/package-lock.json": "{}",
    "backend/node_modules/dep/package-lock.json": "{}"
  });
  const pnpmReport = await fs.readFile(path.join(FIXTURES, "pnpm-audit.json"), "utf8");
  const calls = [];
  const scan = await runSecurityScan(root, {
    scanners: ["npm_audit", "pnpm_audit"],
    runner: fakeRunner({ npm: { stdout: NPM_REPORT, exitCode: 1 }, pnpm: { stdout: pnpmReport, exitCode: 1 } }, { calls }),
    locate: fakeLocator(["npm", "pnpm"])
  });
  assert.deepEqual(calls.map((call) => [path.basename(call.executable), path.relative(root, call.cwd)]), [
    ["npm", "backend"],
    ["pnpm", "frontend"]
  ], "one run per lockfile directory, node_modules not searched");
  const byId = Object.fromEntries(scan.scanners.map((scanner) => [scanner.id, scanner]));
  assert.deepEqual(byId.npm_audit.directories, ["backend"]);
  assert.equal(byId.pnpm_audit.status, "ok");
  // A finding names the lockfile it came from, not the bare name both share.
  assert.ok(scan.findings.some((item) => item.file === "frontend/pnpm-lock.yaml"));
  assert.ok(scan.findings.some((item) => item.file === "backend/package-lock.json"));
  assert.equal(scan.status, "block");
});

test("an error in one directory is an error, and the findings from the others still count", async (t) => {
  const root = await tempProject(t, { "a/package-lock.json": "{}", "b/package-lock.json": "{}" });
  let run = 0;
  const scan = await runSecurityScan(root, {
    scanners: ["npm_audit"],
    runner: async (options) => {
      run += 1;
      return run === 1
        ? { exitCode: 1, ok: false, timedOut: false, stdout: NPM_REPORT, stderr: "" }
        : { exitCode: 2, ok: false, timedOut: false, stdout: "", stderr: "npm error something broke" };
    },
    locate: fakeLocator(["npm"])
  });
  const [npm] = scan.scanners;
  assert.equal(npm.status, "error");
  assert.match(npm.reason, /^b: npm audit exited 2 without a report/);
  assert.equal(scan.summary.findings, 1);
  assert.equal(scan.status, "block", "the critical advisory from a/ still blocks");
});

test("osv-scanner and npm audit reporting one advisory make one finding; malware blocks", async (t) => {
  const root = await tempProject(t, { "package-lock.json": "{}" });
  // The project's folder as JSON writes it: a Windows one has backslashes to escape.
  const osvReport = (await fs.readFile(path.join(FIXTURES, "osv-scanner.json"), "utf8")).replaceAll("/work/app", JSON.stringify(root).slice(1, -1));
  const npmReport = JSON.stringify({
    vulnerabilities: {
      axios: { name: "axios", severity: "critical", via: [{ source: 1115703, name: "axios", title: "Malware in axios", url: "https://github.com/advisories/GHSA-fw8c-xr5c-95f9", severity: "critical", range: "=1.14.1" }] },
      minimist: { name: "minimist", severity: "critical", via: [{ source: 1097678, name: "minimist", title: "Prototype Pollution in minimist", url: "https://github.com/advisories/GHSA-xvch-5gv4-984h", severity: "critical", range: ">=1.0.0 <1.2.6" }] }
    }
  });
  const scan = await runSecurityScan(root, {
    scanners: ["npm_audit", "osv_scanner"],
    runner: fakeRunner({ npm: { stdout: npmReport, exitCode: 1 }, "osv-scanner": { stdout: osvReport, exitCode: 1 } }),
    locate: fakeLocator(["npm", "osv-scanner"])
  });
  const osvAlone = (await import("./security-scan-js-parsers.mjs")).parseOsvScanner(osvReport, { projectRoot: root });
  // Two of osv-scanner's findings are the ones npm audit already made.
  assert.equal(scan.summary.findings, osvAlone.length);
  const malware = scan.findings.filter((item) => item.kind === "malware");
  assert.equal(malware.length, 1);
  assert.equal(malware[0].tool, "npm audit");
  assert.deepEqual(malware[0].confirmed_by, ["osv-scanner"]);
  assert.equal(malware[0].version, "1.14.1", "npm named no version; osv-scanner did");
  assert.equal(findingBlocks(malware[0]), true);
  assert.equal(scan.status, "block");
  assert.match(renderSecurityScanMarkdown(scan), /`critical` \*\*malware\*\* \[npm audit GHSA-fw8c-xr5c-95f9, also osv-scanner\] package-lock\.json/);
  const osvCall = scan.scanners.find((scanner) => scanner.id === "osv_scanner");
  assert.equal(osvCall.status, "ok");
});

test("osv-scanner behind a proxy that refuses its API is skipped as offline, not an error", async (t) => {
  const root = await tempProject(t, {});
  // Measured: exit 127, an empty report on stdout, Go's retry message on stderr.
  const scan = await runSecurityScan(root, {
    scanners: ["osv_scanner"],
    runner: fakeRunner({
      "osv-scanner": {
        exitCode: 127,
        stdout: JSON.stringify({ results: [] }),
        stderr: "Scanned /repo/package-lock.json file and found 8 packages\nError during extraction: (extracting as vulnmatch/osvdev) max retries exceeded: attempt 4: request failed: Post \"https://api.osv.dev/v1/querybatch\": Forbidden"
      }
    }),
    locate: fakeLocator(["osv-scanner"])
  });
  assert.equal(scan.scanners[0].status, "skipped");
  assert.match(scan.scanners[0].reason, /without reaching the network: Error during extraction/);
  assert.equal(scan.status, "unchecked");
});

test("Yarn 2+ is audited with its own command", async (t) => {
  const root = await tempProject(t, { "yarn.lock": "", "package.json": JSON.stringify({ packageManager: "yarn@4.10.3" }) });
  const calls = [];
  const report = await fs.readFile(path.join(FIXTURES, "yarn-berry-audit.ndjson"), "utf8");
  const scan = await runSecurityScan(root, {
    scanners: ["yarn_audit"],
    runner: fakeRunner({ yarn: { stdout: report, exitCode: 1 } }, { calls }),
    locate: fakeLocator(["yarn"])
  });
  assert.deepEqual(calls[0].args, ["npm", "audit", "--all", "--recursive", "--json"]);
  assert.equal(scan.summary.findings, 7);
  // Yarn 1 reports what it found as a bitmask exit code: 28 is moderate, high and critical.
  const classicRoot = await tempProject(t, { "yarn.lock": "", "package.json": "{}" });
  const classic = await runSecurityScan(classicRoot, {
    scanners: ["yarn_audit"],
    runner: fakeRunner({ yarn: { stdout: await fs.readFile(path.join(FIXTURES, "yarn-classic-audit.ndjson"), "utf8"), exitCode: 28 } }),
    locate: fakeLocator(["yarn"])
  });
  assert.equal(classic.scanners[0].status, "ok");
  assert.equal(classic.summary.findings, 7);
});

test("a package manager that failed in prose is an error, even on an exit code that means found", async (t) => {
  // Measured: Yarn 1 asked for Yarn 2+'s command. Exit 1 is in Yarn 1's
  // bitmask of "found something", and nothing on stdout is a finding — this
  // used to read as a clean scan.
  const root = await tempProject(t, { "yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules\n", "package.json": "{}" });
  const scan = await runSecurityScan(root, {
    scanners: ["yarn_audit"],
    runner: fakeRunner({ yarn: { exitCode: 1, stdout: "yarn run v1.22.22\ninfo Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.\n", stderr: "error Command \"npm\" not found.\n" } }),
    locate: fakeLocator(["yarn"])
  });
  assert.equal(scan.scanners[0].status, "error");
  assert.match(scan.scanners[0].reason, /yarn audit exited 1 without a report: error Command "npm" not found\./);
  assert.equal(scan.status, "warn", "an error warns; it never reads as clean");

  // Yarn 2+'s clean report is exit 0 and nothing printed, and that is believed.
  const clean = await runSecurityScan(root, {
    scanners: ["yarn_audit"],
    runner: fakeRunner({ yarn: { exitCode: 0, stdout: "" } }),
    locate: fakeLocator(["yarn"])
  });
  assert.equal(clean.scanners[0].status, "ok");
  assert.equal(clean.status, "pass");

  // A report whose only lines are deprecations is a report with no findings.
  const deprecations = await runSecurityScan(root, {
    scanners: ["yarn_audit"],
    runner: fakeRunner({ yarn: { exitCode: 1, stdout: '{"value":"left-pad","children":{"ID":"left-pad (deprecation)","Issue":"use String.prototype.padStart()","Severity":"moderate","Vulnerable Versions":"1.3.0","Tree Versions":["1.3.0"]}}\n' } }),
    locate: fakeLocator(["yarn"])
  });
  assert.equal(deprecations.scanners[0].status, "ok");
  assert.equal(deprecations.summary.findings, 0);

  const pnpmRoot = await tempProject(t, { "pnpm-lock.yaml": "" });
  const pnpmFailed = await runSecurityScan(pnpmRoot, {
    scanners: ["pnpm_audit"],
    runner: fakeRunner({ pnpm: { exitCode: 1, stdout: JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "The audit endpoint responded with 500" } }) } }),
    locate: fakeLocator(["pnpm"])
  });
  assert.equal(pnpmFailed.scanners[0].status, "error");
});
