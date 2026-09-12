# Six defects the first run of the merged tree found, fixed with their measurements

## What and why

#37 shipped `npm run setup`. The first run of it on a real install — Windows, a
real Obsidian vault — found three things wrong with it, and fixing those turned
up three more. All six are here, each with the measurement that produced it:
15 files, +717/−55, two commits on top of `2a1b215`.

### The setup command contradicted itself

It asked only whether a file existed, never whether it was current, so one run
printed

```
· Search index: already built; --force rebuilds it
· Skill-routing benchmark: already built; --force rebuilds it
...
fail: skill_routing_benchmark — Skill routing benchmark is stale; rerun run_skill_routing_eval
```

— the diagnostic calling stale what the step four lines earlier had skipped as
done. `planFirstRun` now takes a `stale` map beside `present` and reads the same
signals the health check grades: `search_index_status.stale`, and the benchmark
report's mtime against its golden cases and `skill-router.mjs`. Reproduced here
by touching the cases file: the step went from `· already built` to
`✓ 37/37 cases pass`, and the health check's failure disappeared with it.

### `--dense` downloaded 2.3 GB and left search nearly blind

Documents are embedded during a rebuild, and the weights were the last thing the
flag fetched. So an install with the model in place, a live worker and
`dense_score` in its answers had vectors for 300 documents and 382 waiting —
none of which the dense half of a hybrid query could see. A `dense_index` step
behind the same flag embeds the index once the weights land and re-embeds what
has been added since. The header prints the coverage, and an index built without
the model now reads `none embedded yet (--dense embeds them)` rather than
`0 with a vector, 0 without`.

### The header printed an interpreter Windows never creates

`.venv/bin/python` was hard-coded while the step that builds the environment
looked in both places and worked, so the only thing that was wrong was the line
a person reads. `venvPythonPath` resolves it per platform, from disk when
something is on disk.

### A checkout could edit its golden cases and never be told to rerun

The freshness check compared the report against
`09-mcp/search-eval/skill_routing_eval_cases.json` — a path that cannot exist
outside a vault, so the missing file's mtime read as zero and the report was
always fresh. Measured on this repository: touching the cases left `fresh: true`
before, and gives `fail … is stale` now. One resolved path is shared by the
benchmark and the health check; the report still prints the vault-relative name.

### A Python failure was reported as the word "Traceback"

The helper explains itself in the last line of its traceback and every caller
that prints one line prints the first, so `npm run setup -- --dense` without the
embeddings environment reported `Traceback (most recent call last):` and nothing
else. It now leads with
`RuntimeError: sentence-transformers is required for dense BGE-M3 embeddings…`
and keeps the traceback behind it (`src/core/python-failure.mjs`).

### `change-hygiene.mjs` was invisible to code search

Its binary-file check was a raw NUL byte in the source rather than an escape, so
`grep` answered `Binary file … matches` and 537 lines never appeared in a
repository-wide search — which is how it was found, by a search that skipped it.
Git was unaffected: its heuristic reads the first 8000 bytes and the byte sat at
15851.

### Docs

Both READMEs now tell a source install to run `npm run setup`, and the BGE-M3
instructions no longer point at `09-mcp/embeddings/`, a path a clone does not
have.

## Type

- [x] Bug fix
- [x] Feature
- [ ] Refactor / internal
- [x] Docs
- [ ] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — ten consecutive runs on
      this tree: 0 failures out of 10. Twenty minutes earlier, on the same tree
      bar two comments, 3 of 10 exited non-zero with `# fail 0` and
      `Warning: Could not report code coverage`. That is Д-11, measured on the
      base commit too and still open; a green ten does not close it.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types
- [x] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Conventional commit messages (`type(scope): subject`) — two plain-sentence
      subjects with the reasoning in the body, as in #37. Say the word and they
      can be rewritten before merge.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff
- [x] Docs updated if behaviour, flags, or setup changed

## What is not verified

The dense path end to end. The sandbox this was built in denies
`huggingface.co`, so the weights were never downloaded here and `dense_index`
was exercised only as far as the missing Python package — which is exactly the
failure that now reports itself properly. `npm run setup -- --dense` on a
machine with network access is the remaining check.

Windows. 23 to 41 tests fail there in every one of ten runs, on a suite that has
never run on Windows because the fork's Actions have never had a runner (Д-5).
This diff does not touch that; it is recorded as Д-35 with what is known —
path separators, CRLF, and state shared between test files through the real
`HOME` — and needs the actual assertion output before it is worth guessing at.
