# How AI Dev differs from plain agent rules

`AGENTS.md` or `CLAUDE.md` gives an agent static instructions. AI Dev adds a bounded project context pack, explicit task acceptance criteria, a quality gate, evidence receipts, skill routing, and a verification lifecycle.

Cursor rules and other MCP knowledge servers can provide useful context, but they do not necessarily provide the same project identity, task locks, command policy, or source-state verification. AI Dev is designed to keep those controls local and inspectable.

The compact `core` tool profile is intended for normal client sessions. The `full` profile remains available for compatibility and migration.
