---
name: frontend-product-builder
description: "Orchestrate design-first frontend product work and prevent generic AI-generated UI. Use for new interfaces, landing pages, substantial redesigns, visual direction changes, or frontend delivery that requires a product brief, approved references, a project design system, screenshot comparison, anti-slop checks, and independent visual review."
---

# Frontend Product Builder

## Contract

Use this skill as the only frontend product orchestrator. Select no more than three skills total:

1. `frontend-product-builder`;
2. one mode specialist chosen by `frontend_product_builder`;
3. `frontend-quality-gate`.

Do not load extra design skills because they look relevant. Resolve conflicts through the approved project direction and design system, not by averaging styles.

The workflow is a blocking state machine:

```text
Product context
-> Design Brief
-> References
-> Two or three directions
-> Direction approval
-> Design System approval
-> Implementation
-> Screenshot and visual diff
-> Independent visual review
-> Technical QA
-> Handoff
```

## Start

1. Call MCP `frontend_product_builder` with the project path, task, and mode when known.
2. Read only the returned skills.
3. Call `prepare_frontend_product` when the project is not prepared.
4. Complete these files before implementation:
   - `.ai-dev/frontend/design-brief.md`
   - `.ai-dev/frontend/design-system.md`
   - `.ai-dev/frontend/ui-inventory.md`
   - `.ai-dev/frontend/visual-acceptance.md`
   - `.ai-dev/frontend/anti-slop-policy.md`
   - `.ai-dev/frontend/references/`
5. Treat `.ai-dev/frontend/product-quality.json` as machine state. Change it through MCP tools, not by hand.

## Product Context

Use `update_frontend_product_brief` to record:

- product and screen type;
- specific audience;
- primary user task;
- business goal;
- tone of voice;
- real data and content sources;
- brand constraints;
- screen scope;
- required loading, empty, error, success, disabled, focus, and edge states;
- product-specific forbidden patterns;
- local image, Figma, or URL references.

Do not invent copy, metrics, testimonials, customers, product screenshots, or data. Mark unknown context as a blocker.

## Reference Factory

When no approved external reference exists, do not improvise UI code. Use the generated-reference workflow:

```text
plan_frontend_references stage=concepts
-> call ImageGen or Figma for every manifest job
-> inspect every PNG
-> register_frontend_references
-> compare and approve one direction
-> plan_frontend_references stage=coverage
-> generate and inspect only the approved direction
-> register_frontend_references
```

The MCP server is the planner and validator. It does not call ImageGen or Figma and must never claim
that a visual artifact was generated when the client did not call the corresponding tool.

Follow the manifest exactly:

- use the returned surface-specific generation skill;
- preserve `prompt_sha256`;
- save every PNG at its exact `output_path`;
- generate distinct composition systems, not palette variants;
- inspect each artifact with `view_image`, a browser, or Figma;
- reject illegible text, fabricated proof, duplicate output, generic composition, and off-brief assets;
- register concrete per-image observations.

Concept references use the `candidate` role and may overlap route, viewport, and state mappings across
different directions. After direction approval, Reference Factory creates `baseline` coverage only for
that direction. Design-system approval must remain blocked until the baseline coverage is registered.

## Visual Directions

Create two or three genuinely distinct directions in Figma or separate images. Each direction must include:

- stable ID and name;
- product-specific rationale;
- cited reference IDs;
- inspectable artifact paths or URLs;
- meaningful tradeoffs.

Do not make palette-only variants of one composition. Use `record_frontend_directions`, then `approve_frontend_direction` for exactly one direction.

## Design System

Complete the project design system from the approved direction. Define:

- principles;
- typography and text measure;
- semantic color;
- spacing and density;
- grid and layout;
- reusable components and variants;
- interaction states;
- responsive behavior;
- purposeful motion and reduced motion;
- content rules;
- accessibility.

Map every screen, route, component, data source, state, viewport, and visual reference in the UI inventory and visual acceptance files.

Call `approve_frontend_design_system` before application code changes. It must reject:

- missing sections or placeholders;
- no approved direction;
- application files or Git HEAD changed after the preparation baseline;
- unsafe or missing references;
- unapproved anti-slop exceptions.

Call `frontend_product_gate` with `gate=implementation`. Stop when it blocks.

## Implementation

Implement only the approved direction:

- reuse project components and tokens where compatible;
- use real content and assets;
- preserve domain-appropriate density;
- implement all required states;
- make mobile a complete workflow, not a compressed desktop page;
- keep interactions and motion purposeful;
- avoid unrelated refactors.

When the design files need to change, update and reapprove them before continuing.

## Visual Reference QA

Call `run_visual_reference_qa`, not ordinary screenshot QA, before handoff. Supply deterministic scenarios with stable `state` names.

The strict run must:

- cover desktop and mobile;
- capture default and every required state;
- compare every capture with immutable approved PNG baselines;
- record pixel diffs;
- block console, network, overflow, serious accessibility, scenario, and visual failures;
- block unwaived anti-slop findings;
- return `awaiting_review`, never final success, until artifacts are inspected.

Never set `update_visual_baselines=true` during QA. Baselines are design approvals, not test output.

## Independent Review

The reviewer must differ from the implementer. Inspect every screenshot, baseline, and diff with a browser, image viewer, or human review and record concrete observations. The handoff gate rehashes every reviewed artifact and blocks evidence changed after review.

Use `record_visual_review` with all ten dimensions:

- hierarchy;
- composition;
- typography;
- density;
- action clarity;
- content quality;
- asset authenticity;
- mobile UX;
- state coverage;
- brand coherence.

Give each dimension its own status, 1-5 score, evidence, and findings. Do not submit an overall score. A passing dimension needs at least 4/5 and direct evidence.

After review, call `frontend_product_gate` with `gate=handoff`, then run the repository quality gate.

## Anti-Slop Rules

Block these patterns unless a named approver accepts a product-specific rationale:

- card soup;
- oversized empty hero;
- generic purple or blue-purple gradient;
- decorative glassmorphism;
- decorative orbs, blobs, bokeh, or glow;
- fabricated metrics or proof;
- generic SaaS copy;
- excessive rounding;
- meaningless motion.

Automated heuristics are evidence, not the final design judgment. The independent scorecard remains mandatory.

## Completion Evidence

Report:

- approved direction and approver;
- selected three-skill set;
- design document hashes;
- routes, viewports, and states captured;
- screenshot, baseline, and diff paths;
- anti-slop findings and explicit exceptions;
- ten separate scorecard results;
- technical and handoff gate status;
- unavailable checks and residual risk.
