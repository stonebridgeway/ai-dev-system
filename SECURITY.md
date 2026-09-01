# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use **GitHub's private vulnerability reporting**:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue with enough detail to reproduce it.

If private reporting is unavailable to you, contact the maintainers privately
through the address listed on the
[`stonebridgeway`](https://github.com/stonebridgeway) organization profile.

Please include as much of the following as you can:

- type of issue (path traversal, command injection, resource exhaustion, …)
- affected source files and the tag / branch / commit
- configuration needed to reproduce
- step-by-step reproduction and, if possible, a proof of concept
- impact and how an attacker might exploit it

You should receive an acknowledgement within **72 hours**. We follow
[Coordinated Vulnerability Disclosure](https://vuls.cert.org/confluence/display/CVD):
we confirm the issue, look for related problems, prepare fixes for supported
releases, and publish a fixed version and advisory as soon as practical.

## Preferred languages

English or Russian.

## Security model

This server executes project code during quality verification and is **not** an
operating-system sandbox. The trust boundaries, invariants, command allowlist,
and non-goals are documented in
[`ai-dev-mcp-server/docs/SECURITY.md`](ai-dev-mcp-server/docs/SECURITY.md).

Key points for operators:

- The MCP transport is local `stdio`; no network listener is opened.
- The Docker image ships only the audited public seed — no passwords, tokens,
  personal vault, project sources, task history, indexes, or model weights.
- By default the container runs with no network, as a non-root user, with a
  read-only root filesystem, no Linux capabilities, and `no-new-privileges`.
- Run repositories you do not trust inside a container or a disposable VM.
