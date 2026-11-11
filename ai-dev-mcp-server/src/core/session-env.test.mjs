import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { userHomeDirectory } from "./project-identity.mjs";
import {
  DAEMON_WIDE_VARIABLES,
  NOT_DAEMON_WIDE,
  absolutePathVariables,
  currentSessionEnvironment,
  daemonIdentity,
  daemonWideEnvironment,
  environmentObject,
  isDaemonWide,
  runInSession,
  scopeProcessEnvironment
} from "./session-env.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repositoryRoot = path.dirname(serverRoot);

test("what clients of one daemon must share is where the data is and which model it loads; their programs and network are their own", () => {
  for (const name of ["AI_DEV_HOME", "HOME", "USERPROFILE", "AI_DEV_VAULT_ROOT", "BGE_M3_ONNX_DIR", "AI_DEV_MODEL_MANIFEST", "AI_DEV_RUNTIME"]) {
    assert.equal(isDaemonWide(name, { platform: "linux" }), true, name);
  }
  for (const name of ["PATH", "Path", "PATHEXT", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_OPTIONS", "APPDATA", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HF_ENDPOINT", "PLAYWRIGHT_BROWSERS_PATH",
    "AI_DEV_PROFILES", "AI_DEV_OFFLINE", "AI_DEV_MODEL_MIRROR", "AI_DEV_DAEMON", "AI_DEV_IDLE_TIMEOUT_MS", "AI_DEV_HOOK_PROFILE", "AI_DEV_IMAGE",
    // The desktop app's own: the app and the clients share one daemon whatever they say.
    "AI_DEV_SERVER_ROOT", "AI_DEV_DESKTOP_TEST", "AI_DEV_DESKTOP_DEVTOOLS", "AI_DEV_DESKTOP_NO_SANDBOX", "AI_DEV_DESKTOP_BUNDLE", "AI_DEV_DESKTOP_UPDATES", "AI_DEV_NODE"]) {
    assert.equal(isDaemonWide(name, { platform: "linux" }), false, name);
  }
  assert.equal(isDaemonWide("AI_DEV_NOT_YET_KNOWN", { platform: "linux" }), true, "an unlisted AI Dev variable splits the daemon rather than leaks");
  assert.equal(isDaemonWide("ai_dev_home", { platform: "linux" }), false, "Linux names are case-sensitive");
  assert.equal(isDaemonWide("Ai_Dev_Home", { platform: "win32" }), true, "Windows names are not");

  assert.deepEqual(daemonWideEnvironment({ PATH: "/bin", HOME: "/h", AI_DEV_VAULT_ROOT: "/v", AI_DEV_STATE_ROOT: " ", AI_DEV_PROFILES: "core", B: undefined }, { platform: "linux" }),
    [["AI_DEV_VAULT_ROOT", "/v"], ["HOME", "/h"]]);
  assert.deepEqual(daemonWideEnvironment({ UserProfile: "C:\\Users\\i", Ai_Dev_Home: "D:\\ai" }, { platform: "win32" }),
    [["AI_DEV_HOME", "D:\\ai"], ["USERPROFILE", "C:\\Users\\i"]], "the same build whatever case a client spells the names in");
});

test("every AI_DEV_ and BGE_ variable the code names is classified on purpose", () => {
  const classified = new Set([...DAEMON_WIDE_VARIABLES, ...Object.values(NOT_DAEMON_WIDE).flat()]);
  const named = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:mjs|js|sh|ps1|cs)$/.test(entry.name) && !entry.name.endsWith(".test.mjs")) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(/\b((?:AI_DEV|BGE_M3)_[A-Z0-9_]*[A-Z0-9])\b/g)) {
          if (!named.has(match[1])) named.set(match[1], path.relative(repositoryRoot, full));
        }
      }
    }
  };
  for (const directory of ["src", "hooks", "bin", "scripts"]) walk(path.join(serverRoot, directory));
  walk(path.join(repositoryRoot, "docker"));
  // The desktop app passes its environment to the daemon's transport too.
  for (const directory of ["src", "scripts", "test"]) {
    if (fs.existsSync(path.join(repositoryRoot, "desktop", directory))) walk(path.join(repositoryRoot, "desktop", directory));
  }
  for (const file of ["bootstrap.sh", "bootstrap.ps1"]) {
    const full = path.join(repositoryRoot, file);
    if (!fs.existsSync(full)) continue;
    for (const match of fs.readFileSync(full, "utf8").matchAll(/\b((?:AI_DEV|BGE_M3)_[A-Z0-9_]*[A-Z0-9])\b/g)) named.set(match[1], file);
  }
  const unclassified = [...named].filter(([name]) => !classified.has(name)).map(([name, where]) => `${name} (${where})`);
  assert.deepEqual(unclassified, [], "list each in session-env.mjs: daemon-wide, or one of NOT_DAEMON_WIDE's groups");
  assert.ok(named.size > 40, `found ${named.size} names`);
});

test("a relative path in the environment means for the daemon what it means for the client", () => {
  assert.deepEqual(absolutePathVariables({ AI_DEV_HOME: "rel/home", AI_DEV_VAULT_ROOT: "/abs/vault", PATH: "bin:/usr/bin", AI_DEV_PROFILES: "core", CODEX_HOME: "./codex", EMPTY: "" }, { cwd: "/work/client", platform: "linux" }),
    { AI_DEV_HOME: "/work/client/rel/home", AI_DEV_VAULT_ROOT: "/abs/vault", PATH: "bin:/usr/bin", AI_DEV_PROFILES: "core", CODEX_HOME: "/work/client/codex", EMPTY: "" });
  assert.deepEqual(absolutePathVariables({ Ai_Dev_Home: "home", NODE_EXTRA_CA_CERTS: "C:\\certs\\ca.pem" }, { cwd: "D:\\work", platform: "win32" }),
    { Ai_Dev_Home: "D:\\work\\home", NODE_EXTRA_CA_CERTS: "C:\\certs\\ca.pem" });
});

test("a session's environment behaves as process.env does: strings, and on Windows names that ignore case", () => {
  const unix = environmentObject({ PATH: "/bin", N: 3, GONE: undefined }, { platform: "linux" });
  assert.equal(unix.PATH, "/bin");
  assert.equal(unix.N, "3");
  assert.equal(unix.path, undefined);
  assert.deepEqual(Object.keys(unix), ["PATH", "N"]);
  assert.deepEqual({ ...unix }, { PATH: "/bin", N: "3" });
  unix.ADDED = 1;
  assert.equal(unix.ADDED, "1");
  delete unix.N;
  assert.equal("N" in unix, false);
  assert.equal(typeof unix.toString, "function", "what an object has, it still has");

  const windows = environmentObject({ Path: "C:\\bin", SystemRoot: "C:\\Windows" }, { platform: "win32" });
  assert.equal(windows.PATH, "C:\\bin");
  assert.equal(windows.path, "C:\\bin");
  assert.equal("PATH" in windows, true);
  windows.PATH = "D:\\bin";
  assert.deepEqual(Object.keys(windows), ["Path", "SystemRoot"], "the name keeps the case it came with");
  assert.equal(windows.Path, "D:\\bin");
});

test("process.env is the session's inside it and the process's own outside", async () => {
  const target = { env: { PATH: "/daemon/bin", OWN: "daemon" } };
  scopeProcessEnvironment(target);
  scopeProcessEnvironment(target);
  const session = environmentObject({ PATH: "/client/bin", TOKEN: "client" });
  assert.equal(target.env.PATH, "/daemon/bin");
  assert.equal(currentSessionEnvironment(), null);
  await runInSession(session, async () => {
    assert.equal(target.env.PATH, "/client/bin");
    assert.equal(target.env.OWN, undefined, "nothing of the daemon's own leaks into the session");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(target.env.TOKEN, "client", "and it stays the session's across awaits and timers");
    target.env.WRITTEN = "in session";
    assert.deepEqual(Object.keys(target.env).sort(), ["PATH", "TOKEN", "WRITTEN"]);
    assert.equal(currentSessionEnvironment(), session);
  });
  assert.equal(target.env.WRITTEN, undefined, "a session's write stays in the session");
  assert.equal(session.WRITTEN, "in session");
  assert.deepEqual({ ...target.env }, { PATH: "/daemon/bin", OWN: "daemon" });
});

test("a child process started in a session, without an env of its own, gets the session's environment", () => {
  scopeProcessEnvironment();
  const probe = ["-e", "process.stdout.write(`${process.env.AI_DEV_SESSION_PROBE ?? 'none'}|${process.env.ONLY_DAEMON ?? 'none'}`)"];
  process.env.ONLY_DAEMON = "daemon";
  try {
    const session = environmentObject({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AI_DEV_SESSION_PROBE: "client-a" });
    const inside = runInSession(session, () => spawnSync(process.execPath, probe, { encoding: "utf8" }).stdout);
    assert.equal(inside, "client-a|none");
    assert.equal(spawnSync(process.execPath, probe, { encoding: "utf8" }).stdout, "none|daemon");
  } finally {
    delete process.env.ONLY_DAEMON;
  }
});

test("the identity a build carries is where the data is, resolved as the server resolves it", () => {
  const identity = (env, platform = "linux", execPath = "/usr/bin/node") => daemonIdentity({ serverRoot, env, platform, execPath });
  // The runtime folder is resolved on this machine's paths, as the server it
  // describes resolves it: each system's names are checked on that system.
  const windows = process.platform === "win32";
  const [here, onThis] = windows
    ? [{ USERPROFILE: "C:\\Users\\Ivan", AI_DEV_VAULT_ROOT: "D:\\Vault" }, (env) => identity(env, "win32", "C:\\node.exe")]
    : [{ HOME: "/home/ivan", AI_DEV_VAULT_ROOT: "/data/vault" }, (env) => identity(env)];
  const named = onThis(here);
  const home = windows ? "c:/users/ivan/.ai-dev" : "/home/ivan/.ai-dev";
  assert.equal(named.AI_DEV_HOME, home);
  assert.equal(named.AI_DEV_VAULT_ROOT, windows ? "d:/vault" : "/data/vault");
  assert.equal(named.AI_DEV_SEARCH_INDEX_DIR, `${home}/cache/search-index`);
  assert.equal(named.BGE_M3_ONNX_DIR, `${home}/models/bge-m3-onnx`);
  assert.equal(named.BGE_M3_DEVICE, "cpu");
  const trailing = windows
    ? { USERPROFILE: "C:\\Users\\Ivan\\", AI_DEV_VAULT_ROOT: "d:\\vault\\" }
    : { HOME: "/home/ivan/", AI_DEV_VAULT_ROOT: "/data/vault/" };
  assert.deepEqual(onThis({ ...trailing, BGE_M3_DEVICE: "cpu", AI_DEV_DENSE_BACKEND: "" }), named);
  assert.equal(onThis({ ...here, AI_DEV_NEW_THING: "1" }).AI_DEV_NEW_THING, "1", "an unlisted variable, as written");
  assert.equal(onThis({ ...here, AI_DEV_PROFILES: "core" }).AI_DEV_PROFILES, undefined, "a session's variable is not the daemon's");
  // The home rule is the server's own, on either system.
  for (const [env, platform] of [[{ HOME: "/h", USERPROFILE: "/p" }, "linux"], [{ USERPROFILE: "C:\\Users\\i", HOME: "C:\\msys\\home" }, "win32"], [{ HOME: "C:\\only-home" }, "win32"]]) {
    const expected = userHomeDirectory({ env, platform });
    const paths = platform === "win32" ? path.win32 : path.posix;
    assert.equal(identity(env, platform, "C:\\node.exe")["the home folder"], paths.resolve(expected).replaceAll("\\", "/")[platform === "win32" ? "toLowerCase" : "toString"](), JSON.stringify(env));
  }
});

test("a data folder under a link is one folder before it exists and after; a Windows name is read without case", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "real"));
  fs.symlinkSync(path.join(root, "real"), path.join(root, "link"), "dir");
  const identity = (home) => daemonIdentity({ serverRoot, env: { HOME: "/home/ivan", AI_DEV_HOME: home, AI_DEV_VAULT_ROOT: "/data/vault" }, platform: process.platform });
  const before = identity(path.join(root, "link", "aidev"));
  for (const folder of ["aidev", path.join("aidev", "state"), path.join("aidev", "models", "bge-m3-onnx")]) {
    fs.mkdirSync(path.join(root, "real", folder), { recursive: true });
    assert.deepEqual(identity(path.join(root, "link", "aidev")), before, `after ${folder} appears`);
  }
  assert.deepEqual(identity(path.join(root, "real", "aidev")), before, "the link and the folder it names are one");

  // The bridge hashes a plain copy, the Windows daemon its own case-blind environment.
  const windows = (env) => daemonIdentity({ serverRoot, env, platform: "win32", execPath: "C:\\node.exe" });
  const client = (vault) => ({ USERPROFILE: "C:\\Users\\me", Ai_Dev_Vault_Root: vault });
  assert.deepEqual(windows(client("D:\\VaultA")), windows(environmentObject(client("D:\\VaultA"), { platform: "win32" })));
  assert.notDeepEqual(windows(client("D:\\VaultA")), windows(client("D:\\VaultB")));

  // Where `USERPROFILE` is another folder than the home, it is a part of its own.
  const posix = (env) => daemonIdentity({ serverRoot, env: { AI_DEV_HOME: "/data/ai", AI_DEV_VAULT_ROOT: "/data/vault", ...env }, platform: "linux", execPath: "/usr/bin/node" });
  assert.notDeepEqual(posix({ HOME: "/home/a", USERPROFILE: "/mnt/c/Users/a" }), posix({ HOME: "/home/a", USERPROFILE: "/mnt/c/Users/b" }));
  assert.equal(posix({ HOME: "/home/a" }).USERPROFILE, undefined, "and no part at all where it is not set");
});

test("of two spellings of one name on Windows, the one Node's spawn passes on is the one read, in any order", () => {
  const orders = [
    [["bge_m3_onnx_dir", "C:\\lower"], ["Bge_M3_Onnx_Dir", "C:\\mixed"]],
    [["Bge_M3_Onnx_Dir", "C:\\mixed"], ["bge_m3_onnx_dir", "C:\\lower"]]
  ];
  for (const entries of orders) {
    const env = Object.fromEntries(entries);
    // What spawn keeps on Windows: the first in sorted order (lib/child_process.js).
    const kept = Object.keys(env).sort()[0];
    assert.equal(kept, "Bge_M3_Onnx_Dir");
    assert.equal(environmentObject(env, { platform: "win32" }).BGE_M3_ONNX_DIR, "C:\\mixed", JSON.stringify(entries));
    assert.deepEqual(daemonWideEnvironment(env, { platform: "win32" }), [["BGE_M3_ONNX_DIR", "C:\\mixed"]]);
  }
  // An upper-case spelling sorts before every other.
  const both = { Bge_M3_Onnx_Dir: "C:\\mixed", BGE_M3_ONNX_DIR: "C:\\upper" };
  assert.equal(environmentObject(both, { platform: "win32" }).BGE_M3_ONNX_DIR, "C:\\upper");
  assert.equal(daemonIdentity({ serverRoot, env: { ...both, HOME: "C:\\Users\\me", USERPROFILE: "C:\\Users\\me" }, platform: "win32" }).BGE_M3_ONNX_DIR, "c:/upper");
});

test("the daemon's process.env cannot be frozen, and shows what it holds", () => {
  const target = { env: { PATH: "/daemon/bin" } };
  scopeProcessEnvironment(target);
  assert.throws(() => Object.preventExtensions(target.env), TypeError, "as the real one refuses");
  assert.throws(() => Object.freeze(target.env), TypeError);
  assert.deepEqual(Object.keys(target.env), ["PATH"], "and its listing still works after the attempt");
  assert.match(inspect(target.env), /PATH: '\/daemon\/bin'/);
  const session = environmentObject({ TOKEN: "x" });
  assert.match(inspect(session), /TOKEN: 'x'/);
  assert.throws(() => Object.preventExtensions(session), TypeError);
  runInSession(session, () => assert.match(inspect(target.env), /TOKEN: 'x'/));
});
