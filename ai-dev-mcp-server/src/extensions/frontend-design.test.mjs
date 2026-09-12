import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { createExtensionTools } from "../tool-extensions.mjs";
import { FRONTEND_PRODUCT_PATHS } from "../core/frontend-product-quality.mjs";
import { createFrontendDesignTools } from "./frontend-design.mjs";

/**
 * Minimal, deterministic PNGs. `seed` changes the pixels, so two artifacts can
 * be made identical, near-identical or plainly different on purpose.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}
function createPng(width, height, seed) {
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
      const value = (seed * 37 + x * (seed + 5) + y * (seed + 11)) % 256;
      row[offset] = value;
      row[offset + 1] = (value + seed * 19) % 256;
      row[offset + 2] = (255 - value) % 256;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const CONTEXT = {
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

/**
 * A project on disk plus a host that answers the frontend-design extension.
 * The product state is in memory; the brief and direction writers record what
 * they were asked to do rather than running the rest of the state machine.
 */
async function createFixture(t, { state = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontend-design-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });

  let productState = {
    schema_version: 2,
    project_name: "Atlas",
    mode: "new",
    phase: "brief",
    implementer: "builder-agent",
    context: CONTEXT,
    references: [],
    directions: [],
    anti_slop_exceptions: [],
    approvals: { direction: null, design_system: null },
    selected_skills: [
      { name: "frontend-product-builder", source: "custom", role: "orchestrator" },
      { name: "ui-ux-pro-max", source: "external/ui-ux-pro-max", role: "visual-direction" },
      { name: "frontend-quality-gate", source: "custom", role: "independent-quality" }
    ],
    ...state
  };

  const calls = [];
  const host = {
    safeProjectRoot: async (value) => {
      if (!value) throw new Error("project_path is required.");
      return projectRoot;
    },
    safeProjectFile: (base, relative) => path.join(base, relative),
    pathExists: (target) => fs.access(target).then(() => true, () => false),
    readJsonIfExists: async (target) => {
      try {
        return JSON.parse(await fs.readFile(target, "utf8"));
      } catch {
        return null;
      }
    },
    sha256: (value) => crypto.createHash("sha256").update(value).digest("hex"),
    truncateOutput: (value) => String(value ?? ""),
    readFrontendProductState: async () => productState,
    writeFrontendProductState: async (_root, next) => {
      productState = next;
      return next;
    },
    normalizeFrontendProductReference: (reference) => reference,
    validateFrontendReferenceFiles: async () => [],
    updateFrontendProductBrief: async (args) => {
      calls.push(["updateFrontendProductBrief", args.references.length]);
      productState = { ...productState, references: args.references };
      return { blockers: [] };
    },
    recordFrontendDirections: async (args) => {
      calls.push(["recordFrontendDirections", args.directions.length]);
      productState = { ...productState, phase: "directions-ready", directions: args.directions };
      return { action: "frontend_directions_recorded" };
    },
    runUiUxProMax: async (args, options = {}) => {
      calls.push(["runUiUxProMax", options.json ? "json" : "markdown"]);
      return options.json
        ? { design_system: { project_name: "Atlas", pattern: { name: "Operations" } } }
        : "## Design System: Atlas\n\n### Colors\n";
    },
    uiUxProMaxSource: async () => ({
      skill: "ui-ux-pro-max",
      path: "03-skills-catalog/sources/external/ui-ux-pro-max",
      repository: "https://github.com/example/ui-ux-pro-max",
      commit: "a".repeat(40),
      version: "2.11.0",
      license: "MIT"
    }),
    markSearchIndexDirty: (reason) => calls.push(["markSearchIndexDirty", reason])
  };

  return {
    root,
    projectRoot,
    host,
    calls,
    state: () => productState,
    registry: createExtensionTools(host, [createFrontendDesignTools])
  };
}

async function writeArtifacts(projectRoot, plan, { seedFor = (index) => index + 1 } = {}) {
  for (const [index, job] of plan.artifact_jobs.entries()) {
    const target = path.join(projectRoot, job.output_path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const landscape = job.width >= job.height;
    await fs.writeFile(target, createPng(landscape ? 960 : 390, landscape ? 640 : 844, seedFor(index)));
  }
}

const outputEvidence = (plan) => plan.artifact_jobs.map((job) => ({
  artifact_id: job.artifact_id,
  path: job.output_path,
  prompt_sha256: job.prompt_sha256,
  inspection: {
    status: "pass",
    method: "view_image",
    observations: `Inspected ${job.artifact_id}; hierarchy, content and composition follow the manifest.`,
    blocking_findings: []
  }
}));

async function planConcepts(registry, projectRoot, overrides = {}) {
  return registry.handlers.get("plan_frontend_references")({
    project_path: projectRoot,
    task: "Generate references for the delivery confirmation workflow",
    stage: "concepts",
    surface: "application",
    direction_count: 2,
    ...overrides
  });
}

test("the design extension exposes its three tools and none of them is read-only", async (t) => {
  const { registry } = await createFixture(t);
  assert.deepEqual(registry.definitions.map((definition) => definition.name), [
    "plan_frontend_references",
    "register_frontend_references",
    "generate_ui_ux_design_system"
  ]);
  assert.deepEqual(registry.readOnly, []);
  for (const definition of registry.definitions) assert.equal(definition.inputSchema.type, "object");
});

test("planning concepts writes a manifest and a plan, and names every artifact job", async (t) => {
  const { registry, projectRoot, state, calls } = await createFixture(t);
  const plan = await planConcepts(registry, projectRoot);

  assert.equal(plan.action, "frontend_references_planned");
  assert.equal(plan.stage, "concepts");
  assert.equal(plan.surface, "application");
  assert.equal(plan.artifact_count, plan.artifact_jobs.length);
  assert.ok(plan.artifact_count > 0);
  assert.match(plan.manifest_id, /^rf-\d{14}-[a-f0-9]{10}$/);
  assert.match(plan.tool_handoff, /Call ImageGen for every artifact job/);
  for (const job of plan.artifact_jobs) {
    assert.match(job.prompt_sha256, /^[0-9a-f]{64}$/);
    assert.ok(job.output_path.startsWith(FRONTEND_PRODUCT_PATHS.generatedReferences));
  }

  assert.ok(await fs.access(path.join(projectRoot, plan.manifest_path)).then(() => true, () => false));
  assert.match(await fs.readFile(path.join(projectRoot, plan.plan_path), "utf8"), /#/);
  assert.equal(state().reference_factory.concepts.manifest_id, plan.manifest_id);
  assert.deepEqual(calls.at(-1), ["markSearchIndexDirty", `reference factory planned: ${plan.manifest_path}`]);
});

test("a figma plan hands off differently", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const plan = await planConcepts(registry, projectRoot, { generator: "figma" });
  assert.equal(plan.generator, "figma");
  assert.match(plan.tool_handoff, /Create each frame in Figma/);
});

test("an unplannable request is rejected with reasons, not thrown", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const badSurface = await planConcepts(registry, projectRoot, { surface: "not-a-surface" });
  assert.equal(badSurface.action, "rejected");
  assert.ok(badSurface.errors.length > 0);

  const tooManyDirections = await planConcepts(registry, projectRoot, { direction_count: 99 });
  assert.equal(tooManyDirections.action, "rejected");

  const coverageWithoutDirection = await registry.handlers.get("plan_frontend_references")({
    project_path: projectRoot, stage: "coverage", surface: "application"
  });
  assert.equal(coverageWithoutDirection.action, "rejected");
});

test("registering concepts records the references and the directions they imply", async (t) => {
  const { registry, projectRoot, state, calls } = await createFixture(t);
  const plan = await planConcepts(registry, projectRoot);
  await writeArtifacts(projectRoot, plan);

  const registered = await registry.handlers.get("register_frontend_references")({
    project_path: projectRoot, manifest_id: plan.manifest_id, outputs: outputEvidence(plan)
  });

  assert.equal(registered.action, "frontend_reference_concepts_registered");
  assert.equal(registered.stage, "concepts");
  assert.equal(registered.directions_registered.length, 2);
  assert.equal(registered.references_registered.length, plan.artifact_count);
  for (const evidence of Object.values(registered.file_evidence)) {
    assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
    assert.ok(evidence.size_bytes > 256);
    assert.ok(evidence.width > 0 && evidence.height > 0);
  }
  assert.ok(calls.some(([name]) => name === "updateFrontendProductBrief"));
  assert.ok(calls.some(([name]) => name === "recordFrontendDirections"));
  assert.equal(state().reference_factory.concepts.status, "registered");
  assert.match(registered.next_step, /Concept Jury/);

  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, plan.manifest_path), "utf8"));
  assert.equal(manifest.status, "registered");
  assert.equal(manifest.outputs.length, plan.artifact_count);
});

test("an unknown manifest id is refused before anything is read", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  await assert.rejects(
    () => registry.handlers.get("register_frontend_references")({
      project_path: projectRoot, manifest_id: "not-a-manifest", outputs: []
    }),
    /Invalid Reference Factory manifest id/
  );
  await assert.rejects(
    () => registry.handlers.get("register_frontend_references")({
      project_path: projectRoot, manifest_id: "rf-20260101000000-0123456789", outputs: []
    }),
    /Reference Factory manifest not found/
  );
});

test("evidence that does not match the plan is rejected and nothing is recorded", async (t) => {
  const { registry, projectRoot, state } = await createFixture(t);
  const plan = await planConcepts(registry, projectRoot);
  await writeArtifacts(projectRoot, plan);

  const stale = outputEvidence(plan);
  stale[0].prompt_sha256 = "not-the-prompt-hash";
  const rejected = await registry.handlers.get("register_frontend_references")({
    project_path: projectRoot, manifest_id: plan.manifest_id, outputs: stale
  });
  assert.equal(rejected.action, "rejected");
  assert.ok(rejected.errors.length > 0);
  assert.equal(state().reference_factory.concepts.status, "planned");
});

test("a missing generated file is named rather than assumed", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const plan = await planConcepts(registry, projectRoot);
  const rejected = await registry.handlers.get("register_frontend_references")({
    project_path: projectRoot, manifest_id: plan.manifest_id, outputs: outputEvidence(plan)
  });
  assert.equal(rejected.action, "rejected");
  assert.ok(rejected.errors.every((error) => error.startsWith("Generated PNG does not exist")));
});

test("byte-identical artifacts are refused: two jobs cannot be one image", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const plan = await planConcepts(registry, projectRoot);
  await writeArtifacts(projectRoot, plan, { seedFor: () => 7 });
  const rejected = await registry.handlers.get("register_frontend_references")({
    project_path: projectRoot, manifest_id: plan.manifest_id, outputs: outputEvidence(plan)
  });
  assert.equal(rejected.action, "rejected");
  assert.ok(rejected.errors.some((error) => error.includes("byte-identical")));
});

test("a design-system draft carries provenance and is not persisted unless asked", async (t) => {
  const { registry, projectRoot, calls } = await createFixture(t);
  const generated = await registry.handlers.get("generate_ui_ux_design_system")({
    query: "operations dashboard for logistics"
  });

  assert.equal(generated.action, "generated");
  assert.equal(generated.source.commit.length, 40);
  assert.equal(generated.persistence, null);
  assert.deepEqual(generated.design_system, { project_name: "Atlas", pattern: { name: "Operations" } });
  assert.match(generated.guardrail, /browser-based visual QA/);
  assert.deepEqual(calls.filter(([name]) => name === "runUiUxProMax").map(([, mode]) => mode).sort(), ["json", "markdown"]);
  assert.ok(!(await fs.access(path.join(projectRoot, ".ai-dev/frontend/design-system.md")).then(() => true, () => false)));
});

test("persisting writes an unapproved draft, refuses to clobber, then overwrites", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const target = path.join(projectRoot, ".ai-dev/frontend/design-system.md");

  const created = await registry.handlers.get("generate_ui_ux_design_system")({
    query: "operations dashboard", project_path: projectRoot, persist: true
  });
  assert.equal(created.persistence.action, "created");
  assert.equal(created.persistence.path, ".ai-dev/frontend/design-system.md");
  assert.equal(created.request.project_name, path.basename(projectRoot));
  const document = await fs.readFile(target, "utf8");
  assert.match(document, /^# UI UX Design System Draft\n/);
  assert.match(document, /This is a recommendation, not visual approval/);
  assert.match(document, /## Approval State\n\n- \[ \] Product constraints reviewed/);
  assert.equal(created.persistence.bytes, Buffer.byteLength(document, "utf8"));

  await assert.rejects(
    () => registry.handlers.get("generate_ui_ux_design_system")({
      query: "operations dashboard", project_path: projectRoot, persist: true
    }),
    /Design system already exists\. Set overwrite=true/
  );

  const overwritten = await registry.handlers.get("generate_ui_ux_design_system")({
    query: "operations dashboard", project_path: projectRoot, persist: true, overwrite: true
  });
  assert.equal(overwritten.persistence.action, "overwritten");
});
