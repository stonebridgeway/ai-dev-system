# Archify MCP integration

Archify creates validated, self-contained HTML diagrams from JSON IR. The MCP
server invokes the vendored CLI at
`03-skills-catalog/sources/external/archify/bin/archify.mjs`; it never runs the
upstream self-update flow. The pin is recorded in that directory's
`upstream.json`.

## Tool contract

All diagram tools accept `diagram_type` where applicable: `architecture`,
`workflow`, `sequence`, `dataflow`, or `lifecycle`. A specification is provided
by exactly one of `spec` (an inline JSON object) or `spec_path` (an absolute path,
or a path relative to `project_path`). `quality` is `standard` or `showcase` and
defaults to `showcase`.

| Tool | Required input | Optional input | Result |
| --- | --- | --- | --- |
| `archify_doctor` | none | none | CLI, Node, and browser configuration status. |
| `archify_guide` | `scenario` | `lang` (`en` or `zh`) | Diagram type and authoring recipe. |
| `archify_validate` | `diagram_type`, one specification input | `quality`, `project_path`, `artifact_location`, `layout_json` | Structured diagnostics; no deliverable HTML. |
| `archify_render` | `diagram_type`, one specification input | `quality`, `project_path`, `artifact_location`, `output_path` | Rendered HTML without the delivery quality gate. |
| `archify_deliver` | `diagram_type`, one specification input | `quality`, `project_path`, `artifact_location`, `output_path`, `open` | Validated HTML, SHA-256 receipt, and `report.md`. |
| `archify_visual_check` | `artifact_path` | `project_path` | Bounded browser check for a delivered HTML artifact. |
| `archify_compare` | `base_path`, `head_path` | `output_path`, `quality`, `project_path`, `artifact_location` | Validated architecture-delta HTML and receipt. |
| `archify_migrate` | `old_path`, `new_path` | `project_path` | Workflow schema-v2 migration summary. |
| `archify_brands` | none | `query` or explicit `capture_url` | Local mark search, or a digest-pinned URL capture. |

`output_path` is allowed only with `artifact_location: "project"` and is always
contained by `project_path`. The URL form of `archify_brands` is the only
Archify operation that fetches an explicit remote address.

## Artifact layout and evidence

Each call receives a unique run directory.

| Location | Run directory |
| --- | --- |
| `system` (default) | `${AI_DEV_HOME}/artifacts/archify/<project-slug>/<run-id>/` |
| `project` | `<project-path>/.ai-dev/archify/artifacts/<run-id>/` |

Inline specifications are written into the run directory. System deliveries
place their HTML there; project deliveries use the requested project-relative
`output_path`, while their `report.md` remains in the run directory.

`archify_deliver` and `archify_visual_check` each return a ready-to-use
`evidence` object — pass it verbatim to `verify_task` / `complete_task`. The
diagram acceptance criterion is marked met only when the delivery receipt clears
its full bar (showcase profile, zero composition errors and warnings, all nine
artifact checks, on-disk artifact hash match) and any supplied
`archify_visual_check` evidence reports clean containment. A `standard`-quality
or warning-carrying delivery records a failed check rather than passing.

## Three separate claims

Do not collapse these claims into one result:

1. `archify_deliver` proves deterministic rendering, validation, and artifact hashes.
2. `archify_visual_check` proves bounded automated browser geometry/overflow checks.
3. Perceptual quality is a separate human or image-capable review, recorded independently.

## Runtime and offline behavior

Node 18 or later is required. Rendering, validation, delivery, comparison,
migration, recipes, and built-in brand search operate locally from the vendored
package and work offline. Chrome or Edge is required only for
`archify_visual_check` (and local preview); set `ARCHIFY_CHROME` when automatic
detection is insufficient and use `archify_doctor` to diagnose it. A browser is
not required to validate or deliver an HTML artifact.

The clean Docker seed contains the pinned Archify runtime and its dependencies,
so a local build does not require a hidden package install. `capture_url` remains
network-dependent by design; avoid it when offline operation is required.
