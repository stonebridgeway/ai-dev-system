import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTI_SLOP_RULES,
  CONCEPT_JURY_DIMENSIONS,
  FRONTEND_PRODUCT_PATHS,
  PRODUCT_DESIGN_SCORECARD_DIMENSIONS,
  approveDesignSystemState,
  approveDirectionState,
  buildFrontendProductFiles,
  createFrontendProductState,
  evaluateFrontendProductGate,
  recordConceptJuryState,
  selectFrontendProductSkills,
  validateFrontendDocuments,
  validateFrontendDirections,
  validateFrontendReferences,
  validateProductDesignScorecard
} from "./frontend-product-quality.mjs";

function completeContext() {
  return {
    product_name: "Atlas",
    product_type: "B2B analytics dashboard",
    audience: "Operations leads at small logistics companies",
    primary_task: "Find late deliveries and assign an owner",
    business_goal: "Reduce unresolved late deliveries",
    tone_of_voice: "Direct, calm, operational",
    real_data_source: "GET /api/deliveries and approved fixtures",
    content_source: "Product copy deck 2026-07",
    brand_constraints: "Use the existing Atlas wordmark",
    accessibility_target: "WCAG 2.2 AA",
    screen_scope: ["/dashboard", "/deliveries/:id"],
    required_states: ["loading", "empty", "error", "success"]
  };
}

function completedDocuments() {
  return {
    designSystem: `# Project Design System
## Principles
Operational clarity comes first.
## Typography
Inter 14/20 for body and 24/30 for page headings.
## Color
Semantic neutral, success, warning, and danger tokens meet AA contrast.
## Spacing
Four-pixel base scale with compact operational density.
## Grid and Layout
Twelve columns on desktop and one content column on mobile.
## Components
Tables, filters, dialogs, inputs, and buttons reuse documented variants.
## Interaction States
Hover, focus, active, disabled, loading, empty, error, and success are specified.
## Responsive Behavior
Tables collapse into prioritized records and touch targets stay at least 44 pixels.
## Motion
Motion only explains state transitions and honors reduced motion.
## Content Rules
Labels use real logistics terms and metrics come from declared APIs.
## Accessibility
Keyboard order, visible focus, semantics, and announcements target WCAG 2.2 AA.
`,
    uiInventory: `# UI Inventory
## Screens and Routes
Dashboard and delivery detail routes are in scope.
## Components
Delivery table, filters, status badge, owner selector, and detail panel.
## Data and Content
Every field maps to GET /api/deliveries or approved fixtures.
## Required States
Loading, empty, error, success, disabled, and focus states.
## Responsive Risks
Long addresses and dense delivery tables need explicit mobile reflow.
`,
    visualAcceptance: `# Visual Acceptance
## Approved Direction
Direction calm-ops is approved.
## Reference Mapping
Dashboard references cover desktop and mobile success and error states.
## Viewport Matrix
Desktop 1440x1000 and mobile 390x844.
## State Matrix
Loading, empty, error, and success have deterministic scenarios.
## Product Design Scorecard
All ten dimensions require screenshot evidence and separate findings.
## Anti-Slop Exceptions
None.
## Handoff Evidence
Screenshots, pixel diffs, browser diagnostics, accessibility, and independent review.
`
  };
}

function scorecard(status = "pass") {
  return Object.fromEntries(PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => [
    dimension.id,
    {
      status,
      score: status === "pass" ? 4 : 2,
      evidence: `Reviewed desktop and mobile artifacts for ${dimension.id}.`,
      findings: []
    }
  ]));
}

function juryReview(directionId, decision) {
  return {
    direction_id: directionId,
    decision,
    strengths: ["Clear product-specific structure"],
    risks: decision === "recommend" ? [] : ["Less direct support for the primary task"],
    dimensions: Object.fromEntries(CONCEPT_JURY_DIMENSIONS.map((dimension) => [
      dimension.id,
      {
        status: decision === "recommend" ? "pass" : "fail",
        score: decision === "recommend" ? 4 : 3,
        evidence: `Compared ${directionId} against both artifacts for ${dimension.id}.`
      }
    ]))
  };
}

function directionReadyState() {
  const state = createFrontendProductState({
    projectName: "Atlas",
    mode: "new",
    implementer: "builder-agent",
    context: completeContext()
  });
  state.references = [{
    id: "dashboard-reference",
    label: "Approved dashboard composition",
    kind: "local-image",
    value: ".ai-dev/frontend/references/dashboard.png",
    purpose: "Controls hierarchy and density",
    routes: ["/dashboard"],
    viewports: ["desktop", "mobile"],
    states: ["success"]
  }];
  state.directions = [
    {
      id: "calm-ops",
      name: "Calm operations",
      rationale: "Dense scanning layout for repeated exception handling.",
      reference_ids: ["dashboard-reference"],
      artifacts: [".ai-dev/frontend/references/direction-calm.png"]
    },
    {
      id: "dispatch-board",
      name: "Dispatch board",
      rationale: "Status-led board for rapid owner assignment and triage.",
      reference_ids: ["dashboard-reference"],
      artifacts: [".ai-dev/frontend/references/direction-board.png"]
    }
  ];
  return state;
}

test("builder always selects exactly three compatible skills", () => {
  for (const mode of ["new", "redesign", "landing", "maintenance"]) {
    const skills = selectFrontendProductSkills({ mode });
    assert.equal(skills.length, 3);
    assert.equal(skills[0].name, "frontend-product-builder");
    assert.equal(skills[2].name, "frontend-quality-gate");
    assert.equal(new Set(skills.map((item) => item.name)).size, 3);
  }
});

test("project preparation defines every mandatory file and policy rule", () => {
  const state = createFrontendProductState({ projectName: "Atlas" });
  const files = buildFrontendProductFiles(state);
  for (const requiredPath of [
    FRONTEND_PRODUCT_PATHS.designBrief,
    FRONTEND_PRODUCT_PATHS.designSystem,
    FRONTEND_PRODUCT_PATHS.uiInventory,
    FRONTEND_PRODUCT_PATHS.visualAcceptance,
    FRONTEND_PRODUCT_PATHS.antiSlopPolicy,
    FRONTEND_PRODUCT_PATHS.referencesReadme
  ]) {
    assert.ok(files.has(requiredPath), requiredPath);
  }
  const policy = files.get(FRONTEND_PRODUCT_PATHS.antiSlopPolicy);
  for (const rule of ANTI_SLOP_RULES) assert.match(policy, new RegExp(rule.id));
});

test("direction cannot be approved before context, references, and two directions exist", () => {
  const state = createFrontendProductState({ projectName: "Atlas" });
  const result = approveDirectionState(state, {
    directionId: "missing",
    approver: "product-owner",
    evidence: "Approval recorded in design review."
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /At least one product-specific visual reference/);
  assert.match(result.errors.join("\n"), /two or three visual directions/);
});

test("Reference Factory direction approval requires a current independent Concept Jury", () => {
  const state = directionReadyState();
  state.reference_factory = { concepts: { status: "registered" } };
  const blocked = approveDirectionState(state, {
    directionId: "calm-ops",
    approver: "product-owner",
    evidence: "Reviewed both concept directions."
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join("\n"), /Concept Jury/);

  const jury = recordConceptJuryState(state, {
    reviewer: "independent-designer",
    independentFromImplementer: true,
    comparison: "Calm operations makes owner assignment clearer while the dispatch board adds avoidable scanning cost.",
    directionReviews: [
      juryReview("calm-ops", "recommend"),
      juryReview("dispatch-board", "reserve")
    ]
  });
  assert.equal(jury.ok, true);
  const approved = approveDirectionState(jury.state, {
    directionId: "calm-ops",
    approver: "product-owner",
    evidence: "Accepted the independently reviewed recommendation."
  });
  assert.equal(approved.ok, true);
});

test("design-first gate rejects application changes before design-system approval", () => {
  const direction = approveDirectionState(directionReadyState(), {
    directionId: "calm-ops",
    approver: "product-owner",
    evidence: "Direction review meeting 2026-07-26."
  });
  assert.equal(direction.ok, true);

  const result = approveDesignSystemState(direction.state, {
    approver: "product-owner",
    evidence: "Design system review 2026-07-26.",
    dirtyFiles: ["src/App.tsx", ".ai-dev/frontend/design-system.md"],
    documents: completedDocuments(),
    documentHashes: {
      design_brief: "brief",
      design_system: "system",
      ui_inventory: "inventory",
      visual_acceptance: "acceptance"
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /src\/App\.tsx/);
});

test("completed documents pass structural validation", () => {
  assert.deepEqual(validateFrontendDocuments(completedDocuments()), []);
});

test("document validation checks the entire section body for placeholders", () => {
  const documents = completedDocuments();
  documents.designSystem = documents.designSystem.replace(
    "Semantic neutral, success, warning, and danger tokens meet AA contrast.",
    "Semantic tokens meet AA contrast.\nTBD - add the final danger token."
  );
  assert.match(validateFrontendDocuments(documents).join("\n"), /Color.*placeholder/);
});

test("references require baseline mapping and directions cannot cite unknown references", () => {
  const references = [{
    id: "reference-one",
    label: "Approved layout",
    kind: "local-image",
    value: ".ai-dev/frontend/references/layout.png",
    purpose: "Controls layout hierarchy"
  }];
  assert.match(validateFrontendReferences(references).join("\n"), /requires routes mapping/);
  assert.match(validateFrontendDirections([{
    id: "direction-one",
    name: "Focused",
    rationale: "A focused operational layout for repeated work.",
    reference_ids: ["missing-reference"],
    artifacts: [".ai-dev/frontend/references/focused.png"]
  }, {
    id: "direction-two",
    name: "Dense",
    rationale: "A denser comparison layout for expert operators.",
    reference_ids: ["missing-reference"],
    artifacts: [".ai-dev/frontend/references/dense.png"]
  }], directionReadyState().references).join("\n"), /unknown reference_id/);
});

test("scorecard rejects an opaque overall score and incomplete dimensions", () => {
  assert.match(
    validateProductDesignScorecard({ overall_score: 8 }).join("\n"),
    /must not contain an overall score/
  );
  assert.deepEqual(validateProductDesignScorecard(scorecard()), []);
});

test("handoff requires strict visual QA and independent artifact review", () => {
  const direction = approveDirectionState(directionReadyState(), {
    directionId: "calm-ops",
    approver: "product-owner",
    evidence: "Direction review meeting 2026-07-26."
  });
  const approved = approveDesignSystemState(direction.state, {
    approver: "product-owner",
    evidence: "Design system review 2026-07-26.",
    documents: completedDocuments(),
    documentHashes: {
      design_brief: "brief",
      design_system: "system",
      ui_inventory: "inventory",
      visual_acceptance: "acceptance"
    }
  });
  assert.equal(approved.ok, true);
  const hashes = approved.state.approvals.design_system.document_hashes;
  assert.equal(evaluateFrontendProductGate(approved.state, {
    gate: "implementation",
    currentDocumentHashes: hashes
  }).ok, true);
  assert.equal(evaluateFrontendProductGate(approved.state, {
    gate: "handoff",
    currentDocumentHashes: hashes
  }).ok, false);

  approved.state.latest_visual_run = {
    run_id: "qa-1",
    status: "passed",
    strict: true,
    desktop_and_mobile: true,
    required_states_covered: true,
    baselines_complete: true,
    unwaived_anti_slop_findings: 0
  };
  approved.state.visual_reviews.push({
    run_id: "qa-1",
    reviewer: "review-agent",
    independent: true,
    artifact_hashes_current: true,
    scorecard: scorecard()
  });
  assert.equal(evaluateFrontendProductGate(approved.state, {
    gate: "handoff",
    currentDocumentHashes: hashes,
    reviewArtifactsCurrent: false
  }).ok, false);
  assert.equal(evaluateFrontendProductGate(approved.state, {
    gate: "handoff",
    currentDocumentHashes: hashes,
    reviewArtifactsCurrent: true
  }).ok, true);
});
