---
name: frontend-polisher
description: Use when Codex needs to improve, redesign, or verify a frontend UI, including layout, responsive behavior, visual hierarchy, accessibility, design-system consistency, and browser-based QA.
---

# Frontend Polisher

## Workflow

1. Inspect existing UI patterns and design system.
2. Identify the primary user workflow.
3. If the task introduces a new visual direction or substantial redesign, call
   `generate_ui_ux_design_system` with the product, audience, industry, tone, and constraints. Skip
   this for narrow maintenance work where the existing product system is authoritative.
4. Use `query_ui_ux_knowledge` only for focused follow-up evidence such as accessibility,
   typography, charts, or stack guidance.
5. Select one coherent direction and reconcile it with approved brand assets, existing tokens, and
   repository conventions.
6. Improve layout, hierarchy, spacing, states, and responsiveness.
7. Use existing components, icons, tokens, and styling conventions.
8. Run the app.
9. Verify in browser across desktop and mobile viewports.
10. Fix overlap, clipping, unreadable text, and broken states.

## Guardrails

- Build the actual app/tool UI, not a marketing page, unless requested.
- Do not introduce visual noise as a substitute for hierarchy.
- Keep text readable and contained at all viewport sizes.
- Do not add decorative UI that fights the product task.
- Treat generated design-system output as a draft, not as proof that the rendered interface is good.
- Do not combine several generated styles or palettes into an incoherent result.

## Verification

- Check representative desktop and mobile viewports for overflow, overlap, clipping, unreadable text, and broken interaction states.
- Review keyboard access, focus visibility, console errors, and loading, empty, error, and success states affected by the change.

## Output

Report the user workflow improved, visual and accessibility checks performed, screenshots or browser evidence, and any remaining device-specific risk.
