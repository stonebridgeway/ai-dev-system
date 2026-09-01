# Contributing to AI Dev MCP System

Thanks for considering a contribution. This project is a local-first MCP server plus a Docker
distribution, so most changes touch either the Node.js server (`ai-dev-mcp-server/`), the
Docker/bootstrap tooling (`docker/`, `bootstrap.ps1`, `bootstrap.sh`), or the packaging scripts
(`packaging/`). Read [README.md](README.md) first for the overall architecture and how the
pieces fit together.

## Before you start

- For anything beyond a small fix, open an issue first to discuss the approach. This avoids
  wasted work on changes that don't fit the project's local-first, no-telemetry design.
- Check existing issues and open pull requests to avoid duplicate work.
- Security issues must **not** be filed as public issues — see [Reporting security issues](#reporting-security-issues).

## Project layout

- `ai-dev-mcp-server/` — the MCP server itself (Node.js 24, ES modules, no framework).
  See [ai-dev-mcp-server/README.md](ai-dev-mcp-server/README.md) for tool inventory and
  [ai-dev-mcp-server/docs/ARCHITECTURE.md](ai-dev-mcp-server/docs/ARCHITECTURE.md) for runtime
  layers, and [ai-dev-mcp-server/docs/SECURITY.md](ai-dev-mcp-server/docs/SECURITY.md) for trust
  boundaries and invariants that changes must not break.
- `docker/` — Dockerfile, Compose files, and the allowlist build context used to publish the
  team image.
- `bootstrap.ps1` / `bootstrap.sh` — one-command installers for Windows and macOS/Linux.
- `packaging/` — Arch (`makepkg`) and Homebrew formula sources.
- `embeddings/`, `search-index/`, `search-eval/`, `frontend-qa/` — supporting local tooling used
  by the server and its quality gates.

## Development setup

Requires Node.js 24 and npm.

```bash
cd ai-dev-mcp-server
npm ci
npm run check
```

`npm run check` runs the same gate used before every release: static quality checks, the unit
test suite with coverage thresholds, the dependency/secret security scan, and MCP protocol and
task-lifecycle smoke tests. A change is not ready for review until this passes locally.

Useful individual scripts (all run from `ai-dev-mcp-server/`):

| Command | Purpose |
| --- | --- |
| `npm run lint` | Static quality checks (syntax, forbidden APIs like `eval`, unsafe `child_process` usage). |
| `npm test` | Unit tests (`node --test`). |
| `npm run test:coverage` | Unit tests with coverage thresholds enforced on `src/core/*.mjs`. |
| `npm run security` | Dependency pinning/integrity and hard-coded secret scan. |
| `npm run protocol:smoke` | MCP protocol smoke test. |
| `npm run lifecycle:smoke` | Task lifecycle (`begin_task`/`checkpoint_task`/`verify_task`/`complete_task`) smoke test. |
| `npm run doctor` | Diagnose a local environment/config problem. |

If you touch the Docker image or bootstrap scripts, also run:

```bash
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

`docker:audit` enforces the privacy policy for the published image (no personal Vault, task
history, credentials, or project source in the allowlist context) — see
[Local data and security](README.md#local-data-and-security) in the README. A change that adds a
new file to `.docker/build-context` almost always needs a matching allowlist update; don't widen
the allowlist without checking why a file needs to be there.

If you touch `packaging/`, run:

```bash
cd ai-dev-mcp-server
npm run packaging:check
```

## Making changes

- Keep changes scoped to the issue at hand; avoid unrelated refactors in the same PR.
- Match the existing code style: ES modules, no build step, no external framework in the server.
  There is no separate formatter/linter config beyond `npm run lint` — follow the conventions of
  the surrounding file.
- Add or update tests under `src/core/*.test.mjs` for any behavior change in `src/core/`; the
  coverage gate (85% lines/functions, 60% branches on `src/core/`) will fail CI otherwise.
- Don't add telemetry, network calls, or dependencies that phone home. The server is designed to
  run fully offline over `stdio`.
- Don't loosen the security invariants in
  [docs/SECURITY.md](ai-dev-mcp-server/docs/SECURITY.md) (path handling, `shell: false` process
  execution, output bounding) without discussing it in an issue first.
- Pin any new dependency to an exact version and keep `package-lock.json` in sync
  (`npm run security` checks this).
- Update the relevant docs in the same PR: [README.md](README.md) (English) and
  [README.ru.md](README.ru.md) (Russian) both describe user-facing setup and must stay in sync
  when you change bootstrap, Docker, or client-configuration behavior; update
  [ai-dev-mcp-server/README.md](ai-dev-mcp-server/README.md) and
  [ai-dev-mcp-server/docs/ARCHITECTURE.md](ai-dev-mcp-server/docs/ARCHITECTURE.md) for
  server/tool changes.

## Commit and pull request guidelines

- Use short, imperative commit subjects in the existing style, e.g. `fix: avoid CI runner
  privacy false positives` or `feat: add cross-platform package installers` (`git log` shows more
  examples).
- Keep PRs focused on one logical change.
- In the PR description, state what changed and why, and list which checks you ran
  (`npm run check`, Docker smoke, etc.).
- CI runs [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml) on
  qualifying changes, which rebuilds the allowlist context and runs the privacy/audit and MCP
  smoke checks. A PR that fails this workflow will not be merged.

## Reporting security issues

Do not open a public GitHub issue for a security vulnerability. Instead report it privately
through [GitHub's private vulnerability reporting](https://github.com/IamPiligrim/ai-dev-system/security/advisories/new)
for this repository. See
[ai-dev-mcp-server/docs/SECURITY.md](ai-dev-mcp-server/docs/SECURITY.md) for the trust
boundaries and invariants the fix will need to preserve.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](LICENSE).
