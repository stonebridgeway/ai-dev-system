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
const generatedRoot = path.join(repositoryRoot, ".docker");
const defaultOutput = path.join(generatedRoot, "build-context");

function parseArgs(argv) {
  const options = { output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      options.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function assertGeneratedTarget(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(generatedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Docker context must stay below ${generatedRoot}: ${resolved}`);
  }
  return resolved;
}

async function copyFile(source, stage, target) {
  await copyDistributionFile(source, path.join(stage, target));
}

async function writeText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function copyApplication(stage) {
  await copyFile(path.join(serverRoot, "package.json"), stage, "app/package.json");
  await copyFile(path.join(serverRoot, "package-lock.json"), stage, "app/package-lock.json");
  await copyDistributionTree(path.join(serverRoot, "src"), path.join(stage, "app", "src"), {
    exclude: (relative, entry) => (
      /\.test\.mjs$/i.test(entry.name)
      || relative.replaceAll("\\", "/") === "core/public-distribution.mjs"
    )
  });
  for (const name of [
    "ai-dev.mjs",
    "docker-bootstrap.mjs",
    "protocol-smoke.mjs",
    "rebuild-live-state.mjs"
  ]) {
    await copyFile(path.join(serverRoot, "scripts", name), stage, `app/scripts/${name}`);
  }
  await copyFile(
    path.join(serverRoot, "config", "runtime.example.json"),
    stage,
    "app/config/runtime.example.json"
  );
}

async function copyRuntime(stage) {
  const runtimeFiles = [
    ["frontend-qa/frontend_qa_runner.mjs", "runtime/frontend-qa/frontend_qa_runner.mjs"],
    ["frontend-qa/package.json", "runtime/frontend-qa/package.json"],
    ["frontend-qa/pnpm-lock.yaml", "runtime/frontend-qa/pnpm-lock.yaml"],
    ["search-index/search_cli.py", "runtime/search-index/search_cli.py"],
    ["search-eval/search_eval_cases.json", "runtime/search-eval/search_eval_cases.json"],
    ["search-eval/skill_routing_eval_cases.json", "runtime/search-eval/skill_routing_eval_cases.json"],
    ["embeddings/bge_m3_embed.py", "runtime/embeddings/bge_m3_embed.py"],
    ["embeddings/bge_m3_worker.py", "runtime/embeddings/bge_m3_worker.py"],
    ["embeddings/requirements-bge-m3.txt", "runtime/embeddings/requirements-bge-m3.txt"]
  ];
  for (const [source, target] of runtimeFiles) {
    await copyFile(path.join(repositoryRoot, source), stage, target);
  }
}

async function createDockerContext({ output }) {
  const outputRoot = assertGeneratedTarget(output);
  const stage = path.join(generatedRoot, `context-${process.pid}`);
  const publicSeed = path.join(repositoryRoot, "docker", "public-seed");
  await fs.access(path.join(publicSeed, "public-seed.manifest.json")).catch(() => {
    throw new Error("Public seed is missing. Run npm run docker:seed first.");
  });

  await fs.mkdir(generatedRoot, { recursive: true });
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  try {
    await copyFile(path.join(repositoryRoot, "docker", "Dockerfile"), stage, "Dockerfile");
    await copyFile(path.join(repositoryRoot, "docker", "entrypoint.sh"), stage, "container/entrypoint.sh");
    await copyFile(
      path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
      stage,
      "THIRD_PARTY_NOTICES.md"
    );
    await copyFile(path.join(repositoryRoot, "LICENSE"), stage, "LICENSE");
    await copyApplication(stage);
    await copyRuntime(stage);
    await copyDistributionTree(publicSeed, path.join(stage, "public-seed"));
    await writeText(path.join(stage, ".dockerignore"), `**
!.dockerignore
!Dockerfile
!container/
!container/**
!app/
!app/**
!runtime/
!runtime/**
!public-seed/
!public-seed/**
!LICENSE
!THIRD_PARTY_NOTICES.md
`);

    const forbiddenTerms = [
      os.homedir(),
      ...(process.env.CI ? [] : [os.userInfo().username])
    ];
    const initialAudit = assertCleanDistribution(
      await auditDistributionTree(stage, { forbiddenTerms }),
      "Docker build context"
    );
    const manifest = {
      schema_version: 1,
      policy: "generated from explicit repository and public-seed allowlists",
      docker_receives_only_allowlisted_files: true,
      total_files: initialAudit.total_files,
      total_bytes: initialAudit.total_bytes,
      content_fingerprint: distributionContentFingerprint(initialAudit.files),
      files: initialAudit.files
    };
    await writeText(
      path.join(stage, "distribution-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const finalAudit = assertCleanDistribution(
      await auditDistributionTree(stage, { forbiddenTerms }),
      "Docker build context"
    );

    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.rename(stage, outputRoot);
    return {
      status: "prepared",
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
    process.stdout.write(`${JSON.stringify(await createDockerContext(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

export { createDockerContext };
