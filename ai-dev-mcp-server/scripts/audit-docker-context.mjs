#!/usr/bin/env node
import { existsSync } from "node:fs";
import os from "node:os";
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
const target = path.resolve(process.argv[2] || path.join(repositoryRoot, ".docker", "build-context"));

if (!existsSync(target)) {
  process.stderr.write(
    `Docker build context not found: ${target}\n` +
    "Run `npm run docker:prepare` first to generate the allowlisted context.\n"
  );
  process.exit(1);
}
const audit = assertCleanDistribution(
  await auditDistributionTree(target, {
    forbiddenTerms: [
      os.homedir(),
      ...(process.env.CI ? [] : [os.userInfo().username])
    ]
  }),
  "Docker build context"
);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  target,
  files: audit.total_files,
  bytes: audit.total_bytes,
  fingerprint: distributionContentFingerprint(audit.files)
}, null, 2)}\n`);
