# Agent Rules

These rules should gradually move into project-level `AGENTS.md` files and custom skills.

## Baseline behavior

- Read project context before changing code.
- Prefer existing project patterns.
- Do not add architecture without a concrete reason.
- Make small, verifiable changes.
- Do not leave TODO placeholders in the final implementation.
- Verify the result with a command, test, build, or visual check.

## Knowledge work

- If information is missing from the current context, search the knowledge base.
- If a fact may be stale, verify it against the repository or ask the user.
- Do not use model memory as the source of truth for project facts.

## Code work

- For frontend changes, run a local browser check after meaningful edits.
- For backend changes, check tests, types, and edge cases.
- Add focused tests for shared logic.
- For high-risk changes, write a short list of risks and checks.

## User collaboration

- Move autonomously when the goal is clear.
- Ask only when a choice is genuinely risky.
- Give concise status updates during long-running work.
- In the final response, report what changed, where it lives, and what remains.
