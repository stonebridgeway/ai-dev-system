---
name: ui-ux-pro-max
description: Use when an agent needs evidence-based UI/UX direction for a web or mobile product, including a coherent design-system recommendation, product-specific patterns, colors, typography, accessibility guidance, charts, motion, icons, or stack-specific implementation rules.
---

# UI UX Pro Max

This is the AI Dev System adapter for the curated core of
`nextlevelbuilder/ui-ux-pro-max-skill`. It exposes the upstream local dataset through bounded MCP
tools. The generated output is design intelligence, not visual approval.

## Trigger

Use this skill when:

- a new page or product needs an initial design direction;
- an existing frontend needs a more coherent visual system;
- a team needs targeted guidance for accessibility, typography, color, charts, motion, icons, or a
  supported frontend stack;
- an agent needs product- and industry-specific evidence before implementing UI.

Skip this skill for backend-only, infrastructure-only, or non-visual work.

## Required Workflow

1. Inspect the existing product, repository conventions, design tokens, and real reference material.
2. For a new visual direction, call `generate_ui_ux_design_system` with a concrete product,
   audience, industry, mood, and usage context.
3. Call `query_ui_ux_knowledge` only for focused follow-up questions. Select one domain or one stack,
   not both.
4. Choose one coherent direction. Reconcile recommendations with the existing brand and product
   constraints before editing code.
5. If durable project memory is useful, persist the approved draft to
   `.ai-dev/frontend/design-system.md` through the MCP tool.
6. Implement with the repository's components, tokens, and architecture.
7. Run the app and complete browser-based desktop and mobile QA. Inspect screenshots yourself.

## Query Inputs

A useful design-system query contains:

- product type and industry;
- primary audience and work context;
- core user task;
- desired tone;
- density and motion expectations;
- constraints such as accessibility, enterprise trust, conversion, or data volume.

Example:

```text
B2B fraud analytics dashboard for compliance teams, precise and trustworthy,
dense but scannable, keyboard accessible, restrained motion
```

Use the optional dials from 1 to 10:

- `variance`: visual asymmetry and distinctiveness;
- `motion`: animation intensity;
- `density`: information density and spacing.

## Focused Domains

`query_ui_ux_knowledge` supports:

- `style`
- `color`
- `chart`
- `landing`
- `product`
- `ux`
- `typography`
- `google-fonts`
- `icons`
- `gsap`
- `react`
- `web`

It also supports one stack filter such as `react`, `nextjs`, `vue`, `svelte`, `astro`, `nuxtjs`,
`angular`, `laravel`, `swiftui`, `react-native`, `flutter`, `jetpack-compose`, `html-tailwind`,
`shadcn`, or `threejs`. Use the MCP schema as the canonical list.

## Guardrails

- Treat results as candidates grounded in a curated dataset, not as requirements or proof.
- Existing product behavior, approved brand assets, user research, and repository conventions remain
  authoritative.
- Do not mix unrelated styles, palettes, or typography systems.
- Do not copy a generated palette without checking contrast in the actual UI states.
- Do not add GSAP, fonts, icon libraries, or any dependency solely because a recommendation mentions
  it.
- Do not let generated examples override security, privacy, performance, or accessibility needs.
- Do not call the upstream persistence flag directly. Use the MCP persistence path, which is bounded
  to the selected project.
- Never claim frontend quality from a text recommendation alone.

## Verification

After implementation:

1. Run the repository quality gate.
2. Run `run_frontend_qa` for representative desktop and mobile routes when the app can run.
3. Inspect screenshots for hierarchy, overflow, clipping, typography, responsive behavior, and
   visual consistency.
4. Check keyboard access, focus visibility, contrast, reduced motion, loading, empty, error, and
   success states affected by the change.
5. Compare the result with the approved direction and real references, then revise visible defects.

## Output

Report:

- the chosen direction and why it fits the product;
- recommendations accepted, changed, or rejected;
- persisted design-system path, if any;
- implementation and browser evidence;
- unresolved product or device-specific risk.

## Provenance

The pinned source, version, license, included files, and exclusions are documented in
`UPSTREAM.md` and `upstream.json`. `UPSTREAM-SKILL.md` is retained only as the unmodified upstream
reference.
