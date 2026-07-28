import crypto from "node:crypto";
import {
  ANTI_SLOP_RULES,
  FRONTEND_PRODUCT_PATHS,
  validateFrontendProductContext
} from "./frontend-product-quality.mjs";

export const REFERENCE_FACTORY_SCHEMA_VERSION = 1;

export const REFERENCE_FACTORY_GENERATORS = Object.freeze([
  "imagegen",
  "figma",
  "hybrid"
]);

export const REFERENCE_FACTORY_SURFACES = Object.freeze([
  "web",
  "application",
  "mobile"
]);

const CONCEPT_PROFILES = Object.freeze({
  web: [
    {
      id: "editorial-proof",
      name: "Editorial Proof",
      rationale: "Lead with a precise offer, real evidence, and an editorial reading rhythm instead of a generic SaaS shell.",
      layout: "Asymmetric editorial grid with full-width section bands, a visible next section, and restrained repeated containers.",
      typography: "High-contrast display and text hierarchy with controlled line length and no viewport-scaled type.",
      color: "Neutral foundation with one brand accent and semantic support colors; no default purple gradient.",
      density: "Moderate density with proof close to every important claim.",
      imagery: "Use authentic product, place, object, or workflow media as the first-viewport signal.",
      motion: "Only reveal hierarchy or state; no ambient decorative motion.",
      tradeoffs: ["Needs strong real content and photography", "Less suitable for dense operational workflows"]
    },
    {
      id: "product-demonstration",
      name: "Product Demonstration",
      rationale: "Make the real product or service observable immediately and organize the page around how it works.",
      layout: "Product-first composition with large inspectable media, compact supporting copy, and clear task progression.",
      typography: "Direct functional hierarchy with concise headings and readable supporting detail.",
      color: "Product-derived palette with neutral surfaces and clear interaction contrast.",
      density: "Information-dense around the product demonstration and quieter around transitions.",
      imagery: "Primary media shows the actual product state or outcome, never an atmospheric substitute.",
      motion: "Motion demonstrates causality or product behavior only.",
      tradeoffs: ["Requires authentic product media", "Can expose weak or incomplete product states"]
    },
    {
      id: "structured-authority",
      name: "Structured Authority",
      rationale: "Build trust through disciplined hierarchy, comparisons, process clarity, and credible evidence.",
      layout: "Strong grid, flat section hierarchy, compact proof modules, and deliberate alignment.",
      typography: "Reserved professional type scale with strong labels, numbers, and evidence captions.",
      color: "Balanced neutral and brand palette with semantic contrast rather than decorative effects.",
      density: "Moderately dense and optimized for scanning, comparison, and decision support.",
      imagery: "Use diagrams, real artifacts, and specific evidence instead of generic stock visuals.",
      motion: "Minimal transitions that preserve orientation and reduced-motion behavior.",
      tradeoffs: ["Can feel formal without good brand voice", "Needs careful content editing"]
    }
  ],
  application: [
    {
      id: "operational-clarity",
      name: "Operational Clarity",
      rationale: "Prioritize repeated user work, comparison, and fast status recognition over decorative presentation.",
      layout: "Stable application shell, explicit hierarchy, aligned data regions, and predictable navigation.",
      typography: "Compact readable text with clear labels, numbers, and state emphasis.",
      color: "Quiet neutral surfaces plus semantic status and action colors.",
      density: "Dense but organized for expert scanning and repeated actions.",
      imagery: "Use real data visualizations, objects, or workflow evidence only where they improve decisions.",
      motion: "State transitions, progress, and spatial continuity only.",
      tradeoffs: ["Less expressive for marketing surfaces", "Requires accurate data and state definitions"]
    },
    {
      id: "focused-workflow",
      name: "Focused Workflow",
      rationale: "Reduce cognitive load by centering one primary job and revealing secondary detail only when needed.",
      layout: "Task-first canvas with progressive disclosure, contextual side panels, and minimal competing actions.",
      typography: "Clear action and instruction hierarchy with generous form readability.",
      color: "Restrained brand accent with accessible focus, error, and success states.",
      density: "Lower density on the active task and higher density in supporting inspection views.",
      imagery: "Use only task-relevant diagrams, previews, or records.",
      motion: "Explain step changes, validation, and panel relationships.",
      tradeoffs: ["Slower for users who need broad comparison", "Requires good information prioritization"]
    },
    {
      id: "editorial-workspace",
      name: "Editorial Workspace",
      rationale: "Combine application utility with strong reading hierarchy for content-heavy or analytical work.",
      layout: "Flat workspace bands, asymmetric content columns, persistent context, and limited framed tools.",
      typography: "Editorial hierarchy with compact controls and comfortable long-form reading.",
      color: "Content-led neutral palette with distinct action and annotation colors.",
      density: "Variable density: compact controls around spacious content and analysis regions.",
      imagery: "Use real documents, media, charts, and annotations as working material.",
      motion: "Preserve reading position and explain content transformations.",
      tradeoffs: ["Needs disciplined component boundaries", "Not ideal for uniformly dense transaction screens"]
    }
  ],
  mobile: [
    {
      id: "native-task-flow",
      name: "Native Task Flow",
      rationale: "Optimize the primary job for thumb reach, platform expectations, and interruption-safe progress.",
      layout: "Single prioritized flow with native-feeling navigation, safe areas, and reachable primary actions.",
      typography: "Comfortable mobile type with short labels and resilient wrapping.",
      color: "Platform-aware neutral surfaces with accessible semantic and brand accents.",
      density: "Comfortable touch density without oversized empty screens.",
      imagery: "Use product content and media at useful inspection sizes.",
      motion: "Navigation and state transitions that preserve spatial understanding.",
      tradeoffs: ["Shows less information at once", "Requires deliberate navigation depth"]
    },
    {
      id: "content-led-mobile",
      name: "Content-Led Mobile",
      rationale: "Let the real content determine the visual rhythm rather than forcing every item into a generic card.",
      layout: "Edge-aware content flow, sectional hierarchy, and contextual actions near the content they affect.",
      typography: "Strong reading hierarchy with accessible measures and dynamic-length resilience.",
      color: "Content-supporting palette with controlled brand accents.",
      density: "Moderate density with clear separation and no card soup.",
      imagery: "Authentic content media is prominent and correctly sized.",
      motion: "Purposeful content transitions and reduced-motion support.",
      tradeoffs: ["Depends on strong content", "Needs careful empty and error states"]
    },
    {
      id: "compact-utility",
      name: "Compact Utility",
      rationale: "Support frequent mobile operations with compact controls, clear status, and fast access to actions.",
      layout: "Tight task modules, persistent context, and efficient lists without nested cards.",
      typography: "Compact but readable labels, values, and status hierarchy.",
      color: "Quiet surfaces with strong focus, selected, warning, and destructive states.",
      density: "High mobile density while preserving touch targets and legibility.",
      imagery: "Only use thumbnails or previews that help identify or compare records.",
      motion: "Fast feedback for selection, completion, and error recovery.",
      tradeoffs: ["Can overwhelm casual users", "Requires rigorous responsive content priority"]
    }
  ]
});

function text(value) {
  return String(value ?? "").trim();
}

function list(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value))
    .filter(Boolean))];
}

function slug(value, fallback = "item") {
  return text(value)
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || fallback;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])])
  );
}

export function referenceFactoryContextFingerprint(context = {}) {
  return hash(JSON.stringify(stableObject(context)));
}

export function inferReferenceFactorySurface({
  surface = "",
  mode = "",
  productType = ""
} = {}) {
  const explicit = text(surface).toLowerCase();
  if (explicit) {
    if (!REFERENCE_FACTORY_SURFACES.includes(explicit)) {
      throw new Error(`Unsupported reference surface: ${surface}.`);
    }
    return explicit;
  }
  const value = `${mode} ${productType}`.toLowerCase();
  if (/(mobile|ios|android|iphone|ipad|native app)/i.test(value)) return "mobile";
  if (/(dashboard|admin|portal|crm|workspace|application|web app|saas app)/i.test(value)) {
    return "application";
  }
  return "web";
}

export function selectReferenceFactorySkills({ surface = "web" } = {}) {
  const selectedSurface = inferReferenceFactorySurface({ surface });
  return [
    { name: "frontend-product-builder", source: "custom", role: "orchestrator" },
    {
      name: selectedSurface === "mobile" ? "imagegen-frontend-mobile" : "imagegen-frontend-web",
      source: "design/taste-skill",
      role: "reference-generation"
    },
    { name: "frontend-quality-gate", source: "custom", role: "independent-quality" }
  ];
}

function viewportsForSurface(surface) {
  if (surface === "mobile") {
    return [
      { name: "mobile", width: 390, height: 844 },
      { name: "mobile-large", width: 430, height: 932 }
    ];
  }
  return [
    { name: "desktop", width: 1440, height: 960 },
    { name: "mobile", width: 390, height: 844 }
  ];
}

function artifactPrompt({
  artifact,
  context,
  direction,
  surface,
  stage
}) {
  const antiSlop = ANTI_SLOP_RULES.map((rule) => rule.label).join(", ");
  const stateInstruction = artifact.state === "default"
    ? "Show the normal ready state."
    : `Show the "${artifact.state}" state clearly without changing the visual system.`;
  return [
    `Create one standalone high-fidelity ${surface} interface reference image.`,
    `Product: ${context.product_name}. Product type: ${context.product_type}.`,
    `Audience: ${context.audience}. Primary task: ${context.primary_task}.`,
    `Business goal: ${context.business_goal}. Tone: ${context.tone_of_voice}.`,
    `Target: ${artifact.scope}, ${artifact.viewport}, ${artifact.width}x${artifact.height}. ${stateInstruction}`,
    `Direction "${direction.name}": ${direction.rationale}`,
    `Layout: ${direction.layout}`,
    `Typography: ${direction.typography}`,
    `Color: ${direction.color}`,
    `Density: ${direction.density}`,
    `Imagery: ${direction.imagery}`,
    `Motion intent for later implementation: ${direction.motion}`,
    `Use truthful content from: ${context.content_source}. Use real data from: ${context.real_data_source}.`,
    `Brand constraints: ${context.brand_constraints || "No additional brand constraints supplied."}`,
    stage === "concepts"
      ? "This is a concept-direction artifact. Make its composition materially different from the other directions."
      : "This is an approved-direction baseline. Preserve the chosen visual language exactly.",
    "Render a single inspectable screen or section, not a moodboard, device mockup, multi-screen collage, or design-system board.",
    "Keep text legible and concise. Never invent customers, testimonials, ratings, metrics, certifications, or product claims.",
    `Avoid these default AI patterns unless explicitly approved: ${antiSlop}.`,
    "Use stable dimensions. Do not crop the primary product evidence or hide it behind atmospheric decoration."
  ].join("\n");
}

function makeArtifact({
  manifestId,
  direction,
  scope,
  viewport,
  state,
  context,
  surface,
  stage
}) {
  const artifactId = [
    slug(direction.id, "direction"),
    slug(scope, "root"),
    slug(viewport.name, "viewport"),
    slug(state, "default")
  ].join("--");
  const outputPath = [
    FRONTEND_PRODUCT_PATHS.generatedReferences,
    manifestId,
    slug(direction.id, "direction"),
    `${artifactId}.png`
  ].join("/");
  const artifact = {
    id: artifactId,
    direction_id: direction.id,
    scope,
    route: scope,
    viewport: viewport.name,
    state,
    width: viewport.width,
    height: viewport.height,
    orientation: viewport.width >= viewport.height ? "landscape" : "portrait",
    role: stage === "concepts" ? "candidate" : "baseline",
    output_path: outputPath,
    purpose: stage === "concepts"
      ? `Compare the ${direction.name} direction for ${scope} on ${viewport.name}.`
      : `Approved ${direction.name} baseline for ${scope}, ${viewport.name}, ${state}.`
  };
  const prompt = artifactPrompt({ artifact, context, direction, surface, stage });
  return {
    ...artifact,
    prompt,
    prompt_sha256: hash(prompt),
    negative_prompt: [
      "multi-screen collage",
      "device mockup",
      "moodboard",
      "illegible text",
      "fabricated metrics",
      "generic SaaS copy",
      "purple gradient",
      "decorative glassmorphism",
      "floating orb decoration",
      "nested card soup"
    ]
  };
}

function directionFromRecorded(recorded, conceptManifest) {
  const source = conceptManifest?.directions?.find((item) => item.id === recorded?.id);
  return {
    id: text(recorded?.id),
    name: text(recorded?.name),
    rationale: text(recorded?.rationale),
    layout: text(source?.layout) || "Preserve the approved composition and layout hierarchy.",
    typography: text(source?.typography) || "Preserve the approved type hierarchy and readable measure.",
    color: text(source?.color) || "Preserve the approved semantic and brand color roles.",
    density: text(source?.density) || "Preserve the approved information density.",
    imagery: text(source?.imagery) || "Use authentic product-specific media and assets.",
    motion: text(source?.motion) || "Use motion only for state, hierarchy, or causality.",
    tradeoffs: list(recorded?.tradeoffs?.length ? recorded.tradeoffs : source?.tradeoffs)
  };
}

function manifestFingerprint(manifest) {
  const { manifest_fingerprint: _ignored, ...source } = manifest;
  return hash(JSON.stringify(stableObject(source)));
}

export function updateReferenceFactoryManifest(manifest, updates = {}) {
  const next = {
    ...manifest,
    ...updates
  };
  delete next.manifest_fingerprint;
  return {
    ...next,
    manifest_fingerprint: manifestFingerprint(next)
  };
}

export function validateReferenceFactoryPlanning({
  state,
  stage = "auto",
  surface = "",
  generator = "imagegen",
  directionCount = 3,
  artifactBudget = 32
} = {}) {
  const errors = [];
  if (!state) return ["Frontend Product Quality must be prepared before planning references."];
  errors.push(...validateFrontendProductContext(state.context));
  const selectedStage = stage === "auto"
    ? (state.approvals?.direction ? "coverage" : "concepts")
    : text(stage);
  if (!["concepts", "coverage"].includes(selectedStage)) {
    errors.push(`Unsupported Reference Factory stage: ${stage}.`);
  }
  if (!REFERENCE_FACTORY_GENERATORS.includes(text(generator))) {
    errors.push(`Unsupported Reference Factory generator: ${generator}.`);
  }
  try {
    inferReferenceFactorySurface({
      surface,
      mode: state.mode,
      productType: state.context?.product_type
    });
  } catch (error) {
    errors.push(error.message);
  }
  if (
    selectedStage === "concepts" &&
    (!Number.isInteger(Number(directionCount)) || Number(directionCount) < 2 || Number(directionCount) > 3)
  ) {
    errors.push("Reference Factory requires two or three concept directions.");
  }
  if (selectedStage === "coverage" && !state.approvals?.direction?.direction_id) {
    errors.push("Approve one concept direction before planning baseline coverage.");
  }
  const budget = Number(artifactBudget);
  if (!Number.isInteger(budget) || budget < 4 || budget > 64) {
    errors.push("artifact_budget must be an integer from 4 to 64.");
  }
  return errors;
}

export function createReferenceFactoryManifest({
  state,
  task = "",
  stage = "auto",
  surface = "",
  generator = "imagegen",
  directionCount = 3,
  artifactBudget = 32,
  conceptManifest = null,
  now = new Date().toISOString()
} = {}) {
  const planningErrors = validateReferenceFactoryPlanning({
    state,
    stage,
    surface,
    generator,
    directionCount,
    artifactBudget
  });
  if (planningErrors.length) {
    throw new Error(planningErrors.join("\n"));
  }

  const selectedStage = stage === "auto"
    ? (state.approvals?.direction ? "coverage" : "concepts")
    : text(stage);
  const selectedSurface = inferReferenceFactorySurface({
    surface,
    mode: state.mode,
    productType: state.context?.product_type
  });
  const contextFingerprint = referenceFactoryContextFingerprint(state.context);
  const timestamp = now.replace(/\D/g, "").slice(0, 14);
  const idSeed = `${state.project_name}\n${selectedStage}\n${selectedSurface}\n${contextFingerprint}\n${task}\n${now}`;
  const manifestId = `rf-${timestamp}-${hash(idSeed).slice(0, 10)}`;
  const viewports = viewportsForSurface(selectedSurface);

  let directions;
  let scopes;
  let states;
  if (selectedStage === "concepts") {
    directions = CONCEPT_PROFILES[selectedSurface]
      .slice(0, Number(directionCount))
      .map((item) => ({ ...item, id: `${slug(state.project_name, "product")}-${item.id}` }));
    scopes = [list(state.context.screen_scope)[0]];
    states = ["default"];
  } else {
    const approvedId = state.approvals.direction.direction_id;
    const recorded = state.directions.find((item) => item.id === approvedId);
    if (!recorded) throw new Error(`Approved direction is missing from state: ${approvedId}.`);
    directions = [directionFromRecorded(recorded, conceptManifest)];
    scopes = list(state.context.screen_scope);
    states = list(["default", ...state.context.required_states]);
  }

  const requiredArtifactCount = directions.length * scopes.length * states.length * viewports.length;
  if (requiredArtifactCount > Number(artifactBudget)) {
    throw new Error(
      `Reference plan needs ${requiredArtifactCount} artifacts, above artifact_budget=${artifactBudget}. ` +
      "Narrow screen_scope or required_states, or explicitly raise the budget up to 64."
    );
  }

  const artifacts = [];
  for (const direction of directions) {
    for (const scope of scopes) {
      for (const viewport of viewports) {
        for (const stateName of states) {
          artifacts.push(makeArtifact({
            manifestId,
            direction,
            scope,
            viewport,
            state: stateName,
            context: state.context,
            surface: selectedSurface,
            stage: selectedStage
          }));
        }
      }
    }
  }

  const manifest = {
    schema_version: REFERENCE_FACTORY_SCHEMA_VERSION,
    id: manifestId,
    status: "planned",
    stage: selectedStage,
    project_name: state.project_name,
    mode: state.mode,
    surface: selectedSurface,
    generator,
    task: text(task),
    context_fingerprint: contextFingerprint,
    approved_direction_id: selectedStage === "coverage"
      ? state.approvals.direction.direction_id
      : null,
    selected_skills: selectReferenceFactorySkills({ surface: selectedSurface }),
    direction_count: directions.length,
    artifact_budget: Number(artifactBudget),
    directions,
    artifacts,
    generation_contract: {
      output_format: "png",
      tool_boundary: "The MCP server plans and validates. The client agent calls ImageGen or Figma.",
      exact_output_paths: true,
      prompt_hash_binding: true,
      require_actual_visual_inspection: true,
      reject_duplicate_images: true,
      approval_is_separate: true
    },
    created_at: now,
    updated_at: now
  };
  return {
    ...manifest,
    manifest_fingerprint: manifestFingerprint(manifest)
  };
}

export function validateReferenceFactoryManifest(manifest, {
  state = null
} = {}) {
  const errors = [];
  if (manifest?.schema_version !== REFERENCE_FACTORY_SCHEMA_VERSION) {
    errors.push(`Expected Reference Factory schema ${REFERENCE_FACTORY_SCHEMA_VERSION}.`);
  }
  if (!/^rf-\d{14}-[a-f0-9]{10}$/.test(text(manifest?.id))) {
    errors.push("Reference Factory manifest has an invalid id.");
  }
  if (!["concepts", "coverage"].includes(text(manifest?.stage))) {
    errors.push("Reference Factory manifest has an invalid stage.");
  }
  if (!REFERENCE_FACTORY_SURFACES.includes(text(manifest?.surface))) {
    errors.push("Reference Factory manifest has an invalid surface.");
  }
  if (!REFERENCE_FACTORY_GENERATORS.includes(text(manifest?.generator))) {
    errors.push("Reference Factory manifest has an invalid generator.");
  }
  if (!Array.isArray(manifest?.directions) || !manifest.directions.length) {
    errors.push("Reference Factory manifest has no directions.");
  }
  if (!Array.isArray(manifest?.artifacts) || !manifest.artifacts.length) {
    errors.push("Reference Factory manifest has no artifacts.");
  }
  if (manifest?.manifest_fingerprint !== manifestFingerprint(manifest ?? {})) {
    errors.push("Reference Factory manifest fingerprint is stale or invalid.");
  }
  if (state) {
    const current = referenceFactoryContextFingerprint(state.context);
    if (manifest?.context_fingerprint !== current) {
      errors.push("Product context changed after Reference Factory planning; create a new manifest.");
    }
    if (
      manifest?.stage === "coverage" &&
      manifest?.approved_direction_id !== state.approvals?.direction?.direction_id
    ) {
      errors.push("Approved direction changed after coverage planning; create a new manifest.");
    }
  }

  const directionIds = new Set();
  for (const direction of manifest?.directions ?? []) {
    if (!text(direction?.id)) errors.push("Every manifest direction requires an id.");
    if (directionIds.has(direction.id)) errors.push(`Duplicate manifest direction: ${direction.id}.`);
    directionIds.add(direction.id);
  }
  const artifactIds = new Set();
  for (const artifact of manifest?.artifacts ?? []) {
    if (!text(artifact?.id)) errors.push("Every manifest artifact requires an id.");
    if (artifactIds.has(artifact.id)) errors.push(`Duplicate manifest artifact: ${artifact.id}.`);
    artifactIds.add(artifact.id);
    if (!directionIds.has(artifact?.direction_id)) {
      errors.push(`Artifact "${artifact?.id || "unknown"}" cites an unknown direction.`);
    }
    if (!text(artifact?.output_path).startsWith(`${FRONTEND_PRODUCT_PATHS.generatedReferences}/`)) {
      errors.push(`Artifact "${artifact?.id || "unknown"}" has an unsafe output path.`);
    }
    if (!/\.png$/i.test(text(artifact?.output_path))) {
      errors.push(`Artifact "${artifact?.id || "unknown"}" must output PNG.`);
    }
    if (!text(artifact?.prompt_sha256) || text(artifact.prompt_sha256) !== hash(text(artifact.prompt))) {
      errors.push(`Artifact "${artifact?.id || "unknown"}" prompt hash is invalid.`);
    }
  }
  return errors;
}

export function validateReferenceFactoryOutputs(manifest, outputs = []) {
  const errors = [];
  const expected = new Map((manifest?.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const supplied = new Map();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    const id = text(output?.artifact_id);
    if (!id) {
      errors.push("Every generated output requires artifact_id.");
      continue;
    }
    if (supplied.has(id)) errors.push(`Duplicate generated output: ${id}.`);
    supplied.set(id, output);
    const artifact = expected.get(id);
    if (!artifact) {
      errors.push(`Generated output is not in the manifest: ${id}.`);
      continue;
    }
    if (text(output?.path).replaceAll("\\", "/") !== artifact.output_path) {
      errors.push(`Generated output "${id}" must use the manifest output_path.`);
    }
    if (text(output?.prompt_sha256) !== artifact.prompt_sha256) {
      errors.push(`Generated output "${id}" is not bound to the manifest prompt hash.`);
    }
    if (text(output?.inspection?.status) !== "pass") {
      errors.push(`Generated output "${id}" must pass actual visual inspection.`);
    }
    if (!["view_image", "browser", "figma"].includes(text(output?.inspection?.method))) {
      errors.push(`Generated output "${id}" requires a supported inspection method.`);
    }
    if (text(output?.inspection?.observations).length < 30) {
      errors.push(`Generated output "${id}" requires concrete visual observations.`);
    }
    if (
      Array.isArray(output?.inspection?.blocking_findings) &&
      output.inspection.blocking_findings.length
    ) {
      errors.push(`Generated output "${id}" still has blocking visual findings.`);
    }
  }
  for (const id of expected.keys()) {
    if (!supplied.has(id)) errors.push(`Missing generated output: ${id}.`);
  }
  return errors;
}

export function buildReferenceFactoryRegistration(manifest, outputs, fileMetadata = {}) {
  const outputById = new Map(outputs.map((output) => [output.artifact_id, output]));
  const referenceIdByArtifact = new Map();
  const references = manifest.artifacts.map((artifact) => {
    const output = outputById.get(artifact.id);
    const metadata = fileMetadata[artifact.id] ?? {};
    const referenceId = `${manifest.id}-${artifact.id}`;
    referenceIdByArtifact.set(artifact.id, referenceId);
    return {
      id: referenceId,
      label: `${manifest.directions.find((item) => item.id === artifact.direction_id)?.name || artifact.direction_id}: ${artifact.scope} ${artifact.viewport} ${artifact.state}`,
      kind: "local-image",
      role: artifact.role,
      direction_id: artifact.direction_id,
      value: artifact.output_path,
      purpose: artifact.purpose,
      routes: [artifact.route],
      viewports: [artifact.viewport],
      states: [artifact.state],
      generation: {
        factory_schema_version: REFERENCE_FACTORY_SCHEMA_VERSION,
        manifest_id: manifest.id,
        artifact_id: artifact.id,
        prompt_sha256: artifact.prompt_sha256,
        file_sha256: metadata.sha256 || "",
        perceptual_hash: metadata.perceptual_hash || "",
        width: metadata.width || 0,
        height: metadata.height || 0,
        inspection_method: output?.inspection?.method || "",
        inspection_observations: output?.inspection?.observations || ""
      }
    };
  });

  const directions = manifest.stage === "concepts"
    ? manifest.directions.map((direction) => {
      const artifacts = manifest.artifacts.filter((item) => item.direction_id === direction.id);
      return {
        id: direction.id,
        name: direction.name,
        rationale: direction.rationale,
        reference_ids: artifacts.map((item) => referenceIdByArtifact.get(item.id)),
        artifacts: artifacts.map((item) => item.output_path),
        tradeoffs: list(direction.tradeoffs)
      };
    })
    : [];

  return { references, directions };
}

export function renderReferenceFactoryPlan(manifest) {
  const lines = [
    "# Frontend Reference Factory Plan",
    "",
    `- Manifest: \`${manifest.id}\``,
    `- Stage: \`${manifest.stage}\``,
    `- Surface: \`${manifest.surface}\``,
    `- Generator: \`${manifest.generator}\``,
    `- Context fingerprint: \`${manifest.context_fingerprint}\``,
    `- Artifacts: ${manifest.artifacts.length}`,
    "",
    "The MCP server does not fabricate tool execution. Generate every artifact through ImageGen or Figma, save it at the exact path, inspect the image, then register it with the manifest ID.",
    "",
    "## Directions",
    ""
  ];
  for (const direction of manifest.directions) {
    lines.push(
      `### ${direction.name}`,
      "",
      direction.rationale,
      "",
      `- Layout: ${direction.layout}`,
      `- Typography: ${direction.typography}`,
      `- Color: ${direction.color}`,
      `- Density: ${direction.density}`,
      `- Imagery: ${direction.imagery}`,
      `- Motion: ${direction.motion}`,
      `- Tradeoffs: ${list(direction.tradeoffs).join("; ") || "None recorded."}`,
      ""
    );
  }
  lines.push("## Artifact Jobs", "");
  for (const artifact of manifest.artifacts) {
    lines.push(
      `### ${artifact.id}`,
      "",
      `- Output: \`${artifact.output_path}\``,
      `- Target: ${artifact.scope} / ${artifact.viewport} / ${artifact.state}`,
      `- Size: ${artifact.width}x${artifact.height}`,
      `- Prompt SHA-256: \`${artifact.prompt_sha256}\``,
      "",
      "```text",
      artifact.prompt,
      "```",
      "",
      `Negative prompt: ${artifact.negative_prompt.join(", ")}`,
      ""
    );
  }
  return `${lines.join("\n").trim()}\n`;
}
