import assert from "node:assert/strict";
import test from "node:test";
import {
  createFrontendProductState,
  validateFrontendDirections,
  validateFrontendReferences
} from "./frontend-product-quality.mjs";
import {
  buildReferenceFactoryRegistration,
  createReferenceFactoryManifest,
  validateReferenceFactoryManifest,
  validateReferenceFactoryOutputs,
  validateReferenceFactoryPlanning
} from "./reference-factory.mjs";

function completeContext() {
  return {
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
    required_states: ["loading", "empty", "error", "success"]
  };
}

function preparedState() {
  return createFrontendProductState({
    projectName: "Atlas",
    mode: "new",
    implementer: "builder-agent",
    context: completeContext()
  });
}

function passingOutputs(manifest) {
  return manifest.artifacts.map((artifact) => ({
    artifact_id: artifact.id,
    path: artifact.output_path,
    prompt_sha256: artifact.prompt_sha256,
    inspection: {
      status: "pass",
      method: "view_image",
      observations: `Inspected ${artifact.id}; hierarchy, content, and composition match the planned direction.`,
      blocking_findings: []
    }
  }));
}

test("concept manifest plans three materially distinct application directions", () => {
  const state = preparedState();
  const manifest = createReferenceFactoryManifest({
    state,
    task: "Generate dashboard references without an external reference",
    stage: "concepts",
    surface: "application",
    directionCount: 3,
    now: "2026-07-27T12:00:00.000Z"
  });

  assert.equal(manifest.stage, "concepts");
  assert.equal(manifest.directions.length, 3);
  assert.equal(new Set(manifest.directions.map((item) => item.layout)).size, 3);
  assert.equal(manifest.artifacts.length, 6);
  assert.equal(manifest.selected_skills.length, 3);
  assert.equal(manifest.selected_skills[1].name, "imagegen-frontend-web");
  assert(manifest.artifacts.every((item) => item.role === "candidate"));
  assert(manifest.artifacts.every((item) => item.output_path.endsWith(".png")));
  assert.deepEqual(validateReferenceFactoryManifest(manifest, { state }), []);
});

test("coverage manifest expands only the approved direction", () => {
  const state = preparedState();
  const concepts = createReferenceFactoryManifest({
    state,
    stage: "concepts",
    surface: "application",
    directionCount: 2,
    now: "2026-07-27T12:00:00.000Z"
  });
  state.directions = buildReferenceFactoryRegistration(
    concepts,
    passingOutputs(concepts),
    {}
  ).directions;
  state.approvals.direction = {
    direction_id: state.directions[0].id,
    approver: "product-owner",
    evidence: "Approved after visual comparison."
  };
  const coverage = createReferenceFactoryManifest({
    state,
    stage: "coverage",
    surface: "application",
    artifactBudget: 32,
    conceptManifest: concepts,
    now: "2026-07-27T12:10:00.000Z"
  });

  assert.equal(coverage.directions.length, 1);
  assert.equal(coverage.directions[0].id, state.approvals.direction.direction_id);
  assert.equal(coverage.artifacts.length, 10);
  assert(coverage.artifacts.every((item) => item.role === "baseline"));
  assert.deepEqual(validateReferenceFactoryManifest(coverage, { state }), []);
});

test("planning rejects missing product context and premature coverage", () => {
  const state = createFrontendProductState({ projectName: "Atlas" });
  const conceptErrors = validateReferenceFactoryPlanning({
    state,
    stage: "concepts"
  });
  assert.match(conceptErrors.join("\n"), /product_type/);

  const complete = preparedState();
  const coverageErrors = validateReferenceFactoryPlanning({
    state: complete,
    stage: "coverage"
  });
  assert.match(coverageErrors.join("\n"), /Approve one concept direction/);
});

test("output registration requires exact prompt binding and visual inspection", () => {
  const state = preparedState();
  const manifest = createReferenceFactoryManifest({
    state,
    stage: "concepts",
    directionCount: 2,
    now: "2026-07-27T12:00:00.000Z"
  });
  const outputs = passingOutputs(manifest);
  outputs[0].prompt_sha256 = "stale";
  outputs[1].inspection = {
    status: "reject",
    method: "view_image",
    observations: "The image contains generic card soup and must be regenerated.",
    blocking_findings: ["Generic card soup"]
  };
  const errors = validateReferenceFactoryOutputs(manifest, outputs);
  assert.match(errors.join("\n"), /not bound to the manifest prompt hash/);
  assert.match(errors.join("\n"), /must pass actual visual inspection/);
  assert.match(errors.join("\n"), /blocking visual findings/);
});

test("candidate references may overlap mappings across directions but stay direction-owned", () => {
  const state = preparedState();
  const manifest = createReferenceFactoryManifest({
    state,
    stage: "concepts",
    directionCount: 2,
    now: "2026-07-27T12:00:00.000Z"
  });
  const registration = buildReferenceFactoryRegistration(
    manifest,
    passingOutputs(manifest),
    Object.fromEntries(manifest.artifacts.map((item, index) => [
      item.id,
      { sha256: `hash-${index}`, width: item.width, height: item.height }
    ]))
  );
  assert.deepEqual(validateFrontendReferences(registration.references), []);
  assert.deepEqual(
    validateFrontendDirections(registration.directions, registration.references),
    []
  );

  const wrongDirection = structuredClone(registration.directions);
  wrongDirection[0].reference_ids = [registration.directions[1].reference_ids[0]];
  assert.match(
    validateFrontendDirections(wrongDirection, registration.references).join("\n"),
    /owned by another direction/
  );
});
