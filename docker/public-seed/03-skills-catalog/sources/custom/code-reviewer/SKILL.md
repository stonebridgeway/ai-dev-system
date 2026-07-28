---
name: code-reviewer
description: Use when Codex needs to review a code diff, pull request, patch, or local changes for bugs, regressions, security issues, broken UX, missing tests, and maintainability risks.
---

# Code Reviewer

## Review stance

Findings first. Prioritize defects over style.

## Look for

- Correctness bugs.
- Behavioral regressions.
- Security or permission issues.
- Data loss risks.
- Missing tests for changed behavior.
- Broken accessibility or UX.
- Performance problems on hot paths.

## Output

1. Findings ordered by severity with file and line references.
2. Open questions or assumptions.
3. Short summary.
4. Test gaps or residual risk.

## Guardrails

- Do not over-index on subjective style.
- If no issues are found, say so clearly.
- Keep praise and summaries secondary to findings.

