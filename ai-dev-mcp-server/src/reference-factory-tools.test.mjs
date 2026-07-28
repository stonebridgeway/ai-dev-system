import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { callTool } from "./mcp-stdio.mjs";
import { CONCEPT_JURY_DIMENSIONS } from "./core/frontend-product-quality.mjs";

function toolValue(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function call(name, args) {
  return toolValue(await callTool(name, args));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createPng(width, height, seed) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const value = {
        1: Math.floor((x / Math.max(1, width - 1)) * 255),
        2: Math.floor((y / Math.max(1, height - 1)) * 255),
        3: 255 - Math.floor((x / Math.max(1, width - 1)) * 255),
        4: ((Math.floor(x / 40) + Math.floor(y / 40)) % 2) * 220
      }[seed] ?? (seed * 31 + x * (seed + 1) + y * (seed + 3)) % 256;
      row[offset] = value;
      row[offset + 1] = (value + seed * 17) % 256;
      row[offset + 2] = (255 - value + seed * 11) % 256;
    }
    rows.push(row);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function context() {
  return {
    product_name: "Atlas",
    product_type: "B2B logistics dashboard",
    audience: "Operations leads at small logistics companies",
    primary_task: "Confirm the current delivery owner",
    business_goal: "Reduce unresolved late deliveries",
    tone_of_voice: "Direct, calm, operational",
    real_data_source: "Approved deterministic fixture",
    content_source: "Approved fixture copy",
    brand_constraints: "Use the existing Atlas wordmark",
    accessibility_target: "WCAG 2.2 AA",
    screen_scope: ["/"],
    required_states: ["success"],
    forbidden_patterns: ["No fabricated delivery metrics"]
  };
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
The delivery confirmation route is in scope.
## Components
Owner input, confirmation action, and status feedback.
## Data and Content
Every field maps to the approved deterministic fixture.
## Required States
Default and success states are covered.
## Responsive Risks
Long owner names require resilient wrapping.
`,
    visualAcceptance: `# Visual Acceptance
## Approved Direction
The selected Reference Factory direction is approved.
## Reference Mapping
Generated baselines cover desktop and mobile default and success states.
## Viewport Matrix
Desktop 1440x960 and mobile 390x844 are required.
## State Matrix
Default and success have deterministic references.
## Product Design Scorecard
All ten dimensions require direct artifact evidence.
## Anti-Slop Exceptions
None.
## Handoff Evidence
Screenshots, baselines, diffs, diagnostics, and independent review are required.
`
  };
}

async function writeArtifacts(projectRoot, plan) {
  let seed = 1;
  for (const job of plan.artifact_jobs) {
    const target = path.join(projectRoot, job.output_path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const landscape = job.width >= job.height;
    await fs.writeFile(
      target,
      createPng(landscape ? 960 : 390, landscape ? 640 : 844, seed)
    );
    seed += 1;
  }
}

function outputEvidence(plan) {
  return plan.artifact_jobs.map((job) => ({
    artifact_id: job.artifact_id,
    path: job.output_path,
    prompt_sha256: job.prompt_sha256,
    inspection: {
      status: "pass",
      method: "view_image",
      observations: `Inspected ${job.artifact_id}; hierarchy, typography, content, and composition follow the manifest.`,
      blocking_findings: []
    }
  }));
}

function juryDirectionReview(directionId, decision) {
  return {
    direction_id: directionId,
    decision,
    strengths: ["The inspected concept has a coherent product-specific hierarchy."],
    risks: decision === "recommend" ? [] : ["The alternative increases scanning cost for the primary task."],
    dimensions: Object.fromEntries(CONCEPT_JURY_DIMENSIONS.map((dimension) => [
      dimension.id,
      {
        status: decision === "recommend" ? "pass" : "fail",
        score: decision === "recommend" ? 4 : 3,
        evidence: `Compared both desktop and mobile artifacts for ${dimension.id}.`
      }
    ]))
  };
}

test("Reference Factory registers concepts, blocks premature approval, and registers coverage", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reference-factory-tools-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "atlas-reference-factory",
    private: true
  }));

  const commandMatch = await call("match_auto_command", {
    request: "сгенерируй референсы для проекта"
  });
  assert.equal(commandMatch[0].name, "generate_frontend_references");

  await call("prepare_frontend_product", {
    project_path: projectRoot,
    project_name: "Atlas",
    mode: "new",
    implementer: "builder-agent",
    context: context()
  });
  const conceptPlan = await call("plan_frontend_references", {
    project_path: projectRoot,
    task: "Generate references for the delivery confirmation workflow",
    stage: "concepts",
    surface: "application",
    direction_count: 2
  });
  assert.equal(conceptPlan.action, "frontend_references_planned");
  assert.equal(conceptPlan.artifact_count, 4);
  await writeArtifacts(projectRoot, conceptPlan);

  const rejectedEvidence = outputEvidence(conceptPlan);
  rejectedEvidence[0].prompt_sha256 = "stale";
  const rejected = await call("register_frontend_references", {
    project_path: projectRoot,
    manifest_id: conceptPlan.manifest_id,
    outputs: rejectedEvidence
  });
  assert.equal(rejected.action, "rejected");
  assert.match(rejected.errors.join("\n"), /prompt hash/);

  const concepts = await call("register_frontend_references", {
    project_path: projectRoot,
    manifest_id: conceptPlan.manifest_id,
    outputs: outputEvidence(conceptPlan)
  });
  assert.equal(concepts.action, "frontend_reference_concepts_registered");
  assert.equal(concepts.directions_registered.length, 2);

  const prematureDirection = await call("approve_frontend_direction", {
    project_path: projectRoot,
    direction_id: concepts.directions_registered[0],
    approver: "product-owner",
    evidence: "Approved after comparing every generated desktop and mobile concept."
  });
  assert.equal(prematureDirection.action, "rejected");
  assert.match(prematureDirection.errors.join("\n"), /Concept Jury/);

  const jury = await call("record_frontend_concept_jury", {
    project_path: projectRoot,
    reviewer: "independent-design-reviewer",
    independent_from_implementer: true,
    comparison: "The first direction prioritizes owner confirmation; the second adds avoidable scanning and weaker mobile hierarchy.",
    direction_reviews: [
      juryDirectionReview(concepts.directions_registered[0], "recommend"),
      juryDirectionReview(concepts.directions_registered[1], "reserve")
    ]
  });
  assert.equal(jury.action, "frontend_concept_jury_recorded");

  const directionApproval = await call("approve_frontend_direction", {
    project_path: projectRoot,
    direction_id: concepts.directions_registered[0],
    approver: "product-owner",
    evidence: "Approved after accepting the independent Concept Jury recommendation."
  });
  assert.equal(directionApproval.action, "frontend_direction_approved");
  const documents = completeDocuments();
  await Promise.all([
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "design-system.md"), documents.designSystem),
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "ui-inventory.md"), documents.uiInventory),
    fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend", "visual-acceptance.md"), documents.visualAcceptance)
  ]);
  const premature = await call("approve_frontend_design_system", {
    project_path: projectRoot,
    approver: "product-owner",
    evidence: "Attempted approval before baseline coverage."
  });
  assert.equal(premature.action, "rejected");
  assert.match(premature.errors.join("\n"), /baseline coverage is missing/);

  const coveragePlan = await call("plan_frontend_references", {
    project_path: projectRoot,
    stage: "coverage",
    surface: "application",
    artifact_budget: 8
  });
  assert.equal(coveragePlan.action, "frontend_references_planned");
  assert.equal(coveragePlan.artifact_count, 4);
  await writeArtifacts(projectRoot, coveragePlan);
  const coverage = await call("register_frontend_references", {
    project_path: projectRoot,
    manifest_id: coveragePlan.manifest_id,
    outputs: outputEvidence(coveragePlan)
  });
  assert.equal(coverage.action, "frontend_reference_coverage_registered");

  const approved = await call("approve_frontend_design_system", {
    project_path: projectRoot,
    approver: "product-owner",
    evidence: "Approved after complete generated baseline coverage and document review."
  });
  assert.equal(approved.action, "frontend_design_system_approved");
  assert.equal(approved.implementation_gate.ok, true);
  assert.equal(approved.approved_visual_baselines.length, 4);

  const status = await call("reference_factory_status", {
    project_path: projectRoot
  });
  assert.equal(status.reference_factory.concepts.status, "registered");
  assert.equal(status.reference_factory.coverage.status, "registered");
  assert.equal(status.design_system_approved, true);
});
