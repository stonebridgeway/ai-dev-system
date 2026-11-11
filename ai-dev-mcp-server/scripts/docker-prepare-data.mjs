#!/usr/bin/env node
/**
 * At image build only (`docker/Dockerfile`): build into the image's /data what
 * a first start builds, so a new volume, which Docker fills from it, starts with
 * nothing left to build. The steps are the entrypoint's
 * (`scripts/docker-bootstrap.mjs`), run as a volume would see them:
 *
 * 1. the seed into the vault, dated a minute back, so what is built from it is
 *    newer than it even after the layer rounds times to the second;
 * 2. the first start's steps;
 * 3. every time rounded down to the second, as the layer will keep it, and the
 *    steps again for what that made stale (the index records each document's
 *    time to the nanosecond);
 * 4. once more, which must build nothing — or the build stops, because every
 *    new volume would then rebuild it on its first start;
 * 5. the state the build's own tool calls left (a usage ledger of the build)
 *    removed — a volume's first start would have moved it into the user's
 *    state folder — and the record of the seed's time and of how much the data
 *    holds, for that first start (`src/core/image-data.mjs`).
 *
 *   node scripts/docker-prepare-data.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../src/core/direct-execution.mjs";
import { dateTree, settleTimes, writePreparedMarker } from "../src/core/image-data.mjs";
import { currentInstallLayout } from "../src/core/install-layout.mjs";
import { syncSeed } from "../src/core/seed-sync.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The entrypoint's steps in a process of their own, as each container start runs them. */
function bootstrap() {
  const run = spawnSync(process.execPath, [path.join(serverRoot, "scripts", "docker-bootstrap.mjs"), "--json"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1 << 24
  });
  if (run.status !== 0) throw new Error(`docker-bootstrap.mjs exited with ${run.status ?? run.signal}.`);
  const line = run.stdout.trim().split("\n").at(-1);
  return JSON.parse(line).results;
}

const built = (results) => results.filter((step) => step.status === "done").map((step) => step.id);
const failed = (results) => results.filter((step) => step.status === "failed").map((step) => `${step.id}: ${step.error}`);

export async function prepareImageData({ layout = currentInstallLayout(), now = () => Date.now() } = {}) {
  if (layout.kind !== "docker" || !layout.seedRoot) throw new Error("This prepares an image's /data: run it in the image's build, with AI_DEV_RUNTIME=docker.");
  const dataRoot = path.dirname(layout.contentRoot);
  const seconds = Math.floor(now() / 1000) - 60;
  const version = JSON.parse(await fs.readFile(path.join(layout.serverRoot, "package.json"), "utf8")).version;
  const seed = await syncSeed({ seedRoot: layout.seedRoot, contentRoot: layout.contentRoot, version });
  await dateTree(layout.contentRoot, seconds);
  const first = bootstrap();
  if (failed(first).length) throw new Error(`The first start's steps failed at build: ${failed(first).join("; ")}`);
  await settleTimes(dataRoot);
  const second = bootstrap();
  await settleTimes(dataRoot);
  const third = bootstrap();
  if (built(third).length || failed(third).length) {
    throw new Error(`After the build the data is still not current: ${[...built(third), ...failed(third)].join(", ")} would run again on every new volume's first start.`);
  }
  const stateRoot = process.env.AI_DEV_STATE_ROOT || path.join(layout.runtimeRoot, "state");
  await fs.rm(stateRoot, { recursive: true, force: true });
  // A start makes its state folder before it looks at a new volume: neither side counts it.
  await writePreparedMarker(dataRoot, { seconds, version, skip: [stateRoot] });
  return { seed: { status: seed.status, added: seed.added }, seed_dated: seconds, first: built(first), second: built(second), third: built(third) };
}

if (await isDirectExecution(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await prepareImageData())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
