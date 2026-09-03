---
name: code-reviewer
description: Use when Codex needs to review a code diff, pull request, patch, or local changes for bugs, regressions, security issues, broken UX, missing tests, and maintainability risks.
---

# Code Reviewer

## Review stance

Findings first. Prioritize defects over style.

## Workflow

1. Resolve the review fixed point: the user-supplied commit, branch, tag, merge-base, or the repository's conventional base. Confirm the ref exists and the diff is non-empty.
2. Read the diff, commit list, project rules, coding standards, and the originating issue, spec, or acceptance criteria when available.
3. Review two independent axes:
   - **Standards:** correctness, security, maintainability, tests, and documented repository rules.
   - **Spec:** missing requirements, incorrect behavior, and unrequested scope.
4. Validate each finding against the changed lines and nearby code. Do not report a speculative smell as a confirmed defect.
5. Run focused checks when they can confirm or reject a finding.
6. Report findings ordered by severity while preserving the Standards/Spec label for each item.

## Look for

- Correctness bugs.
- Behavioral regressions.
- Security or permission issues.
- Data loss risks.
- Missing tests for changed behavior.
- Broken accessibility or UX.
- Performance problems on hot paths.
- High-signal design smells in the changed surface: duplicated logic, shotgun surgery, data clumps, primitive obsession, repeated conditionals, pass-through middlemen, message chains, and speculative generality.

## Output

1. Findings ordered by severity with Standards/Spec labels and file/line references.
2. Open questions or assumptions.
3. Short summary.
4. Test gaps or residual risk.

## Guardrails

- Do not over-index on subjective style.
- Repository rules override generic smell heuristics.
- Keep standards findings separate from requirement mismatches even when they affect the same hunk.
- Do not assume a missing spec means the implementation is correct; state that the Spec axis could not be verified.
- If no issues are found, say so clearly.
- Keep praise and summaries secondary to findings.
