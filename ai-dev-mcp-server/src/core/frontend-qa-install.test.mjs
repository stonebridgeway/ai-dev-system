import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { frontendQaInstallCommands, frontendQaInstalled, pinnedPnpmVersion } from "./frontend-qa-install.mjs";

const qaManifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend-qa", "package.json");

test("the pnpm version comes from the runner's packageManager, integrity suffix or not", () => {
  assert.equal(pinnedPnpmVersion({ packageManager: "pnpm@11.25.0" }), "11.25.0");
  assert.equal(pinnedPnpmVersion({ packageManager: "pnpm@11.25.0+sha512.0123abcd" }), "11.25.0");
  assert.equal(pinnedPnpmVersion({ packageManager: "pnpm@12.0.0-rc.1" }), "12.0.0-rc.1");
  for (const packageManager of [undefined, "", "npm@11.17.0", "pnpm@latest", "pnpm@11"]) {
    assert.throws(() => pinnedPnpmVersion({ packageManager }), /must pin pnpm/, String(packageManager));
  }
});

test("the shipped runner pins an exact pnpm", () => {
  const manifest = JSON.parse(fs.readFileSync(qaManifest, "utf8"));
  assert.match(pinnedPnpmVersion(manifest), /^\d+\.\d+\.\d+$/);
});

test("the install is the lockfile through the pinned pnpm, then Playwright's own Chromium", () => {
  const qaRoot = path.join(path.sep, "repo", "frontend-qa");
  const [install, browser] = frontendQaInstallCommands({ qaRoot, pnpmVersion: "11.25.0", nodeExecutable: "/usr/bin/node" });
  assert.equal(install.command, "npm", "named, so the caller routes it through the process-runner adapter");
  assert.deepEqual(install.args, ["exec", "--yes", "--package=pnpm@11.25.0", "--", "pnpm", "install", "--frozen-lockfile"]);
  assert.equal(install.cwd, qaRoot);
  assert.equal(browser.command, "/usr/bin/node");
  assert.deepEqual(browser.args, [path.join(qaRoot, "node_modules", "playwright", "cli.js"), "install", "chromium"]);
  assert.equal(browser.cwd, qaRoot);
  assert.equal(install.args.indexOf("install"), install.args.indexOf("pnpm") + 1, "pnpm installs; npm only fetches pnpm");
});

test("packages without the browser do not count as installed", () => {
  assert.equal(frontendQaInstalled({ dependencies: true, status: { chromium_available: true } }), true);
  assert.equal(frontendQaInstalled({ dependencies: true, status: { chromium_available: false } }), false);
  assert.equal(frontendQaInstalled({ dependencies: true, status: null }), false);
  assert.equal(frontendQaInstalled({ dependencies: false, status: { chromium_available: true } }), false);
});

test("asked for by name, installed means a browser that launches", () => {
  const onDiskOnly = { chromium_available: true, browser_launch_ok: false };
  assert.equal(frontendQaInstalled({ dependencies: true, status: onDiskOnly }), true, "unasked, the cheap check");
  assert.equal(frontendQaInstalled({ dependencies: true, status: onDiskOnly, requireLaunch: true }), false, "a browser that does not start is reinstalled and checked again");
  assert.equal(frontendQaInstalled({ dependencies: true, status: { chromium_available: true, browser_launch_ok: true }, requireLaunch: true }), true);
});
