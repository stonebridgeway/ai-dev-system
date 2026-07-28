import crypto from "node:crypto";

export const FRONTEND_PRODUCT_SCHEMA_VERSION = 2;

export const FRONTEND_PRODUCT_MODES = Object.freeze([
  "new",
  "redesign",
  "landing",
  "maintenance"
]);

export const FRONTEND_PRODUCT_PATHS = Object.freeze({
  root: ".ai-dev/frontend",
  state: ".ai-dev/frontend/product-quality.json",
  designBrief: ".ai-dev/frontend/design-brief.md",
  designSystem: ".ai-dev/frontend/design-system.md",
  uiInventory: ".ai-dev/frontend/ui-inventory.md",
  visualAcceptance: ".ai-dev/frontend/visual-acceptance.md",
  antiSlopPolicy: ".ai-dev/frontend/anti-slop-policy.md",
  references: ".ai-dev/frontend/references",
  referencesReadme: ".ai-dev/frontend/references/README.md",
  approvedReferences: ".ai-dev/frontend/references/approved",
  generatedReferences: ".ai-dev/frontend/references/generated",
  referenceFactory: ".ai-dev/frontend/reference-factory",
  referenceFactoryManifests: ".ai-dev/frontend/reference-factory/manifests",
  referenceFactoryPlans: ".ai-dev/frontend/reference-factory/plans"
});

export const FRONTEND_REFERENCE_ROLES = Object.freeze([
  "baseline",
  "candidate",
  "inspiration"
]);

export const PRODUCT_DESIGN_SCORECARD_DIMENSIONS = Object.freeze([
  {
    id: "hierarchy",
    label: "Hierarchy",
    description: "The primary task, reading order, and emphasis are immediately clear."
  },
  {
    id: "composition",
    label: "Composition",
    description: "Layout, alignment, rhythm, balance, and whitespace support the product task."
  },
  {
    id: "typography",
    label: "Typography",
    description: "Type scale, measure, weight, contrast, and wrapping are intentional and readable."
  },
  {
    id: "density",
    label: "Density",
    description: "Information density matches the domain and repeated user workflow."
  },
  {
    id: "action_clarity",
    label: "Action clarity",
    description: "Primary and secondary actions are understandable, prioritized, and state-aware."
  },
  {
    id: "content_quality",
    label: "Content quality",
    description: "Copy is specific, truthful, useful, and grounded in real product data."
  },
  {
    id: "asset_authenticity",
    label: "Asset authenticity",
    description: "Images, icons, charts, and product media are relevant, legible, and non-generic."
  },
  {
    id: "mobile_ux",
    label: "Mobile UX",
    description: "Small-screen layout, navigation, touch targets, input, and content order are complete."
  },
  {
    id: "state_coverage",
    label: "State coverage",
    description: "Loading, empty, error, success, disabled, focus, and relevant edge states are designed."
  },
  {
    id: "brand_coherence",
    label: "Brand coherence",
    description: "Visual language, tone, components, and motion feel like one intentional product."
  }
]);

export const CONCEPT_JURY_DIMENSIONS = Object.freeze([
  {
    id: "brief_alignment",
    label: "Brief alignment",
    description: "The direction solves the declared audience, task, and business goal."
  },
  {
    id: "composition_distinctness",
    label: "Composition distinctness",
    description: "The direction is materially different from the other candidates, not a palette swap."
  },
  {
    id: "hierarchy",
    label: "Hierarchy",
    description: "Reading order and the primary action are immediately clear."
  },
  {
    id: "content_authenticity",
    label: "Content authenticity",
    description: "Copy, data, and assets are grounded in declared product sources."
  },
  {
    id: "implementation_feasibility",
    label: "Implementation feasibility",
    description: "The direction can be implemented within the real stack and delivery constraints."
  },
  {
    id: "responsive_viability",
    label: "Responsive viability",
    description: "The concept remains coherent on every planned viewport."
  },
  {
    id: "brand_coherence",
    label: "Brand coherence",
    description: "The visual language fits the product and can scale across the interface."
  },
  {
    id: "anti_slop",
    label: "Anti-slop",
    description: "The direction avoids generic model defaults and ungrounded decoration."
  }
]);

export const ANTI_SLOP_RULES = Object.freeze([
  {
    id: "card-soup",
    label: "Card soup",
    description: "Do not wrap every section or datum in an interchangeable floating card."
  },
  {
    id: "empty-hero",
    label: "Oversized empty hero",
    description: "Do not spend the first viewport on oversized type and empty space without product evidence."
  },
  {
    id: "purple-gradient",
    label: "Default purple gradient",
    description: "Do not use purple or blue-purple gradients as an unrequested generic visual identity."
  },
  {
    id: "glassmorphism",
    label: "Decorative glassmorphism",
    description: "Do not use blurred translucent panels without a product or interaction reason."
  },
  {
    id: "decorative-orbs",
    label: "Decorative orbs",
    description: "Do not add gradient spheres, glow blobs, or bokeh as filler decoration."
  },
  {
    id: "fabricated-metrics",
    label: "Fabricated metrics",
    description: "Do not invent customers, ratings, growth figures, activity, or testimonials."
  },
  {
    id: "generic-saas-copy",
    label: "Generic SaaS copy",
    description: "Do not use interchangeable claims such as revolutionize, supercharge, or all-in-one."
  },
  {
    id: "excessive-rounding",
    label: "Excessive rounding",
    description: "Do not apply large pill or rounded-card radii to unrelated controls and sections."
  },
  {
    id: "meaningless-motion",
    label: "Meaningless motion",
    description: "Do not animate elements unless motion communicates state, hierarchy, or causality."
  }
]);

export const REQUIRED_PRODUCT_CONTEXT_FIELDS = Object.freeze([
  "product_name",
  "product_type",
  "audience",
  "primary_task",
  "business_goal",
  "tone_of_voice",
  "real_data_source",
  "content_source",
  "accessibility_target"
]);

const REQUIRED_DESIGN_SYSTEM_SECTIONS = Object.freeze([
  "Principles",
  "Typography",
  "Color",
  "Spacing",
  "Grid and Layout",
  "Components",
  "Interaction States",
  "Responsive Behavior",
  "Motion",
  "Content Rules",
  "Accessibility"
]);

const REQUIRED_UI_INVENTORY_SECTIONS = Object.freeze([
  "Screens and Routes",
  "Components",
  "Data and Content",
  "Required States",
  "Responsive Risks"
]);

const REQUIRED_VISUAL_ACCEPTANCE_SECTIONS = Object.freeze([
  "Approved Direction",
  "Reference Mapping",
  "Viewport Matrix",
  "State Matrix",
  "Product Design Scorecard",
  "Anti-Slop Exceptions",
  "Handoff Evidence"
]);

function text(value) {
  return String(value ?? "").trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function frontendDirectionsFingerprint(state) {
  const references = new Map((state?.references ?? []).map((reference) => [
    text(reference.id),
    {
      id: text(reference.id),
      direction_id: text(reference.direction_id),
      value: text(reference.value),
      file_sha256: text(reference.generation?.file_sha256),
      perceptual_hash: text(reference.generation?.perceptual_hash)
    }
  ]));
  const payload = (state?.directions ?? []).map((direction) => ({
    id: text(direction.id),
    name: text(direction.name),
    rationale: text(direction.rationale),
    tradeoffs: list(direction.tradeoffs),
    artifacts: list(direction.artifacts),
    references: list(direction.reference_ids).map((id) => references.get(text(id)) ?? { id: text(id) })
  }));
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

function list(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value))
    .filter(Boolean))];
}

function validMode(mode) {
  const normalized = text(mode).toLowerCase() || "new";
  if (!FRONTEND_PRODUCT_MODES.includes(normalized)) {
    throw new Error(`Unsupported frontend product mode: ${mode}`);
  }
  return normalized;
}

function markdownValue(value) {
  return text(value) || "TBD - complete before direction approval";
}

function markdownList(values, fallback = "TBD - complete before direction approval") {
  const items = list(values);
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

function hasPlaceholder(value) {
  return /(?:\bTBD\b|TODO|complete before|replace with|add real|not yet selected)/i.test(text(value));
}

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text(markdown).match(new RegExp(
    `^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "im"
  ));
  return match ? text(match[1]) : "";
}

function validateMarkdownSections(markdown, sections, documentName) {
  const errors = [];
  for (const heading of sections) {
    const body = sectionBody(markdown, heading);
    if (!body) {
      errors.push(`${documentName}: missing section "${heading}".`);
    } else if (hasPlaceholder(body)) {
      errors.push(`${documentName}: section "${heading}" still contains a placeholder.`);
    }
  }
  return errors;
}

export function selectFrontendProductSkills({ mode = "new" } = {}) {
  const selectedMode = validMode(mode);
  const specialist = {
    new: {
      name: "ui-ux-pro-max",
      source: "external/ui-ux-pro-max",
      role: "visual-direction"
    },
    redesign: {
      name: "redesign-existing-projects",
      source: "design/taste-skill",
      role: "redesign"
    },
    landing: {
      name: "landing-conversion-reviewer",
      source: "custom",
      role: "conversion"
    },
    maintenance: {
      name: "beta-frontend-maintainer",
      source: "custom",
      role: "maintenance"
    }
  }[selectedMode];

  return [
    {
      name: "frontend-product-builder",
      source: "custom",
      role: "orchestrator"
    },
    specialist,
    {
      name: "frontend-quality-gate",
      source: "custom",
      role: "independent-quality"
    }
  ];
}

export function createFrontendProductState({
  projectName,
  mode = "new",
  implementer = "",
  context = {},
  now = new Date().toISOString()
} = {}) {
  const selectedMode = validMode(mode);
  const normalizedContext = {
    product_name: text(context.product_name) || text(projectName),
    product_type: text(context.product_type),
    audience: text(context.audience),
    primary_task: text(context.primary_task),
    business_goal: text(context.business_goal),
    tone_of_voice: text(context.tone_of_voice),
    real_data_source: text(context.real_data_source),
    content_source: text(context.content_source),
    brand_constraints: text(context.brand_constraints),
    accessibility_target: text(context.accessibility_target) || "WCAG 2.2 AA",
    screen_scope: list(context.screen_scope),
    required_states: list(context.required_states),
    forbidden_patterns: list(context.forbidden_patterns)
  };

  return {
    schema_version: FRONTEND_PRODUCT_SCHEMA_VERSION,
    project_name: text(projectName) || normalizedContext.product_name || "Unnamed project",
    mode: selectedMode,
    phase: "brief",
    implementer: text(implementer),
    selected_skills: selectFrontendProductSkills({ mode: selectedMode }),
    context: normalizedContext,
    references: [],
    directions: [],
    concept_jury: null,
    anti_slop_exceptions: [],
    approvals: {
      direction: null,
      design_system: null
    },
    reference_factory: null,
    latest_visual_run: null,
    visual_reviews: [],
    created_at: now,
    updated_at: now
  };
}

export function renderDesignBrief(state) {
  const context = state.context ?? {};
  return `# Frontend Design Brief

Status: draft until a direction is approved.

## Product Context

- Product: ${markdownValue(context.product_name || state.project_name)}
- Product type: ${markdownValue(context.product_type)}
- Audience: ${markdownValue(context.audience)}
- Primary user task: ${markdownValue(context.primary_task)}
- Business goal: ${markdownValue(context.business_goal)}

## Voice and Content

- Tone of voice: ${markdownValue(context.tone_of_voice)}
- Real data source: ${markdownValue(context.real_data_source)}
- Content source: ${markdownValue(context.content_source)}
- Brand constraints: ${markdownValue(context.brand_constraints)}

## Screen Scope

${markdownList(context.screen_scope)}

## Required States

${markdownList(context.required_states)}

## Accessibility Target

${markdownValue(context.accessibility_target)}

## Forbidden Patterns

${markdownList([
    ...ANTI_SLOP_RULES.map((rule) => `${rule.id}: ${rule.label}`),
    ...(context.forbidden_patterns ?? [])
  ])}

## Success Definition

- The primary task is obvious without explanatory UI copy.
- Product claims and metrics are backed by the declared content or data source.
- Desktop and mobile implementations match an approved visual direction.
- Every Product Design Scorecard dimension has direct screenshot evidence.
`;
}

export function renderDesignSystem(state) {
  return `# Project Design System

Approved direction: ${state.approvals?.direction?.direction_id || "TBD - not yet selected"}

## Principles

TBD - complete before design-system approval.

## Typography

TBD - define families, scale, weights, line heights, measures, and wrapping behavior.

## Color

TBD - define semantic tokens, contrast requirements, and light/dark behavior.

## Spacing

TBD - define spacing scale and density rules.

## Grid and Layout

TBD - define containers, columns, alignment, and breakpoint behavior.

## Components

TBD - define shared components, variants, composition rules, and radius policy.

## Interaction States

TBD - define hover, focus, active, disabled, loading, empty, error, and success states.

## Responsive Behavior

TBD - define content priority, reflow, navigation, touch targets, and mobile exceptions.

## Motion

TBD - define allowed purposes, durations, easing, and reduced-motion behavior.

## Content Rules

TBD - define voice, labels, real-data requirements, and prohibited generic copy.

## Accessibility

TBD - define keyboard, focus, contrast, semantics, announcements, and test target.
`;
}

export function renderUiInventory(state) {
  return `# UI Inventory

Project: ${markdownValue(state.project_name)}

## Screens and Routes

TBD - list every in-scope screen or route and its primary user task.

## Components

TBD - list reusable components, variants, ownership, and existing implementation paths.

## Data and Content

TBD - map visible content to real sources, schemas, fixtures, or approved copy.

## Required States

${markdownList(state.context?.required_states, "TBD - list loading, empty, error, success, disabled, and edge states")}

## Responsive Risks

TBD - record dense tables, long text, navigation, forms, media, and touch risks.
`;
}

export function renderVisualAcceptance() {
  return `# Visual Acceptance

## Approved Direction

TBD - record the approved direction ID and approval evidence.

## Reference Mapping

TBD - map each route, viewport, and state to an approved reference.

## Viewport Matrix

TBD - define required desktop and mobile viewport dimensions.

## State Matrix

TBD - define the interaction steps and expected state for every required scenario.

## Product Design Scorecard

${PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => `- ${dimension.id}: ${dimension.description}`).join("\n")}

## Anti-Slop Exceptions

TBD - list approved exceptions by rule ID, rationale, and approver; write "None" when there are no exceptions.

## Handoff Evidence

TBD - list screenshot, baseline, diff, scenario, accessibility, console, and independent-review evidence.
`;
}

export function renderAntiSlopPolicy() {
  return `# Anti-Slop Policy

These rules are blocking by default. An exception requires the rule ID, a product-specific rationale, and an approver in product-quality.json.

${ANTI_SLOP_RULES.map((rule) => `## ${rule.id}: ${rule.label}

${rule.description}
`).join("\n")}
`;
}

export function renderReferencesReadme() {
  return `# Approved Visual References

Store local reference images in this directory. Keep final pixel-comparison baselines in \`approved/\`.

Each reference must also be registered in \`../product-quality.json\` with:

- stable ID;
- label and purpose;
- kind: \`local-image\`, \`figma\`, or \`url\`;
- role: \`candidate\`, \`baseline\`, or \`inspiration\`;
- direction ID when the reference belongs to one generated direction;
- local relative path or URL;
- routes, viewports, and states it governs.

Candidate images compare visual directions. Only baseline images for the approved direction are copied into \`approved/\`.
Do not auto-update approved baselines during verification. A changed baseline is a design decision and requires explicit approval.
`;
}

export function buildFrontendProductFiles(state) {
  return new Map([
    [FRONTEND_PRODUCT_PATHS.designBrief, renderDesignBrief(state)],
    [FRONTEND_PRODUCT_PATHS.designSystem, renderDesignSystem(state)],
    [FRONTEND_PRODUCT_PATHS.uiInventory, renderUiInventory(state)],
    [FRONTEND_PRODUCT_PATHS.visualAcceptance, renderVisualAcceptance(state)],
    [FRONTEND_PRODUCT_PATHS.antiSlopPolicy, renderAntiSlopPolicy(state)],
    [FRONTEND_PRODUCT_PATHS.referencesReadme, renderReferencesReadme(state)]
  ]);
}

export function validateFrontendProductContext(context = {}) {
  const errors = [];
  for (const field of REQUIRED_PRODUCT_CONTEXT_FIELDS) {
    if (!text(context[field]) || hasPlaceholder(context[field])) {
      errors.push(`Product context is missing "${field}".`);
    }
  }
  if (!list(context.screen_scope).length) {
    errors.push("Product context must include at least one screen_scope entry.");
  }
  if (!list(context.required_states).length) {
    errors.push("Product context must include required_states.");
  }
  return errors;
}

export function validateFrontendReferences(references = []) {
  const errors = [];
  const normalized = Array.isArray(references) ? references : [];
  if (!normalized.length) {
    return ["At least one product-specific visual reference is required."];
  }
  const seen = new Set();
  const baselineMappings = new Map();
  for (const reference of normalized) {
    const id = text(reference?.id);
    const role = text(reference?.role) || "baseline";
    const directionId = text(reference?.direction_id);
    if (!id) errors.push("Every reference requires a stable id.");
    if (seen.has(id)) errors.push(`Duplicate reference id: ${id}.`);
    seen.add(id);
    if (!text(reference?.label)) errors.push(`Reference "${id || "unknown"}" requires a label.`);
    if (!["local-image", "figma", "url"].includes(text(reference?.kind))) {
      errors.push(`Reference "${id || "unknown"}" has an unsupported kind.`);
    }
    if (!text(reference?.value)) errors.push(`Reference "${id || "unknown"}" requires a path or URL.`);
    if (!text(reference?.purpose)) errors.push(`Reference "${id || "unknown"}" requires a purpose.`);
    if (!FRONTEND_REFERENCE_ROLES.includes(role)) {
      errors.push(`Reference "${id || "unknown"}" has an unsupported role.`);
    }
    if (role === "candidate" && !directionId) {
      errors.push(`Candidate reference "${id || "unknown"}" requires direction_id.`);
    }
    for (const field of ["routes", "viewports", "states"]) {
      if (!list(reference?.[field]).length) {
        errors.push(`Reference "${id || "unknown"}" requires ${field} mapping.`);
      }
    }

    if (
      role === "baseline" &&
      text(reference?.kind) === "local-image" &&
      /\.png$/i.test(text(reference?.value))
    ) {
      for (const route of list(reference?.routes)) {
        for (const viewport of list(reference?.viewports)) {
          for (const state of list(reference?.states)) {
            const mapping = `${route}\u0000${viewport}\u0000${state}`;
            const previous = baselineMappings.get(mapping);
            if (previous && previous !== id) {
              errors.push(
                `References "${previous}" and "${id || "unknown"}" map to the same baseline: ${route} / ${viewport} / ${state}.`
              );
            } else {
              baselineMappings.set(mapping, id);
            }
          }
        }
      }
    }
  }
  return errors;
}

export function validateFrontendDirections(directions = [], references = []) {
  const errors = [];
  const normalized = Array.isArray(directions) ? directions : [];
  const referenceById = new Map(
    (Array.isArray(references) ? references : [])
      .map((reference) => [text(reference?.id), reference])
      .filter(([id]) => Boolean(id))
  );
  const knownReferenceIds = new Set(referenceById.keys());
  if (normalized.length < 2 || normalized.length > 3) {
    errors.push("Exactly two or three visual directions are required.");
  }
  const seen = new Set();
  for (const direction of normalized) {
    const id = text(direction?.id);
    if (!id) errors.push("Every visual direction requires a stable id.");
    if (seen.has(id)) errors.push(`Duplicate direction id: ${id}.`);
    seen.add(id);
    if (!text(direction?.name)) errors.push(`Direction "${id || "unknown"}" requires a name.`);
    if (!text(direction?.rationale) || hasPlaceholder(direction?.rationale)) {
      errors.push(`Direction "${id || "unknown"}" requires a product-specific rationale.`);
    }
    if (!list(direction?.reference_ids).length) {
      errors.push(`Direction "${id || "unknown"}" must cite reference_ids.`);
    }
    for (const referenceId of list(direction?.reference_ids)) {
      if (knownReferenceIds.size && !knownReferenceIds.has(referenceId)) {
        errors.push(`Direction "${id || "unknown"}" cites unknown reference_id "${referenceId}".`);
        continue;
      }
      const reference = referenceById.get(referenceId);
      if (
        text(reference?.role) === "candidate" &&
        text(reference?.direction_id) !== id
      ) {
        errors.push(
          `Direction "${id || "unknown"}" cites candidate reference "${referenceId}" owned by another direction.`
        );
      }
    }
    if (!list(direction?.artifacts).length) {
      errors.push(`Direction "${id || "unknown"}" must include Figma or image artifacts.`);
    }
  }
  return errors;
}

export function validateFrontendDocuments({
  designSystem = "",
  uiInventory = "",
  visualAcceptance = ""
} = {}) {
  return [
    ...validateMarkdownSections(designSystem, REQUIRED_DESIGN_SYSTEM_SECTIONS, "design-system.md"),
    ...validateMarkdownSections(uiInventory, REQUIRED_UI_INVENTORY_SECTIONS, "ui-inventory.md"),
    ...validateMarkdownSections(visualAcceptance, REQUIRED_VISUAL_ACCEPTANCE_SECTIONS, "visual-acceptance.md")
  ];
}

export function validateAntiSlopExceptions(exceptions = []) {
  const knownRules = new Set(ANTI_SLOP_RULES.map((rule) => rule.id));
  const errors = [];
  for (const exception of Array.isArray(exceptions) ? exceptions : []) {
    const ruleId = text(exception?.rule_id);
    if (!knownRules.has(ruleId)) errors.push(`Unknown anti-slop rule: ${ruleId || "missing"}.`);
    if (text(exception?.rationale).length < 20) {
      errors.push(`Anti-slop exception "${ruleId || "unknown"}" needs a product-specific rationale.`);
    }
    if (!text(exception?.approver)) {
      errors.push(`Anti-slop exception "${ruleId || "unknown"}" needs an approver.`);
    }
  }
  return errors;
}

export function validateProductDesignScorecard(scorecard) {
  if (!scorecard || typeof scorecard !== "object" || Array.isArray(scorecard)) {
    return ["Product Design Scorecard must be an object keyed by dimension."];
  }
  if ("overall_score" in scorecard || "overall" in scorecard) {
    return ["Product Design Scorecard must not contain an overall score."];
  }

  const expected = new Set(PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => dimension.id));
  const supplied = Object.keys(scorecard);
  const errors = [];
  for (const key of supplied) {
    if (!expected.has(key)) errors.push(`Unknown scorecard dimension: ${key}.`);
  }
  for (const dimension of PRODUCT_DESIGN_SCORECARD_DIMENSIONS) {
    const result = scorecard[dimension.id];
    if (!result || typeof result !== "object") {
      errors.push(`Scorecard is missing "${dimension.id}".`);
      continue;
    }
    if (!["pass", "fail"].includes(text(result.status))) {
      errors.push(`Scorecard "${dimension.id}" status must be pass or fail.`);
    }
    const score = Number(result.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      errors.push(`Scorecard "${dimension.id}" score must be an integer from 1 to 5.`);
    }
    if (text(result.evidence).length < 10) {
      errors.push(`Scorecard "${dimension.id}" needs concrete evidence.`);
    }
    if (!Array.isArray(result.findings)) {
      errors.push(`Scorecard "${dimension.id}" findings must be an array.`);
    }
    if (text(result.status) === "pass" && score < 4) {
      errors.push(`Scorecard "${dimension.id}" cannot pass below 4/5.`);
    }
  }
  return errors;
}

export function recordConceptJuryState(state, {
  reviewer,
  independentFromImplementer = false,
  comparison = "",
  directionReviews = [],
  now = new Date().toISOString()
} = {}) {
  const errors = [
    ...validateFrontendProductContext(state?.context),
    ...validateFrontendReferences(state?.references),
    ...validateFrontendDirections(state?.directions, state?.references)
  ];
  const reviewerName = text(reviewer);
  if (!reviewerName) errors.push("Concept Jury requires a named reviewer.");
  if (!independentFromImplementer) {
    errors.push("Concept Jury reviewer must explicitly confirm independence from the implementer.");
  }
  if (reviewerName && text(state?.implementer) && reviewerName === text(state.implementer)) {
    errors.push("Concept Jury reviewer cannot be the recorded implementer.");
  }
  if (text(comparison).length < 30) {
    errors.push("Concept Jury requires a concrete cross-direction comparison.");
  }

  const knownDirections = new Set((state?.directions ?? []).map((direction) => text(direction.id)));
  const reviews = Array.isArray(directionReviews) ? directionReviews : [];
  const reviewByDirection = new Map();
  for (const review of reviews) {
    const directionId = text(review?.direction_id);
    if (!knownDirections.has(directionId)) {
      errors.push(`Concept Jury review cites unknown direction "${directionId || "missing"}".`);
      continue;
    }
    if (reviewByDirection.has(directionId)) {
      errors.push(`Concept Jury contains duplicate review for "${directionId}".`);
      continue;
    }
    reviewByDirection.set(directionId, review);
    if (!["recommend", "reserve", "reject"].includes(text(review?.decision))) {
      errors.push(`Concept Jury decision for "${directionId}" must be recommend, reserve, or reject.`);
    }
    if (!Array.isArray(review?.strengths) || !review.strengths.length) {
      errors.push(`Concept Jury review for "${directionId}" needs at least one strength.`);
    }
    if (!Array.isArray(review?.risks)) {
      errors.push(`Concept Jury review for "${directionId}" risks must be an array.`);
    }
    const scorecard = review?.dimensions;
    if (!scorecard || typeof scorecard !== "object" || Array.isArray(scorecard)) {
      errors.push(`Concept Jury review for "${directionId}" needs a dimension scorecard.`);
      continue;
    }
    for (const dimension of CONCEPT_JURY_DIMENSIONS) {
      const result = scorecard[dimension.id];
      if (!result || typeof result !== "object") {
        errors.push(`Concept Jury "${directionId}" is missing "${dimension.id}".`);
        continue;
      }
      if (!["pass", "fail"].includes(text(result.status))) {
        errors.push(`Concept Jury "${directionId}/${dimension.id}" status must be pass or fail.`);
      }
      const score = Number(result.score);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        errors.push(`Concept Jury "${directionId}/${dimension.id}" score must be an integer from 1 to 5.`);
      }
      if (text(result.evidence).length < 15) {
        errors.push(`Concept Jury "${directionId}/${dimension.id}" needs concrete evidence.`);
      }
      if (text(result.status) === "pass" && score < 4) {
        errors.push(`Concept Jury "${directionId}/${dimension.id}" cannot pass below 4/5.`);
      }
    }
  }
  for (const directionId of knownDirections) {
    if (!reviewByDirection.has(directionId)) {
      errors.push(`Concept Jury is missing direction "${directionId}".`);
    }
  }
  const recommended = reviews.filter((review) => text(review?.decision) === "recommend");
  if (recommended.length !== 1) {
    errors.push("Concept Jury must recommend exactly one direction.");
  } else {
    const directionId = text(recommended[0].direction_id);
    for (const dimension of CONCEPT_JURY_DIMENSIONS) {
      if (text(recommended[0]?.dimensions?.[dimension.id]?.status) !== "pass") {
        errors.push(`Recommended direction "${directionId}" must pass "${dimension.id}".`);
      }
    }
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)], state };

  return {
    ok: true,
    errors: [],
    state: {
      ...state,
      concept_jury: {
        reviewer: reviewerName,
        independent_from_implementer: true,
        comparison: text(comparison),
        recommended_direction_id: text(recommended[0].direction_id),
        direction_reviews: reviews,
        directions_fingerprint: frontendDirectionsFingerprint(state),
        reviewed_at: now
      },
      updated_at: now
    }
  };
}

export function approveDirectionState(state, {
  directionId,
  approver,
  evidence = "",
  now = new Date().toISOString()
} = {}) {
  const errors = [
    ...validateFrontendProductContext(state.context),
    ...validateFrontendReferences(state.references),
    ...validateFrontendDirections(state.directions, state.references),
    ...validateAntiSlopExceptions(state.anti_slop_exceptions)
  ];
  const selected = (state.directions ?? []).find((direction) => direction.id === directionId);
  if (!selected) errors.push(`Direction not found: ${directionId || "missing"}.`);
  if (!text(approver)) errors.push("Direction approval requires an approver.");
  if (text(evidence).length < 10) errors.push("Direction approval requires concrete evidence.");
  if (state?.reference_factory?.concepts?.status === "registered") {
    if (!state.concept_jury) {
      errors.push("Reference Factory directions require an independent Concept Jury review before approval.");
    } else {
      if (state.concept_jury.directions_fingerprint !== frontendDirectionsFingerprint(state)) {
        errors.push("Concept Jury review is stale because directions or visual artifacts changed.");
      }
      if (state.concept_jury.recommended_direction_id !== directionId) {
        errors.push(
          `Direction "${directionId || "missing"}" is not the Concept Jury recommendation ` +
          `"${state.concept_jury.recommended_direction_id || "missing"}".`
        );
      }
    }
  }
  if (errors.length) return { ok: false, errors, state };

  return {
    ok: true,
    errors: [],
    state: {
      ...state,
      phase: "direction-approved",
      approvals: {
        ...(state.approvals ?? {}),
        direction: {
          direction_id: directionId,
          approver: text(approver),
          evidence: text(evidence),
          approved_at: now
        },
        design_system: null
      },
      updated_at: now
    }
  };
}

export function approveDesignSystemState(state, {
  approver,
  evidence = "",
  documentHashes = {},
  baseline = {},
  dirtyFiles = [],
  documents = {},
  now = new Date().toISOString()
} = {}) {
  const appDirtyFiles = list(dirtyFiles)
    .map((value) => value.replaceAll("\\", "/"))
    .filter((value) => !value.startsWith(`${FRONTEND_PRODUCT_PATHS.root}/`));
  const errors = [
    ...(state.approvals?.direction ? [] : ["Approve one visual direction before the design system."]),
    ...validateFrontendDocuments(documents),
    ...validateAntiSlopExceptions(state.anti_slop_exceptions)
  ];
  if (appDirtyFiles.length) {
    errors.push(`Design-first gate found application changes before approval: ${appDirtyFiles.join(", ")}.`);
  }
  if (!text(approver)) errors.push("Design-system approval requires an approver.");
  if (text(evidence).length < 10) errors.push("Design-system approval requires concrete evidence.");
  for (const key of ["design_brief", "design_system", "ui_inventory", "visual_acceptance"]) {
    if (!text(documentHashes[key])) errors.push(`Missing approved document hash: ${key}.`);
  }
  if (errors.length) return { ok: false, errors, state };

  return {
    ok: true,
    errors: [],
    state: {
      ...state,
      phase: "ready-for-implementation",
      approvals: {
        ...(state.approvals ?? {}),
        design_system: {
          approver: text(approver),
          evidence: text(evidence),
          document_hashes: { ...documentHashes },
          baseline: { ...baseline },
          approved_at: now
        }
      },
      updated_at: now
    }
  };
}

function changedApprovedDocuments(state, currentDocumentHashes) {
  const approved = state.approvals?.design_system?.document_hashes ?? {};
  const changed = [];
  for (const [key, expected] of Object.entries(approved)) {
    if (!text(currentDocumentHashes?.[key]) || currentDocumentHashes[key] !== expected) {
      changed.push(key);
    }
  }
  return changed;
}

export function evaluateFrontendProductGate(state, {
  gate = "implementation",
  currentDocumentHashes = {},
  reviewArtifactsCurrent = null
} = {}) {
  const selectedGate = text(gate) || "implementation";
  if (!["implementation", "handoff"].includes(selectedGate)) {
    throw new Error(`Unsupported frontend product gate: ${gate}`);
  }
  const blockers = [];
  const warnings = [];

  if (state?.schema_version !== FRONTEND_PRODUCT_SCHEMA_VERSION) {
    blockers.push(`Expected frontend product schema ${FRONTEND_PRODUCT_SCHEMA_VERSION}.`);
  }
  const selectedSkillNames = (state?.selected_skills ?? []).map((skill) => text(skill?.name));
  if (selectedSkillNames.length !== 3 || new Set(selectedSkillNames).size !== 3) {
    blockers.push("Frontend Product Builder must select exactly three distinct skills.");
  }
  for (const requiredSkill of ["frontend-product-builder", "frontend-quality-gate"]) {
    if (!selectedSkillNames.includes(requiredSkill)) {
      blockers.push(`Frontend Product Builder selection is missing "${requiredSkill}".`);
    }
  }
  if (!state?.approvals?.direction) blockers.push("No approved visual direction.");
  if (!state?.approvals?.design_system) blockers.push("No approved project design system.");

  const changed = changedApprovedDocuments(state ?? {}, currentDocumentHashes);
  if (state?.approvals?.design_system && changed.length) {
    blockers.push(`Approved frontend documents changed and require re-approval: ${changed.join(", ")}.`);
  }

  if (selectedGate === "handoff") {
    const run = state?.latest_visual_run;
    if (!run) {
      blockers.push("No strict Visual Reference QA run is recorded.");
    } else {
      if (run.status !== "passed") blockers.push(`Visual Reference QA status is ${run.status || "unknown"}.`);
      if (!run.strict) blockers.push("Latest frontend QA run was not strict.");
      if (!run.desktop_and_mobile) blockers.push("Latest frontend QA does not cover desktop and mobile.");
      if (!run.required_states_covered) blockers.push("Latest frontend QA does not cover every required state.");
      if (!run.baselines_complete) blockers.push("Approved visual baselines are incomplete.");
      if (Number(run.unwaived_anti_slop_findings || 0) > 0) {
        blockers.push("Latest frontend QA has unwaived anti-slop findings.");
      }
    }

    const review = (state?.visual_reviews ?? []).at(-1);
    if (!review) {
      blockers.push("No independent visual review is recorded.");
    } else {
      if (review.run_id !== run?.run_id) blockers.push("Latest visual review does not match the latest QA run.");
      if (!review.independent) blockers.push("Visual review was not independent from implementation.");
      if (!review.artifact_hashes_current || reviewArtifactsCurrent === false) {
        blockers.push("Reviewed screenshot or diff hashes are stale.");
      }
      blockers.push(...validateProductDesignScorecard(review.scorecard));
      const failingDimensions = PRODUCT_DESIGN_SCORECARD_DIMENSIONS
        .filter((dimension) => review.scorecard?.[dimension.id]?.status !== "pass")
        .map((dimension) => dimension.id);
      if (failingDimensions.length) {
        blockers.push(`Product Design Scorecard failed: ${failingDimensions.join(", ")}.`);
      }
    }
  }

  return {
    ok: blockers.length === 0,
    gate: selectedGate,
    phase: state?.phase ?? "missing",
    blockers,
    warnings
  };
}
