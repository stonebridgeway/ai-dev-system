#!/usr/bin/env node
/**
 * Check that `docker/public-seed/public-seed.manifest.json` still describes the
 * seed tree next to it.
 *
 *   node scripts/verify-public-seed.mjs           # verify, non-zero on drift
 *   node scripts/verify-public-seed.mjs --write   # recompute the manifest
 *
 * The image audit trusts the manifest, so a manifest that has drifted from the
 * files turns "what was built is what was audited" into a formality. Three
 * things are checked: the manifest agrees with itself (counts and fingerprint),
 * every file it lists is on disk with the same bytes and hash, and no file on
 * disk is missing from it.
 *
 * `03-skills-catalog/{registries,cards,groups}` is skipped on both sides: those
 * are rebuilt on demand by `npm run skills:ensure-index` in a standalone
 * checkout and are git-ignored there, while a full-vault build commits them.
 * Either way they are generated output, not seed content.
 *
 * `--write` is the repair path for a checkout without the private vault, where
 * `npm run docker:seed` cannot run: it recomputes the manifest from the tree as
 * committed. It refuses to write while the privacy audit reports a finding, so
 * a regenerated manifest never blesses a seed that should not ship. Rebuilding
 * the seed itself is still `npm run docker:seed` against the vault.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertCleanDistribution,
  auditDistributionTree,
  distributionContentFingerprint
} from "../src/core/public-distribution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const seedRoot = path.join(repositoryRoot, "docker", "public-seed");
const manifestName = "public-seed.manifest.json";
const manifestPath = path.join(seedRoot, manifestName);

const GENERATED_PREFIXES = [
  "03-skills-catalog/registries/",
  "03-skills-catalog/cards/",
  "03-skills-catalog/groups/"
];

// Dashboards rendered on demand by `validate_skill_library` and
// `rebuild_system_dashboard`. Like the registries they are output, not seed
// content, so running either tool in a checkout must not read as seed drift.
const GENERATED_FILES = [
  "03-skills-catalog/Skill Quality Dashboard.md",
  "01-system/System Dashboard.md",
  "01-system/system-dashboard.json"
];

/**
 * @param {string} relativePath - Seed-relative path with forward slashes.
 * @returns {boolean} True for the manifest itself and for generated output.
 */
function skipped(relativePath) {
  return relativePath === manifestName
    || GENERATED_FILES.includes(relativePath)
    || GENERATED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

/**
 * @param {Array<{ path: string, bytes: number, sha256: string }>} files
 * @returns {Map<string, { bytes: number, sha256: string }>}
 */
function index(files) {
  return new Map(files.filter((item) => !skipped(item.path)).map((item) => [item.path, item]));
}

const write = process.argv.includes("--write");
const audit = await auditDistributionTree(seedRoot);
const onDisk = index(audit.files);

if (write) {
  // The manifest describes the seed without itself, exactly as
  // refresh-public-seed.mjs computes it before writing the file. Generated
  // output is left out so the fingerprint depends only on committed content
  // and stays reproducible from a clean checkout.
  assertCleanDistribution(audit, "public seed");
  const files = [...onDisk.values()];
  const manifest = {
    schema_version: 1,
    policy: "explicit allowlist; no private vault zones or local runtime state",
    total_files: files.length,
    total_bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    content_fingerprint: distributionContentFingerprint(files),
    files
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    status: "written",
    manifest: `docker/public-seed/${manifestName}`,
    files: manifest.total_files,
    bytes: manifest.total_bytes,
    fingerprint: manifest.content_fingerprint
  }, null, 2)}\n`);
  process.exit(0);
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const listed = Array.isArray(manifest.files) ? manifest.files : [];
const problems = [];

if (manifest.total_files !== listed.length) {
  problems.push(`manifest total_files is ${manifest.total_files} but it lists ${listed.length} files.`);
}
const listedBytes = listed.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
if (manifest.total_bytes !== listedBytes) {
  problems.push(`manifest total_bytes is ${manifest.total_bytes} but its entries add up to ${listedBytes}.`);
}
const fingerprint = distributionContentFingerprint(listed);
if (manifest.content_fingerprint !== fingerprint) {
  problems.push(`manifest content_fingerprint is ${manifest.content_fingerprint} but its entries hash to ${fingerprint}.`);
}

const expected = index(listed);
for (const [relative, entry] of expected) {
  const actual = onDisk.get(relative);
  if (!actual) {
    problems.push(`listed in the manifest but missing from the seed: ${relative}`);
  } else if (actual.sha256 !== entry.sha256) {
    problems.push(`content differs from the manifest: ${relative} (${entry.bytes} bytes / ${entry.sha256.slice(0, 12)} listed, ${actual.bytes} / ${actual.sha256.slice(0, 12)} on disk)`);
  }
}
for (const relative of onDisk.keys()) {
  if (!expected.has(relative)) problems.push(`in the seed but missing from the manifest: ${relative}`);
}

if (problems.length) {
  const shown = problems.slice(0, 25);
  process.stderr.write([
    `Public seed manifest is out of sync with docker/public-seed (${problems.length} problems):`,
    ...shown.map((item) => `- ${item}`),
    ...(problems.length > shown.length ? [`- ... and ${problems.length - shown.length} more`] : []),
    "",
    "Rebuild the seed from the private vault with `npm run docker:seed`, or, in a checkout",
    "without the vault, recompute the manifest from the committed tree with",
    "`npm run docker:seed:verify -- --write`.",
    ""
  ].join("\n"));
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: "current",
  manifest: `docker/public-seed/${manifestName}`,
  verified_files: expected.size,
  skipped_generated: audit.total_files - 1 - onDisk.size,
  fingerprint: manifest.content_fingerprint
}, null, 2)}\n`);
