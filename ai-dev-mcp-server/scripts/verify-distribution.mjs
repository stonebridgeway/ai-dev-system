#!/usr/bin/env node
/**
 * Check a built distribution against its `distribution.json`.
 *
 *   node ai-dev-mcp-server/scripts/verify-distribution.mjs [--root <folder>]
 *
 * The npm package's `prepack` runs it from the package's own folder, so a
 * tarball is never made from a tree that changed after `npm run dist` built
 * it: a file edited, removed or added by hand, or one `npm pack` would leave
 * out. Prints JSON; exits 1 on any difference.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyDistribution } from "../src/core/distribution-build.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const at = process.argv.indexOf("--root");
const root = path.resolve(at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : scriptRoot);

try {
  const result = await verifyDistribution(root);
  process.stdout.write(`${JSON.stringify({ root, ...result }, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(`${root} is not the distribution its distribution.json describes; run \`npm run dist\` again.\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${root}: ${error.message}\n`);
  process.exitCode = 1;
}
