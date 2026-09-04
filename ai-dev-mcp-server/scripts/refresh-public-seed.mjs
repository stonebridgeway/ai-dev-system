#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertCleanDistribution,
  auditDistributionTree,
  copyDistributionFile,
  copyDistributionTree,
  distributionContentFingerprint
} from "../src/core/public-distribution.mjs";
import { isDirectExecution } from "../src/core/direct-execution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const defaultVaultRoot = path.resolve(repositoryRoot, "..");
const defaultOutput = path.join(repositoryRoot, "docker", "public-seed");
const generatedRoot = path.join(repositoryRoot, ".docker");

function parseArgs(argv) {
  const options = {
    source: process.env.AI_DEV_SOURCE_VAULT_ROOT || defaultVaultRoot,
    output: defaultOutput,
    replace: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") {
      options.source = argv[++index];
    } else if (argument === "--output") {
      options.output = argv[++index];
    } else if (argument === "--replace") {
      options.replace = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function excludedSource(relative, entry) {
  const segments = relative.replaceAll("\\", "/").toLowerCase().split("/");
  return segments.some((segment) => [
    ".git",
    ".venv",
    "__pycache__",
    "node_modules"
  ].includes(segment))
    || entry.name === ".DS_Store"
    || /\.pyc$/i.test(entry.name);
}

function assertGeneratedTarget(target) {
  const resolved = path.resolve(target);
  const allowed = path.resolve(repositoryRoot, "docker");
  const relative = path.relative(allowed, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Public seed output must stay below ${allowed}: ${resolved}`);
  }
  return resolved;
}

async function writeText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function copyStaticFiles(vaultRoot, stage) {
  const files = [
    "01-system/Agent Rules.md",
    "01-system/Operating Model.md",
    "01-system/Project Agent Standards.md",
    "05-project-templates/AGENTS.template.md",
    "06-prompts/Auto Commands.md",
    "06-prompts/Prompt Patterns.md",
    "07-quality-gates/Frontend Product Quality v2.md",
    "07-quality-gates/Quality Gate.md"
  ];
  for (const relative of files) {
    await copyDistributionFile(
      path.join(vaultRoot, relative),
      path.join(stage, relative)
    );
  }
  for (const relative of ["04-agent-workflows"]) {
    await copyDistributionTree(
      path.join(vaultRoot, relative),
      path.join(stage, relative),
      { exclude: excludedSource }
    );
  }
}

async function copySkillSources(vaultRoot, stage) {
  const catalogTarget = path.join(stage, "03-skills-catalog", "sources");
  await copyDistributionTree(
    path.join(vaultRoot, "03-skills-catalog", "sources", "custom"),
    path.join(catalogTarget, "custom"),
    { exclude: excludedSource }
  );

  const tasteSource = path.join(vaultRoot, "03-skills-catalog", "sources", "design", "taste-skill");
  const tasteTarget = path.join(catalogTarget, "design", "taste-skill");
  await copyDistributionTree(
    path.join(tasteSource, "skills"),
    path.join(tasteTarget, "skills"),
    { exclude: excludedSource }
  );
  await copyDistributionFile(path.join(tasteSource, "LICENSE"), path.join(tasteTarget, "LICENSE"));
  await copyDistributionFile(path.join(tasteSource, "README.md"), path.join(tasteTarget, "README.md"));
  await writeText(path.join(tasteTarget, "upstream.json"), `${JSON.stringify({
    schema_version: 1,
    repository: "https://github.com/Leonxlnx/taste-skill",
    commit: "5285855df6719b6efb95d5268359e752d3d79045",
    license: "MIT"
  }, null, 2)}\n`);

  const uiUxSource = path.join(vaultRoot, "03-skills-catalog", "sources", "external", "ui-ux-pro-max");
  await copyDistributionTree(
    uiUxSource,
    path.join(catalogTarget, "external", "ui-ux-pro-max"),
    { exclude: excludedSource }
  );

  // Archify is a locally executed CLI, so the clean seed must carry its pinned
  // runtime dependencies. This is the sole approved node_modules exception in
  // the distribution policy; copying an arbitrary source tree would weaken the
  // privacy boundary and make offline behavior less predictable.
  const archifySource = path.join(vaultRoot, "03-skills-catalog", "sources", "external", "archify");
  const archifyTarget = path.join(catalogTarget, "external", "archify");
  for (const directory of [
    "assets", "bin", "brand-marks", "delta", "examples", "migrations",
    "recipes", "references", "renderers", "schemas", "scripts", "node_modules"
  ]) {
    await copyDistributionTree(
      path.join(archifySource, directory),
      path.join(archifyTarget, directory),
      {
        exclude: directory === "node_modules"
          // `simple-icons` (~23 MB) is only used by the brand-mark generator,
          // never at runtime, so the clean seed omits it.
          ? (relative, entry) => entry.name === ".DS_Store" || entry.name === "simple-icons"
          : excludedSource
      }
    );
  }
  for (const file of ["LICENSE", "SKILL.md", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "upstream.json"]) {
    await copyDistributionFile(path.join(archifySource, file), path.join(archifyTarget, file));
  }
}

async function writeCleanSeedDocuments(stage) {
  await writeText(path.join(stage, "01-system", "AI Dev Control Center.md"), `# AI Dev Control Center

This is the clean local control surface for the containerized AI Dev System.

## Engineering Workflow

1. Mount repositories under \`/workspace\`.
2. Call \`begin_task\` with the container path.
3. Load only the routed skills and bounded project context.
4. Implement, verify, and complete the task with machine-readable evidence.

## Privacy Boundary

- Knowledge, task state, search indexes, and artifacts stay in the local Docker volume.
- No password notes or owner project contexts are included in the image.
- The MCP transport is local stdio; no remote listener is enabled.
`);
  await writeText(path.join(stage, "02-knowledge", "README.md"), `# Local Knowledge

This directory starts clean. Project summaries and task records are created only from repositories
that the local user explicitly mounts into the container.
`);
  await writeText(path.join(stage, "PUBLIC_SEED.md"), `# Public Seed

This seed contains reusable system rules, project templates, prompts, quality gates, custom workflow
skills, and MIT-licensed design knowledge. It deliberately contains no owner passwords, project
contexts, task history, search indexes, logs, caches, models, or runtime state.
`);
}

function privateTerms(vaultRoot) {
  const username = os.userInfo().username;
  return [
    username,
    os.homedir(),
    path.resolve(vaultRoot)
  ];
}

async function createPublicSeed({ source, output, replace }) {
  const vaultRoot = path.resolve(source);
  const outputRoot = assertGeneratedTarget(output);
  const stage = path.join(generatedRoot, `public-seed-${process.pid}`);
  await fs.mkdir(generatedRoot, { recursive: true });
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });

  try {
    await copyStaticFiles(vaultRoot, stage);
    await copySkillSources(vaultRoot, stage);
    await writeCleanSeedDocuments(stage);

    const initialAudit = assertCleanDistribution(
      await auditDistributionTree(stage, { forbiddenTerms: privateTerms(vaultRoot) }),
      "public seed"
    );
    const manifest = {
      schema_version: 1,
      policy: "explicit allowlist; no private vault zones or local runtime state",
      total_files: initialAudit.total_files,
      total_bytes: initialAudit.total_bytes,
      content_fingerprint: distributionContentFingerprint(initialAudit.files),
      files: initialAudit.files
    };
    await writeText(
      path.join(stage, "public-seed.manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const finalAudit = assertCleanDistribution(
      await auditDistributionTree(stage, { forbiddenTerms: privateTerms(vaultRoot) }),
      "public seed"
    );

    const exists = await fs.access(outputRoot).then(() => true).catch(() => false);
    if (exists && !replace) {
      throw new Error(`Public seed already exists. Re-run with --replace: ${outputRoot}`);
    }
    if (exists) await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputRoot), { recursive: true });
    await fs.rename(stage, outputRoot);
    return {
      status: "created",
      output: outputRoot,
      files: finalAudit.total_files,
      bytes: finalAudit.total_bytes,
      fingerprint: manifest.content_fingerprint
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

if (await isDirectExecution(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await createPublicSeed(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

export { createPublicSeed };
