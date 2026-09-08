---
name: dependency-upgrade
description: Use when upgrading a dependency, runtime, package manager, or generated lockfile, especially across a major version.
---

# Dependency Upgrade

## Procedure

1. Record the current versions, lockfile, supported runtimes, and release notes for the target.
2. Search the codebase for affected APIs, configuration, peer dependencies, and CI images.
3. Apply the smallest codemod or compatibility patch; do not bundle unrelated dependency changes.
4. Run focused tests, package-manager integrity checks, security checks, and the full project gate.
5. Document rollback steps and any changed minimum runtime or platform support.

## Ready when

The lockfile is reproducible, all supported environments are checked, the upgrade's breaking changes are covered by tests, and the rollback path is explicit.

## Evidence

Include before/after versions, commands, test output summary, and links or file references to migration decisions.

## Tools

Use `begin_task`, `run_quality_gate`, `security`, `checkpoint_task`, and `verify_task`.
