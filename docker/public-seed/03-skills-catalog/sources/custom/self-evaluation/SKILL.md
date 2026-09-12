---
name: self-evaluation
description: Use when a change looks finished and before calling complete_task, to score your own work on five axes with quoted evidence, to check every claim in the report against what actually proves it, and to decide whether to complete, fix, or start over.
---

# Self Evaluation

The last thing between a change and a false "done" is your own report. Score the work, then
check the report sentence by sentence. A claim no run backs is not a claim, it is a wish.

`checkpoint_task` and `complete_task` lint the text you send them: a rationalization
("pre-existing issue", "skipping tests for now", "should work", "works on my machine",
"flaky") whose check did not pass is refused. Score first and the refusal never happens.

## Workflow

1. Collect the evidence you actually have: the last `verify_task` result and its
   `checks[]` (`quality_gate`, `change_hygiene`, `frontend_qa`), the test output from this
   session, `git diff --stat` and the full diff, the acceptance criteria and their status.
2. Score the five axes below from 1 to 5. Write the score, then the evidence it rests on,
   in that order — never the other way round.
3. Quote a gap for every axis below 5: the file and line, the failing check, the missing
   test, the criterion left `pending`. A number with no quote is not a score.
4. Read your draft report line by line against the claim table. Delete or rewrite every
   sentence whose evidence column is empty.
5. Average the five axes and take the post-action for that band.
6. Repeat from step 1 after any fix; evidence is bound to the Git state that produced it,
   so a later edit invalidates the score as surely as it invalidates `verify_task`.

## The five axes

| Axis | Scored 5 when | Scored 1 when |
| --- | --- | --- |
| Correctness | The requested behavior is implemented and a run shows it, including the failing case that started the task | Nothing was executed, or the run contradicts the claim |
| Evidence | Every claim maps to a check bound to the current source state | The report rests on reading the code |
| Scope | The diff contains the requested change and nothing else | Unrelated refactors, dependency churn, or drive-by reformatting |
| Robustness | Errors propagate, edge cases and empty inputs are handled, no swallowed failure | Silent failures, bare catches, unhandled rejections |
| Maintainability | Tests cover the new behavior, names and structure match the codebase, no leftovers | Placeholders, dead code, untracked TODOs, weakened linter config |

## Claim to evidence

Every row is a sentence people write in reports. The middle column is the only thing that
earns it.

| Claim | What backs it | Where it comes from |
| --- | --- | --- |
| "Tests pass" | A `quality_gate` check with status `passed`, on the current fingerprint | `verify_task` → `verification.checks[]` |
| "No regression" | The suite for the touched packages, plus a new test that fails without the change | Test output in this session |
| "The bug is fixed" | The reproduction that failed before the change and passes after it | Before and after runs, both quoted |
| "Only what was asked changed" | The full diff read file by file | `git diff` and `git diff --stat` |
| "The UI is correct" | Desktop and mobile screenshots you opened and looked at | `verify_task` with `run_frontend=true` |
| "No secrets, no debug leftovers" | A hygiene scan with no `block` finding | `verify_change_hygiene` |
| "The failure is pre-existing" | The same check failing on the base ref, output quoted | A run on the base ref |
| "Coverage is sufficient" | Coverage of the changed lines against the project target | Quality gate output |
| "The contract still holds" | Contract or consumer tests for the changed API | Test output |
| "Docs are current" | The changed documentation paths present in the diff | `git diff --name-only` |
| "It is done" | Every acceptance criterion `met`, or `waived` with a concrete reason | `get_task` |

## Post-action by average

| Average | Action |
| --- | --- |
| 4.5 and above | Call `complete_task` with a report that states results, not intentions |
| 3.5 to 4.4 | Fix the quoted gaps, run `verify_task` again, score again; do not complete yet |
| 2.5 to 3.4 | The change is not ready: return to implementation, keep the task active, checkpoint what is known |
| Below 2.5 | Start over: re-read the request, discard the approach that produced this, call `plan_task` before rewriting |

An axis below 3 caps the whole evaluation at 3 however good the others are: a report with a
hole is not an average, it is a hole.

## Output

```
SELF EVALUATION
Correctness:     N/5 — evidence
Evidence:        N/5 — evidence
Scope:           N/5 — evidence
Robustness:      N/5 — evidence
Maintainability: N/5 — evidence
Average:         N.N → complete | fix | return to implementation | start over
Gaps: file:line or check, one line each
Unbacked claims removed from the report: ...
```

## Guardrails

- Do not score from memory or intention. If the run is not in this session against the
  current code, the axis is not a 5.
- Do not inflate an axis to reach a band. A 3.4 average is a result, not a negotiation.
- Never edit the report to slip a rationalization past the linter. If the reason is real,
  write it out in full and waive that one rule in `.ai-dev/policy.json`; a waiver without a
  stated reason does not apply.
- Never skip, delete, or weaken a test, and never suppress a linter or type error to raise
  a score; fix the code instead.
- Do not treat a generated report, a screenshot nobody opened, a `dry_run`, or a previous
  run as evidence.
- Keep secrets, tokens, and customer data out of the evaluation text.

## Verification

The evaluation is complete when every axis carries a quote, the report contains no sentence
the claim table cannot back, and the post-action was taken. `complete_task` returning
`completion_claims.status: "ok"` confirms the report and the evidence agree; a refusal names
the rule, the check behind it, and what is missing.
