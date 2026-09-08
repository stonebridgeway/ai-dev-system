import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { aiDevHome } from "../src/core/runtime-paths.mjs";

const manifestPath = fileURLToPath(new URL("../models/bge-m3.manifest.json", import.meta.url));
export const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
export const defaultModelDir = () => path.resolve(process.env.BGE_M3_MODEL_DIR || path.join(aiDevHome(), "models", "bge-m3"));

export async function fileSha256(file) {
  try {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest("hex");
  } catch (error) { return error?.code === "ENOENT" ? null : Promise.reject(error); }
}

export async function modelStatus(targetDir = defaultModelDir(), expected = manifest) {
  const missing = [];
  for (const [relative, digest] of Object.entries(expected.files)) {
    if (await fileSha256(path.join(targetDir, relative)) !== digest) missing.push(relative);
  }
  return { model: expected.model, revision: expected.revision, dtype: expected.dtype, dir: targetDir, ready: missing.length === 0, missing };
}

async function download(url, target, expected, log) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url} returned HTTP ${response.status}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.part`;
  const hash = crypto.createHash("sha256");
  const tap = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  log(`downloading ${path.basename(target)}`);
  try {
    await pipeline(Readable.fromWeb(response.body), tap, fs.createWriteStream(temporary, { flags: "wx" }));
    const actual = hash.digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch: ${actual} != ${expected}`);
    await fsp.rename(temporary, target);
  } finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function pullModel({ targetDir = defaultModelDir(), expected = manifest, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  if (process.env.AI_DEV_OFFLINE === "1") throw new Error("AI_DEV_OFFLINE=1 prevents downloads; provide a verified model directory instead.");
  for (const [relative, digest] of Object.entries(expected.files)) {
    const target = path.join(targetDir, relative);
    if (await fileSha256(target) === digest) continue;
    let lastError;
    for (const source of expected.sources) {
      try { await download(`${source.replace(/\/$/, "")}/${relative}`, target, digest, log); lastError = null; break; }
      catch (error) { lastError = error; log(`source failed for ${relative}: ${error.message}`); }
    }
    if (lastError) throw new Error(`Could not fetch ${relative}: ${lastError.message}`);
  }
  await fsp.writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(expected, null, 2)}\n`);
  return modelStatus(targetDir, expected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  const result = command === "pull" ? await pullModel() : await modelStatus();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 1;
}
