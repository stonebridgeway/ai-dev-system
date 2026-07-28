# Upstream Provenance

## Source

- Repository: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Pinned commit: `1307d97a72e6c1cda572cb65471ae5ce82995218`
- Upstream skill version: `2.11.0`
- Imported: `2026-07-26`
- License: MIT, retained in `LICENSE`

## Included

The AI Dev System imports only the self-contained `ui-ux-pro-max` core:

- `data/`
- `scripts/`
- `references/`
- the original skill instructions as `UPSTREAM-SKILL.md`

The Python search and design-system generator use the standard library and local files. They do not
need a network connection or an additional package install.

## Excluded

The repository's sibling skills are intentionally not installed:

- `banner-design`
- `brand`
- `design`
- `design-system`
- `slides`
- `ui-styling`

They overlap with existing AI Dev System frontend skills and reference ClaudeKit, Gemini, Chrome, or
other tools that are not part of this bounded integration. Importing them would create conflicting
instructions and reduce routing precision.

## Adaptation

`SKILL.md` is the local adapter and is not an upstream file. It replaces direct
`${CLAUDE_PLUGIN_ROOT}` commands with two validated MCP tools:

- `query_ui_ux_knowledge`
- `generate_ui_ux_design_system`

The MCP server invokes Python with an argument array and no shell. Persistence is implemented by the
server and restricted to `.ai-dev/frontend/design-system.md` inside a validated project root.

## Update Procedure

1. Review upstream changes and license at a specific commit.
2. Audit Python code for new execution, network, dependency, and write behavior.
3. Run the upstream data validator and unit tests.
4. Replace only `data/`, `scripts/`, `references/`, `UPSTREAM-SKILL.md`, and `LICENSE`.
5. Update `upstream.json` and this note.
6. Run MCP tests, skill validation, routing/search evaluation, health checks, and acceptance tests.
7. Create a new local backup.
