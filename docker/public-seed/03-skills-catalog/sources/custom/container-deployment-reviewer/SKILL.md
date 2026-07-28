---
name: container-deployment-reviewer
description: Use when Codex must review or change Dockerfiles, Compose files, container images, Kubernetes workloads, runtime configuration, health checks, resource limits, supply-chain controls, or container deployment behavior.
---

# Container Deployment Reviewer

## Objective

Produce small, reproducible, non-root container artifacts with explicit runtime contracts, health behavior, resource expectations, and deployment evidence.

## Workflow

1. Inspect Dockerfiles, ignore files, build context, Compose or orchestration manifests, entrypoints, health checks, and CI image publishing.
2. Identify build-time and runtime dependencies, ports, writable paths, users, signals, configuration, secrets, and persistent state.
3. Review stage boundaries and ensure only runtime artifacts enter the final image.
4. Check deterministic dependency installation and base-image pinning policy.
5. Review non-root execution, file ownership, capabilities, read-only filesystem compatibility, and secret injection.
6. Review startup, shutdown, signal forwarding, probes, restart policy, and graceful termination.
7. Review CPU/memory requests or limits, storage, networking, and dependency readiness.
8. Build and inspect the image using repository commands, then run focused smoke and health checks.

## Image Checks

- Keep build context narrow and exclude secrets, caches, local databases, test artifacts, and VCS metadata.
- Use multi-stage builds when they materially reduce runtime dependencies or attack surface.
- Avoid package-manager upgrades unrelated to the application.
- Preserve lockfile-driven installs and fail when the lockfile is inconsistent.
- Run as a dedicated non-root user unless the application has a documented requirement.
- Copy files with deliberate ownership and permissions.
- Avoid embedding environment-specific configuration or credentials in image layers.

## Runtime Checks

- Use exec-form entrypoints and preserve signal delivery.
- Separate liveness, readiness, and startup probes by purpose.
- Do not mark a process ready before required migrations, connections, or warmup complete.
- Define writable directories and persistence explicitly.
- Set resource expectations from evidence; do not invent tiny limits that cause instability.
- Verify behavior during dependency delay, restart, termination, and repeated deployment.

## Verification

Use available Docker, Compose, Kubernetes, Helm, or policy validators. Record image build result, final size when available, effective user, exposed ports, health status, smoke response, configuration gaps, and checks that could not run.

## Output

Report findings by severity, changed runtime contract, commands run, artifact or digest when available, deployment implications, and remaining risk.

## Guardrails

- Do not print, copy, or bake secrets into images or build logs.
- Do not use privileged mode, host networking, broad capabilities, or root execution without a documented need.
- Do not delete volumes, clusters, registries, or running workloads during review.
- Do not treat a successful image build as proof that startup, health, and shutdown are correct.
