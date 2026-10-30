# Contributing to AI Dev MCP System

Thanks for your interest in contributing. This repository holds the AI Dev MCP server and every
form it ships in: the `ai-dev` command line and the daemon behind it, the npm package
`ai-dev-system`, the Docker image, and the desktop app with its packages for Windows and Linux (macOS:
in development, built and tested but not released) — plus a small public skill seed.

AI Dev is © stonebridgeway, under the [PolyForm Noncommercial License 1.0.0](LICENSE). By
contributing you agree that stonebridgeway may use, change and license your contribution under that
licence and under commercial licences, and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Commercial licences: [Telegram @stonebridgeway](https://t.me/stonebridgeway).

## Repository layout

| Path | What it is |
| --- | --- |
| `ai-dev-mcp-server/src/extensions/` | the MCP tools, one extension per area, registered in `src/tool-extensions.mjs` |
| `ai-dev-mcp-server/src/core/` | vault-free modules — pure logic, unit tested in isolation |
| `ai-dev-mcp-server/src/*.mjs` | the server's runtime (`mcp-stdio.mjs`, `server.mjs`, the daemon, the tool definitions) |
| `ai-dev-mcp-server/bin/`, `src/cli/` | the `ai-dev` command line: `bin/ai-dev.mjs` → `src/cli/main.mjs`, one module per command |
| `ai-dev-mcp-server/hooks/` | the agent hooks, copied into users' repositories — a deliberate second copy of some server logic |
| `ai-dev-mcp-server/scripts/` | build, check and smoke scripts; `distribution.allowlist.json` says which ship |
| `desktop/` | the Electron app (`src/main`, `src/renderer`), its tests, and the build of its packages for Windows, macOS and Linux (`scripts/`, `build/`) |
| `docker/` | the Dockerfile, the entrypoint, compose files, the 2.x launchers kept until 4.0, and `public-seed/` (the clean bundled vault) |
| `bootstrap.sh`, `bootstrap.ps1` | the Docker install for macOS / Linux and for Windows |
| `scripts/*.ps1` | 2.x PowerShell wrappers, kept until 4.0, each naming the command that replaced it |
| `search-eval/`, `frontend-qa/` | the search golden cases, the Playwright runner |
| `docs/`, `docs/ru/` | the guides the two READMEs link to, in English and Russian |
| `dist/`, `.docker/` | build output, git-ignored: `npm run dist`, `npm run docker:prepare`, `npm run dist:win` |
| `.github/workflows/` | CI ([What CI runs](#what-ci-runs)) |

`README.md` and `README.ru.md` answer what the project is and why to install it;
they stay short on purpose. Reference material belongs in `docs/`. Code, comments
and the English documents are in English; `README.ru.md`, `docs/ru/` and
`docker/README.md` are in Russian. Keep each file in the language it is already in,
and mirror a change to one language's document in the other.

The full Obsidian vault this server normally reads is **not** in this repository.
A standalone checkout resolves its content root to `docker/public-seed`.

## Where code goes

| You are adding | It goes in |
| --- | --- |
| pure logic, no vault, no MCP | `ai-dev-mcp-server/src/core/<name>.mjs`, with `<name>.test.mjs` beside it |
| a new MCP tool | an extension: `ai-dev-mcp-server/src/extensions/<area>.mjs` |
| a hook that runs inside a user's repository | `ai-dev-mcp-server/hooks/` |
| a command of the `ai-dev` CLI | `ai-dev-mcp-server/src/cli/<command>.mjs`, listed in `src/cli/main.mjs` (`bin/ai-dev.mjs` is the entry) |
| a file the installed system needs at run time, outside `src/` and `hooks/` | a line in `ai-dev-mcp-server/distribution.allowlist.json` |
| the desktop app | `desktop/src/main` (the main process), `desktop/src/renderer` (the page), tests in `desktop/test` ([The desktop app](docs/DESKTOP.md)) |
| the app's packages (the Windows installer, the AppImage and `.deb`, the macOS `.dmg`) | their build in `desktop/scripts` (`build-desktop.mjs`, `runtime-bundle.mjs`, one `TARGETS` entry per system), the NSIS step and the pinned Nodes in `desktop/build`; the runtime copy and its stable link in `ai-dev-mcp-server/src/core/app-bundle.mjs` |

**New tools are added as extensions, never by growing `src/mcp-stdio.mjs`.** Each
extension exports one factory:

```js
export function createXxxTools(host) {
  return {
    definitions: [{ name, description, inputSchema }],
    handlers: { [name]: async (args) => result },
    readOnly: ["tool_name"]          // optional
  };
}
```

Register it in `src/tool-extensions.mjs`. The `host` object is built once by
`mcp-stdio.mjs` and carries the shared runtime services; an extension takes what it
needs from `host` and never imports `mcp-stdio.mjs`, which would be an import cycle
and would tie pure logic to a vault.

A new tool needs a home in two more places, and CI enforces both: a documentation
group in `scripts/render-tool-reference.mjs`, and a capability profile in
`src/core/tool-profiles.mjs`. Run `npm run docs:tools` after adding one; it
rewrites `docs/TOOLS.md` and `docs/CONTROL-API.md`, and CI's `docs:tools:check` (not
part of `npm run check`) fails when either is stale.

A file the installed system needs at run time and that is not under `src/` or
`hooks/` goes in `ai-dev-mcp-server/distribution.allowlist.json`; otherwise
the npm package, the Docker image and the desktop app's packages — all made from
`npm run dist` — ship without it.

## Prerequisites

- Node.js ≥ 22.16, or 24+ (`.nvmrc` says `22`, which nvm resolves to the newest 22.x). 22.13–22.15
  and 23.x have `node:sqlite` without FTS5, and the search index needs it; on them the search tests
  skip and the search tools answer with the Node version they need.
- npm for the server and for `desktop/`, each with its own lockfile; pnpm only if you work on
  `frontend-qa/`
- Git
- Docker Desktop / Engine — only for the Docker path (`docker:build`, `docker:smoke`,
  `docker:upgrade-check`)
- No Python for the server or its tests. It is optional at run time — the two UI UX Pro Max tools
  run the dataset's Python script — and needed by two development checks: `npm run upgrade:test`
  and `npm run search:parity`, which take 2.x from git history
- For the desktop app's end-to-end tests on a Linux machine without a display, `xvfb-run`; to
  build the Windows installer off Windows, Wine (64- and 32-bit)

## Package-manager policy

`ai-dev-mcp-server/` uses npm (`package-lock.json`, `packageManager: npm`) because
it is the server's published runtime and its CI / Docker install path; `desktop/`
uses npm too, with its own `package-lock.json`; `frontend-qa/` uses pnpm
(`pnpm-lock.yaml`, `packageManager: pnpm`) because it is a separately packaged
Playwright helper bundled into the runtime image. Keep the lockfiles and managers
independent. The server's own tooling always shells out to npm; a user's project may
still be a pnpm project, and the quality gate runs it with pnpm in that case.

## Setup

```bash
git clone https://github.com/stonebridgeway/ai-dev-system.git
cd ai-dev-system/ai-dev-mcp-server
npm ci
npm run setup -- --no-clients   # builds what a clone does not ship; leaves your AI clients alone
npm test
```

`npm ci` runs no dependency install scripts (`.npmrc`). At a terminal `npm run setup` would
also offer to connect your AI clients to this clone; `--no-clients` keeps your real client
configs out of it. The desktop app, from the same clone:

```bash
cd ../desktop
npm ci
npm start                       # the app, on this clone's server
npm run test:unit               # its unit tests; npm test adds the end-to-end ones
```

## How the tests are split

`node --test` discovers every `*.test.mjs` under `src/` and `scripts/`. Tests fall into three groups:

- **vault-free** (`src/core/**`) — run everywhere. `npm run check` and `npm run test:coverage` hold
  them to 85% lines / 60% branches / 85% functions; `npm run test:core` runs them without the
  thresholds.
- **vault-coupled** — exercise the tool surface against a content vault. On a
  standalone checkout they run against `docker/public-seed`; `npm run skills:ensure-index`
  builds that seed's registry so skill routing works.
- **full-vault-only** — a few tests assert on the complete production skill
  catalog or the Playwright frontend-qa runner. They `skip` automatically when
  those fixtures are absent, so a fresh clone is green.

The desktop app's tests are in `desktop/test`: `npm run test:unit` for the unit tests, `npm test`
for those and then the end-to-end ones, which launch Electron (under `xvfb-run` when there is no
display). `npm run check` does not run them; CI does.

## What CI runs

| Workflow | Job | What it checks |
| --- | --- | --- |
| `ci.yml` | `mcp-server` | `lint` (the static gate), `security`, `packaging:check`, `bootstrap.ps1 -Plan` and the PowerShell launcher parse, `docs:tools:check`, `docs:links`, `docker:seed:verify`, `test:core` |
| | `no-python` (Linux, macOS, Windows) | `scripts/no-python-check.mjs`: `npm ci`, `npm run setup`, `npm run doctor` and the protocol smoke with every Python interpreter taken off `PATH` |
| | `mcp-server-node-floor` | the static gate and the core tests on the oldest Node the server supports |
| | `vault-suite` | `skills:ensure-index`, then `npm test`, `protocol:smoke`, `lifecycle:smoke` |
| | `macos`, `windows` | core, hook and daemon tests; on Windows every PowerShell script parses, and the bootstrap plan and the Docker entries' Windows paths |
| | `desktop` | the app's unit and end-to-end tests under `xvfb-run`, and the Windows runtime's composition |
| `desktop-windows.yml` | `build`, `release` | the app's unit tests and the installer, kept as an artifact; on a `v*` tag of the production repository, `release` puts it on the tag's draft release |
| `docker-publish.yml` | `validate` | the distribution's privacy policy, `packaging:check`, the allowlisted context and its audit, the image, offline secret scanning, MCP over Docker stdio, `bootstrap.sh` writing a client's config from the image, and the upgrade of a 2.x volume with the 2.x launchers |
| | `validate-browser`, `unix-launcher` | the `-browser` variant and its pnpm; the 2.x launcher's contract and `sh -n` of the shell scripts |
| | `publish`, `freeze-2x` | the production repository only: the images to GHCR on a push; and, run by hand before 3.0 is tagged, `:2` copied from `:latest` |
| `dense-eval.yml` | `onnx` | by hand: the real BGE-M3 weights downloaded, the dense index built, the inference test and its measurements |

Run the same gate locally before opening a PR:

```bash
cd ai-dev-mcp-server
npm run check          # the static gate, packaging:check, the seed index, the tests with coverage, security-check, the protocol and lifecycle smokes
npm run docs:tools:check && npm run docs:links   # the generated references are current; no broken link in the docs
npm run docker:prepare && npm run docker:audit   # if you touched the Docker context or seed
npm run docker:seed:verify                       # if you touched the seed
```

Before a release, and at the end of any larger change, the slower checks:

```bash
npm run acceptance                      # npm run check ten times in a row: prints "N failures out of 10"
npm run upgrade:test                    # a 2.x clone from git history, updated to this one (Python 3, git; ~3 minutes)
npm run docker:smoke -- --image ai-dev-system:local
npm run docker:upgrade-check -- --old-image <a 2.x image> --new-image ai-dev-system:local
npm run dist:pack                       # the npm tarball, checked file by file
cd ../desktop && npm test && npm run dist:win   # the app's tests, the Windows installer (dist:mac, dist:linux: the others)
```

## Coding standards

- ES modules, `async`/`await`, `const` over `let`.
- Match the style of the file you are editing — comment density, naming, idiom.
- JSDoc type annotations for every exported function in `src/core/`.
- Modules stay under 800 lines; `src/mcp-stdio.mjs` has a budget of its own and may not grow
  ([Rules for every change](#rules-for-every-change)).
- Add or update tests for behaviour changes. Put pure logic in `src/core/` with
  an isolated test; keep vault-coupled assertions in the top-level `src/*.test.mjs`.
- Never introduce shell string interpolation into command execution: commands
  run as argument arrays with `shell: false`
  ([Rules for every change](#rules-for-every-change)).

## Rules for every change

Five rules look arbitrary and are not. The gate enforces most of them; the rest are
yours to keep.

**Modules stay under 800 lines.** `npm run check` holds every module under `bin/`,
`src/cli/`, `src/core/`, `src/extensions/` and `src/galaxy/`, and the desktop app's
code in `desktop/src` and `desktop/scripts` (not its tests), to `MODULE_LINE_CEILING`.
The top-level `src/*.mjs`, `src/transport/`, `src/workers/`, `scripts/` and `hooks/`
are not measured — a hook is one file by design — so the ceiling there is yours to
keep. The two modules that were already over it are pinned in
`MODULE_LINE_EXCEPTIONS`: they may shrink, never grow, and once one is back under 800
the gate tells you to drop its pin. `src/mcp-stdio.mjs` has a budget of its own,
`SYSTEM_LINE_CEILING`: it can be edited but not re-grown. If your change does not
fit, extract something; do not raise a ceiling
([Line Budgets](ai-dev-mcp-server/docs/ARCHITECTURE.md#line-budgets)).

**Fake secrets in tests are built by concatenation, never written as one literal.**
`scripts/security-check.mjs` scans `bin/`, `src/`, `scripts/`, `hooks/` and the
desktop app's `src/`, `scripts/` and `test/` for leaked credentials, and cannot tell a
fixture from a real key:

```js
const key = ["AKIA", "B".repeat(16)].join("");      // passes
const token = ["ghp_", "a".repeat(36)].join("");    // passes
```

The same values written as single string literals fail the gate. It looks for an
AWS `AKIA…` key, an `sk-…` secret of 20 characters or more, a private-key header,
and any `password`, `passwd`, `api_key`, `secret_key` or `access_token` assigned a
literal of 12 characters or more, so `api_key: "…"` in a fixture needs the same
treatment.

**The hooks under `ai-dev-mcp-server/hooks/` duplicate server code on purpose.**
They are copied into other people's repositories and run there without this
package, so what they share with the server is a second copy, not an import —
project identity above all. When you change one side, change the other and keep
the two behaving identically; a test holds each copy to the server's answers
([Hook and server duplicates](ai-dev-mcp-server/docs/ARCHITECTURE.md#hook-and-server-duplicates)).
The bug to watch for is the two copies disagreeing.

**Commands run as argument arrays with `shell: false`.** Never interpolate a
variable into a command string. The static gate reads the server's code and the
desktop app's as tokens (`src/core/code-tokens.mjs`, its rules in
`src/core/forbidden-calls.mjs`) and refuses `exec` and `execSync` of
`child_process`, a `shell` option that is not plainly off, `eval` and the
`Function` constructor (only the desktop app's tests may use them), and a computed
member of `globalThis`, `window`, `global` or `self`, in their usual spellings and
plain equivalents. It follows plain re-binding and nothing else, so it keeps honest
code honest and is not a security boundary. What it reads and where it stops is in
the architecture's [Line Budgets](ai-dev-mcp-server/docs/ARCHITECTURE.md#line-budgets);
the trust model is in [`docs/SECURITY.md`](ai-dev-mcp-server/docs/SECURITY.md).

**A change is finished with the acceptance run, not with one green gate.**

```bash
cd ai-dev-mcp-server
npm run acceptance          # ten consecutive `npm run check` runs
```

It prints `N failures out of 10`; quote that line in the pull request. One green run is
not evidence: some failures show up in one run out of ten, and the point of the
rule is that they show up before a user finds them. Note which kind of failure you
got: a run with a failing test is the suite telling you something; a run that exits
non-zero with `# fail 0` is the coverage reporter and says nothing about the code.

### Commands worth knowing

```bash
cd ai-dev-mcp-server
npm run setup -- --no-clients   # build what a fresh clone does not ship; leave your AI clients alone
npm run check                   # the gate: static quality, packaging:check, the seed index, the tests with coverage, security-check, the protocol and lifecycle smokes
npm run acceptance              # the gate, ten times
npm run upgrade:test            # a 2.x clone updated to this one (Python 3 and git; ~3 minutes)
npm run docs:tools              # after adding or changing a tool; docs:tools:check is what CI runs
npm run docs:links              # after touching the documentation: no broken link or anchor
npm run -s doctor               # the health check as one command
npm run docker:seed:verify      # after touching docker/public-seed
cd ../desktop && npm test       # the desktop app: unit tests, then end to end (xvfb-run without a display)
```

## Skills in the seed

`docker/public-seed/03-skills-catalog/sources/` holds the small public skill set.
After editing a `SKILL.md` there, regenerate the registry:

```bash
cd ai-dev-mcp-server
node scripts/ensure-skill-index.mjs   # or: npm run docker:seed  (rebuilds the whole seed from a full vault)
```

The generated `registries/`, `cards/`, and `groups/` folders under the seed are
git-ignored; only the `sources/` and hand-written seed docs are committed.

`public-seed.manifest.json` records the size and SHA-256 of every committed seed
file, and the image audit trusts it — so a manifest that has drifted from the
files makes "what was built is what was audited" a formality. CI runs
`npm run docker:seed:verify` to catch that; it also runs the distribution audit
over the committed seed, so a secret, a forbidden path or a NUL byte in a text
file fails it too. When the manifest has drifted, rebuild the seed from
the full vault with `npm run docker:seed`; in a checkout without the vault,
recompute the manifest from the committed tree:

```bash
node scripts/verify-public-seed.mjs --write
```

The generated folders are excluded on both sides, so the fingerprint depends only
on committed content. A seed file that changed is also an entry in
`ai-dev-mcp-server/data/seed-history.json`, which tells an untouched 2.x copy of it
from one a user edited; `npm run docker:seed` keeps it current.

## Branches, releases and pull requests

- Branch off `main`: `feature/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`, and open a pull request
  to `main`. CI runs on every pull request; merge when it is green.
- A push to `main` publishes the `:edge` image and nothing else. A release is a `vX.Y.Z` tag: the
  images `:X.Y.Z`, `:X.Y`, `:X` and `:latest` (each with its `-browser` twin), and a draft release
  with the Windows installer and the Linux packages, which a maintainer publishes (the Mac app is built as
a check and not released while macOS is in development). A fix to the 2.x line ships as a `v2.Y.Z`
  tag and moves only `:2` and its own tags.
- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.
- Keep changes focused. Update `CHANGELOG.md` under `[Unreleased]`.
- Never commit secrets, absolute personal paths, tokens, or a personal vault.
  `npm run security` and the Docker audit check for common leaks.

PR checklist:

- [ ] `npm run check` passes from `ai-dev-mcp-server/` (and `npm test` from `desktop/` if you touched the app)
- [ ] new behaviour has tests; `src/core/` additions have JSDoc
- [ ] a bug fix comes with a test that fails before the fix and passes after it
- [ ] `npm run acceptance` run at the end, and its `N failures out of 10` line quoted in the PR
- [ ] `CHANGELOG.md` updated
- [ ] no personal data, secrets, or machine-specific paths
- [ ] docs updated (`README.md` / `README.ru.md` for the product story,
      `docs/` and `docs/ru/` for the detail, or `ai-dev-mcp-server/README.md`), and `npm run docs:links` clean

## Reporting bugs and security issues

- Bugs: open a GitHub issue with the steps to reproduce the bug. A fix comes with a test that
  fails before it.
- Features: open a GitHub issue that says what you are trying to do.
- Security vulnerabilities: **do not** open a public issue — see [SECURITY.md](SECURITY.md).
