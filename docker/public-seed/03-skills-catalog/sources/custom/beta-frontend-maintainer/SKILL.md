---
name: beta-frontend-maintainer
description: "Use when Codex maintains an existing beta or production-like frontend, especially support tasks, UI fixes, responsive bugs, API-bound screens, small feature tweaks, and rare backend-adjacent changes where minimal safe diffs matter."
---

# Beta Frontend Maintainer

## Overview

Maintain already-built frontends without turning a support task into a redesign. The goal is to understand the existing product quickly, make the smallest correct change, and verify the user-facing behavior in the browser when possible.

Use this skill for beta/staging apps, admin panels, dashboards, landing sections inside existing products, frontend bug tickets, UI polish tickets, responsive layout defects, and small screens that depend on API data. If the user asks for a full visual upgrade, pair this with `redesign-existing-projects`, `design-taste-frontend`, or `frontend-quality-gate` as needed.

## Start Protocol

1. Read local guidance first: `AGENTS.md`, `.ai-dev/project-brief.md`, `.ai-dev/project-map.md`, and `.ai-dev/quality-gate.md` when present.
2. Identify the real repo root and check current changes before editing.
3. Classify the task:
   - visual-only layout, spacing, color, typography, responsive behavior;
   - interaction behavior, state transitions, forms, navigation;
   - API-bound UI, data mapping, loading or error behavior;
   - copy/content update;
   - regression or browser-specific defect;
   - backend-adjacent change required by a frontend task.
4. Locate existing patterns before inventing anything: route structure, component library, layout primitives, design tokens, form helpers, API hooks, state management, tests, and story/demo fixtures.
5. Define the smallest change that solves the ticket and preserves the surrounding product.
6. Do not generate a replacement design system for a normal support ticket. Use
   `query_ui_ux_knowledge` for a narrow uncertainty, or `generate_ui_ux_design_system` only when the
   task explicitly introduces a new screen family or approved redesign direction.

## Implementation Rules

- Reuse existing components, tokens, icons, hooks, validators, API clients, and layout patterns.
- Prefer local, narrow changes over global CSS, theme, routing, or shared component edits.
- Keep public behavior stable unless the task explicitly changes it.
- Do not introduce a dependency unless the project already uses that family of tooling or the benefit is obvious and small.
- Do not change backend contracts, migrations, auth, payments, analytics, or data models unless the frontend task truly requires it.
- Preserve accessibility while changing visuals: keyboard access, visible focus, labels, error text, and readable contrast.
- Treat beta users as real users: no placeholder flows, no broken empty states, no hidden console errors.

## Required UI States

Check the states that can appear on the touched surface:

- loading, skeleton, optimistic, and refetching states;
- empty state and zero-result state;
- error, validation, unauthorized, and offline-ish states;
- disabled, hover, focus, active, selected, and pressed states;
- long text, translated text, narrow mobile width, wide desktop width;
- slow API response and missing optional fields;
- success confirmation, toast, redirect, or post-submit state.

## Backend-Adjacent Protocol

If a frontend task touches data contracts:

1. Find the source of truth for request and response shapes.
2. Check generated types, schemas, DTOs, API clients, mocks, and tests.
3. Keep compatibility with existing fields when possible.
4. Update frontend handling for missing or nullable fields.
5. Run the lightest backend or contract check that proves the change.
6. Clearly report any API assumptions that were not verified.

## Verification

Run the relevant project gate from `.ai-dev/quality-gate.md` or package scripts. Typical checks:

- lint or format check;
- typecheck;
- unit or component tests for changed behavior;
- build;
- browser verification for the touched screen on desktop and mobile.

When a browser is available, inspect the actual page after the change. Look for layout overlap, clipped text, broken scroll, console errors, focus traps, missing states, and mobile regressions.

## Output

End with:

1. What changed and why.
2. Files changed.
3. Checks run and results.
4. Browser/device states verified, if any.
5. Risks, assumptions, or follow-up work.

## Guardrails

- Do not perform broad redesigns unless asked.
- Do not normalize unrelated files or run repo-wide formatting unless the project expects it.
- Do not remove tests or weaken validation to make checks pass.
- Do not claim browser verification, accessibility verification, or performance verification unless it was actually done.
- Do not expose or copy secrets from `.env`, logs, browser storage, screenshots, or network traces.
- Existing product UI and approved brand rules override generated style recommendations.
