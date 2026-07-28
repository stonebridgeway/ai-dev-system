# Frontend Product Quality v2

This is the mandatory product-design workflow for new interfaces, landing pages, substantial redesigns, and visual frontend delivery.

## Why It Exists

Technical QA proves that a page runs. It does not prove that the page has a clear product character, useful composition, credible content, or coherent visual system.

Frontend Product Quality v2 separates creation from approval and makes visual evidence durable.

## State Machine

```text
Product context
-> Design Brief
-> External references or Reference Factory concepts
-> Two or three directions
-> Direction approval
-> Approved-direction baseline coverage
-> Design System approval
-> Implementation
-> Screenshot and visual diff
-> Independent review
-> Technical QA
-> Handoff
```

Machine state: `.ai-dev/frontend/product-quality.json`.

Human-readable project files:

- `.ai-dev/frontend/design-brief.md`
- `.ai-dev/frontend/design-system.md`
- `.ai-dev/frontend/ui-inventory.md`
- `.ai-dev/frontend/visual-acceptance.md`
- `.ai-dev/frontend/anti-slop-policy.md`
- `.ai-dev/frontend/references/`

## Skill Policy

`frontend_product_builder` selects at most three compatible skills:

1. `frontend-product-builder`;
2. one mode specialist;
3. `frontend-quality-gate`.

Do not stack additional style skills. The approved direction and project design system resolve visual decisions.

## MCP Workflow

1. `frontend_product_builder`
2. `prepare_frontend_product`
3. `update_frontend_product_brief`
4. external-reference path: `record_frontend_directions`
5. no-reference path: `plan_frontend_references` with `stage=concepts`, actual ImageGen/Figma calls, visual inspection, then `register_frontend_references`
6. `approve_frontend_direction`
7. Reference Factory path: `plan_frontend_references` with `stage=coverage`, generate and inspect the approved direction, then `register_frontend_references`
8. `approve_frontend_design_system`
9. `frontend_product_gate` with `gate=implementation`
10. implementation
11. `run_visual_reference_qa`
12. inspect every screenshot, baseline, and diff
13. `record_visual_review`
14. `frontend_product_gate` with `gate=handoff`
15. `run_quality_gate`

## Reference Factory

Reference Factory is used only when no approved visual reference exists. It is deliberately split
across the MCP/client boundary:

- MCP creates a versioned manifest and validates state;
- the client agent calls ImageGen or Figma;
- every PNG is saved at the exact manifest path;
- the agent visually inspects every output;
- MCP verifies PNG structure, dimensions, path containment, SHA-256 uniqueness, prompt binding, and inspection evidence;
- candidate concepts enter the same Frontend Product Quality state instead of a parallel workflow.

Concept images use role `candidate` and belong to one direction. Mapping overlap across different
directions is allowed. After approval, the factory creates role `baseline` images only for the chosen
direction. The design-system gate rejects a Reference Factory project until this coverage is registered.

The short command is `сгенерируй референсы для проекта`; the MCP prompt is
`generate_frontend_references`.

## Design-First Gate

Before application UI code changes, approval requires:

- complete product context;
- at least one real visual reference;
- two or three inspectable directions;
- one approved direction;
- complete design system, UI inventory, and visual acceptance documents;
- no placeholders;
- no application file or Git HEAD change since `prepare_frontend_product`;
- hashes for all approved documents;
- a preparation baseline that preserves unchanged pre-existing worktree changes instead of treating them as new implementation.

Changing an approved frontend document invalidates the implementation gate until reapproval.

## Approved References

Local images live under `.ai-dev/frontend/references/`.

PNG references can map to routes, viewports, and states. On design-system approval, mapped PNGs become immutable comparison baselines under:

```text
.ai-dev/frontend/references/approved/
```

The strict QA workflow never updates these baselines automatically.

Reference roles:

- `candidate`: generated concept used to compare directions;
- `baseline`: approved route, viewport, and state target used for visual diff;
- `inspiration`: supporting evidence that must not become a pixel baseline.

## Strict Visual QA

`run_visual_reference_qa` always checks:

- desktop and mobile;
- default plus every required UI state;
- scenario screenshots;
- approved-baseline pixel comparison and diff artifacts;
- console and page errors;
- network failures;
- horizontal overflow;
- basic and axe accessibility;
- centralized anti-slop rules.

A technically passing run returns `awaiting_review`. File existence is not visual approval.

## Independent Product Review

The reviewer must differ from the implementer and inspect every screenshot, baseline, and diff. Every later handoff check rehashes those artifacts, so a screenshot or diff changed after review makes the evidence stale.

The Product Design Scorecard has ten independent dimensions:

1. hierarchy;
2. composition;
3. typography;
4. density;
5. action clarity;
6. content quality;
7. asset authenticity;
8. mobile UX;
9. state coverage;
10. brand coherence.

Each dimension requires:

- `pass` or `fail`;
- integer score from 1 to 5;
- concrete evidence;
- findings array.

A passing dimension requires at least 4/5. An overall score is forbidden.

## Anti-Slop Policy

The following patterns block by default:

- card soup;
- oversized empty hero;
- default purple gradient;
- decorative glassmorphism;
- decorative orbs, blobs, bokeh, or glow;
- fabricated metrics;
- generic SaaS copy;
- excessive rounding;
- meaningless motion.

An exception requires the exact rule ID, a product-specific rationale, and a named approver. Automated findings support review but do not replace human visual judgment.

## Handoff Gate

Handoff passes only when:

- approved document hashes remain current;
- strict QA passed;
- desktop and mobile are covered;
- every required state is captured;
- approved visual baselines are complete;
- no unwaived anti-slop finding remains;
- every visual artifact was inspected and hash-bound;
- the reviewer is independent;
- all ten scorecard dimensions pass.
