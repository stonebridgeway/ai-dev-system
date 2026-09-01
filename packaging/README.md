# Package Maintainer Guide

These package definitions install only the public repository contents. Runtime knowledge, indexes,
task history, client configuration, project files, credentials, and Docker volumes remain local and
are never included in a package.

## Arch Linux / AUR

After the AUR package is published, install the VCS package with:

```bash
yay -S ai-dev-system-git
ai-dev-system --install-prerequisites
```

To build the same package from this clone instead:

```bash
cd packaging/arch
makepkg -si
ai-dev-system --install-prerequisites
```

The package follows `main`, so its AUR name is `ai-dev-system-git`.

### AUR publication checklist (maintainer only)

1. Create or use a personal AUR account, add an SSH public key in its account settings, and verify
   the key with `ssh -T aur@aur.archlinux.org`.
2. Clone the empty package repository:

   ```bash
   git clone ssh://aur@aur.archlinux.org/ai-dev-system-git.git
   ```

3. Copy `packaging/arch/PKGBUILD` into that clone, then generate the committed metadata there:

   ```bash
   cd ai-dev-system-git
   makepkg --printsrcinfo > .SRCINFO
   bash -n PKGBUILD
   namcap PKGBUILD
   makepkg -sri
   ```

4. Inspect `git diff --check`, commit only `PKGBUILD` and `.SRCINFO` (for example,
   `feat(aur): publish ai-dev-system-git`), then push to the AUR remote.

The GitHub repository has no authority to create or push this separate SSH-backed repository; an
AUR maintainer must perform every checklist step above.

## Homebrew

After the tap is published, install the stable formula with:

```bash
brew tap stonebridgeway/tap
brew install ai-dev-system
ai-dev-system --install-prerequisites
```

The current formula pins the immutable `v1.0.0` source archive and its SHA-256. It is kept here as
the source file for the tap, whose repository layout must be:

```text
stonebridgeway/homebrew-tap
└── Formula/
    └── ai-dev-system.rb
```

### Homebrew tap checklist (maintainer only)

1. In the personal GitHub account **stonebridgeway** (not an organization), create the public
   repository named `homebrew-tap`. GitHub recognizes it as the `stonebridgeway/tap` tap.
2. In a clone of that repository, create `Formula/` and copy
   `packaging/homebrew/ai-dev-system.rb` to `Formula/ai-dev-system.rb`.
3. On macOS, validate the copied formula before committing:

   ```bash
   brew style Formula/ai-dev-system.rb
   brew audit --strict --formula Formula/ai-dev-system.rb
   ```

4. Commit and push the formula to `stonebridgeway/homebrew-tap`. The user-facing commands above
   become available once GitHub serves the default branch.

### Homebrew release updates

For every new Git tag, replace the version in the formula URL, download the exact tag archive, and
replace `sha256` with its digest:

```bash
VERSION=v1.0.1
curl -L --fail --silent --show-error \
  "https://github.com/stonebridgeway/ai-dev-system/archive/refs/tags/${VERSION}.tar.gz" \
  -o "ai-dev-system-${VERSION}.tar.gz"
# macOS:
shasum -a 256 "ai-dev-system-${VERSION}.tar.gz"
# Linux:
sha256sum "ai-dev-system-${VERSION}.tar.gz"
```

Use the resulting lower-case digest in both the tap formula and this source formula, then rerun
`brew style` and `brew audit --strict --formula`. The release tag must already exist; do not use a
moving branch archive as a stable formula source.

## Maintainer Checks

```bash
cd ai-dev-mcp-server
npm run packaging:check
```

GitHub Actions additionally checks the shell scripts on Ubuntu and macOS, validates the Arch
package shell metadata in an Arch container, and runs Ruby syntax and `brew style` for the
Homebrew formula on macOS.
