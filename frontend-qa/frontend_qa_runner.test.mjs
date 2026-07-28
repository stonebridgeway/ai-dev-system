import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.join(runnerDir, "frontend_qa_runner.mjs");

async function waitForUrl(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry while the fixture binds its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture did not become ready: ${url}`);
}

async function stopProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
}

async function runRunner(options) {
  const child = spawn(process.execPath, [runnerPath], {
    cwd: runnerDir,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(options));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

async function withFixture(name, port, callback) {
  const source = path.join(runnerDir, "fixtures", name);
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `frontend-qa-${name}-`));
  await fs.cp(source, projectRoot, { recursive: true });
  const server = spawn(process.execPath, [path.join(projectRoot, "fixture-server.mjs"), "--port", String(port)], {
    cwd: projectRoot,
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
    stdio: "ignore"
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForUrl(url);
    await callback({ projectRoot, url });
  } finally {
    await stopProcess(server);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

test("healthy page passes interactions, axe, responsive checks, and visual baselines", async () => {
  await withFixture("healthy", 43281, async ({ projectRoot, url }) => {
    const baseOptions = {
      project_path: projectRoot,
      url,
      start_dev_server: false,
      viewports: [
        { name: "desktop", width: 960, height: 720 },
        { name: "mobile", width: 390, height: 844 }
      ]
    };
    const baseline = await runRunner({
      ...baseOptions,
      required_states: ["success"],
      check_anti_slop: true,
      update_visual_baselines: true
    });
    assert.equal(baseline.gate, "pass", baseline.markdown);
    assert.deepEqual(baseline.results.map((item) => item.visual.status), ["updated", "updated"]);
    assert(baseline.results.every((item) => item.scenarios.every((scenario) => scenario.status === "passed")));
    assert(baseline.results.every((item) => item.scenarios[0].visual.status === "updated"));
    assert(baseline.results.every((item) => item.axe_findings.length === 0));
    assert.equal(baseline.state_coverage.complete, true);
    assert.equal(baseline.unwaived_anti_slop_findings, 0);

    const comparison = await runRunner({
      ...baseOptions,
      required_states: ["success"],
      check_anti_slop: true,
      update_visual_baselines: false
    });
    assert.equal(comparison.gate, "pass");
    assert.deepEqual(comparison.results.map((item) => item.visual.status), ["match", "match"]);
    assert(comparison.results.every((item) => item.scenarios[0].visual.status === "match"));
  });
});

test("diagnostic page blocks console, overflow, and accessibility regressions", async () => {
  await withFixture("diagnostic", 43282, async ({ projectRoot, url }) => {
    const report = await runRunner({
      project_path: projectRoot,
      url,
      start_dev_server: false,
      check_anti_slop: true,
      check_visual_regression: false
    });
    assert.equal(report.gate, "block");
    assert(report.results[0].console_errors.length > 0);
    assert(report.results[0].overflow.document_overflow_px > 0);
    assert(report.results[0].accessibility_findings.length > 0);
    assert(report.results[0].axe_findings.some((finding) => ["critical", "serious"].includes(finding.impact)));
    assert(report.results[0].anti_slop_findings.some((finding) => finding.rule_id === "generic-saas-copy"));
  });
});
