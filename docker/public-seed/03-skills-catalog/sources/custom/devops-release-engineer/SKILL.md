---
name: devops-release-engineer
description: Use when Codex must design, implement, or review CI/CD, build, deployment, release, rollback, environment promotion, infrastructure automation, or production-readiness changes with reproducibility and operational safety.
---

# DevOps Release Engineer

## Objective

Create a repeatable release path that promotes the same verified artifact, limits privilege, exposes failures, and supports safe rollback or forward recovery.

## Workflow

1. Read repository guidance, CI configuration, deployment manifests, runtime configuration, quality gates, and current release documentation.
2. Map source commit to build artifact, checks, registry, environment promotion, deployment strategy, health verification, and rollback.
3. Identify trust boundaries: pull requests, forks, protected branches, environments, runners, registries, and cloud credentials.
4. Reuse existing pipeline conventions and pin behavior that must remain reproducible.
5. Keep build, test, publish, deploy, migrate, and verify stages explicit.
6. Add concurrency control, retry policy, timeout, caching, and artifact retention only where behavior is understood.
7. Define rollout and rollback signals before automating production changes.
8. Test configuration syntax and the narrowest safe pipeline path.
9. Record environment prerequisites and manual approval points.

## Pipeline Checks

- Build once and promote the same immutable artifact across environments.
- Pin critical actions, images, runtimes, and package-manager behavior according to repository policy.
- Keep untrusted pull-request code away from production secrets and privileged runners.
- Make cache keys include lockfiles and relevant toolchain inputs.
- Prevent duplicate deployments with concurrency groups or release locks.
- Keep migrations coordinated with application compatibility and rollback constraints.
- Fail clearly on missing variables, unhealthy rollout, or incomplete verification.

## Release Strategy

- Choose rolling, blue-green, canary, recreate, or manual rollout based on state, traffic, and rollback needs.
- Define readiness separately from liveness.
- Verify logs, metrics, error rate, latency, queue depth, and business-critical smoke paths.
- Prefer forward fixes when schema or irreversible side effects make rollback unsafe.
- Keep an auditable mapping between commit, artifact digest, deployment, and operator action.

## Verification

Run available linters or validators for workflow and infrastructure files. Verify build reproducibility, test gates, least-privilege permissions, artifact identity, environment configuration, deployment health, and rollback commands without mutating production unless explicitly approved.

## Output

Report pipeline stages, security boundaries, artifact flow, checks executed, rollout/rollback procedure, required manual actions, and remaining operational risk.

## Guardrails

- Do not expose secrets in commands, logs, artifacts, cache keys, screenshots, or generated reports.
- Do not grant broad cloud or repository permissions to solve a narrow access problem.
- Do not deploy to production, rotate credentials, delete infrastructure, or mutate DNS without explicit approval.
- Do not claim rollback is available when database or external side effects make it incomplete.
