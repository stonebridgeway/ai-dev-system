---
name: knowledge-curator
description: Use when Codex needs to add, reorganize, summarize, or maintain the AI development knowledge base, skill catalog, project notes, decision records, prompts, and MCP-facing indexes.
---

# Knowledge Curator

## Workflow

1. Determine whether the knowledge is a rule, fact, workflow, prompt, decision, or integration note.
2. Place it in the smallest appropriate file.
3. Link related notes.
4. Update indexes when adding new durable material.
5. Keep notes concise and factual.

## Guardrails

- Do not duplicate the same fact across many files.
- Prefer Markdown over opaque formats.
- Keep machine-readable data in JSON or generated indexes.
- Do not store secrets.

## Verification

- Check that every added link resolves and that no durable fact was copied into competing source-of-truth notes.
- Rebuild the affected registry or search index and verify the new material is discoverable with a representative query.

## Output

Report the notes and indexes changed, the links checked, the search query used, and any unresolved ownership or freshness risk.
