import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { callTool } from "./mcp-stdio.mjs";
import { PRODUCT_DESIGN_SCORECARD_DIMENSIONS } from "./core/frontend-product-quality.mjs";

const execFileAsync = promisify(execFile);

function toolValue(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function call(name, args) {
  return toolValue(await callTool(name, args));
}

async function git(projectRoot, ...args) {
  await execFileAsync("git", ["-C", projectRoot, ...args]);
}

function completeDocuments() {
  return {
    designSystem: `# Project Design System
## Principles
Operational clarity comes before decorative novelty.
## Typography
Inter body text uses readable measures and documented heading sizes.
## Color
Semantic neutral, success, warning, and danger tokens meet AA contrast.
## Spacing
A four-pixel base scale supports compact operational density.
## Grid and Layout
Desktop uses twelve columns and mobile uses one prioritized content flow.
## Components
Tables, filters, dialogs, inputs, and buttons reuse documented variants.
## Interaction States
Hover, focus, active, disabled, loading, empty, error, and success are specified.
## Responsive Behavior
Dense tables reflow into records and touch targets remain at least 44 pixels.
## Motion
Motion only explains state changes and respects reduced-motion preferences.
## Content Rules
Labels use real logistics terms and metrics come from declared APIs.
## Accessibility
Keyboard order, focus, semantics, and announcements target WCAG 2.2 AA.
`,
    uiInventory: `# UI Inventory
## Screens and Routes
Dashboard and delivery detail routes are in scope.
## Components
Delivery table, filters, status badge, owner selector, and detail panel.
## Data and Content
Every field maps to the deliveries API or approved fixtures.
## Required States
Loading, empty, error, success, disabled, and focus states are covered.
## Responsive Risks
Long addresses and dense tables require explicit mobile reflow.
`,
    visualAcceptance: `# Visual Acceptance
## Approved Direction
The calm operations direction is approved.
## Reference Mapping
Dashboard references cover desktop and mobile states.
## Viewport Matrix
Desktop 1440x900 and mobile 390x844 are required.
## State Matrix
Loading, empty, error, and success have deterministic scenarios.
## Product Design Scorecard
All ten dimensions require direct artifact evidence.
## Anti-Slop Exceptions
None.
## Handoff Evidence
Screenshots, baselines, diffs, diagnostics, and independent review are required.
`
  };
}

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

async function startFixtureServer() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Frontend Product Fixture</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #17202a; background: #f4f7f9; font-family: Arial, sans-serif; }
    main { width: min(100% - 32px, 760px); margin: 48px auto; padding: 32px; background: #fff; border: 1px solid #d8e0e7; }
    label { display: block; margin: 20px 0 6px; }
    input { width: 100%; min-height: 42px; padding: 8px 10px; }
    button { min-height: 42px; margin-top: 16px; padding: 8px 16px; }
    #status { min-height: 24px; margin-top: 16px; }
    @media (max-width: 520px) { main { margin: 20px auto; padding: 20px; } }
  </style>
</head>
<body>
  <main>
    <h1>Delivery confirmation</h1>
    <p>Confirm the delivery owner using approved fixture data.</p>
    <label for="name">Owner</label>
    <input id="name" name="name" autocomplete="name">
    <button id="submit" type="button">Confirm</button>
    <p id="status" aria-live="polite">Waiting</p>
  </main>
  <script>
    document.querySelector("#submit").addEventListener("click", () => {
      const name = document.querySelector("#name").value.trim() || "Guest";
      document.querySelector("#status").textContent = "Confirmed: " + name;
    });
  </script>
</body>
</html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function passingScorecard() {
  return Object.fromEntries(PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => [
    dimension.id,
    {
      status: "pass",
      score: 4,
      evidence: `Reviewed current desktop and mobile evidence for ${dimension.id}.`,
      findings: []
    }
  ]));
}

async function approvePreparedProduct(projectRoot, references) {
  await call("update_frontend_product_brief", {
    project_path: projectRoot,
    context: {
      product_name: "Atlas",
      product_type: "B2B logistics dashboard",
      audience: "Operations leads at small logistics companies",
      primary_task: "Confirm the current delivery owner",
      business_goal: "Reduce unresolved late deliveries",
      tone_of_voice: "Direct, calm, operational",
      real_data_source: "Approved deterministic fixture",
      content_source: "Approved fixture copy",
      brand_constraints: "Use the existing product wordmark",
      accessibility_target: "WCAG 2.2 AA",
      screen_scope: ["/"],
      required_states: ["success"],
      forbidden_patterns: ["No fabricated delivery metrics"]
    },
    references,
    anti_slop_exceptions: []
  });
  await call("record_frontend_directions", {
    project_path: projectRoot,
    directions: [
      {
        id: "calm-ops",
        name: "Calm operations",
        rationale: "Direct confirmation flow for repeated operational work.",
        reference_ids: references.map((item) => item.id),
        artifacts: [references[0].value],
        tradeoffs: ["Less room for editorial content"]
      },
      {
        id: "focused-form",
        name: "Focused form",
        rationale: "Single-task form layout with explicit success feedback.",
        reference_ids: references.map((item) => item.id),
        artifacts: [references[1].value],
        tradeoffs: ["Lower information density"]
      }
    ]
  });
  await call("approve_frontend_direction", {
    project_path: projectRoot,
    direction_id: "calm-ops",
    approver: "product-owner",
    evidence: "Approved against the deterministic fixture references."
  });
  const documents = completeDocuments();
  await Promise.all([
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "design-system.md"), documents.designSystem),
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "ui-inventory.md"), documents.uiInventory),
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "visual-acceptance.md"), documents.visualAcceptance)
  ]);
  return call("approve_frontend_design_system", {
    project_path: projectRoot,
    approver: "product-owner",
    evidence: "Approved complete tokens, states, responsive rules, and baseline mapping."
  });
}

test("frontend product tools enforce preparation, direction approval, and pre-code design gate", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "frontend-product-tools-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const packageJson = JSON.stringify({
    name: "atlas-test",
    private: true,
    scripts: { dev: "vite", build: "vite build" },
    dependencies: { react: "19.0.0", vite: "7.0.0" }
  });
  await fs.writeFile(path.join(projectRoot, "package.json"), packageJson);
  await git(projectRoot, "init");
  await git(projectRoot, "config", "user.name", "AI Dev Test");
  await git(projectRoot, "config", "user.email", "ai-dev-test@example.invalid");
  await git(projectRoot, "add", "package.json");
  await git(projectRoot, "commit", "-m", "fixture");

  const prepared = await call("prepare_frontend_product", {
    project_path: projectRoot,
    project_name: "Atlas",
    mode: "new",
    implementer: "builder-agent"
  });
  assert.equal(prepared.action, "frontend_product_prepared");
  assert.equal(prepared.selected_skills.length, 3);
  assert.ok(prepared.created.includes(".ai-dev/frontend/product-quality.json"));

  const referencesDir = path.join(projectRoot, ".ai-dev", "frontend", "references");
  await fs.mkdir(referencesDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(referencesDir, "dashboard.png"), "reference"),
    fs.writeFile(path.join(referencesDir, "calm.png"), "direction-one"),
    fs.writeFile(path.join(referencesDir, "board.png"), "direction-two")
  ]);

  const brief = await call("update_frontend_product_brief", {
    project_path: projectRoot,
    context: {
      product_name: "Atlas",
      product_type: "B2B logistics dashboard",
      audience: "Operations leads at small logistics companies",
      primary_task: "Find late deliveries and assign an owner",
      business_goal: "Reduce unresolved late deliveries",
      tone_of_voice: "Direct, calm, operational",
      real_data_source: "GET /api/deliveries and approved fixtures",
      content_source: "Approved product copy deck",
      brand_constraints: "Keep the Atlas wordmark",
      accessibility_target: "WCAG 2.2 AA",
      screen_scope: ["/dashboard"],
      required_states: ["loading", "empty", "error", "success"],
      forbidden_patterns: ["No fabricated delivery metrics"]
    },
    references: [{
      id: "dashboard-reference",
      label: "Approved dashboard",
      kind: "local-image",
      value: ".ai-dev/frontend/references/dashboard.png",
      purpose: "Controls hierarchy and density",
      routes: ["/"],
      viewports: ["desktop", "mobile"],
      states: ["default"]
    }],
    anti_slop_exceptions: []
  });
  assert.deepEqual(brief.blockers, []);

  const directions = await call("record_frontend_directions", {
    project_path: projectRoot,
    directions: [
      {
        id: "calm-ops",
        name: "Calm operations",
        rationale: "Dense scanning layout for repeated exception handling.",
        reference_ids: ["dashboard-reference"],
        artifacts: [".ai-dev/frontend/references/calm.png"],
        tradeoffs: ["Less room for editorial storytelling"]
      },
      {
        id: "dispatch-board",
        name: "Dispatch board",
        rationale: "Status-led board for rapid owner assignment and triage.",
        reference_ids: ["dashboard-reference"],
        artifacts: [".ai-dev/frontend/references/board.png"],
        tradeoffs: ["More horizontal density"]
      }
    ]
  });
  assert.equal(directions.action, "frontend_directions_recorded");

  const directionApproval = await call("approve_frontend_direction", {
    project_path: projectRoot,
    direction_id: "calm-ops",
    approver: "product-owner",
    evidence: "Approved during product design review."
  });
  assert.equal(directionApproval.action, "frontend_direction_approved");

  const documents = completeDocuments();
  await Promise.all([
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "design-system.md"), documents.designSystem),
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "ui-inventory.md"), documents.uiInventory),
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "visual-acceptance.md"), documents.visualAcceptance)
  ]);
  await fs.writeFile(path.join(projectRoot, "package.json"), `${packageJson}\n`);
  const rejectedApproval = await call("approve_frontend_design_system", {
    project_path: projectRoot,
    approver: "product-owner",
    evidence: "Attempted approval after an application change."
  });
  assert.equal(rejectedApproval.action, "rejected");
  assert.match(rejectedApproval.errors.join("\n"), /package\.json/);
  await fs.writeFile(path.join(projectRoot, "package.json"), packageJson);

  const systemApproval = await call("approve_frontend_design_system", {
    project_path: projectRoot,
    approver: "product-owner",
    evidence: "Approved complete tokens, states, and responsive rules."
  });
  assert.equal(systemApproval.action, "frontend_design_system_approved");
  assert.equal(systemApproval.implementation_gate.ok, true);
  assert.equal(systemApproval.approved_visual_baselines.length, 2);
  assert(systemApproval.approved_visual_baselines.every((item) => item.path.includes("root__")));

  const gate = await call("frontend_product_gate", {
    project_path: projectRoot,
    gate: "implementation"
  });
  assert.equal(gate.ok, true);
});

test("strict visual workflow requires browser evidence and independent scorecard before handoff", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "frontend-product-visual-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "atlas-visual-test",
    private: true
  }));
  await call("prepare_frontend_product", {
    project_path: projectRoot,
    project_name: "Atlas",
    mode: "new",
    implementer: "builder-agent"
  });

  const server = await startFixtureServer();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await waitForUrl(url);

  const viewports = [
    { name: "desktop", width: 960, height: 720 },
    { name: "mobile", width: 390, height: 844 }
  ];
  const scenarios = [{
    name: "complete confirmation",
    state: "success",
    route: "/",
    actions: [
      { action: "fill", selector: "#name", value: "Codex" },
      { action: "click", selector: "#submit" },
      { action: "expect_text", selector: "#status", text: "Confirmed: Codex" }
    ]
  }];
  const capture = await call("run_frontend_qa", {
    project_path: projectRoot,
    url,
    start_dev_server: false,
    routes: ["/"],
    viewports,
    scenarios,
    check_visual_regression: false,
    artifact_location: "project",
    screenshot_dir: ".ai-dev/reference-capture",
    write_report: false,
    update_registry: false
  });
  assert.equal(capture.gate, "pass");

  const referencesDir = path.join(projectRoot, ".ai-dev", "frontend", "references");
  const references = [];
  for (const item of capture.results) {
    for (const source of [
      { state: "default", path: item.screenshot },
      { state: "success", path: item.scenarios[0].screenshot }
    ]) {
      const fileName = `${item.viewport.name}-${source.state}.png`;
      const target = path.join(referencesDir, fileName);
      await fs.copyFile(path.join(projectRoot, source.path), target);
      references.push({
        id: `${item.viewport.name}-${source.state}`,
        label: `${item.viewport.name} ${source.state}`,
        kind: "local-image",
        value: `.ai-dev/frontend/references/${fileName}`,
        purpose: `Approved ${source.state} composition`,
        routes: ["/"],
        viewports: [item.viewport.name],
        states: [source.state]
      });
    }
  }
  const approval = await approvePreparedProduct(projectRoot, references);
  assert.equal(approval.implementation_gate.ok, true);
  assert.equal(approval.approved_visual_baselines.length, 4);

  const strict = await call("run_visual_reference_qa", {
    project_path: projectRoot,
    url,
    start_dev_server: false,
    routes: ["/"],
    viewports,
    scenarios,
    artifact_location: "project",
    screenshot_dir: ".ai-dev/strict-visual",
    write_report: false
  });
  assert.equal(strict.action, "awaiting_visual_review", strict.qa.markdown);
  assert.equal(strict.strict_checks.desktop_and_mobile, true);
  assert.equal(strict.strict_checks.required_states_covered, true);
  assert.equal(strict.strict_checks.baselines_complete, true);

  const review = await call("record_visual_review", {
    project_path: projectRoot,
    reviewer: "independent-reviewer",
    reviewer_role: "product designer",
    inspections: strict.required_review_artifacts.map((artifact) => ({
      path: artifact.path,
      inspection_method: "view_image",
      observations: `Inspected current ${artifact.type} for ${artifact.viewport} ${artifact.state}.`
    })),
    scorecard: passingScorecard()
  });
  assert.equal(review.action, "visual_review_recorded");
  assert.equal(review.handoff_gate.ok, true);

  const handoff = await call("frontend_product_gate", {
    project_path: projectRoot,
    gate: "handoff"
  });
  assert.equal(handoff.ok, true);

  const reviewedScreenshot = strict.required_review_artifacts.find((artifact) => (
    artifact.type === "screenshot"
  ));
  const reviewedScreenshotPath = path.isAbsolute(reviewedScreenshot.path)
    ? reviewedScreenshot.path
    : path.join(projectRoot, reviewedScreenshot.path);
  await fs.appendFile(reviewedScreenshotPath, "changed-after-review");
  const staleHandoff = await call("frontend_product_gate", {
    project_path: projectRoot,
    gate: "handoff"
  });
  assert.equal(staleHandoff.ok, false);
  assert.match(staleHandoff.blockers.join("\n"), /hashes are stale/i);
  assert.equal(staleHandoff.reviewed_artifacts.current, false);
});
