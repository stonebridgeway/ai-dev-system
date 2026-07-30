#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCleanDistribution,
  auditDistributionTree
} from "../src/core/public-distribution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const publishedImage = "ghcr.io/stonebridgeway/ai-dev-system:latest";

async function read(relativePath) {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function requireText(content, expected, label) {
  assert.match(content, expected, `${label} is missing required metadata`);
}

const [
  readme,
  dockerReadme,
  bootstrapUnix,
  bootstrapWindows,
  launcher,
  pkgbuild,
  srcinfo,
  formula
] = await Promise.all([
  read("README.md"),
  read("docker/README.md"),
  read("bootstrap.sh"),
  read("bootstrap.ps1"),
  read("packaging/launcher.sh"),
  read("packaging/arch/PKGBUILD"),
  read("packaging/arch/.SRCINFO"),
  read("packaging/homebrew/ai-dev-system.rb")
]);

for (const [label, content] of [
  ["README.md", readme],
  ["docker/README.md", dockerReadme]
]) {
  assert.ok(!content.includes("OWNER/REPOSITORY"), `${label} still contains OWNER/REPOSITORY`);
  assert.ok(content.includes(publishedImage), `${label} does not use the published image`);
}

requireText(bootstrapUnix, /image=.*ghcr\.io\/stonebridgeway\/ai-dev-system:latest/, "bootstrap.sh");
requireText(bootstrapUnix, /--install-prerequisites/, "bootstrap.sh");
requireText(bootstrapUnix, /brew install --cask docker/, "bootstrap.sh");
requireText(bootstrapUnix, /--build-local/, "bootstrap.sh");
requireText(bootstrapWindows, /ghcr\.io\/stonebridgeway\/ai-dev-system:latest/, "bootstrap.ps1");
requireText(bootstrapWindows, /\[switch\]\$BuildLocal/, "bootstrap.ps1");

requireText(launcher, /@AI_DEV_SYSTEM_ROOT@/, "packaging launcher");
requireText(launcher, /bootstrap\.sh/, "packaging launcher");
requireText(pkgbuild, /^pkgname=ai-dev-system-git$/m, "PKGBUILD");
requireText(pkgbuild, /^arch=\('x86_64' 'aarch64'\)$/m, "PKGBUILD");
requireText(pkgbuild, /git\+https:\/\/github\.com\/stonebridgeway\/ai-dev-system\.git#branch=main/, "PKGBUILD");
requireText(srcinfo, /^pkgbase = ai-dev-system-git$/m, ".SRCINFO");
requireText(srcinfo, /^\s+arch = x86_64$/m, ".SRCINFO");
requireText(srcinfo, /^\s+arch = aarch64$/m, ".SRCINFO");
requireText(formula, /^class AiDevSystem < Formula$/m, "Homebrew formula");
requireText(formula, /^# typed: strict$/m, "Homebrew formula");
requireText(formula, /^# frozen_string_literal: true$/m, "Homebrew formula");
requireText(formula, /head "https:\/\/github\.com\/stonebridgeway\/ai-dev-system\.git", branch: "main"/, "Homebrew formula");
requireText(formula, /inreplace launcher, "@AI_DEV_SYSTEM_ROOT@", libexec/, "Homebrew formula");
requireText(formula, /launcher\.chmod 0755/, "Homebrew formula");

const packagingAudit = assertCleanDistribution(
  await auditDistributionTree(path.join(repositoryRoot, "packaging"), {
    forbiddenTerms: [os.homedir(), os.userInfo().username]
  }),
  "Packaging assets"
);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  image: publishedImage,
  packaging_files: packagingAudit.total_files,
  packaging_bytes: packagingAudit.total_bytes
}, null, 2)}\n`);
