/**
 * A dependency fix plan: what to change, to which version, with which command.
 *
 * The plan changes nothing. The project's rules put `install`, `add`, `update`
 * and `audit fix` behind a confirmation (`command-policy.mjs`), and the owner
 * decided fixes stay that way: the plan is exact enough to confirm line by
 * line, and the agent runs it only after the user has said yes.
 *
 * One item per package per lockfile. Each item says:
 *
 * - `action` — `remove-malware` when no safe version exists, `replace-malware`
 *   when one does; `upgrade-direct` for a package the manifest names;
 *   `update-in-range` for a transitive one whose dependents already accept the
 *   fix; `override` when they do not, or when the lockfile does not record what
 *   they accept (pnpm); `no-fix` when nothing published is safe.
 * - `target` — from `chooseTarget`: the first safe version old enough to trust.
 * - `breaking` — a major upgrade, where below 1.0.0 a minor counts (sharp
 *   0.34 → 0.35 was one).
 * - `commands` and `manifest_change` — exact, for the package manager that
 *   owns the lockfile.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { chooseTarget, DEFAULT_MIN_RELEASE_AGE_DAYS, fetchPackageMetadata } from "./security-fix-registry.mjs";
import { MALWARE_REMEDIATION, SECURITY_SEVERITIES } from "./security-scan-parsers.mjs";
import { LOCKFILE_MANAGERS, readLockfileFacts } from "./security-scan-lockfiles.mjs";
import { compareVersions, satisfies } from "./semver-lite.mjs";

const DAY_MS = 86_400_000;
const ACTION_ORDER = ["remove-malware", "replace-malware", "upgrade-direct", "update-in-range", "override", "no-fix"];
const MANIFEST_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** The manifest key an override goes under, per package manager. */
const OVERRIDE_FIELD = { npm: ["overrides"], pnpm: ["pnpm", "overrides"], yarn: ["resolutions"], bun: ["overrides"] };

/**
 * The commands for one change, per package manager. `before` is the cutoff
 * date npm can resolve against, so the transitive packages an upgrade pulls
 * in are held to the same quarantine as the target.
 */
function commandsFor(manager, { action, name, target, dev, before }) {
  const cutoff = manager === "npm" && before ? ` --before=${before}` : "";
  if (action === "remove-malware") {
    // A transitive package is removed through whatever pulls it in; the note says how to find that.
    if (dev === null) return [];
    return { npm: [`npm uninstall ${name}`], pnpm: [`pnpm remove ${name}`], yarn: [`yarn remove ${name}`], bun: [`bun remove ${name}`] }[manager];
  }
  if (action === "upgrade-direct" || (action === "replace-malware" && dev !== null)) {
    const flag = dev ? { npm: " --save-dev", pnpm: " --save-dev", yarn: " --dev", bun: " --dev" }[manager] : "";
    return [`${{ npm: "npm install", pnpm: "pnpm add", yarn: "yarn add", bun: "bun add" }[manager]} ${name}@${target}${flag}${cutoff}`];
  }
  if (action === "update-in-range") {
    return manager === "npm" ? [`npm update ${name}${cutoff}`] : [`yarn up -R ${name}`];
  }
  if (action === "override" || action === "replace-malware") {
    return [`${manager} install${cutoff}`];
  }
  return [];
}

function severityRank(severity) {
  const index = SECURITY_SEVERITIES.indexOf(severity);
  return index === -1 ? SECURITY_SEVERITIES.length : index;
}

function lockfileOf(finding) {
  const file = String(finding.file ?? "");
  return LOCKFILE_MANAGERS[path.posix.basename(file)] ? file : "";
}

async function readManifest(directory) {
  return fs.readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => null);
}

function declaredIn(manifest, name) {
  for (const field of MANIFEST_FIELDS) {
    const range = manifest?.[field]?.[name];
    if (range !== undefined) return { field, range: String(range) };
  }
  return null;
}

async function isYarnBerry(directory, manifest) {
  const declared = /^yarn@(\d+)/.exec(String(manifest?.packageManager ?? ""));
  if (declared) return Number(declared[1]) >= 2;
  return fs.stat(path.join(directory, ".yarnrc.yml")).then(() => true).catch(() => false);
}

/**
 * Group the dependency and malware findings by lockfile and package.
 *
 * @param {object[]} findings
 * @returns {Map<string, { lockfile: string, name: string, findings: object[] }>}
 */
export function groupFindings(findings) {
  const groups = new Map();
  for (const item of findings ?? []) {
    if (!["dependency", "malware"].includes(item?.kind) || !item.package) continue;
    const lockfile = lockfileOf(item);
    if (!lockfile) continue;
    const key = `${lockfile}|${item.package}`;
    const group = groups.get(key) ?? { lockfile, name: item.package, findings: [] };
    group.findings.push(item);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Plan one package in one lockfile.
 *
 * @param {object} group
 * @param {object} context
 * @returns {Promise<object>}
 */
async function planItem({ lockfile, name, findings }, { projectRoot, metadataFor, minReleaseAgeDays, now, before }) {
  const directory = path.join(projectRoot, path.posix.dirname(lockfile));
  const facts = await readLockfileFacts(path.join(projectRoot, lockfile));
  const manager = facts.manager;
  const manifest = await readManifest(directory);
  const declared = declaredIn(manifest, name);
  const installed = [...new Set([
    ...findings.map((item) => item.version).filter(Boolean),
    ...(facts.installed.get(name) ?? [])
  ])].sort(compareVersions);
  const vulnerable = [...new Set(findings.map((item) => item.vulnerable).filter(Boolean))];
  // The copies an advisory actually covers; a range that cannot be read covers them all.
  const affected = installed.filter((version) => !vulnerable.length || vulnerable.some((range) => satisfies(version, range)));
  const base = (affected.length ? affected : installed).at(-1) ?? "";
  const malware = findings.some((item) => item.kind === "malware");
  const metadata = await metadataFor(name);
  const target = chooseTarget({
    installed: base,
    vulnerable,
    fixedIn: findings.map((item) => item.fixed_in ?? ""),
    metadata,
    preferRange: declared?.range ?? "",
    minReleaseAgeDays,
    now
  });

  const requested = facts.requested?.get(name) ?? null;
  const dependentsAccept = Boolean(target.version && requested?.length && requested.every((range) => satisfies(target.version, range)));
  let action;
  if (malware) action = target.version ? "replace-malware" : "remove-malware";
  else if (!target.version) action = "no-fix";
  else if (declared) action = "upgrade-direct";
  else if (dependentsAccept && (manager === "npm" || (manager === "yarn" && await isYarnBerry(directory, manifest)))) action = "update-in-range";
  else action = "override";

  const overridden = !declared && (action === "override" || (action === "replace-malware" && !declared));
  const manifestChange = overridden
    ? { file: path.posix.join(path.posix.dirname(lockfile), "package.json"), path: [...OVERRIDE_FIELD[manager], name], value: target.version }
    : null;
  const dev = declared ? declared.field === "devDependencies" : null;
  const notes = [];
  if (target.reason) notes.push(target.reason);
  if (malware) notes.push(MALWARE_REMEDIATION);
  if (action === "remove-malware" && !declared) {
    notes.push(`${name} is not in the manifest: find what pulls it in (${{ npm: "npm ls", pnpm: "pnpm why", yarn: "yarn why", bun: "bun pm ls" }[manager]} ${name}) and remove or replace that.`);
  }
  if (action === "override" && requested === null) notes.push("pnpm records resolved versions, not the ranges dependents ask for, so whether an in-range update would do is unknown; the override is certain.");
  if (action === "override" && requested?.length) notes.push(`Dependents ask for ${[...new Set(requested)].join(", ")}, which ${target.version} is outside of: the override forces it, so check the dependents still work.`);
  if (target.upgrade === "major") notes.push(`${base || "the installed version"} → ${target.version} is a breaking upgrade: read the changelog before confirming.`);
  if (manifestChange) notes.push(`Remove the override once the dependents ask for ${target.version} themselves; it outlives its reason silently.`);

  return {
    lockfile,
    package_manager: manager,
    package: name,
    kind: malware ? "malware" : "dependency",
    severity: findings.map((item) => item.severity).sort((left, right) => severityRank(left) - severityRank(right))[0],
    advisories: [...new Set(findings.map((item) => item.rule).filter(Boolean))],
    installed,
    direct: Boolean(declared),
    declared_range: declared?.range ?? "",
    action,
    target: target.version,
    target_source: target.source,
    target_age_days: target.age_days,
    quarantined: target.quarantined,
    upgrade: target.upgrade,
    breaking: target.upgrade === "major",
    manifest_change: manifestChange,
    commands: commandsFor(manager, { action, name, target: target.version, dev, before }) ?? [],
    notes
  };
}

/**
 * Build the plan from a scan's findings.
 *
 * @param {object} input
 * @param {string} input.projectRoot
 * @param {object[]} input.findings - From `runSecurityScan`.
 * @param {boolean} [input.offline] - Do not ask the registry.
 * @param {number} [input.minReleaseAgeDays]
 * @param {Function} [input.fetchMetadata] - Injected by tests.
 * @param {number} [input.now]
 * @returns {Promise<object>}
 */
export async function buildFixPlan({
  projectRoot,
  findings,
  offline = false,
  minReleaseAgeDays = DEFAULT_MIN_RELEASE_AGE_DAYS,
  fetchMetadata = fetchPackageMetadata,
  now = Date.now()
}) {
  const root = path.resolve(projectRoot);
  const cache = new Map();
  const registryProblems = [];
  const metadataFor = (name) => {
    if (offline) return Promise.resolve(null);
    if (!cache.has(name)) {
      cache.set(name, Promise.resolve(fetchMetadata(name)).then((metadata) => {
        if (!metadata?.ok) registryProblems.push(metadata?.reason ?? `${name}: no answer`);
        return metadata;
      }));
    }
    return cache.get(name);
  };
  const before = new Date(now - minReleaseAgeDays * DAY_MS).toISOString().slice(0, 10);
  const items = [];
  for (const group of groupFindings(findings).values()) {
    items.push(await planItem(group, { projectRoot: root, metadataFor, minReleaseAgeDays, now, before }));
  }
  items.sort((left, right) => (
    ACTION_ORDER.indexOf(left.action) - ACTION_ORDER.indexOf(right.action) ||
    severityRank(left.severity) - severityRank(right.severity) ||
    left.lockfile.localeCompare(right.lockfile) ||
    left.package.localeCompare(right.package)
  ));
  const managers = [...new Set(items.map((item) => item.package_manager))];
  return {
    project_path: root,
    min_release_age_days: minReleaseAgeDays,
    registry: offline ? "not asked (offline)" : registryProblems.length ? `partly unavailable: ${registryProblems.slice(0, 3).join("; ")}` : "asked",
    summary: {
      items: items.length,
      malware: items.filter((item) => item.kind === "malware").length,
      breaking: items.filter((item) => item.breaking).length,
      no_fix: items.filter((item) => item.action === "no-fix").length,
      overrides: items.filter((item) => item.manifest_change).length
    },
    items,
    verify: [
      ...managers.map((manager) => ({ npm: "npm ci", pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --immutable (Yarn 2+) or yarn install --frozen-lockfile (Yarn 1)", bun: "bun install --frozen-lockfile" })[manager]),
      "the project's own build and tests",
      "run_security_scan again: every item above should be gone"
    ]
  };
}

/**
 * The plan as the table a user confirms.
 *
 * @param {object} plan
 * @returns {string}
 */
export function renderFixPlanMarkdown(plan) {
  const lines = [`# Security fix plan: ${plan.summary.items} item(s)`, ""];
  lines.push(`Nothing has been changed. Quarantine: versions younger than ${plan.min_release_age_days} days are not picked. Registry: ${plan.registry}.`, "");
  if (plan.summary.malware) lines.push(`**${plan.summary.malware} malicious package(s).** ${MALWARE_REMEDIATION}`, "");
  if (!plan.items.length) {
    lines.push("No dependency or malware findings to plan for.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("| # | Package | Lockfile | Installed | Action | Target | Risk |", "|---|---|---|---|---|---|---|");
  plan.items.forEach((item, index) => {
    const risk = item.kind === "malware" ? "**malware**" : item.breaking ? "**breaking**" : item.upgrade;
    // An in-range update takes the newest version the range allows before the
    // cutoff, so the target is a floor there, not a pin.
    const target = !item.target ? "—" : item.action === "update-in-range" ? `≥ ${item.target}` : item.target;
    lines.push(`| ${index + 1} | ${item.package} (${item.severity}) | ${item.lockfile} | ${item.installed.join(", ") || "?"} | ${item.action} | ${target} | ${risk} |`);
  });
  lines.push("");
  plan.items.forEach((item, index) => {
    lines.push(`**${index + 1}. ${item.package}** — ${item.advisories.join(", ")}`);
    if (item.manifest_change) lines.push(`- ${item.manifest_change.file}: set \`${item.manifest_change.path.join(".")}\` to \`${item.manifest_change.value}\``);
    const where = path.posix.dirname(item.lockfile);
    for (const command of item.commands) lines.push(`- \`${command}\` (in ${where === "." ? "the project root" : `${where}/`})`);
    for (const note of item.notes) lines.push(`- ${note}`);
  });
  lines.push("", "Then verify:", ...plan.verify.map((step) => `- ${step}`));
  return `${lines.join("\n")}\n`;
}
