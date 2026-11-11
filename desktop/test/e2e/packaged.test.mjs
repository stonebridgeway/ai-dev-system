import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { _electron as electron } from "playwright-core";
import { NO_SANDBOX, quitApp, shot, stage } from "./harness.mjs";

// The app as it is installed, not as a checkout runs it: the executable the
// build made (`npm run dist:linux` or `dist:mac`), named by
// AI_DEV_DESKTOP_PACKAGED. It must copy the runtime it ships into the AI Dev
// home, point the stable link at it, start the daemon on its own Node, and
// open — with no server, Node or vault of the test's. Skipped when no build
// is named (desktop-macos-linux.yml names one).

const packaged = process.env.AI_DEV_DESKTOP_PACKAGED;

test("the installed app copies its runtime, links it, and runs on it", { skip: !packaged && "no packaged app named (AI_DEV_DESKTOP_PACKAGED)", timeout: 300_000 }, async (t) => {
  const s = await stage(t);
  const env = { ...s.env };
  for (const name of ["AI_DEV_NODE", "AI_DEV_SERVER_ROOT", "AI_DEV_VAULT_ROOT"]) delete env[name];
  // An AppImage where FUSE 2 is missing runs unpacked (desktop-macos-linux.yml).
  if (process.env.APPIMAGE_EXTRACT_AND_RUN) env.APPIMAGE_EXTRACT_AND_RUN = process.env.APPIMAGE_EXTRACT_AND_RUN;
  const app = await electron.launch({ executablePath: path.resolve(packaged), args: NO_SANDBOX ? ["--no-sandbox"] : [], env, timeout: 120_000 });
  t.after(() => quitApp(app));
  const page = await app.firstWindow();
  await page.waitForSelector('[data-screen="wizard"], [data-screen="status"]', { timeout: 180_000 });
  await shot(page, `packaged-${process.platform}`);

  const current = path.join(s.home, ".ai-dev", "app", "current");
  const copy = await fs.realpath(current);
  assert.notEqual(copy, current, "current is a link to the copy");
  assert.match(path.basename(copy), /^\d+\.\d+\.\d+-[0-9a-f]{8,}$/, copy);
  const bundle = JSON.parse(await fs.readFile(path.join(copy, "bundle.json"), "utf8"));
  assert.equal(bundle.platform, process.platform);
  if (process.platform === "darwin") {
    // The workflow puts a download's quarantine on the shipped runtime: the copy does not carry it.
    const attributes = spawnSync("/usr/bin/xattr", ["-r", "-l", copy], { encoding: "utf8", shell: false });
    assert.equal(attributes.status, 0, attributes.stderr);
    assert.doesNotMatch(attributes.stdout, /com\.apple\.quarantine/);
  }
  // The command beside the link — on Windows its Node and CLI, which ai-dev.cmd runs: no shell reads anything here.
  const [command, ...words] = process.platform === "win32"
    ? [path.join(current, ...bundle.node.file.split("/")), path.join(current, "ai-dev-mcp-server", "bin", "ai-dev.mjs")]
    : [path.join(current, "ai-dev")];
  const ran = spawnSync(command, [...words, "version"], { encoding: "utf8", env: { ...env, AI_DEV_DAEMON: "0" }, shell: false });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`^ai-dev ${bundle.version} \\(Node ${bundle.node.version.replaceAll(".", "\\.")}, ${process.platform}-`));
  // The daemon the window talks to runs on the shipped Node, from the copy.
  const status = await app.evaluate(() => globalThis.aiDevTest.link.call("system_status", { checks: false }, { id: "test-packaged" }));
  assert.equal(status.ok, true, status.error);
  assert.equal(status.result.install.kind, "package");
  assert.equal(await fs.realpath(status.result.install.root), copy);
});
