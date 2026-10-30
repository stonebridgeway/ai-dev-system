#!/usr/bin/env node
/**
 * Every version of a seed file a 2.x image shipped — what an old Docker volume
 * can hold.
 *
 *   node scripts/seed-history.mjs            print what the history would hold
 *   node scripts/seed-history.mjs --write    write data/seed-history.json
 *   node scripts/seed-history.mjs --check    exit 1 when the file is not what git says
 *
 * 2.x images copied their seed into the volume with `cp -n` and kept no record.
 * The sync that replaces it (`src/core/seed-sync.mjs`)
 * tells a file the user changed from one an update should replace by that
 * record; a 2.x volume has none, so every skill an older image left there would
 * look like the user's own, and none would ever be updated or removed. This
 * history is how the sync tells them apart: each (path, sha256) pair that a
 * commit of `docker/public-seed` reachable from {@link SEED_HISTORY_BASE} held,
 * as the first 16 hex digits of `sha256("<path>\0<sha256>")`.
 *
 * Only the 2.x line: 3.0 keeps a record in every vault it fills, and images
 * are published from the production repository alone, so no volume without a
 * record holds a seed of a 3.0 commit. Nothing is left out for being
 * in the current manifest either — a 3.0 edit of such a file would otherwise
 * turn the 2.x version of it into "the user's". So the file changes
 * only when the base does: when production ships another 2.x, the base moves to
 * it and the history is written again, from a clone that has that history.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../src/core/direct-execution.mjs";
import { SEED_HISTORY_FILE, seedHistoryKey } from "../src/core/seed-sync.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const SEED = "docker/public-seed";

function git(args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], { encoding, shell: false, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(result.stderr || result.error?.message || "failed").trim()}`);
  return result.stdout;
}

/** Production `main` when work on 3.0 started: the newest 2.x a volume can have been filled from. */
export const SEED_HISTORY_BASE = "86aba56f9d2b7ebd6e883f4774778bd0625e17e3";

/**
 * The blobs' contents, by one `git cat-file --batch`: a process per blob took
 * 18 seconds for the seed's history.
 *
 * @param {string[]} blobs - Object names, each once.
 * @returns {Map<string, Buffer>}
 */
function readBlobs(blobs) {
  const result = spawnSync("git", ["-C", repositoryRoot, "cat-file", "--batch"], { input: `${blobs.join("\n")}\n`, shell: false, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`git cat-file --batch: ${String(result.stderr || result.error?.message || "failed").trim()}`);
  const contents = new Map();
  let offset = 0;
  for (const blob of blobs) {
    const newline = result.stdout.indexOf(10, offset);
    const [name, type, size] = result.stdout.subarray(offset, newline).toString("utf8").split(" ");
    if (name !== blob || type !== "blob") throw new Error(`git cat-file --batch answered ${name} ${type} for ${blob}.`);
    const start = newline + 1;
    contents.set(blob, result.stdout.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return contents;
}

/**
 * The (path, sha256) pairs of the seed in the given commits, as history keys.
 *
 * @param {string[]} commits
 * @returns {Set<string>}
 */
export function seedKeys(commits) {
  const files = [];
  for (const commit of commits) {
    for (const entry of git(["ls-tree", "-r", "--full-tree", commit, "--", SEED]).split("\n").filter(Boolean)) {
      const [meta, file] = entry.split("\t");
      files.push({ blob: meta.split(" ")[2], relative: file.slice(SEED.length + 1) });
    }
  }
  const contents = readBlobs([...new Set(files.map((file) => file.blob))]);
  const sha = new Map([...contents].map(([blob, content]) => [blob, crypto.createHash("sha256").update(content).digest("hex")]));
  return new Set(files.map((file) => seedHistoryKey(file.relative, sha.get(file.blob))));
}

/** Whether this clone has the base's history: a shallow clone (CI's) has one commit. */
export function hasSeedHistory(base = SEED_HISTORY_BASE) {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") return false;
  return spawnSync("git", ["-C", repositoryRoot, "cat-file", "-e", `${base}^{commit}`], { shell: false }).status === 0;
}

/** The history as git has it, from the base back. */
export async function computeSeedHistory(base = SEED_HISTORY_BASE) {
  if (!hasSeedHistory(base)) {
    throw new Error(`This clone does not have the history of ${base}: run \`git fetch --unshallow\` (or fetch that commit) first.`);
  }
  const commits = git(["log", "--format=%H %h %ad", "--date=short", base, "--", SEED]).trim().split("\n").filter(Boolean);
  const keys = seedKeys(commits.map((line) => line.split(" ")[0]));
  const [last, first] = [commits[0], commits.at(-1)].map((line) => line.split(" ").slice(1).join(" "));
  return {
    schema_version: 1,
    $comment: "Every (path, sha256) a commit of docker/public-seed reachable from `base` held: what a 2.x volume's `cp -n` can have left. Written by scripts/seed-history.mjs; read by src/core/seed-sync.mjs.",
    key: "sha256 of `<path>\\0<sha256 of the file>`, first 16 hex digits",
    base,
    commits: commits.length,
    first,
    last,
    pairs: [...keys].sort()
  };
}

if (await isDirectExecution(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? "";
    if (mode && !["--write", "--check"].includes(mode)) throw new Error(`Unknown argument: ${mode}`);
    const history = await computeSeedHistory();
    const text = `${JSON.stringify(history, null, 1)}\n`;
    if (mode === "--write") {
      await fs.mkdir(path.dirname(SEED_HISTORY_FILE), { recursive: true });
      await fs.writeFile(SEED_HISTORY_FILE, text, "utf8");
    } else if (mode === "--check") {
      const current = await fs.readFile(SEED_HISTORY_FILE, "utf8").catch(() => "");
      if (current !== text) {
        process.stderr.write(`${path.relative(repositoryRoot, SEED_HISTORY_FILE)} is not what git says: run \`node scripts/seed-history.mjs --write\`.\n`);
        process.exitCode = 1;
      }
    }
    process.stdout.write(`${JSON.stringify({ commits: history.commits, first: history.first, last: history.last, pairs: history.pairs.length, bytes: Buffer.byteLength(text) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
