# Package Maintainer Guide

These package definitions install only the public repository contents. Runtime knowledge, indexes,
task history, client configuration, project files, credentials, and Docker volumes remain local and
are never included in a package.

## Arch Linux

Build and install the VCS package from a clone:

```bash
cd packaging/arch
makepkg -si
ai-dev-system --install-prerequisites
```

The package follows `main`, so its AUR name is `ai-dev-system-git`. To publish it in AUR:

1. Create or use an AUR account and register an SSH key.
2. Clone `ssh://aur@aur.archlinux.org/ai-dev-system-git.git`.
3. Copy `PKGBUILD` and `.SRCINFO` from this directory.
4. Run `namcap PKGBUILD`, build in a clean Arch environment, then commit and push the two files.

The GitHub repository cannot publish to AUR until an AUR maintainer explicitly configures that
separate SSH-backed repository.

## Homebrew

Install the HEAD formula directly from a clone:

```bash
brew install --HEAD --formula ./packaging/homebrew/ai-dev-system.rb
ai-dev-system --install-prerequisites
```

A short package name such as `brew install stonebridgeway/tap/ai-dev-system` requires a separate
`stonebridgeway/homebrew-tap` repository. Until that tap exists, the local formula command above is
the supported Homebrew path.

## Maintainer Checks

```bash
cd ai-dev-mcp-server
npm run packaging:check
```

GitHub Actions additionally checks the shell scripts on Ubuntu and macOS, validates the Arch
metadata in an Arch container, and runs Ruby syntax validation for the Homebrew formula.
