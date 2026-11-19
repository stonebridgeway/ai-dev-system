# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 3.0.x   | ✅        |
| 2.x     | ❌ — its image is `:2`, the way back, which only a `v2.*` tag moves; `:latest` no longer follows 2.x |
| < 2.0   | ❌        |

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

- A client talks MCP to the server over local `stdio`. A local install's entry
  hands the session to the user's daemon over a Unix socket in a private folder,
  or a named pipe on Windows, behind an HMAC handshake on a secret in a file only
  that user can read ([the daemon](ai-dev-mcp-server/docs/SECURITY.md#the-daemon));
  no TCP listener is opened. A Docker entry runs the server in the container
  itself.
- The Docker image ships only the audited public seed and the indexes built
  from it — no passwords, tokens, personal vault, project sources, task history,
  or model weights.
- By default the container runs with no network, as a non-root user, with a
  read-only root filesystem, no Linux capabilities, and `no-new-privileges`. It
  writes to its data volume, `/tmp`, the projects folder and — where it is
  shared — the host's AI Dev state folder, nothing else.
- Run repositories you do not trust inside a container or a disposable VM.
