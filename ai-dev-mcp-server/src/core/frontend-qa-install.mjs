/**
 * How `npm run setup -- --frontend-qa` installs the Frontend QA runner, and
 * when it may say it worked.
 *
 * It used to run whichever package manager was on the PATH: `pnpm install`
 * without `--frozen-lockfile`, or, with no pnpm, `npm install`, which never
 * reads `pnpm-lock.yaml` and resolved the tree afresh. It installed no browser,
 * so its ✓ meant "packages are here" while the health check two lines later
 * said Frontend QA could not run.
 *
 * Now the pnpm the runner's `packageManager` names installs exactly the
 * lockfile, Playwright installs the Chromium build it was released with, and
 * the step succeeds only when the check `doctor` makes says the browser
 * launches. Spawning is the caller's job; this decides what to spawn and how
 * to read what came back.
 */
import path from "node:path";

/**
 * The pnpm version a package pins in `packageManager` — "pnpm@11.25.0",
 * optionally with a `+sha512.…` integrity suffix.
 *
 * @param {{ packageManager?: string }} manifest - The runner's package.json.
 * @returns {string} The exact version.
 */
export function pinnedPnpmVersion(manifest) {
  const declared = String(manifest?.packageManager ?? "").trim();
  const match = declared.match(/^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/);
  if (!match) {
    throw new Error(`frontend-qa/package.json must pin pnpm as "packageManager": "pnpm@<version>"; it says ${JSON.stringify(declared || null)}.`);
  }
  return match[1];
}

/**
 * The two commands of the install, in order. `npm` is named rather than
 * resolved so the caller can route it through `resolveSpawnInvocation`, which
 * on Windows runs npm's own entry point instead of `npm.cmd`; Playwright's CLI
 * is a plain script, run by this Node.
 *
 * @param {{ qaRoot: string, pnpmVersion: string, nodeExecutable?: string }} input
 * @returns {Array<{ label: string, command: string, args: string[], cwd: string }>}
 */
export function frontendQaInstallCommands({ qaRoot, pnpmVersion, nodeExecutable = process.execPath }) {
  return [
    {
      label: `pnpm@${pnpmVersion} install --frozen-lockfile`,
      command: "npm",
      args: ["exec", "--yes", `--package=pnpm@${pnpmVersion}`, "--", "pnpm", "install", "--frozen-lockfile"],
      cwd: qaRoot
    },
    {
      label: "playwright install chromium",
      command: nodeExecutable,
      args: [path.join(qaRoot, "node_modules", "playwright", "cli.js"), "install", "chromium"],
      cwd: qaRoot
    }
  ];
}

/**
 * Whether what is on disk counts as installed: the dependencies, and the
 * Chromium build this Playwright wants — one that launches, when the install
 * was asked for by name. Without the browser a rerun would skip the step as
 * "already built" while QA still could not start.
 *
 * @param {{ dependencies: boolean, status?: { chromium_available?: boolean, browser_launch_ok?: boolean } | null, requireLaunch?: boolean }} input
 * @returns {boolean}
 */
export function frontendQaInstalled({ dependencies, status, requireLaunch = false }) {
  return Boolean(dependencies && status?.chromium_available && (!requireLaunch || status?.browser_launch_ok));
}
