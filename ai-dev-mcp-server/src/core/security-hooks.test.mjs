import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installAgentHooks } from "./agent-hooks.mjs";
import { dependencyNote } from "../../hooks/post-edit.mjs";
import { SECURITY_SCAN_STAMP, porcelainPaths, unreviewedChanges } from "../../hooks/stop-check.mjs";
import {
  SUPPLY_CHAIN_DEFAULTS,
  checkSupplyChain,
  installSpecs,
  parseSpec,
  resolveVersion,
  supplyChainSettings,
  verdictFor
} from "../../hooks/supply-chain.mjs";

// The hooks that make "every change gets a security look" true without an
// agent having to remember it: the guard checks a package before an install
// runs it, post-edit flags a changed manifest, and the Stop hook sends the
// agent back when code changed after the last scan.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooksSourceDir = path.join(serverRoot, "hooks");
const NOW = Date.parse("2026-09-27T12:00:00Z");
const hoursAgo = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

test("the hooks' semver is a byte-for-byte copy of the server's", async () => {
  const server = await fs.readFile(path.join(serverRoot, "src", "core", "semver-lite.mjs"), "utf8");
  const hook = await fs.readFile(path.join(hooksSourceDir, "semver-lite.mjs"), "utf8");
  const body = hook.split("\n").slice(3).join("\n");
  assert.ok(hook.startsWith("// Below this comment, a byte-for-byte copy"), "the copy says what it is");
  assert.equal(body, server, "hooks/semver-lite.mjs has drifted from src/core/semver-lite.mjs: copy it again");
});

test("install commands are read for the registry packages they would fetch", () => {
  const specs = (command) => installSpecs(command.split(/\s+/)).map((item) => `${item.manager}:${item.name}@${item.want}`);
  assert.deepEqual(specs("npm install axios@1.14.1 lodash --save-dev"), ["npm:axios@1.14.1", "npm:lodash@latest"]);
  assert.deepEqual(specs("npm i -D @scope/pkg@^2.0.0"), ["npm:@scope/pkg@^2.0.0"]);
  assert.deepEqual(specs("npm --registry https://r.test install left-pad"), ["npm:left-pad@latest"], "an option's value is not a package");
  assert.deepEqual(specs("pnpm add -w --filter web react@18"), ["pnpm:react@18"]);
  assert.deepEqual(specs("yarn add typescript@next"), ["yarn:typescript@next"]);
  assert.deepEqual(specs("bun add zod"), ["bun:zod@latest"]);
  assert.deepEqual(specs("NODE_ENV=dev sudo npm i chalk"), ["npm:chalk@latest"]);
  assert.deepEqual(specs("npx -y create-vite@latest my-app --template react"), ["npm:create-vite@latest"], "an exec runs one package; the rest are its arguments");
  assert.deepEqual(specs("npx --package=cowsay@1.5.0 cowsay hi"), ["npm:cowsay@1.5.0", "npm:cowsay@latest"]);
  assert.deepEqual(specs("pnpm dlx degit user/repo"), ["pnpm:degit@latest"]);
  assert.deepEqual(specs("bunx prettier --write ."), ["bun:prettier@latest"]);
  assert.deepEqual(specs("npm i alias@npm:real-pkg@1.0.0"), ["npm:real-pkg@1.0.0"], "an alias installs the real package");
  // Nothing to look up: a lockfile install, scripts, local paths, git.
  for (const command of ["npm install", "npm ci", "pnpm install --frozen-lockfile", "npm test", "npm run build", "yarn", "npm i ./pkg ../other /abs file:x.tgz", "npm i github:user/repo user/repo git+https://x.test/r.git", "node npm.js add x", "npm i -- --weird"]) {
    assert.deepEqual(specs(command), [], command);
  }
  assert.equal(parseSpec("@scope/pkg@1.2.3").name, "@scope/pkg");
  assert.equal(parseSpec("https://example.test/p.tgz"), null);
  assert.equal(parseSpec("Not A Package!"), null);
});

test("a spec resolves to an exact version, a dist-tag, or the highest release a range allows", () => {
  const document = { "dist-tags": { latest: "2.1.0", next: "3.0.0-rc.1" }, versions: { "1.0.0": {}, "1.9.9": {}, "2.0.0": {}, "2.1.0": {}, "3.0.0-rc.1": {} } };
  assert.equal(resolveVersion(document, "1.9.9"), "1.9.9");
  assert.equal(resolveVersion(document, "latest"), "2.1.0");
  assert.equal(resolveVersion(document, "next"), "3.0.0-rc.1");
  assert.equal(resolveVersion(document, "^1.0.0"), "1.9.9");
  assert.equal(resolveVersion(document, "^4"), "");
});

test("settings come from the policy and can be switched off from the environment", () => {
  assert.deepEqual(supplyChainSettings({}, {}), SUPPLY_CHAIN_DEFAULTS);
  assert.equal(supplyChainSettings({ supply_chain: { min_release_age_hours: 72, osv: false } }, {}).min_release_age_hours, 72);
  assert.equal(supplyChainSettings({ supply_chain: { min_release_age_hours: -1, timeout_ms: "fast" } }, {}).min_release_age_hours, 24, "a nonsense value keeps the default");
  assert.equal(supplyChainSettings({ supply_chain: { enabled: false } }, {}).enabled, false);
  assert.equal(supplyChainSettings({}, { AI_DEV_SUPPLY_CHAIN: "off" }).enabled, false);
});

/** A registry and OSV that answer from a table, as fetch would. */
function fakeNetwork({ packages = {}, advisories = {}, osv = {}, fail = [] }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (fail.some((pattern) => url.includes(pattern))) throw new Error("getaddrinfo ENOTFOUND");
    if (url.endsWith("/-/npm/v1/security/advisories/bulk")) {
      const [[name, [version]]] = Object.entries(JSON.parse(options.body));
      return reply(200, { [name]: advisories[`${name}@${version}`] ?? [] });
    }
    if (url.endsWith("/v1/querybatch")) {
      const { package: { name }, version } = JSON.parse(options.body).queries[0];
      return reply(200, { results: [{ vulns: (osv[`${name}@${version}`] ?? []).map((id) => ({ id })) }] });
    }
    const name = decodeURIComponent(url.split("/").pop());
    return packages[name] ? reply(200, packages[name]) : reply(404, {});
  };
  return { fetchImpl, calls };
}

function registryDocument(versions, latest) {
  return {
    "dist-tags": { latest },
    versions: Object.fromEntries(Object.keys(versions).map((version) => [version, {}])),
    time: Object.fromEntries(Object.entries(versions).map(([version, hours]) => [version, hoursAgo(hours)]))
  };
}

const NETWORK = {
  packages: {
    axios: registryDocument({ "1.13.0": 4000, "1.14.0": 1500, "1.18.0": 700 }, "1.18.0"),
    keyv: registryDocument({ "5.5.0": 900, "6.0.0": 1000 }, "5.5.0"),
    fresh: registryDocument({ "1.0.0": 2000, "1.1.0": 3 }, "1.1.0"),
    weekold: registryDocument({ "2.0.0": 90 }, "2.0.0"),
    lodash: registryDocument({ "4.17.20": 40000, "4.17.21": 30000 }, "4.17.21"),
    typo: registryDocument({ "0.0.1": 5000 }, "0.0.1")
  },
  advisories: {
    "axios@1.14.1": [{ url: "https://github.com/advisories/GHSA-fw8c-xr5c-95f9", title: "Malware in axios", severity: "critical", vulnerable_versions: "=1.14.1" }],
    "lodash@4.17.20": [{ url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm", title: "Command Injection in lodash", severity: "high", vulnerable_versions: "<4.17.21" }]
  },
  osv: { "keyv@6.0.0": ["MAL-2026-11524"], "typo@0.0.1": ["MAL-2026-9999"] }
};

test("malware is refused whether GitHub or OSV knows it, even after npm unpublished it", async () => {
  const { fetchImpl } = fakeNetwork(NETWORK);
  const run = (command) => checkSupplyChain([command.split(/\s+/)], { fetchImpl, now: NOW, env: {} });

  // axios 1.14.1 is gone from the registry, as it is from the real one; the
  // exact version is still asked about, because a mirror may still serve it.
  const axios = await run("npm install axios@1.14.1");
  assert.equal(axios.blocks.length, 1);
  assert.match(axios.blocks[0], /^BLOCKED \(supply-chain\): axios@1\.14\.1 is reported as malware \(GHSA-fw8c-xr5c-95f9\)/);
  assert.ok(axios.warns.some((line) => /no longer in https:\/\/registry\.npmjs\.org; a mirror may still serve it/.test(line)));

  const keyv = await run("pnpm add keyv@6.0.0");
  assert.match(keyv.blocks[0], /keyv@6\.0\.0 is reported as malware \(MAL-2026-11524\)/, "an OSV report GitHub never published");
  const typo = await run("npm i typo");
  assert.match(typo.blocks[0], /typo@0\.0\.1 is reported as malware/, "a bare name resolves to latest and is checked");

  const osvOff = await checkSupplyChain([["pnpm", "add", "keyv@6.0.0"]], { fetchImpl, now: NOW, env: {}, policy: { supply_chain: { osv: false } } });
  assert.equal(osvOff.blocks.length, 0, "with OSV off, only GitHub's advisories are asked");
});

test("a release younger than a day is refused with an older version to pin; a week-old one is warned about", async () => {
  const { fetchImpl } = fakeNetwork(NETWORK);
  const fresh = await checkSupplyChain([["npm", "i", "fresh"]], { fetchImpl, now: NOW, env: {} });
  assert.equal(fresh.blocks.length, 1);
  assert.match(fresh.blocks[0], /fresh@1\.1\.0 was published 3 hour\(s\) ago\. Releases younger than 24 h are held back/);
  assert.match(fresh.blocks[0], /Pin fresh@1\.0\.0, wait until 2026-09-28T09:00:00Z/);
  assert.match(fresh.blocks[0], /allow_commands in \.ai-dev\/policy\.json/);

  const week = await checkSupplyChain([["npm", "i", "weekold"]], { fetchImpl, now: NOW, env: {} });
  assert.deepEqual(week.blocks, []);
  assert.match(week.warns[0], /weekold@2\.0\.0 is 3 day\(s\) old, younger than the 7-day quarantine/);

  const relaxed = await checkSupplyChain([["npm", "i", "fresh"]], { fetchImpl, now: NOW, env: {}, policy: { supply_chain: { min_release_age_hours: 0, warn_release_age_days: 0 } } });
  assert.deepEqual(relaxed, { blocks: [], warns: [] }, "a project can turn the quarantine off");
});

test("known vulnerabilities warn with the first safe release; what cannot be checked warns and never blocks", async () => {
  const { fetchImpl } = fakeNetwork({ ...NETWORK, fail: ["api.osv.dev"] });
  const lodash = await checkSupplyChain([["yarn", "add", "lodash@4.17.20"]], { fetchImpl, now: NOW, env: {} });
  assert.deepEqual(lodash.blocks, []);
  assert.ok(lodash.warns.some((line) => /lodash@4\.17\.20 has 1 known high or critical vulnerability \(GHSA-35jh-r3h4-6jhm\); lodash@4\.17\.21 is the first release outside them/.test(line)));
  assert.ok(lodash.warns.some((line) => /OSV could not be read: getaddrinfo ENOTFOUND/.test(line)));

  const missing = await checkSupplyChain([["npm", "i", "no-such-package"]], { fetchImpl, now: NOW, env: {} });
  assert.deepEqual(missing.blocks, []);
  assert.match(missing.warns[0], /not in https:\/\/registry\.npmjs\.org — a typo, a private package/);

  const offline = fakeNetwork({ fail: ["registry.npmjs.org", "api.osv.dev"] });
  const down = await checkSupplyChain([["npm", "i", "left-pad"]], { fetchImpl: offline.fetchImpl, now: NOW, env: {} });
  assert.deepEqual(down.blocks, [], "no answer is not a reason to refuse");
  assert.match(down.warns[0], /the registry could not be read/);
});

test("the guard asks nothing when there is nothing to ask, or when it is switched off", async () => {
  const { fetchImpl, calls } = fakeNetwork(NETWORK);
  assert.deepEqual(await checkSupplyChain([["npm", "ci"], ["npm", "run", "build"]], { fetchImpl, now: NOW, env: {} }), { blocks: [], warns: [] });
  assert.deepEqual(await checkSupplyChain([["npm", "i", "axios@1.14.1"]], { fetchImpl, now: NOW, env: { AI_DEV_SUPPLY_CHAIN: "0" } }), { blocks: [], warns: [] });
  assert.deepEqual(calls, []);
  const many = await checkSupplyChain([["npm", "i", "a1", "a2", "a3"]], { fetchImpl, now: NOW, env: {}, policy: { supply_chain: { max_packages: 2 } } });
  assert.ok(many.warns.some((line) => /only the first 2 of 3 packages/.test(line)));
  assert.deepEqual(verdictFor({ name: "p", want: "1", version: "1", published: "", malware: [], vulnerabilities: [], problems: [] }, SUPPLY_CHAIN_DEFAULTS, NOW), { blocks: [], warns: [] });
  const unchecked = verdictFor({
    name: "p", want: "1", version: "1", published: "", malware: [], vulnerabilities: [],
    problems: ["the registry could not be read: the proxy refused to connect to registry.npmjs.org:443 (HTTP 403).", "OSV could not be read: no answer in 3s"]
  }, SUPPLY_CHAIN_DEFAULTS, NOW);
  assert.deepEqual(unchecked.warns, [
    "[supply-chain] p@1 was not fully checked: the registry could not be read: the proxy refused to connect to registry.npmjs.org:443 (HTTP 403).",
    "[supply-chain] p@1 was not fully checked: OSV could not be read: no answer in 3s."
  ], "one full stop, not two");
});

test("a changed manifest or lockfile is a note to the agent; other edits are not", () => {
  assert.match(dependencyNote(["web/package.json", "src/app.ts"]), /^\[ai-dev security\] web\/package\.json changed what this project installs/);
  assert.match(dependencyNote(["pnpm-lock.yaml"]), /plan_security_fixes/);
  assert.equal(dependencyNote(["src/app.ts", "README.md"]), "");
});

async function project(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "security-hooks-"));
  t.after(() => fs.rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = await fs.realpath(created);
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "api.ts"), "export const a = 1;\n");
  const git = (...args) => spawnSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  return { root, projectRoot };
}

/** Run an installed hook as the harness does, without blocking this process's event loop. */
function runHook(projectRoot, script, args, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectRoot, ".ai-dev", "hooks", script), ...args], {
      cwd: projectRoot,
      env: { ...process.env, AI_DEV_STATE_ROOT: path.join(projectRoot, "..", "state"), AI_DEV_HOOK_PROFILE: "", ...env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ cwd: projectRoot, ...payload }));
  });
}

test("installed as a hook, the guard refuses malware before the install runs, and stays offline when minimal", async (t) => {
  const { projectRoot } = await project(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(request.url);
      response.setHeader("content-type", "application/json");
      if (request.url === "/axios") return response.end(JSON.stringify(registryDocument({ "1.14.0": 1500 }, "1.14.0")));
      if (request.url === "/-/npm/v1/security/advisories/bulk") {
        return response.end(JSON.stringify(body.includes("1.14.1") ? { axios: [{ url: "https://github.com/advisories/GHSA-fw8c-xr5c-95f9", title: "Malware in axios", severity: "critical", vulnerable_versions: "=1.14.1" }] } : {}));
      }
      if (request.url === "/v1/querybatch") return response.end(JSON.stringify({ results: [{ vulns: [] }] }));
      response.statusCode = 404;
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { npm_config_registry: base, AI_DEV_OSV_API: base };
  const bash = (command, extra = {}) => runHook(projectRoot, "guard.mjs", ["bash"], { tool_name: "Bash", tool_input: { command } }, { ...env, ...extra });

  const refused = await bash("cd web && npm install axios@1.14.1");
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /BLOCKED \(supply-chain\): axios@1\.14\.1 is reported as malware \(GHSA-fw8c-xr5c-95f9\)/);
  assert.ok(requests.includes("/v1/querybatch"), "OSV was asked too");

  const allowed = await bash("npm install axios@1.14.0");
  assert.equal(allowed.status, 0, allowed.stderr);

  requests.length = 0;
  const minimal = await bash("npm install axios@1.14.1", { AI_DEV_HOOK_PROFILE: "minimal" });
  assert.equal(minimal.status, 0);
  assert.deepEqual(requests, [], "the minimal profile keeps the guard off the network");
});

test("installed as hooks: post-edit flags a manifest, and Stop sends the agent back until a scan has seen the change", async (t) => {
  const { projectRoot } = await project(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });

  const edited = await runHook(projectRoot, "post-edit.mjs", [], { tool_name: "Edit", tool_input: { file_path: path.join(projectRoot, "package.json"), new_string: "{}" } });
  assert.equal(edited.status, 0);
  assert.equal(JSON.parse(edited.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(JSON.parse(edited.stdout).hookSpecificOutput.additionalContext, /package\.json changed what this project installs/);

  await fs.writeFile(path.join(projectRoot, "src", "api.ts"), "export const a = 2;\n");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# docs only\n");
  const stop = (payload = {}) => runHook(projectRoot, "stop-check.mjs", [], { hook_event_name: "Stop", ...payload });

  const sentBack = await stop();
  assert.equal(sentBack.status, 0);
  const decision = JSON.parse(sentBack.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /1 changed file\(s\) no security scan has seen: src\/api\.ts\. Run the ar-security-review skill/);
  assert.doesNotMatch(decision.reason, /README/, "documentation is not a security change");

  // The turn the agent was sent back for runs with stop_hook_active: no loop.
  assert.equal((await stop({ stop_hook_active: true })).stdout, "");

  // A scan newer than the change satisfies it.
  await fs.mkdir(path.join(projectRoot, ".ai-dev", "security"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, SECURITY_SCAN_STAMP), JSON.stringify({ at: new Date(Date.now() + 1000).toISOString() }));
  assert.equal((await stop()).stdout, "");
  assert.deepEqual(unreviewedChanges(projectRoot, ["src/api.ts"]), []);

  // "remind" tells the user on stderr instead of sending the agent back.
  await fs.writeFile(path.join(projectRoot, SECURITY_SCAN_STAMP), JSON.stringify({ at: "2000-01-01T00:00:00Z" }));
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  assert.equal(policy.security_review_on_stop, "block", "the installed default");
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, security_review_on_stop: "remind" }));
  const reminded = await stop();
  assert.equal(reminded.stdout, "");
  assert.match(reminded.stderr, /no security scan has seen: src\/api\.ts/);
});

// `git()` trims its output, so the first porcelain line lost its leading
// space and `slice(3)` turned ` M src/api.ts` into `rc/api.ts` — a file that
// does not exist, so the first changed file skipped every Stop check.
test("the Stop hook reads the first changed file too", async (t) => {
  assert.deepEqual(porcelainPaths("M src/api.ts\n M src/b.ts\n?? new file.ts\nR  old.ts -> new.ts\nA  \"quoted.ts\""), ["src/api.ts", "src/b.ts", "new file.ts", "new.ts", "quoted.ts"]);
  const { projectRoot } = await project(t);
  await fs.writeFile(path.join(projectRoot, "src", "b.ts"), "export const b = 1;\n");
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const git = (...args) => spawnSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", windowsHide: true });
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "hooks");
  await fs.writeFile(path.join(projectRoot, "src", "api.ts"), "export const a = 2;\nconsole.log(\"leak\");\n");
  await fs.writeFile(path.join(projectRoot, "src", "b.ts"), "export const b = 2;\nconsole.log(\"leak\");\n");
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  await fs.writeFile(policyPath, JSON.stringify({ ...JSON.parse(await fs.readFile(policyPath, "utf8")), security_review_on_stop: "off" }));
  const result = await runHook(projectRoot, "stop-check.mjs", [], { hook_event_name: "Stop" });
  assert.match(result.stderr, /console\.log in src\/api\.ts/, "the first file in git status");
  assert.match(result.stderr, /console\.log in src\/b\.ts/);
});
