---
name: accessibility
description: Use when building, reviewing, or testing accessible web or mobile interactions, semantics, keyboard flows, contrast, or assistive-technology support.
---

# Accessibility

## Procedure

1. Identify the user flow and required states, then inspect semantic structure before styling.
2. Verify keyboard order, focus visibility, names/roles/values, labels, error messaging, reduced motion, and responsive zoom behavior.
3. Run automated checks such as axe where available, but manually verify the critical interaction path.
4. Test a failure state and a narrow viewport; confirm fixes do not remove information or trap focus.
5. Record known exceptions with a reason, owner, and follow-up date.

## Ready when

The critical flow works without a mouse, automated blockers are resolved or explicitly waived, and evidence covers desktop and mobile or the supported equivalent.

## Evidence

Report the route/state, keyboard steps, automated findings, screenshots or browser output, and any approved exception.

## Tools

Use `run_frontend_qa`, `frontend_product`, `begin_task`, and `checkpoint_task`.
