import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  explicitRuntimeHome,
  legacyDoubledRuntimeRoot,
  resolveRuntimeStateRoot,
  resolveUserHome,
  sameDirectory
} from "./runtime-home.mjs";
import * as hookLib from "../../hooks/lib.mjs";

const HOME = path.resolve(path.join(path.sep, "tmp", "home-of-someone"));

test("without AI_DEV_HOME the runtime tree is <home>/.ai-dev", () => {
  assert.equal(resolveRuntimeStateRoot("", { HOME }), path.join(HOME, ".ai-dev"));
  assert.equal(resolveRuntimeStateRoot("", { USERPROFILE: HOME, HOME: "/elsewhere" }), path.join(HOME, ".ai-dev"), "USERPROFILE first, as on Windows");
  assert.equal(legacyDoubledRuntimeRoot({ HOME }), "");
});

test("AI_DEV_HOME is the runtime folder itself, as the documentation always said", () => {
  const env = { HOME, AI_DEV_HOME: "/data/runtime-home/.ai-dev" };
  assert.equal(resolveRuntimeStateRoot("", env), path.resolve("/data/runtime-home/.ai-dev"));
  assert.equal(legacyDoubledRuntimeRoot(env), path.join(path.resolve("/data/runtime-home/.ai-dev"), ".ai-dev"));
  assert.equal(resolveRuntimeStateRoot("", { HOME, AI_DEV_HOME: "relative/runtime" }), path.resolve("relative/runtime"));
  assert.equal(resolveRuntimeStateRoot("", { HOME, AI_DEV_HOME: "   " }), path.join(HOME, ".ai-dev"), "blank is unset");
});

test("AI_DEV_HOME naming the home directory keeps its 2.x meaning instead of scattering the tree", () => {
  for (const env of [{ HOME, AI_DEV_HOME: HOME }, { USERPROFILE: HOME, AI_DEV_HOME: `${HOME}${path.sep}` }]) {
    assert.equal(explicitRuntimeHome(env), "");
    assert.equal(resolveRuntimeStateRoot("", env), path.join(HOME, ".ai-dev"));
    assert.equal(legacyDoubledRuntimeRoot(env), "", "nothing to migrate: 2.x used <home>/.ai-dev too");
  }
});

test("the home is recognised however it is spelled: case on Windows and macOS, symlinks everywhere", () => {
  const asIs = { realpath: (value) => value };
  const cases = [
    { left: "C:\\Users\\Me", right: "c:\\users\\me", platform: "win32", same: true },
    { left: "C:\\Users\\Me", right: "C:/Users/Me/", platform: "win32", same: true },
    { left: "/Users/me", right: "/users/ME", platform: "darwin", same: true },
    { left: "/home/me", right: "/home/ME", platform: "linux", same: false },
    { left: "/home/me", right: "/home/me/../me", platform: "linux", same: true },
    { left: "/home/me", right: "/home/other", platform: "linux", same: false }
  ];
  for (const { left, right, platform, same } of cases) {
    assert.equal(sameDirectory(left, right, { platform, ...asIs }), same, `${platform}: ${left} ~ ${right}`);
    assert.equal(hookLib.sameDirectory(left, right, { platform, ...asIs }), same, `hooks, ${platform}: ${left} ~ ${right}`);
  }
  const linked = { platform: "linux", realpath: (value) => (value === "/links/home" ? "/real/home" : value) };
  assert.equal(sameDirectory("/real/home", "/links/home", linked), true);
  assert.equal(hookLib.sameDirectory("/real/home", "/links/home", linked), true);
  // On Windows the 2.x setup spelled differently still means <home>/.ai-dev.
  const env = { USERPROFILE: "C:\\Users\\Me", AI_DEV_HOME: "c:\\users\\me" };
  assert.equal(explicitRuntimeHome(env, { platform: "win32", ...asIs }), "");
});

test("a symlinked home named in AI_DEV_HOME keeps its 2.x meaning", (t) => {
  if (process.platform === "win32") {
    t.skip("creating a symlink needs a privilege Windows does not give by default");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-home-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real-home");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, "home-link"));
  const env = { HOME: path.join(root, "home-link"), AI_DEV_HOME: real };
  assert.equal(explicitRuntimeHome(env), "");
  assert.equal(resolveRuntimeStateRoot("", env), path.join(root, "home-link", ".ai-dev"));
  assert.equal(legacyDoubledRuntimeRoot(env), "", "nothing to migrate, and above all nothing moved into the home itself");
  withEnvironment({ HOME: env.HOME, USERPROFILE: undefined, AI_DEV_HOME: real }, () => {
    assert.equal(hookLib.explicitRuntimeHome(), "");
    assert.equal(hookLib.runtimeStateRoot(), resolveRuntimeStateRoot());
  });
});

test("the vault's parent is the home only when nothing names one", () => {
  assert.equal(resolveUserHome("/vaults/main", { HOME }), HOME);
  assert.equal(resolveUserHome("/vaults/main", {}), path.resolve("/vaults"));
  assert.equal(resolveUserHome("", {}), os.homedir());
});

function withEnvironment(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the hooks' copy names the same runtime tree as the server in every case (rule 3)", () => {
  const cases = [
    { AI_DEV_HOME: undefined, USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: "/data/runtime-home/.ai-dev", USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: "/opt/ai-dev-data", USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: HOME, USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: "relative/runtime", USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: undefined, USERPROFILE: HOME, HOME: "/elsewhere" }
  ];
  for (const env of cases) {
    withEnvironment(env, () => {
      assert.equal(hookLib.runtimeStateRoot(), resolveRuntimeStateRoot(), JSON.stringify(env));
      assert.equal(hookLib.explicitRuntimeHome(), explicitRuntimeHome(), JSON.stringify(env));
    });
  }
});
