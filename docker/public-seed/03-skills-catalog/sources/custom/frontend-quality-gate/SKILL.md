---
name: frontend-quality-gate
description: "Use when Codex must verify frontend or UI changes before handoff, release, pull request, review, or beta testing, including responsive QA, accessibility checks, performance risks, visual regressions, forms, and browser behavior."
---

# Frontend Quality Gate

## Overview

Use this skill as the final gate for UI work. It turns "looks okay" into evidence: static checks, browser checks, accessibility, responsive behavior, performance risk, and honest reporting of what was not verified.

Use it before finishing frontend tasks, after redesign/polish work, during PR review, before beta handoff, and whenever a UI bug could affect real users.

When `.ai-dev/frontend/product-quality.json` exists, this skill is the verification role inside `frontend-product-builder`. Use MCP `run_visual_reference_qa`, inspect every returned screenshot/baseline/diff, record an independent ten-dimension review with `record_visual_review`, and require `frontend_product_gate` with `gate=handoff`. Ordinary `run_frontend_qa` is technical evidence only and cannot complete the product-design gate.

## Gate Levels

- `pass`: required checks ran and no blocking issue remains.
- `warn`: the change is probably acceptable, but one or more non-critical checks were skipped or produced limited risk.
- `block`: a user-facing defect, broken build, missing critical state, accessibility failure, or unsafe uncertainty remains.

Never mark `pass` if the app did not build when a build is expected, the touched screen could not be inspected, or critical states were not considered.
Do not treat a generated design system, static recommendation, or uninspected screenshot as evidence
that the rendered product passes this gate.
Do not replace hierarchy, composition, typography, density, action clarity, content quality, asset authenticity, mobile UX, state coverage, and brand coherence with one overall score.

## Workflow

1. Read project guidance: `AGENTS.md`, `.ai-dev/quality-gate.md`, relevant README, package scripts, and CI config.
2. Identify touched surfaces: routes, components, forms, data flows, breakpoints, and user roles.
3. Confirm expected behavior from the user request, issue, tests, screenshots, or existing UI.
4. Run the relevant static checks.
5. Run or inspect the app in the browser when possible.
6. Verify desktop and mobile layouts.
7. Check accessibility and keyboard behavior.
8. Check performance-sensitive areas.
9. Report gate status with evidence and skipped checks.

## Static Checks

Prefer project-defined commands. Common checks:

- lint and formatting check;
- typecheck;
- unit, component, or integration tests for changed behavior;
- production build;
- route generation, API type generation, or GraphQL/codegen when relevant;
- storybook, visual test, or screenshot test when the project uses it.

Do not invent commands when the repo gives exact scripts. Do not weaken or delete checks to make the gate pass.

## Browser Checks

Inspect the actual changed screen when a runnable app is available:

- desktop viewport and mobile viewport;
- primary happy path;
- loading, empty, error, validation, disabled, hover, focus, and success states;
- navigation, back/forward behavior, modal/dialog closing, scroll locking, and route changes;
- console errors and failed network requests that relate to the change;
- text overflow, clipped controls, layout overlap, unexpected horizontal scroll, sticky header/footer collisions.

Use screenshots when the visual result matters or when reporting a defect.

## Accessibility Checks

Aim for WCAG 2.2 AA-oriented behavior unless the project has stricter rules:

- all interactive elements are keyboard reachable and operable;
- focus indicator is visible and not obscured;
- labels, names, descriptions, and error text are programmatically clear;
- controls have adequate target size or spacing;
- color is not the only carrier of meaning;
- contrast is readable for normal text, large text, icons, and UI controls;
- drag interactions have a non-drag alternative when practical;
- forms avoid forcing users to re-enter the same information unnecessarily;
- authentication or verification flows do not depend only on cognitive puzzles.

If automated accessibility tooling exists, run it. Automated tools are helpful evidence, not a substitute for keyboard and state inspection.

## Performance Checks

Use project tooling when available. Otherwise check for obvious regressions:

- avoid new layout shifts, especially from images, fonts, banners, and async content;
- size images and media correctly, use lazy loading where appropriate, and avoid huge above-the-fold assets;
- keep animations on `transform` and `opacity` when possible;
- avoid animation of layout or paint-heavy properties such as width, height, top, left, margin, box-shadow, filter, and large blur;
- avoid unnecessary re-render loops, expensive effects, and uncontrolled timers;
- keep Core Web Vitals targets in mind: LCP at or under 2.5s, INP at or under 200ms, CLS at or under 0.1 for good user experience.

Do not claim Web Vitals were measured unless a measurement tool was actually used.

## Forms And Data

For forms and API-bound screens:

- required, optional, nullable, and server-derived fields are handled;
- client validation and server validation both show useful errors;
- input is not lost after validation errors;
- submit buttons prevent duplicate submissions when needed;
- success, partial success, permission denied, empty response, and slow response states behave well;
- sensitive data is not exposed in UI, logs, analytics, or screenshots.

## Output Format

Use this concise structure:

```text
Gate: pass | warn | block

Checked:
- ...

Findings:
- [blocker/warn/info] ...

Skipped or not available:
- ...

Evidence:
- commands, screenshots, browser viewports, test counts
```

## Guardrails

- Be honest about skipped checks.
- Do not hide broken UI behind "minor visual issue" if it blocks a user task.
- Do not run real payments, production mutations, mass emails, or destructive admin actions for QA.
- Do not leak secrets from env files, browser storage, logs, or screenshots.
