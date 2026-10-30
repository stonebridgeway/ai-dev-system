import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFixPlan, groupFindings, renderFixPlanMarkdown } from "./security-fix-plan.mjs";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

async function project(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fix-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return root;
}

/** A registry that knows these packages, all published long enough ago. */
function registry(packages) {
  const calls = [];
  const fetchMetadata = async (name) => {
    calls.push(name);
    const versions = packages[name];
    if (!versions) return { ok: false, reason: `${name} answered 404` };
    return { ok: true, versions: Object.keys(versions), time: Object.fromEntries(Object.entries(versions).map(([v, age]) => [v, daysAgo(age)])), deprecated: {} };
  };
  return { fetchMetadata, calls };
}

function finding(overrides) {
  return { tool: "npm audit", kind: "dependency", severity: "high", file: "package-lock.json", line: 0, message: "m", rule: "GHSA-aaaa-bbbb-cccc", package: "p", version: "", vulnerable: "", fixed_in: "", aliases: [], ...overrides };
}

// An old lockfile of ai-dev-mcp-server, reduced to the four packages
// that were vulnerable and the parents that asked for them.
const OLD_LOCKFILE = {
  "package.json": { name: "server", dependencies: { "@modelcontextprotocol/sdk": "1.30.0", "@huggingface/transformers": "3.7.5" } },
  "package-lock.json": {
    lockfileVersion: 3,
    packages: {
      "": { name: "server", dependencies: { "@modelcontextprotocol/sdk": "1.30.0", "@huggingface/transformers": "3.7.5" } },
      "node_modules/@modelcontextprotocol/sdk": { version: "1.30.0", dependencies: { ajv: "^8.17.1", hono: "^4.11.4" } },
      "node_modules/ajv": { version: "8.20.0", dependencies: { "fast-uri": "^3.0.1" } },
      "node_modules/fast-uri": { version: "3.1.4" },
      "node_modules/hono": { version: "4.12.32" },
      "node_modules/@huggingface/transformers": { version: "3.7.5", dependencies: { sharp: "^0.34.1" } },
      "node_modules/sharp": { version: "0.34.5" }
    }
  }
};
const OLD_LOCKFILE_FINDINGS = [
  finding({ package: "fast-uri", rule: "GHSA-7p8r-x3mc-p8w7", vulnerable: ">=3.0.0 <3.1.5" }),
  finding({ package: "fast-uri", rule: "GHSA-f65p-4m7j-42xc", vulnerable: ">=3.0.0 <3.1.6" }),
  finding({ package: "sharp", rule: "GHSA-rgj7-g3m4-5g8c", vulnerable: "<0.35.4" }),
  finding({ package: "hono", rule: "GHSA-gqvv-2mrq-wpjv", severity: "medium", vulnerable: "<4.13.5" })
];
const OLD_LOCKFILE_REGISTRY = {
  "fast-uri": { "3.1.4": 90, "3.1.5": 58, "3.1.6": 35, "3.1.8": 12 },
  sharp: { "0.34.5": 300, "0.35.0": 60, "0.35.4": 32, "0.35.5-rc.1": 0 },
  hono: { "4.12.32": 60, "4.13.5": 20, "4.13.9": 3 }
};

test("a vulnerable lockfile as a plan: in-range updates for what the parents allow, an override for what they do not", async (t) => {
  const root = await project(t, OLD_LOCKFILE);
  const { fetchMetadata } = registry(OLD_LOCKFILE_REGISTRY);
  const plan = await buildFixPlan({ projectRoot: root, findings: OLD_LOCKFILE_FINDINGS, fetchMetadata, now: NOW });
  const byName = Object.fromEntries(plan.items.map((item) => [item.package, item]));

  assert.deepEqual(
    { action: byName["fast-uri"].action, target: byName["fast-uri"].target, upgrade: byName["fast-uri"].upgrade, commands: byName["fast-uri"].commands },
    { action: "update-in-range", target: "3.1.6", upgrade: "patch", commands: ["npm update fast-uri --before=2026-09-20"] },
    "the command that fixed it by hand"
  );
  assert.equal(byName.hono.action, "update-in-range");
  assert.equal(byName.hono.target, "4.13.5", "4.13.9 is three days old");

  const sharp = byName.sharp;
  assert.equal(sharp.action, "override");
  assert.equal(sharp.target, "0.35.4", "not the release candidate");
  assert.equal(sharp.breaking, true, "0.34 → 0.35 is a breaking upgrade below 1.0.0");
  assert.deepEqual(sharp.manifest_change, { file: "package.json", path: ["overrides", "sharp"], value: "0.35.4" });
  assert.deepEqual(sharp.commands, ["npm install --before=2026-09-20"]);
  assert.ok(sharp.notes.some((note) => /Dependents ask for \^0\.34\.1/.test(note)));
  assert.ok(sharp.notes.some((note) => /outlives its reason/.test(note)));

  assert.deepEqual(plan.summary, { items: 3, malware: 0, breaking: 1, no_fix: 0, overrides: 1 });
  assert.equal(plan.registry, "asked");
  // In-range updates first, overrides after: the cheap, certain changes lead.
  assert.deepEqual(plan.items.map((item) => item.action), ["update-in-range", "update-in-range", "override"]);
});

test("a direct dependency is upgraded where it is declared, dev dependencies as dev", async (t) => {
  const root = await project(t, {
    "web/package.json": { dependencies: { lodash: "^4.17.0" }, devDependencies: { minimist: "1.2.5" } },
    "web/pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.20:\n    resolution: {integrity: sha512-x}\n\n  minimist@1.2.5:\n    resolution: {integrity: sha512-y}\n"
  });
  const { fetchMetadata } = registry({ lodash: { "4.17.20": 900, "4.17.21": 800, "4.18.1": 100 }, minimist: { "1.2.5": 900, "1.2.6": 800 } });
  const plan = await buildFixPlan({
    projectRoot: root,
    findings: [
      finding({ tool: "pnpm audit", file: "web/pnpm-lock.yaml", package: "lodash", version: "4.17.20", vulnerable: "<=4.17.23", rule: "GHSA-r5fr-rjxr-66jc" }),
      finding({ tool: "pnpm audit", file: "web/pnpm-lock.yaml", package: "minimist", severity: "critical", vulnerable: ">=1.0.0 <1.2.6", rule: "GHSA-xvch-5gv4-984h" })
    ],
    fetchMetadata,
    now: NOW
  });
  const [minimist, lodash] = plan.items;
  assert.deepEqual(minimist.installed, ["1.2.5"], "the version comes from pnpm-lock.yaml when the finding has none");
  assert.deepEqual(minimist.commands, ["pnpm add minimist@1.2.6 --save-dev"]);
  assert.equal(lodash.target, "4.18.1");
  assert.equal(lodash.declared_range, "^4.17.0");
  assert.deepEqual(lodash.commands, ["pnpm add lodash@4.18.1"]);
  assert.match(renderFixPlanMarkdown(plan), /`pnpm add lodash@4\.18\.1` \(in web\/\)/);
});

test("pnpm cannot say what dependents accept, so a transitive fix is an override, and says why", async (t) => {
  const root = await project(t, {
    "package.json": { dependencies: { ajv: "8.17.1" } },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n\n  fast-uri@3.1.4:\n    resolution: {integrity: sha512-z}\n"
  });
  const { fetchMetadata } = registry({ "fast-uri": { "3.1.4": 90, "3.1.6": 35 } });
  const plan = await buildFixPlan({ projectRoot: root, findings: [finding({ tool: "pnpm audit", file: "pnpm-lock.yaml", package: "fast-uri", vulnerable: ">=3.0.0 <3.1.6" })], fetchMetadata, now: NOW });
  const [item] = plan.items;
  assert.equal(item.action, "override");
  assert.deepEqual(item.manifest_change.path, ["pnpm", "overrides", "fast-uri"]);
  assert.deepEqual(item.commands, ["pnpm install"]);
  assert.ok(item.notes.some((note) => /pnpm records resolved versions/.test(note)));
});

test("Yarn 2+ updates a transitive package in range with yarn up -R; Yarn 1 and Bun override", async (t) => {
  const yarnLock = "__metadata:\n  version: 8\n\n\"fast-uri@npm:^3.0.1\":\n  version: 3.1.4\n  resolution: \"fast-uri@npm:3.1.4\"\n";
  const berry = await project(t, { "package.json": { packageManager: "yarn@4.10.3" }, "yarn.lock": yarnLock });
  const classic = await project(t, { "package.json": {}, "yarn.lock": "fast-uri@^3.0.1:\n  version \"3.1.4\"\n" });
  const bun = await project(t, {
    "package.json": {},
    "bun.lock": "{\n  \"lockfileVersion\": 1,\n  \"workspaces\": { \"\": { \"dependencies\": { \"ajv\": \"8.17.1\", }, }, },\n  \"packages\": {\n    \"ajv\": [\"ajv@8.17.1\", \"\", { \"dependencies\": { \"fast-uri\": \"^3.0.1\" } }, \"sha512-a\"],\n    \"fast-uri\": [\"fast-uri@3.1.4\", \"\", {}, \"sha512-b\"],\n  }\n}\n"
  });
  const { fetchMetadata } = registry({ "fast-uri": { "3.1.4": 90, "3.1.6": 35 } });
  const plan = async (root, file) => (await buildFixPlan({ projectRoot: root, findings: [finding({ file, package: "fast-uri", vulnerable: ">=3.0.0 <3.1.6" })], fetchMetadata, now: NOW })).items[0];

  const up = await plan(berry, "yarn.lock");
  assert.equal(up.action, "update-in-range");
  assert.deepEqual(up.commands, ["yarn up -R fast-uri"]);
  const resolutions = await plan(classic, "yarn.lock");
  assert.equal(resolutions.action, "override");
  assert.deepEqual(resolutions.manifest_change.path, ["resolutions", "fast-uri"]);
  const overrides = await plan(bun, "bun.lock");
  assert.equal(overrides.action, "override");
  assert.deepEqual(overrides.installed, ["3.1.4"], "bun.lock names the installed version bun audit does not");
  assert.deepEqual(overrides.manifest_change.path, ["overrides", "fast-uri"]);
  assert.deepEqual(overrides.commands, ["bun install"]);
});

test("malware leads the plan: replaced when a safe version exists, removed through its parent when none does", async (t) => {
  const root = await project(t, {
    "package.json": { dependencies: { axios: "1.14.1" } },
    "package-lock.json": {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { axios: "1.14.1" } },
        "node_modules/axios": { version: "1.14.1", dependencies: { "plain-crypto-js": "^4.2.0", lodash: "^4.17.0" } },
        "node_modules/plain-crypto-js": { version: "4.2.1" },
        "node_modules/lodash": { version: "4.17.20" }
      }
    }
  });
  const { fetchMetadata } = registry({ axios: { "1.14.0": 200, "1.14.1": 180, "1.18.0": 30 }, "plain-crypto-js": { "4.2.0": 181, "4.2.1": 180 }, lodash: { "4.17.20": 900, "4.17.21": 800 } });
  const plan = await buildFixPlan({
    projectRoot: root,
    findings: [
      finding({ package: "lodash", severity: "critical", vulnerable: "<4.17.21" }),
      finding({ package: "plain-crypto-js", kind: "malware", severity: "critical", vulnerable: ">=0", rule: "GHSA-2x9r-6wxq-hrr7" }),
      finding({ package: "axios", kind: "malware", severity: "critical", vulnerable: "=1.14.1", rule: "GHSA-fw8c-xr5c-95f9" })
    ],
    fetchMetadata,
    now: NOW
  });
  assert.deepEqual(plan.items.map((item) => [item.package, item.action]), [
    ["plain-crypto-js", "remove-malware"],
    ["axios", "replace-malware"],
    ["lodash", "update-in-range"]
  ]);
  const [dropper, axios] = plan.items;
  assert.deepEqual(dropper.commands, [], "a transitive package is removed through its parent");
  assert.ok(dropper.notes.some((note) => /npm ls plain-crypto-js/.test(note)));
  assert.ok(dropper.notes.some((note) => /rotate every credential/.test(note)));
  assert.equal(axios.target, "1.18.0", "above the malicious version, not below it");
  assert.deepEqual(axios.commands, ["npm install axios@1.18.0 --before=2026-09-20"]);
  assert.equal(plan.summary.malware, 2);
  const markdown = renderFixPlanMarkdown(plan);
  assert.match(markdown, /\*\*2 malicious package\(s\)\.\*\*/);
  assert.match(markdown, /\| 1 \| plain-crypto-js \(critical\) \| package-lock\.json \| 4\.2\.1 \| remove-malware \| — \| \*\*malware\*\* \|/);
  assert.match(markdown, /\| lodash \(critical\) .* \| update-in-range \| ≥ 4\.17\.21 \|/);
});

test("offline, the plan uses the fixes the advisories name, and says their age is unchecked", async (t) => {
  const root = await project(t, OLD_LOCKFILE);
  const { fetchMetadata, calls } = registry(OLD_LOCKFILE_REGISTRY);
  const plan = await buildFixPlan({
    projectRoot: root,
    findings: [finding({ package: "fast-uri", vulnerable: ">=3.0.0 <3.1.6", fixed_in: "3.1.6" }), finding({ package: "hono", vulnerable: "<4.13.5" })],
    offline: true,
    fetchMetadata,
    now: NOW
  });
  assert.deepEqual(calls, [], "offline asks nobody");
  assert.equal(plan.registry, "not asked (offline)");
  const byName = Object.fromEntries(plan.items.map((item) => [item.package, item]));
  assert.equal(byName["fast-uri"].target, "3.1.6");
  assert.equal(byName["fast-uri"].target_source, "advisory");
  assert.equal(byName.hono.action, "no-fix", "npm audit named no fix for hono, and the registry was not asked");
  assert.equal(plan.summary.no_fix, 1);
});

test("a registry that cannot answer is named in the plan, and the package is not guessed at", async (t) => {
  const root = await project(t, OLD_LOCKFILE);
  const plan = await buildFixPlan({ projectRoot: root, findings: [finding({ package: "hono", vulnerable: "<4.13.5" })], fetchMetadata: async () => ({ ok: false, reason: "https://registry.npmjs.org/hono answered 503" }), now: NOW });
  assert.match(plan.registry, /partly unavailable: https:\/\/registry\.npmjs\.org\/hono answered 503/);
  assert.equal(plan.items[0].action, "no-fix");
  assert.ok(plan.items[0].notes.some((note) => /answered 503/.test(note)));
});

test("only package findings in a known lockfile are planned", () => {
  const groups = groupFindings([
    finding({ package: "a" }),
    finding({ package: "a", rule: "GHSA-2" }),
    finding({ package: "a", file: "web/package-lock.json" }),
    finding({ package: "b", tool: "trivy fs", file: "Dockerfile" }),
    { tool: "gitleaks", kind: "secret", severity: "critical", file: ".env", line: 1, message: "m", rule: "aws" },
    finding({ package: "", file: "package-lock.json" }),
    finding({ kind: "sast", package: "c" })
  ]);
  assert.deepEqual([...groups.keys()], ["package-lock.json|a", "web/package-lock.json|a"]);
  assert.equal(groups.get("package-lock.json|a").findings.length, 2);
  assert.equal(groupFindings(undefined).size, 0);
});

test("an empty plan says there is nothing to plan", async (t) => {
  const root = await project(t, {});
  const plan = await buildFixPlan({ projectRoot: root, findings: [], offline: true, now: NOW });
  assert.equal(plan.summary.items, 0);
  assert.match(renderFixPlanMarkdown(plan), /No dependency or malware findings to plan for\./);
});
