#!/usr/bin/env node
/**
 * What the install pages and the install scripts promise each other: the image
 * they name, the flags both bootstrap scripts keep, the model folder's rules,
 * and plain `npm ci`. The Homebrew formula and the AUR package this used to
 * check were never published and are gone in 3.0.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  readmeRu,
  dockerReadme,
  installGuide,
  installGuideRu,
  bootstrapUnix,
  bootstrapWindows,
  runMcpUnix,
  runMcpWindows
] = await Promise.all([
  read("README.md"),
  read("README.ru.md"),
  read("docker/README.md"),
  read("docs/INSTALL.md"),
  read("docs/ru/INSTALL.md"),
  read("bootstrap.sh"),
  read("bootstrap.ps1"),
  read("docker/run-mcp.sh"),
  read("docker/run-mcp.ps1")
]);

// A placeholder that reached a published document would have readers pulling an
// image that does not exist, so no user-facing page may carry one.
for (const [label, content] of [
  ["README.md", readme],
  ["README.ru.md", readmeRu],
  ["docker/README.md", dockerReadme],
  ["docs/INSTALL.md", installGuide],
  ["docs/ru/INSTALL.md", installGuideRu]
]) {
  assert.ok(!content.includes("OWNER/REPOSITORY"), `${label} still contains OWNER/REPOSITORY`);
}

// The image address itself belongs to the install instructions. The two READMEs
// send a reader to those guides rather than repeating the address, so asserting
// it there would only force the duplication back.
for (const [label, content] of [
  ["docker/README.md", dockerReadme],
  ["docs/INSTALL.md", installGuide],
  ["docs/ru/INSTALL.md", installGuideRu]
]) {
  assert.ok(content.includes(publishedImage), `${label} does not use the published image`);
}

requireText(bootstrapUnix, /image=.*ghcr\.io\/stonebridgeway\/ai-dev-system:latest/, "bootstrap.sh");
// 3.0 checks for Docker and says where it comes from rather than installing it;
// a 2.x command line with --install-prerequisites (2.x's install guide) is
// told so, not refused.
requireText(bootstrapUnix, /--install-prerequisites\)/, "bootstrap.sh");
requireText(bootstrapUnix, /https:\/\/docs\.docker\.com\/get-docker\//, "bootstrap.sh");
requireText(bootstrapUnix, /--build-local/, "bootstrap.sh");
// Refusing a stale cached image is a decision a user has to be able to
// override on either platform, so the flag is required on both sides.
requireText(bootstrapUnix, /--allow-stale-image/, "bootstrap.sh");
requireText(bootstrapWindows, /ghcr\.io\/stonebridgeway\/ai-dev-system:latest/, "bootstrap.ps1");
requireText(bootstrapWindows, /\[switch\]\$BuildLocal/, "bootstrap.ps1");
requireText(bootstrapWindows, /\[switch\]\$AllowStaleImage/, "bootstrap.ps1");
// The model folder is mounted the same way on both platforms, and the launchers
// refuse the 2.0.0 value — the model directory itself — with the same words.
requireText(bootstrapUnix, /--model-path/, "bootstrap.sh");
requireText(bootstrapWindows, /\[string\]\$ModelPath/, "bootstrap.ps1");
requireText(runMcpUnix, /holds model files itself/, "docker/run-mcp.sh");
requireText(runMcpWindows, /holds model files itself/, "docker/run-mcp.ps1");

// `npm ci` in the server needs no flag because the package's .npmrc keeps
// dependency install scripts off — onnxruntime-node's postinstall downloads the
// CUDA provider from api.nuget.org and fails offline.
// The pages tell people to run plain `npm ci`, so the setting has to stay.
const npmrc = await read("ai-dev-mcp-server/.npmrc");
assert.match(npmrc, /^ignore-scripts=true$/m, "ai-dev-mcp-server/.npmrc no longer keeps install scripts off");
for (const [label, content] of [
  ["README.md", readme],
  ["README.ru.md", readmeRu],
  ["docker/README.md", dockerReadme],
  ["docs/INSTALL.md", installGuide],
  ["docs/ru/INSTALL.md", installGuideRu]
]) {
  assert.ok(!/npm (?:ci|install)[^\n`]*--ignore-scripts/.test(content), `${label} still tells people to pass --ignore-scripts`);
}

process.stdout.write(`${JSON.stringify({ status: "passed", image: publishedImage }, null, 2)}\n`);
