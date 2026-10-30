#!/usr/bin/env node
/**
 * `npm run docker:audit` — check the build context `docker:prepare` made before
 * an image is built from it: made from the tree as it is now, nothing private in
 * it, nothing beside the distribution and the image's own files, the
 * distribution whole by its `distribution.json`, every module it imports in it,
 * and the files the server reads at start.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyDistribution } from "../src/core/distribution-build.mjs";
import {
  assertCleanDistribution,
  auditDistributionTree,
  buildContextStaleness,
  findDanglingImports,
  ownerUsername
} from "../src/core/public-distribution.mjs";
import { CONTEXT_DISTRIBUTION, CONTEXT_RECORD } from "./prepare-docker-context.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const target = path.resolve(process.argv[2] || path.join(repositoryRoot, ".docker", "build-context"));
const distribution = path.join(target, CONTEXT_DISTRIBUTION);

/** What the context holds at its top: the distribution and the image's own files. */
const CONTEXT_ENTRIES = new Set([".dockerignore", "Dockerfile", "container", CONTEXT_DISTRIBUTION, CONTEXT_RECORD]);

/**
 * Files the server reads at load time, which an import check cannot see: the
 * dense manifest is read through `createRequire` from a computed URL, and an
 * image without it died on its first start; the seed's
 * history is read by the first sync of a 2.x volume.
 */
const REQUIRED_ASSETS = ["ai-dev-mcp-server/models/bge-m3.manifest.json", "ai-dev-mcp-server/data/seed-history.json", "seed/public-seed.manifest.json"];

/**
 * The newest modification time below any of `roots`, or NaN when none is readable.
 *
 * @param {string[]} roots
 * @returns {Promise<number>}
 */
async function newestSourceMtime(roots) {
  let newest = Number.NaN;
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stats = await stat(path.join(entry.parentPath ?? entry.path ?? root, entry.name)).catch(() => null);
      if (!stats) continue;
      if (!Number.isFinite(newest) || stats.mtimeMs > newest) newest = stats.mtimeMs;
    }
  }
  return newest;
}

function fail(lines) {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

if (!existsSync(target)) {
  fail([`Docker build context not found: ${target}`, "Run `npm run docker:prepare` first to generate it."]);
}
// The context is local build output, so it can predate the tree being audited.
// Saying so beats reporting its findings as defects of the sources.
const record = await readFile(path.join(target, CONTEXT_RECORD), "utf8").then(JSON.parse).catch(() => null);
const staleness = buildContextStaleness({
  generatedAt: record?.generated_at,
  newestSourceMs: await newestSourceMtime([
    path.join(repositoryRoot, "ai-dev-mcp-server", "src"),
    path.join(repositoryRoot, "ai-dev-mcp-server", "scripts")
  ])
});
if (staleness.stale) {
  fail([`Docker build context is stale: ${staleness.reason}.`,
    "Run `npm run docker:prepare` and audit again; findings from a stale context describe a tree that no longer exists."]);
}

const strays = (await readdir(target)).filter((name) => !CONTEXT_ENTRIES.has(name));
if (strays.length) fail([`Docker build context holds what it is not made of: ${strays.join(", ")}.`, "Run `npm run docker:prepare` again."]);

const audit = assertCleanDistribution(
  await auditDistributionTree(target, { forbiddenTerms: [os.homedir(), ...(process.env.CI ? [] : [ownerUsername()])] }),
  "Docker build context"
);

const check = await verifyDistribution(distribution);
if (!check.ok) {
  fail([`The distribution in the context is not what its distribution.json lists: ${JSON.stringify({ missing: check.missing, changed: check.changed, extra: check.extra, dropped: check.dropped })}`]);
}

const absent = [];
for (const relative of REQUIRED_ASSETS) {
  if (!await stat(path.join(distribution, relative)).then(() => true, () => false)) absent.push(relative);
}
if (absent.length) {
  fail([`Docker build context is missing ${absent.length} file(s) the server reads at startup:`, ...absent.map((item) => `  ${item}`),
    "Add them to ai-dev-mcp-server/distribution.allowlist.json."]);
}

// What the allowlist left out is only discovered when something imports it, and
// by then the image is built and its server dies on startup. The Frontend QA
// runner imports the server as `../ai-dev-mcp-server`, which is where it sits in
// the distribution.
const dangling = [
  ...await findDanglingImports(path.join(distribution, "ai-dev-mcp-server")),
  ...await findDanglingImports(path.join(distribution, "frontend-qa"))
];
if (dangling.length) {
  fail([`Docker build context imports ${dangling.length} module(s) it does not carry:`,
    ...dangling.map((item) => `  ${item.file} imports ${item.specifier} (${item.resolved})`),
    "Either ship the file or stop importing it; the allowlist is ai-dev-mcp-server/distribution.allowlist.json."]);
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  target,
  version: check.version,
  files: audit.total_files,
  bytes: audit.total_bytes,
  distribution: { files: check.files, bytes: check.bytes, fingerprint: record?.distribution?.content_fingerprint ?? "" }
}, null, 2)}\n`);
