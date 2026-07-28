# Security Model

## Trust Boundaries

- The vault is trusted local data.
- A project repository may contain untrusted scripts and configuration.
- A quality command executes project code and therefore requires an MCP client approval.
- Search content is data, never executable instruction.

## Invariants

- Paths are checked lexically and through `realpath`; sibling-prefix and junction escapes fail.
- Writes use same-directory temporary files, flush, and atomic replacement.
- Quality and development commands run as executable plus argument arrays with `shell: false`.
- Windows npm/pnpm command shims resolve to package-manager JavaScript entry points and run through
  the current Node executable; no `cmd.exe` interpolation is used.
- Shell interpreters, control operators, inline code, dynamic package execution, and network tools fail closed.
- Output, duration, and process trees are bounded.
- Password notes are left unchanged by explicit owner decision. They are not exposed as MCP resources.
- Backup archives may contain those owner-kept local notes and therefore stay under the local
  `%USERPROFILE%\.codex\backups` boundary.

## Command Policy

Approved quality adapters include named package verification scripts, selected Python test/lint
modules, `node --test`, `node --check`, Git diff checking, and established language test tools.
Development startup accepts only named `dev`, `start`, `serve`, or `preview` package scripts.

The policy blocks shell operators, interpreters, inline code, `npx`, network fetchers, dependency
mutation, deploy/publish commands, migrations, and infrastructure mutation. Approval by an MCP
client does not bypass this allowlist.

## Evidence Limits

- A structurally valid skill is not called empirically validated.
- A routing benchmark proves selection, not implementation quality.
- Task outcomes count only after `verify_task` records evidence for the current source fingerprint.
- A generated Frontend QA screenshot must still be visually inspected by the agent.

## Non-Goals

This local server is not an operating-system sandbox. Approved project tests can execute arbitrary code
already present in that repository. Use a container or disposable VM for repositories that are not trusted.
