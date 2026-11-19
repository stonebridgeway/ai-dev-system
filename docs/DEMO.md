# Demo — one task, start to finish

[← README](../README.md) · [Install](INSTALL.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md)

**"Add authentication to the API."** One task, from the first command to a closed
one, including the part where it goes wrong.

Everything below is real output. You can produce it yourself from a clone of the
repository in a few seconds, without installing an MCP client and without
touching any of your repositories:

```bash
cd ai-dev-mcp-server
npm ci          # once, in a fresh clone
npm run demo
```

The script builds a throwaway API project in a temporary folder, runs the task
through the real server — whose runtime home, state and search index are in that
folder too — and deletes everything it made. The one thing it may leave is the
clone's skill registry: when it is missing or out of date, the demo builds it
first, as `npm run setup` does, into three folders of
`docker/public-seed/03-skills-catalog` that git ignores — `registries/`, with its
`groups/` and `cards/`.

---

## 1. You give the agent a task

```text
begin_task — "Add authentication to the API"
```

```text
task task-20261019T003825-989724d2 is open

It loaded the project, without being told about it:
  stack Node.js, 4 relevant files read
    package.json - project configuration
    src/routes.mjs - application source
    src/server.mjs - application source

It routed 3 skills out of 614 - nobody named them:
  feature-builder (workflow)
  application-security-reviewer (domain)
  secrets-dependencies-auditor (verification)

And it wrote down what finished has to mean:
  AC-1 Requested behavior is implemented within the stated scope: Add authentication to the API
  AC-2 Relevant automated checks pass or every unavailable check has a recorded reason.
  AC-3 No known regression, unresolved error, placeholder, or unrelated refactor remains.
```

Nobody said "this is a Node project", "read these files", or "use a security
reviewer". Five words of task description produced a compiled context pack, three
routed skills out of 614, and a written definition of done.

## 2. The agent writes the code — and gets it wrong

The authentication middleware has a real bug: a request with no token is waved
through as anonymous instead of being rejected.

```text
checkpoint_task

checkpoint recorded, snapshot-1 holds 3 files at commit 1d46c9f7
nothing was written to your branch, stash or index - rollback_task can undo this turn
```

The snapshot is a commit object no branch points at, under
`refs/ai-dev/snapshots/<task_id>/`. Your branch, stash and index are untouched,
and `rollback_task` can put this turn back exactly as it was.

## 3. It tries to talk its way past the problem

This is the moment the product exists for. The agent files a report saying the
work is done and the failure is somebody else's:

> *"Authentication is done. One test is failing but it's a pre-existing issue,
> will fix later."*

```text
REFUSED - the report claimed more than the evidence showed

The report claims more than the evidence shows: 2 rationalizations are not backed by a passing check.
- pre_existing_failure in notes: The report calls a failure pre-existing; the latest verify_task run
  never ran. Show it on the base ref and record a passing verify_task for this change.
  Quoted: "…ne test is failing but it's a pre-existing issue, will fix later."
- tests_failing_deferred in notes: The report leaves a red test for later; the project quality gate
  (verify_task with run_quality) never ran. Make the suite green before the report claims the change
  is done. Quoted: "One test is failing but it's a pre-existing issue, will fix later."
Fix the check and run verify_task again, or rewrite the report to say what actually happened. If the
reason is real, state it in the report ("reason: …") and waive the rule in .ai-dev/policy.json:
{"completion_claims":{"waivers":[{"rule":"pre_existing_failure","reason":"…"}]}}
```

Two named rules, the check behind each one, the sentence that triggered it, and
what would satisfy it. The checkpoint is not recorded. If the reason is genuinely
real, the refusal says what to do: state it in the report and waive the rule in
`.ai-dev/policy.json` — deliberately, in a file someone can review, rather than
by phrasing it persuasively.

## 4. Verification runs the project's own checks

```text
verify_task

FAILED - quality_gate: failed, change_hygiene: warn, security_scan: unchecked

not ok 1 - a request with no token is rejected
  ---
  duration_ms: 1.498086
  type: 'test'
  location: '/tmp/.../test/auth.test.mjs:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    200 !== 401

# tests 3
# pass 2
# fail 1
```

The quality gate ran the project's own test command — `node --test`, read out of
`.ai-dev/quality-gate.md`, not guessed. The planted bug is caught by the test the
agent itself wrote.

`security_scan: unchecked` is what a machine with no security scanner installed
gets, as the one this was recorded on: no scanner ran, so nothing is called
clean, and the verification is not stopped for it. With one installed — gitleaks
needs no network — the line carries that scanner's verdict.

## 5. The agent fixes the real bug

```js
if (token === "Bearer demo-token") return { ok: true };
return { ok: false, reason: "missing or invalid token" };
```

## 6. Verification again

```text
verify_task

PASSED - quality_gate: passed, change_hygiene: warn, security_scan: unchecked
recorded as verification-1792370306204-0690efa3
```

`change_hygiene` stays at `warn` — it noticed that a public interface changed
without any documentation changing. A warning is reported, not fatal; a `block`
finding would have stopped this.

## 7. Now, and only now, the task can close

```text
complete_task

task complete
pull request description written to .ai-dev/pr/task-20261019T003825-989724d2.md
  title: feat(src): add authentication to the API
```

The pull request description is built from the evidence the task collected, not
written from memory:

```markdown
## Verification

Latest run `verification-1792370306204-0690efa3` at 2026-10-19T00:38:26.204Z: **passed**.

| Check | Result |
| --- | --- |
| `quality_gate` | passed |
| `change_hygiene` | warn |
| `security_scan` | unchecked |

Not run: `frontend_qa`.

2 verification run(s) recorded; the latest one is the one that counts.
```

It also carries the summary, the changed files grouped by kind, every acceptance
criterion with the verification that satisfied it, the checkpoints in order, and
the change-hygiene findings. Nothing is pushed and no pull request is opened —
the `git push` and `gh pr create` commands are returned as text for you to run.

Had `complete_task` been called before step 6, it would have come back with:

```text
The latest verification (verification-…) failed. Fix the problem and run verify_task again.
```

---

## What this run demonstrates

| Step | What an agent normally does | What happened here |
| --- | --- | --- |
| 1 | Asks you about the project, or guesses | Compiled the context and routed 3 skills from 5 words |
| 2 | Edits in place; a bad turn is yours to untangle | Snapshotted the turn, outside your branch and stash |
| 3 | *"Pre-existing issue, will fix later"* | Refused, with the rule and the missing check |
| 4–6 | Says the tests pass | Ran the project's own gate and showed the output |
| 7 | *"Done!"* | Closed on recorded evidence, and wrote the PR from it |

## Recording this

`npm run demo` is the recording. The whole run took 2.5–3.1 seconds on a
2.1 GHz Xeon — about 4 when it built the skill registry first — needs no MCP
client, and leaves nothing behind but that registry.

- `npm run demo -- --no-color` for a plain transcript, or to paste into an issue.
- Every scene fits in 40 rows, but not in 80 columns: the refusal's lines in
  step 3 run to nearly 300 characters.
- Steps 3 and 4 are the ones worth pausing on — the refusal and the failing test
  are the parts people have not seen an agent do before.
