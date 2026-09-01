# Contributing to AI Dev MCP System

Thanks for your interest in contributing. This repository is the standalone,
publishable copy of the AI Dev MCP server: a local `stdio` MCP server plus its
Docker image, packaging, and a small public skill seed.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE), and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `ai-dev-mcp-server/` | the MCP server (`src/`, `scripts/`, tests) |
| `ai-dev-mcp-server/src/core/` | vault-free modules — pure logic, unit tested in isolation |
| `ai-dev-mcp-server/src/*.mjs` | the tool surface, coupled to a content vault |
| `docker/` | launchers, compose files, and `public-seed/` (the clean bundled vault) |
| `packaging/` | Arch `PKGBUILD` and Homebrew formula |
| `embeddings/`, `frontend-qa/`, `search-eval/` | Python and Playwright helpers |

The full Obsidian vault this server normally reads is **not** in this repository.
A standalone checkout resolves its content root to `docker/public-seed`.

## Prerequisites

- Node.js ≥ 24 (`.nvmrc` pins `24`)
- npm (the server uses npm and `package-lock.json`; only `frontend-qa/` uses pnpm)
- Git
- Docker Desktop / Engine — only for the Docker and packaging paths
- Python 3.11+ — only for the embeddings and search-eval helpers

## Setup

```bash
git clone https://github.com/stonebridgeway/ai-dev-system.git
cd ai-dev-system/ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run skills:ensure-index   # builds the bundled seed's skill registry on first run
npm test
```

## How the tests are split

`node --test` discovers every `src/**/*.test.mjs`. Tests fall into three groups:

- **vault-free** (`src/core/**`) — run everywhere, gated for coverage by
  `npm run test:core` and `npm run check` (85% lines / 60% branches / 85% functions).
- **vault-coupled** — exercise the tool surface against a content vault. On a
  standalone checkout they run against `docker/public-seed`; `npm run skills:ensure-index`
  builds that seed's registry so skill routing works.
- **full-vault-only** — a few tests assert on the complete production skill
  catalog (3,000+ skills) or the Playwright frontend-qa runner. They
  `skip` automatically when those fixtures are absent, so a fresh clone is green.

What CI runs (`.github/workflows/`):

- `ci.yml` → `mcp-server`: `npm run lint`, `npm run security`, `npm run packaging:check`, `npm run test:core`
- `ci.yml` → `vault-suite`: `npm run skills:ensure-index`, then `npm test`, `npm run protocol:smoke`, `npm run lifecycle:smoke`
- `docker-publish.yml`: privacy policy test, allowlisted context audit, image build, `docker:smoke`, and (on `main` / tags) the GHCR publish

Run the same gate locally before opening a PR:

```bash
cd ai-dev-mcp-server
npm run check          # static-quality + seed index + coverage + security + protocol/lifecycle smokes
npm run docker:prepare && npm run docker:audit   # if you touched the Docker context or seed
```

## Coding standards

- ES modules, `async`/`await`, `const` over `let`.
- Match the style of the file you are editing — comment density, naming, idiom.
- JSDoc type annotations for every exported function in `src/core/`.
- Add or update tests for behaviour changes. Put pure logic in `src/core/` with
  an isolated test; keep vault-coupled assertions in the top-level `src/*.test.mjs`.
- Never introduce shell string interpolation into command execution — commands
  run as `execFile`-style argument arrays with `shell: false` (see
  [`docs/SECURITY.md`](ai-dev-mcp-server/docs/SECURITY.md)).

## Skills in the seed

`docker/public-seed/03-skills-catalog/sources/` holds the small public skill set.
After editing a `SKILL.md` there, regenerate the registry:

```bash
cd ai-dev-mcp-server
node scripts/ensure-skill-index.mjs   # or: npm run docker:seed  (rebuilds the whole seed from a full vault)
```

The generated `registries/`, `cards/`, and `groups/` folders under the seed are
git-ignored; only the `sources/` and hand-written seed docs are committed.

## Commits and pull requests

- Branch off `main`: `feature/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`.
- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.
- Keep changes focused. Update `CHANGELOG.md` under `[Unreleased]`.
- Never commit secrets, absolute personal paths, tokens, or a personal vault.
  `npm run security` and the Docker audit check for common leaks.

PR checklist:

- [ ] `npm run check` passes from `ai-dev-mcp-server/`
- [ ] new behaviour has tests; `src/core/` additions have JSDoc
- [ ] `CHANGELOG.md` updated
- [ ] no personal data, secrets, or machine-specific paths
- [ ] docs updated (`README.md`, `README.ru.md`, or `ai-dev-mcp-server/README.md`)

## Reporting bugs and security issues

- Bugs and features: open a GitHub issue with reproduction steps.
- Security vulnerabilities: **do not** open a public issue — see [SECURITY.md](SECURITY.md).
