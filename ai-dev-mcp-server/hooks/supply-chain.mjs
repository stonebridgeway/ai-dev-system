// Supply-chain check for the PreToolUse guard: a package an install command
// names is looked up before the command runs.
//
// Malware runs *during* install — a postinstall script, or a dependency with
// one, as with plain-crypto-js under axios 1.14.1 — so a scan afterwards finds
// a machine that is already compromised. Three questions are asked of the
// version the command would install, in parallel and under one deadline:
//
// - Is it malware? GitHub's advisories, as the npm registry serves them to
//   every audit ("Malware in keyv"), and OSV's MAL- reports from the OpenSSF
//   feed — nearly nine in ten of which have no GitHub twin.
// - Is it younger than the quarantine? The 2026 malware releases were pulled
//   within hours; a release younger than a day is refused, younger than a week
//   is warned about.
// - Does it have known vulnerabilities? Warned about, with the first safe version.
//
// A check that cannot be made — no network, a private registry, a timeout —
// warns and never blocks: an install that is refused for want of an answer
// teaches people to turn the guard off. Zero dependencies, like every hook.
// The lookups go through HTTPS_PROXY (`http-proxy.mjs`): `fetch` alone ignores
// it, and behind a corporate proxy nothing was ever checked.
import { proxyFetch } from "./http-proxy.mjs";
import { compareVersions, isPrerelease, parseVersion, satisfies } from "./semver-lite.mjs";

export const SUPPLY_CHAIN_DEFAULTS = Object.freeze({
  enabled: true,
  min_release_age_hours: 24,
  warn_release_age_days: 7,
  osv: true,
  // Per request. The registry document comes first and the two advisory
  // lookups after it in parallel, so a command costs at most two of these —
  // six seconds, inside the ten the client gives the whole guard.
  timeout_ms: 3000,
  max_packages: 8
});

const HOUR_MS = 3_600_000;

/** Install subcommands that take package specs, per package manager. */
const ADD_SUBCOMMANDS = {
  npm: ["install", "i", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall"],
  pnpm: ["add", "install", "i"],
  yarn: ["add"],
  bun: ["add", "a", "install", "i"]
};
/** Subcommands that download a package and run it. */
const EXEC_SUBCOMMANDS = { npm: ["exec", "x"], pnpm: ["dlx"], yarn: ["dlx"], bun: ["x"] };
/** Runners that are themselves `exec`. */
const RUNNERS = { npx: "npm", pnpx: "pnpm", bunx: "bun" };
/**
 * Options whose value is the next token, so it is not read as a package. Per
 * package manager, because the same letter differs: npm's `-w` names a
 * workspace, pnpm's is `--workspace-root` and takes nothing.
 */
const OPTIONS_WITH_VALUE = {
  npm: new Set(["--registry", "--tag", "-w", "--workspace", "--prefix", "--before", "--omit", "--include", "--cache", "--userconfig", "-c", "--call", "--shell"]),
  pnpm: new Set(["--registry", "--filter", "-F", "--dir", "-C", "--reporter", "--store-dir", "--virtual-store-dir", "--config-dir"]),
  yarn: new Set(["--registry", "--cwd", "--network-concurrency", "--mutex", "--modules-folder", "--cache-folder"]),
  bun: new Set(["--registry", "--cwd", "-c", "--config", "--cache-dir", "--backend"])
};

/**
 * The guard's settings, from `.ai-dev/policy.json` (`supply_chain`) and the
 * environment (`AI_DEV_SUPPLY_CHAIN=off`).
 *
 * @param {object} [policy]
 * @param {Record<string, string | undefined>} [env]
 * @returns {typeof SUPPLY_CHAIN_DEFAULTS}
 */
export function supplyChainSettings(policy = {}, env = process.env) {
  const configured = policy?.supply_chain && typeof policy.supply_chain === "object" ? policy.supply_chain : {};
  const settings = { ...SUPPLY_CHAIN_DEFAULTS };
  for (const key of Object.keys(SUPPLY_CHAIN_DEFAULTS)) {
    const value = configured[key];
    if (typeof value === typeof SUPPLY_CHAIN_DEFAULTS[key] && (typeof value !== "number" || (Number.isFinite(value) && value >= 0))) settings[key] = value;
  }
  if (["0", "false", "off", "no"].includes(String(env.AI_DEV_SUPPLY_CHAIN ?? "").trim().toLowerCase())) settings.enabled = false;
  return settings;
}

/**
 * A package spec as a registry name and what is wanted of it, or null for
 * anything that is not a registry package: paths, tarballs, git, workspaces.
 *
 * @param {string} raw
 * @returns {{ name: string, want: string } | null}
 */
export function parseSpec(raw) {
  let spec = String(raw ?? "").trim();
  if (!spec || spec.startsWith("-")) return null;
  if (/^(?:\.|\/|~|[a-z]:\\|file:|link:|workspace:|portal:|patch:|exec:|git\+|git:|github:|gitlab:|bitbucket:|https?:)/i.test(spec)) return null;
  if (!spec.startsWith("@") && /^[^@/\s]+\/[^@/\s]+(?:#.*)?$/.test(spec)) return null; // user/repo is GitHub
  const alias = /^(?:@[^@/]+\/)?[^@/]+@npm:(.+)$/.exec(spec);
  if (alias) spec = alias[1];
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const want = at > 0 ? spec.slice(at + 1) : "";
  if (!/^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i.test(name)) return null;
  return { name, want: want || "latest" };
}

function executable(token) {
  return String(token ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, "");
}

/**
 * The registry packages one shell segment would install or run.
 *
 * @param {string[]} tokens - One segment, split on whitespace.
 * @returns {Array<{ manager: string, name: string, want: string, raw: string }>}
 */
export function installSpecs(tokens) {
  const words = tokens.map((token) => String(token));
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1; // FOO=bar npm i x
  if (executable(words[index]) === "sudo") index += 1;
  const head = executable(words[index]);
  const manager = RUNNERS[head] ?? (["npm", "pnpm", "yarn", "bun"].includes(head) ? head : "");
  if (!manager) return [];
  let mode = RUNNERS[head] ? "exec" : "";
  let position = index + 1;
  const specs = [];
  const take = (raw) => {
    const parsed = parseSpec(raw);
    if (parsed) specs.push({ manager, ...parsed, raw });
  };
  for (; position < words.length; position += 1) {
    const word = words[position];
    if (word === "--") break;
    if (word.startsWith("-")) {
      const [flag, inline] = word.split("=", 2);
      if ((flag === "-p" || flag === "--package") && mode === "exec") {
        if (inline !== undefined) take(inline);
        else take(words[++position]);
        continue;
      }
      if (inline === undefined && OPTIONS_WITH_VALUE[manager].has(flag)) position += 1;
      continue;
    }
    if (!mode) {
      if (ADD_SUBCOMMANDS[manager].includes(word)) mode = "add";
      else if (EXEC_SUBCOMMANDS[manager].includes(word)) mode = "exec";
      else return [];
      continue;
    }
    take(word);
    // An exec runs one package; what follows is its arguments.
    if (mode === "exec") break;
  }
  return specs;
}

/**
 * The version a spec resolves to in the registry's document: an exact version,
 * a dist-tag, or the highest release a range allows.
 *
 * @param {object} document
 * @param {string} want
 * @returns {string}
 */
export function resolveVersion(document, want) {
  const versions = Object.keys(document?.versions ?? {});
  if (versions.includes(want)) return want;
  const tagged = document?.["dist-tags"]?.[want];
  if (tagged) return String(tagged);
  const matching = versions.filter((version) => parseVersion(version) && !isPrerelease(version) && satisfies(version, want)).sort(compareVersions);
  return matching.at(-1) ?? "";
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function reasonOf(error, timeoutMs) {
  if (error?.name === "TimeoutError") return `no answer in ${timeoutMs / 1000}s`;
  return String(error?.message ?? error).split("\n")[0];
}

/**
 * Everything the guard needs to know about one spec.
 *
 * @param {{ name: string, want: string }} spec
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function inspectSpec(spec, { fetchImpl = proxyFetch, registry, osvApi, settings, now = Date.now() }) {
  const result = { ...spec, version: "", published: "", malware: [], vulnerabilities: [], problems: [], previous: "", safe: "" };
  let document;
  try {
    document = await fetchJson(fetchImpl, `${registry}/${spec.name.replace("/", "%2f")}`, { headers: { accept: "application/json" } }, settings.timeout_ms);
  } catch (error) {
    result.problems.push(error?.status === 404 ? `${spec.name} is not in ${registry} — a typo, a private package, or a name squatted and removed` : `the registry could not be read: ${reasonOf(error, settings.timeout_ms)}`);
    return result;
  }
  result.version = resolveVersion(document, spec.want);
  if (!result.version) {
    // An exact version the registry no longer has is still asked about: npm
    // unpublishes malware (axios 1.14.1, keyv 6.0.0 are gone), but a mirror or
    // a proxy cache in front of it may still serve it.
    if (!parseVersion(spec.want)) {
      result.problems.push(`no published version of ${spec.name} matches "${spec.want}"`);
      return result;
    }
    result.version = spec.want;
    result.problems.push(`${spec.name}@${spec.want} is no longer in ${registry}; a mirror may still serve it`);
  }
  result.published = String(document?.time?.[result.version] ?? "");
  const releases = Object.keys(document?.versions ?? {}).filter((version) => parseVersion(version) && !isPrerelease(version)).sort(compareVersions);
  const agedBefore = releases.filter((version) => compareVersions(version, result.version) < 0 && now - Date.parse(document?.time?.[version] ?? "") >= settings.min_release_age_hours * HOUR_MS);
  result.previous = agedBefore.at(-1) ?? "";

  const checks = [
    fetchJson(fetchImpl, `${registry}/-/npm/v1/security/advisories/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ [spec.name]: [result.version] })
    }, settings.timeout_ms).then((answer) => {
      for (const advisory of Array.isArray(answer?.[spec.name]) ? answer[spec.name] : []) {
        const id = /\/(GHSA-[0-9a-z-]+)/i.exec(String(advisory?.url ?? ""))?.[1] ?? String(advisory?.id ?? "");
        if (/^\s*malware in\b/i.test(String(advisory?.title ?? ""))) result.malware.push(id);
        else result.vulnerabilities.push({ id, severity: String(advisory?.severity ?? ""), range: String(advisory?.vulnerable_versions ?? "") });
      }
    }).catch((error) => result.problems.push(`the npm advisory endpoint could not be read: ${reasonOf(error, settings.timeout_ms)}`))
  ];
  if (settings.osv) {
    checks.push(fetchJson(fetchImpl, `${osvApi}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ package: { name: spec.name, ecosystem: "npm" }, version: result.version }] })
    }, settings.timeout_ms).then((answer) => {
      for (const vulnerability of answer?.results?.[0]?.vulns ?? []) {
        if (/^MAL-/.test(String(vulnerability?.id ?? ""))) result.malware.push(String(vulnerability.id));
      }
    }).catch((error) => result.problems.push(`OSV could not be read: ${reasonOf(error, settings.timeout_ms)}`)));
  }
  await Promise.all(checks);
  result.malware = [...new Set(result.malware)];
  if (result.vulnerabilities.length) {
    const ranges = result.vulnerabilities.map((item) => item.range).filter(Boolean);
    result.safe = releases.find((version) => compareVersions(version, result.version) > 0 && !ranges.some((range) => satisfies(version, range))) ?? "";
  }
  return result;
}

function hoursOld(published, now) {
  const at = Date.parse(published);
  return Number.isFinite(at) ? (now - at) / HOUR_MS : null;
}

/**
 * The guard's verdict on what a checked spec would install.
 *
 * @param {object} checked - From {@link inspectSpec}.
 * @param {typeof SUPPLY_CHAIN_DEFAULTS} settings
 * @param {number} [now]
 * @returns {{ blocks: string[], warns: string[] }}
 */
export function verdictFor(checked, settings, now = Date.now()) {
  const label = `${checked.name}@${checked.version || checked.want}`;
  const blocks = [];
  const warns = [];
  if (checked.malware.length) {
    blocks.push(`BLOCKED (supply-chain): ${label} is reported as malware (${checked.malware.join(", ")}). Do not install it. If it is already in a lockfile or node_modules anywhere, run run_security_scan and treat that machine's credentials as leaked.`);
  }
  const age = hoursOld(checked.published, now);
  if (!checked.malware.length && age !== null && age < settings.min_release_age_hours) {
    const wait = new Date(Date.parse(checked.published) + settings.min_release_age_hours * HOUR_MS).toISOString().replace(/\.\d+Z$/, "Z");
    blocks.push(`BLOCKED (supply-chain): ${label} was published ${Math.max(0, Math.floor(age))} hour(s) ago. Releases younger than ${settings.min_release_age_hours} h are held back — the malicious npm releases of 2026 were pulled within hours of publishing. ${checked.previous ? `Pin ${checked.name}@${checked.previous}, ` : ""}wait until ${wait}, or, if this release is needed now and trusted, add the command to allow_commands in .ai-dev/policy.json.`);
  } else if (!checked.malware.length && age !== null && age < settings.warn_release_age_days * 24) {
    warns.push(`[supply-chain] ${label} is ${Math.floor(age / 24)} day(s) old, younger than the ${settings.warn_release_age_days}-day quarantine plan_security_fixes applies${checked.previous ? `; ${checked.name}@${checked.previous} is older` : ""}.`);
  }
  const serious = checked.vulnerabilities.filter((item) => ["critical", "high"].includes(item.severity.toLowerCase()));
  if (serious.length) {
    warns.push(`[supply-chain] ${label} has ${serious.length} known high or critical vulnerabilit${serious.length === 1 ? "y" : "ies"} (${serious.map((item) => item.id).slice(0, 4).join(", ")})${checked.safe ? `; ${checked.name}@${checked.safe} is the first release outside them` : "; no later release is outside them"}.`);
  }
  // A reason that is a sentence already keeps its one full stop: "(HTTP 403).." read as a typo.
  for (const problem of checked.problems) warns.push(`[supply-chain] ${label} was not fully checked: ${String(problem).replace(/[.\s]+$/, "")}.`);
  return { blocks, warns };
}

/**
 * Check every package a shell command would install. Never throws.
 *
 * @param {string[][]} segments - The command's segments, each split into tokens.
 * @param {object} options
 * @returns {Promise<{ blocks: string[], warns: string[] }>}
 */
export async function checkSupplyChain(segments, {
  policy = {},
  env = process.env,
  fetchImpl = (url, init) => proxyFetch(url, { ...init, env }),
  now = Date.now()
} = {}) {
  const settings = supplyChainSettings(policy, env);
  if (!settings.enabled || typeof fetchImpl !== "function") return { blocks: [], warns: [] };
  const seen = new Set();
  const specs = segments.flatMap((tokens) => installSpecs(tokens)).filter((spec) => {
    const key = `${spec.name}@${spec.want}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!specs.length) return { blocks: [], warns: [] };
  const registry = String(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org").trim().replace(/\/+$/, "") || "https://registry.npmjs.org";
  const osvApi = String(env.AI_DEV_OSV_API ?? "https://api.osv.dev").trim().replace(/\/+$/, "");
  const checked = await Promise.all(specs.slice(0, settings.max_packages).map((spec) => inspectSpec(spec, { fetchImpl, registry, osvApi, settings, now })));
  const blocks = [];
  const warns = [];
  for (const item of checked) {
    const verdict = verdictFor(item, settings, now);
    blocks.push(...verdict.blocks);
    warns.push(...verdict.warns);
  }
  if (specs.length > settings.max_packages) warns.push(`[supply-chain] only the first ${settings.max_packages} of ${specs.length} packages in this command were checked.`);
  return { blocks, warns };
}
