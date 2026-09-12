/**
 * The design inputs a frontend product is built from.
 *
 * Two of these tools are the Reference Factory: `plan_frontend_references` mints
 * a manifest of artifact jobs, and `register_frontend_references` accepts the
 * generated PNGs only with evidence that somebody looked at each one — file
 * structure, size, orientation, byte-identity and perceptual distance are all
 * checked before a reference reaches the product state. The third,
 * `generate_ui_ux_design_system`, drafts a design system from the pinned local
 * UI UX Pro Max dataset.
 *
 * The manifest logic lives in `src/core/reference-factory.mjs`, the artifact
 * verdicts in `src/core/reference-factory-artifacts.mjs`, and the product state
 * machine in `src/core/frontend-product-quality.mjs`. What is here is the vault
 * and project I/O between them, reached through `host`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  FRONTEND_PRODUCT_PATHS,
  validateFrontendReferences
} from "../core/frontend-product-quality.mjs";
import {
  REFERENCE_FACTORY_GENERATORS,
  REFERENCE_FACTORY_SURFACES,
  buildReferenceFactoryRegistration,
  createReferenceFactoryManifest,
  renderReferenceFactoryPlan,
  updateReferenceFactoryManifest,
  validateReferenceFactoryManifest,
  validateReferenceFactoryOutputs
} from "../core/reference-factory.mjs";
import {
  NEAR_DUPLICATE_MAX_DISTANCE,
  inspectPngStructure,
  referenceFactoryComparisonGroup,
  referenceFactoryDuplicateFindings,
  referenceFactoryEntry,
  referenceFactoryIdenticalFinding,
  referenceFactoryImageFindings,
  referenceFactoryManifestRelativePath,
  referenceFactoryPlanRelativePath
} from "../core/reference-factory-artifacts.mjs";
import { findNearDuplicateImages, pngDifferenceHash } from "../core/png-perceptual.mjs";
import { isPathInside } from "../core/path-policy.mjs";
import { atomicWriteFile, atomicWriteJson } from "../core/atomic-files.mjs";
import {
  buildUiUxDesignJsonArgs,
  buildUiUxDesignMarkdownArgs
} from "../core/ui-ux-pro-max.mjs";

/** Where a generated design-system draft is written inside a project. */
const DESIGN_SYSTEM_RELATIVE_PATH = ".ai-dev/frontend/design-system.md";

/** Read one manifest by id, or say which id could not be found. */
async function readManifest(host, projectRoot, manifestId) {
  const relativePath = referenceFactoryManifestRelativePath(manifestId);
  const manifest = await host.readJsonIfExists(host.safeProjectFile(projectRoot, relativePath));
  if (!manifest) throw new Error(`Reference Factory manifest not found: ${manifestId}.`);
  return { manifest, relativePath };
}

/**
 * Read one planned artifact and judge it: inside the generated-reference
 * directory, present, a structurally valid PNG, and plausibly large enough for
 * somebody to have inspected it.
 */
async function inspectArtifact(host, projectRoot, artifact) {
  const target = host.safeProjectFile(projectRoot, artifact.output_path);
  const generatedRoot = host.safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.generatedReferences);
  if (!isPathInside(generatedRoot, target)) {
    return { errors: [`Artifact "${artifact.id}" is outside the generated-reference directory.`] };
  }
  if (!(await host.pathExists(target))) {
    return { errors: [`Generated PNG does not exist: ${artifact.output_path}.`] };
  }
  const buffer = await fs.readFile(target);
  const structure = inspectPngStructure(buffer);
  const errors = referenceFactoryImageFindings({ artifact, structure, sizeBytes: buffer.length });
  let perceptualHash = "";
  try {
    perceptualHash = pngDifferenceHash(buffer);
  } catch (error) {
    errors.push(`Artifact "${artifact.id}": ${String(error.message || error)}`);
  }
  return {
    path: artifact.output_path,
    width: structure.width,
    height: structure.height,
    size_bytes: buffer.length,
    sha256: host.sha256(buffer),
    perceptual_hash: perceptualHash,
    errors
  };
}

/**
 * Plan a stage of generated references.
 *
 * Planning is destructive on purpose: a new concepts manifest resets the product
 * back to the brief, and a new coverage manifest drops the design-system
 * approval. Whatever was approved was approved against references that are about
 * to be replaced.
 */
async function planFrontendReferences(host, {
  project_path,
  task = "",
  stage = "auto",
  surface = "",
  generator = "imagegen",
  direction_count = 3,
  artifact_budget = 32
} = {}) {
  const projectRoot = await host.safeProjectRoot(project_path);
  const state = await host.readFrontendProductState(projectRoot);
  let conceptManifest = null;
  if ((stage === "coverage" || (stage === "auto" && state.approvals?.direction))) {
    const conceptManifestId = state.reference_factory?.concepts?.manifest_id;
    if (conceptManifestId) {
      conceptManifest = (await readManifest(host, projectRoot, conceptManifestId)).manifest;
    }
  }

  let manifest;
  try {
    manifest = createReferenceFactoryManifest({
      state,
      task,
      stage,
      surface,
      generator,
      directionCount: Number(direction_count),
      artifactBudget: Number(artifact_budget),
      conceptManifest
    });
  } catch (error) {
    return {
      action: "rejected",
      project_path: projectRoot,
      errors: String(error.message || error).split("\n").filter(Boolean)
    };
  }
  const manifestErrors = validateReferenceFactoryManifest(manifest, { state });
  if (manifestErrors.length) {
    return { action: "rejected", project_path: projectRoot, errors: manifestErrors };
  }

  const manifestPath = referenceFactoryManifestRelativePath(manifest.id);
  const planPath = referenceFactoryPlanRelativePath(manifest.id);
  await fs.mkdir(
    host.safeProjectFile(projectRoot, `${FRONTEND_PRODUCT_PATHS.generatedReferences}/${manifest.id}`),
    { recursive: true }
  );
  await atomicWriteJson(host.safeProjectFile(projectRoot, manifestPath), manifest);
  await atomicWriteFile(
    host.safeProjectFile(projectRoot, planPath),
    renderReferenceFactoryPlan(manifest),
    "utf8"
  );

  const factory = {
    schema_version: 1,
    ...(state.reference_factory || {}),
    surface: manifest.surface,
    selected_skills: manifest.selected_skills,
    [manifest.stage]: referenceFactoryEntry(manifest, manifestPath, planPath)
  };
  const resetForConcepts = manifest.stage === "concepts"
    ? {
      phase: "brief",
      directions: [],
      references: (state.references || []).filter((reference) => (
        reference.generation?.factory_schema_version !== 1
      )),
      approvals: { direction: null, design_system: null },
      concept_jury: null,
      latest_visual_run: null,
      visual_reviews: []
    }
    : {
      phase: "direction-approved",
      approvals: {
        ...(state.approvals || {}),
        design_system: null
      },
      latest_visual_run: null,
      visual_reviews: []
    };
  const saved = await host.writeFrontendProductState(projectRoot, {
    ...state,
    ...resetForConcepts,
    selected_skills: manifest.selected_skills,
    reference_factory: factory
  });
  host.markSearchIndexDirty(`reference factory planned: ${manifestPath}`);
  return {
    action: "frontend_references_planned",
    project_path: projectRoot,
    phase: saved.phase,
    stage: manifest.stage,
    manifest_id: manifest.id,
    manifest_path: manifestPath,
    plan_path: planPath,
    surface: manifest.surface,
    generator: manifest.generator,
    selected_skills: manifest.selected_skills,
    artifact_count: manifest.artifacts.length,
    artifact_jobs: manifest.artifacts.map((artifact) => ({
      artifact_id: artifact.id,
      direction_id: artifact.direction_id,
      output_path: artifact.output_path,
      width: artifact.width,
      height: artifact.height,
      prompt: artifact.prompt,
      prompt_sha256: artifact.prompt_sha256,
      negative_prompt: artifact.negative_prompt
    })),
    tool_handoff: manifest.generator === "figma"
      ? "Create each frame in Figma, export every planned artifact as PNG, inspect it, then call register_frontend_references."
      : "Call ImageGen for every artifact job, save each PNG at output_path, inspect it with view_image, then call register_frontend_references.",
    next_step: "Generate every planned artifact and register only visually inspected outputs."
  };
}

/**
 * Register the generated artifacts for one manifest.
 *
 * Nothing is recorded until every artifact passes: the plan is still the active
 * one, each output carries the prompt hash it was generated from, each file is a
 * real PNG of the planned shape, no two files are byte-identical, and at the
 * concepts stage no two directions are the same picture with different paint.
 */
async function registerFrontendReferences(host, {
  project_path,
  manifest_id,
  outputs = []
} = {}) {
  const projectRoot = await host.safeProjectRoot(project_path);
  const state = await host.readFrontendProductState(projectRoot);
  const { manifest, relativePath: manifestPath } = await readManifest(host, projectRoot, manifest_id);
  const errors = [
    ...validateReferenceFactoryManifest(manifest, { state }),
    ...validateReferenceFactoryOutputs(manifest, outputs)
  ];
  if (state.reference_factory?.[manifest.stage]?.manifest_id !== manifest.id) {
    errors.push("Reference Factory manifest is not the active plan for this stage.");
  }
  if (errors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      manifest_id,
      errors: [...new Set(errors)]
    };
  }
  const fileMetadata = {};
  const seenHashes = new Map();
  for (const artifact of manifest.artifacts || []) {
    const metadata = await inspectArtifact(host, projectRoot, artifact);
    fileMetadata[artifact.id] = metadata;
    errors.push(...(metadata.errors || []));
    if (metadata.sha256) {
      const previous = seenHashes.get(metadata.sha256);
      if (previous) errors.push(referenceFactoryIdenticalFinding(previous, artifact.id));
      else seenHashes.set(metadata.sha256, artifact.id);
    }
  }
  if (manifest.stage === "concepts") {
    const artifactsById = new Map((manifest.artifacts || []).map((artifact) => [artifact.id, artifact]));
    const nearDuplicates = findNearDuplicateImages(
      Object.entries(fileMetadata).map(([id, metadata]) => ({
        id,
        direction_id: artifactsById.get(id)?.direction_id,
        comparison_group: referenceFactoryComparisonGroup(artifactsById.get(id)),
        perceptual_hash: metadata.perceptual_hash
      })),
      {
        maximumDistance: NEAR_DUPLICATE_MAX_DISTANCE,
        comparable: (left, right) => (
          left.direction_id !== right.direction_id &&
          left.comparison_group === right.comparison_group
        )
      }
    );
    errors.push(...referenceFactoryDuplicateFindings(nearDuplicates));
  }
  if (errors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      manifest_id,
      errors: [...new Set(errors)]
    };
  }

  const registration = buildReferenceFactoryRegistration(manifest, outputs, fileMetadata);
  let saved;
  if (manifest.stage === "concepts") {
    const retained = (state.references || []).filter((reference) => (
      reference.generation?.factory_schema_version !== 1
    ));
    const brief = await host.updateFrontendProductBrief({
      project_path: projectRoot,
      context: state.context,
      references: [...retained, ...registration.references],
      anti_slop_exceptions: state.anti_slop_exceptions || []
    });
    if (brief.blockers.length) {
      return {
        action: "rejected",
        project_path: projectRoot,
        manifest_id,
        errors: brief.blockers
      };
    }
    const directions = await host.recordFrontendDirections({
      project_path: projectRoot,
      directions: registration.directions
    });
    if (directions.action === "rejected") return directions;
    saved = await host.readFrontendProductState(projectRoot);
  } else {
    if (manifest.approved_direction_id !== state.approvals?.direction?.direction_id) {
      return {
        action: "rejected",
        project_path: projectRoot,
        manifest_id,
        errors: ["Coverage manifest no longer matches the approved direction."]
      };
    }
    const retained = (state.references || []).filter((reference) => !(
      reference.role === "baseline" &&
      reference.direction_id === manifest.approved_direction_id &&
      reference.generation?.factory_schema_version === 1
    ));
    const references = [...retained, ...registration.references].map(host.normalizeFrontendProductReference);
    const referenceErrors = [
      ...validateFrontendReferences(references),
      ...await host.validateFrontendReferenceFiles(projectRoot, references, state.directions)
    ];
    if (referenceErrors.length) {
      return {
        action: "rejected",
        project_path: projectRoot,
        manifest_id,
        errors: referenceErrors
      };
    }
    saved = await host.writeFrontendProductState(projectRoot, {
      ...state,
      phase: "direction-approved",
      references,
      approvals: {
        ...(state.approvals || {}),
        design_system: null
      },
      latest_visual_run: null,
      visual_reviews: []
    });
  }

  const registeredAt = new Date().toISOString();
  const registeredManifest = updateReferenceFactoryManifest(manifest, {
    status: "registered",
    registered_at: registeredAt,
    updated_at: registeredAt,
    outputs: manifest.artifacts.map((artifact) => ({
      artifact_id: artifact.id,
      path: artifact.output_path,
      prompt_sha256: artifact.prompt_sha256,
      file_sha256: fileMetadata[artifact.id].sha256,
      perceptual_hash: fileMetadata[artifact.id].perceptual_hash,
      width: fileMetadata[artifact.id].width,
      height: fileMetadata[artifact.id].height,
      inspection: outputs.find((item) => item.artifact_id === artifact.id)?.inspection
    }))
  });
  await atomicWriteJson(host.safeProjectFile(projectRoot, manifestPath), registeredManifest);
  const planPath = referenceFactoryPlanRelativePath(manifest.id);
  const factory = {
    schema_version: 1,
    ...(saved.reference_factory || {}),
    surface: manifest.surface,
    generator: manifest.generator,
    selected_skills: manifest.selected_skills,
    [manifest.stage]: {
      ...referenceFactoryEntry(
        registeredManifest,
        manifestPath,
        planPath,
        "registered"
      ),
      registered_at: registeredAt
    }
  };
  saved = await host.writeFrontendProductState(projectRoot, {
    ...saved,
    reference_factory: factory
  });
  host.markSearchIndexDirty(`reference factory registered: ${manifestPath}`);
  return {
    action: manifest.stage === "concepts"
      ? "frontend_reference_concepts_registered"
      : "frontend_reference_coverage_registered",
    project_path: projectRoot,
    manifest_id,
    stage: manifest.stage,
    phase: saved.phase,
    references_registered: registration.references.map((item) => item.id),
    directions_registered: registration.directions.map((item) => item.id),
    file_evidence: Object.fromEntries(Object.entries(fileMetadata).map(([id, metadata]) => [
      id,
      {
        path: metadata.path,
        width: metadata.width,
        height: metadata.height,
        size_bytes: metadata.size_bytes,
        sha256: metadata.sha256,
        perceptual_hash: metadata.perceptual_hash
      }
    ])),
    next_step: manifest.stage === "concepts"
      ? "Run an independent Concept Jury, approve its recommended direction, then plan stage=coverage."
      : "Complete the design system, UI inventory, and visual acceptance documents, then approve the design system."
  };
}

/**
 * Draft a design system from the pinned UI UX Pro Max dataset, optionally
 * writing it into the project as an unapproved draft.
 *
 * The draft is a recommendation with provenance attached, never an approval:
 * the written document carries an explicit unchecked approval list.
 */
async function generateUiUxDesignSystem(host, {
  query,
  project_name = "",
  variance,
  motion,
  density,
  project_path = "",
  persist = false,
  overwrite = false
} = {}) {
  let projectRoot = null;
  let target = null;
  let existed = false;
  const request = { query, project_name, variance, motion, density };

  if (persist) {
    projectRoot = await host.safeProjectRoot(project_path);
    if (!request.project_name) request.project_name = path.basename(projectRoot);
    target = host.safeProjectFile(projectRoot, DESIGN_SYSTEM_RELATIVE_PATH);
    existed = await host.pathExists(target);
    if (existed && !overwrite) {
      throw new Error(
        "Design system already exists. Set overwrite=true to replace "
        + `${DESIGN_SYSTEM_RELATIVE_PATH}.`
      );
    }
  }

  const jsonCommand = buildUiUxDesignJsonArgs(request);
  const markdownCommand = buildUiUxDesignMarkdownArgs(request);
  const [result, markdown] = await Promise.all([
    host.runUiUxProMax(jsonCommand.args, { json: true }),
    host.runUiUxProMax(markdownCommand.args)
  ]);
  const source = await host.uiUxProMaxSource();
  let persistence = null;

  if (persist) {
    const document = [
      "# UI UX Design System Draft",
      "",
      "> Generated from a curated local dataset. This is a recommendation, not visual approval.",
      "> Reconcile it with the product, approved brand, repository conventions, and observed UI.",
      "",
      "## Provenance",
      "",
      `- Source: ${source.repository}`,
      `- Commit: \`${source.commit}\``,
      `- Version: \`${source.version}\``,
      `- Generated: ${new Date().toISOString()}`,
      "",
      "## Request",
      "",
      "```json",
      JSON.stringify(jsonCommand.normalized, null, 2),
      "```",
      "",
      markdown.trim(),
      "",
      "## Approval State",
      "",
      "- [ ] Product constraints reviewed",
      "- [ ] Brand and existing design tokens reconciled",
      "- [ ] Contrast and interaction states verified in the rendered UI",
      "- [ ] Desktop and mobile screenshots inspected",
      ""
    ].join("\n");
    await atomicWriteFile(target, document, "utf8");
    host.markSearchIndexDirty(`project design system written: ${target}`);
    persistence = {
      action: existed ? "overwritten" : "created",
      project_path: projectRoot,
      path: DESIGN_SYSTEM_RELATIVE_PATH,
      bytes: Buffer.byteLength(document, "utf8")
    };
  }

  return {
    action: "generated",
    source,
    request: jsonCommand.normalized,
    design_system: result.design_system ?? result,
    markdown: host.truncateOutput(markdown, 20000),
    persistence,
    guardrail: "Implementation and browser-based visual QA are still required."
  };
}

/**
 * Reference Factory and design-system tools.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createFrontendDesignTools(host) {
  return {
    definitions: [
  {
    name: "plan_frontend_references",
    description: "Plan Reference Factory concept images or approved-direction baseline coverage without pretending the MCP server can invoke ImageGen or Figma itself.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        task: { type: "string" },
        stage: { type: "string", enum: ["auto", "concepts", "coverage"], default: "auto" },
        surface: { type: "string", enum: [...REFERENCE_FACTORY_SURFACES] },
        generator: { type: "string", enum: [...REFERENCE_FACTORY_GENERATORS], default: "imagegen" },
        direction_count: { type: "number", minimum: 2, maximum: 3, default: 3 },
        artifact_budget: { type: "number", minimum: 4, maximum: 64, default: 32 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "register_frontend_references",
    description: "Validate generated PNG signatures, dimensions, hashes, prompt binding, and visual-inspection evidence, then register them in Frontend Product Quality v2.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        manifest_id: { type: "string" },
        outputs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              artifact_id: { type: "string" },
              path: { type: "string" },
              prompt_sha256: { type: "string" },
              inspection: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "reject"] },
                  method: { type: "string", enum: ["view_image", "browser", "figma"] },
                  observations: { type: "string" },
                  blocking_findings: { type: "array", items: { type: "string" } }
                },
                required: ["status", "method", "observations"]
              }
            },
            required: ["artifact_id", "path", "prompt_sha256", "inspection"]
          }
        }
      },
      required: ["project_path", "manifest_id", "outputs"]
    }
  },
  {
    name: "generate_ui_ux_design_system",
    description: "Generate a product-specific UI/UX design-system draft from the pinned local dataset. Optionally persist it only to .ai-dev/frontend/design-system.md inside a validated project. Rendering and browser QA remain required.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Product type, industry, audience, main task, tone, density, motion, and constraints."
        },
        project_name: { type: "string", maxLength: 120 },
        variance: { type: "number", minimum: 1, maximum: 10 },
        motion: { type: "number", minimum: 1, maximum: 10 },
        density: { type: "number", minimum: 1, maximum: 10 },
        project_path: {
          type: "string",
          description: "Absolute project root. Required only when persist=true."
        },
        persist: { type: "boolean", default: false },
        overwrite: { type: "boolean", default: false }
      },
      required: ["query"]
    }
  }
    ],
    handlers: {
      plan_frontend_references: (args) => planFrontendReferences(host, args),
      register_frontend_references: (args) => registerFrontendReferences(host, args),
      generate_ui_ux_design_system: (args) => generateUiUxDesignSystem(host, args)
    }
  };
}
