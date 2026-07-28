---
name: secrets-dependencies-auditor
description: Use when Codex must audit a repository for exposed secrets, unsafe environment handling, vulnerable or unpinned dependencies, lockfile drift, install-script risk, abandoned packages, or software supply-chain weaknesses without leaking credentials.
---

# Secrets Dependencies Auditor

## Objective

Find credible secret and dependency risks, minimize exposure during investigation, and produce remediation steps that preserve reproducibility and application compatibility.

## Workflow

1. Read repository rules, ignore files, manifests, lockfiles, CI configuration, container files, deployment config, and secret-management documentation.
2. Identify ecosystems, package managers, private registries, generated dependency files, and runtime/build separation.
3. Inspect tracked files and history only with approved local tools; redact all secret values from output.
4. Distinguish real credentials from examples, hashes, identifiers, tests, and false positives.
5. Run project-native dependency audit or advisory tooling without automatically upgrading packages.
6. Review direct and high-impact transitive dependencies, lockfile integrity, install scripts, source URLs, and version policy.
7. Map each finding to reachability, environment, privilege, exploitability, and available remediation.
8. Verify targeted upgrades with tests and build checks when changes are requested.

## Secret Review

- Check source, configuration, CI variables, container build arguments, generated artifacts, logs, fixtures, and documentation.
- Treat `.env.example` differently from real `.env` files, but ensure examples contain no usable credentials.
- Check whether secrets can enter git history, image layers, caches, client bundles, screenshots, or error reports.
- Recommend revocation and rotation for confirmed exposure; deleting the file alone is insufficient.
- Prefer established secret stores and short-lived credentials over copied long-lived tokens.

## Dependency Review

- Require one authoritative lockfile per package-manager context.
- Detect manifest/lockfile drift and unexpected registry or git dependencies.
- Review packages with lifecycle scripts, native binaries, broad permissions, or maintainer changes more carefully.
- Separate build-only, development, optional, and runtime exposure.
- Avoid major upgrades unless required and supported by compatibility evidence.
- Record advisory identifier, affected version, reachable usage, fixed version, and residual risk.

## Verification

Run available secret scanners and ecosystem audits in non-destructive mode. Confirm that reports are redacted, lockfiles reproduce, the application builds, focused tests pass, and removed secrets no longer appear in tracked content. Do not claim history is clean unless history was inspected.

## Output

Report confirmed exposures first, then vulnerable dependencies, reproducibility issues, false-positive handling, commands run, remediation order, and remaining risk. Never print secret values; use fingerprints or the final four characters only when necessary.

## Guardrails

- Never echo, decode, validate against a live service, or transmit a discovered credential.
- Do not rotate, revoke, publish, or delete credentials without explicit approval.
- Do not run automatic bulk upgrades or remove lockfiles to resolve audit output.
- Do not mark every advisory as exploitable without checking reachability and deployment context.
