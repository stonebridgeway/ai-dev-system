#!/usr/bin/env node
/**
 * `npm run docker:prepare` — the image's build context, `.docker/build-context`:
 *
 * - `ai-dev/` — the distribution itself, as `npm run dist -- --no-deps` builds
 *   it, `distribution.json` and all. The image installs the dependencies from
 *   its shrinkwrap and checks every file against that list (`docker/Dockerfile`):
 *   the image is the package, not a layout of its own. Before 3.0 the context
 *   had one (`app/`, `runtime/`, `public-seed/`), and the two drifted apart;
 * - `Dockerfile` and `container/entrypoint.sh` — the allowlist's groups only the
 *   image needs;
 * - `.dockerignore`, so nothing else reaches the builder;
 * - `context.json` — when the context was made and from which distribution,
 *   for `npm run docker:audit`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { planDistribution } from "../src/core/distribution-build.mjs";
import {
  assertCleanDistribution,
  auditDistributionTree,
  copyDistributionFile,
  ownerUsername
} from "../src/core/public-distribution.mjs";
import { isDirectExecution } from "../src/core/direct-execution.mjs";
import { stageDistribution } from "./build-dist.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const generatedRoot = path.join(repositoryRoot, ".docker");
const defaultOutput = path.join(generatedRoot, "build-context");

/** Where the distribution sits in the context, and what the Dockerfile copies. */
export const CONTEXT_DISTRIBUTION = "ai-dev";

/** The file `docker:audit` reads to tell a fresh context from one an older tree left. */
export const CONTEXT_RECORD = "context.json";

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

async function writeText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function createDockerContext({ output }) {
  const outputRoot = assertGeneratedTarget(output);
  const stage = path.join(generatedRoot, `context-${process.pid}`);
  await fs.mkdir(generatedRoot, { recursive: true });
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  try {
    const distribution = await stageDistribution(path.join(stage, CONTEXT_DISTRIBUTION), { deps: false });
    for (const item of await planDistribution({ repositoryRoot, target: "docker" })) {
      await copyDistributionFile(item.source, path.join(stage, ...item.destination.split("/")));
    }
    await writeText(path.join(stage, ".dockerignore"), `**
!.dockerignore
!Dockerfile
!container/
!container/**
!${CONTEXT_DISTRIBUTION}/
!${CONTEXT_DISTRIBUTION}/**
`);
    const forbiddenTerms = [os.homedir(), ...(process.env.CI ? [] : [ownerUsername()])];
    const audit = assertCleanDistribution(await auditDistributionTree(stage, { forbiddenTerms }), "Docker build context");
    await writeText(path.join(stage, CONTEXT_RECORD), `${JSON.stringify({
      schema_version: 2,
      generated_at: new Date().toISOString(),
      distribution: {
        folder: CONTEXT_DISTRIBUTION,
        name: distribution.name,
        version: distribution.version,
        content_fingerprint: distribution.fingerprint,
        files: distribution.files,
        bytes: distribution.bytes
      },
      context_files: audit.total_files,
      context_bytes: audit.total_bytes
    }, null, 2)}\n`);

    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.rename(stage, outputRoot);
    return {
      status: "prepared",
      output: outputRoot,
      version: distribution.version,
      files: audit.total_files,
      bytes: audit.total_bytes,
      fingerprint: distribution.fingerprint
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
