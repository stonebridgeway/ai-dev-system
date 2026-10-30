import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDenseRuntime, DENSE_PROBE_TTL_MS } from "./dense-runtime.mjs";

const MANIFEST = Object.freeze({
  model: "BAAI/bge-m3",
  export: "Xenova/bge-m3",
  revision: "c".repeat(40),
  dtype: "int8",
  dimensions: 1024,
  files: Object.freeze({ "config.json": "a".repeat(64), "onnx/model_int8.onnx": "b".repeat(64) })
});

function runtimeWith({ ready = true, supported = true, env = {}, now, legacyModelDir = "", exists, onnxModelDir = "/models/bge-m3-onnx", stampDir = "", found = null, verifyError = null } = {}) {
  const calls = { verify: [], embed: [], shutdown: 0 };
  const runtime = createDenseRuntime({
    manifest: MANIFEST,
    onnxModelDir,
    stampDir,
    legacyModelDir,
    env,
    onnxRuntime: {
      embedTexts: async (payload) => {
        calls.embed.push(payload);
        return { embeddings: [[1]], backend: "onnx" };
      },
      status: () => ({ worker: { started: true, pending_requests: 0, load_seconds: 0.2 } }),
      shutdown: async () => {
        calls.shutdown += 1;
        throw new Error("already gone");
      }
    },
    verify: async (options) => {
      calls.verify.push(options);
      if (verifyError) throw verifyError;
      return found ?? { ready, dir: onnxModelDir, missing: ready ? [] : ["onnx/model_int8.onnx"], mismatched: [] };
    },
    support: () => ({ supported, reason: supported ? "" : "no build for darwin-x64 (Intel Mac)" }),
    ...(exists ? { exists } : {}),
    ...(now ? { now } : {})
  });
  return { runtime, calls };
}

test("a verified export is the backend, with the manifest's provenance, and embeds", async () => {
  const { runtime, calls } = runtimeWith();
  const chosen = await runtime.describe();
  assert.deepEqual([chosen.backend, chosen.available], ["onnx", true]);
  assert.deepEqual(chosen.provenance, { backend: "onnx", model: "BAAI/bge-m3", revision: MANIFEST.revision, dtype: "int8", dimensions: 1024 });
  assert.deepEqual(chosen.legacy, { notes: [], command: "" });
  assert.deepEqual(await runtime.embed({ texts: ["x"] }), { embeddings: [[1]], backend: "onnx" });
  assert.deepEqual(calls.embed, [{ texts: ["x"] }]);
  await runtime.shutdown();
  assert.equal(calls.shutdown, 1, "a worker that is already gone does not make shutdown throw");
});

test("without the model, embedding is refused with the reason and the commands", async () => {
  const { runtime, calls } = runtimeWith({ ready: false });
  await assert.rejects(runtime.embed({ texts: ["x"] }), /Dense search is not installed: the model is not on this machine\. Run `npm run setup -- --model`/);
  assert.deepEqual(calls.embed, []);
  const inContainer = runtimeWith({ ready: false, env: { AI_DEV_RUNTIME: "docker" } });
  // Its folder here is the host's mount at /models: the fix is on the host.
  assert.match((await inContainer.runtime.describe()).reason, /mounted read-only at \/models .*put the model right there on the host/);
  const intel = runtimeWith({ supported: false });
  assert.match((await intel.runtime.describe()).reason, /darwin-x64/);
  // Files that are there but not the pinned ones are not "not on this machine".
  const tampered = runtimeWith({ found: { ready: false, dir: "/models/bge-m3-onnx", present: ["config.json"], missing: [], mismatched: ["onnx/model_int8.onnx"] } });
  await assert.rejects(tampered.runtime.embed({ texts: ["x"] }),
    /^Error: Dense search is not ready: onnx\/model_int8\.onnx in \/models\/bge-m3-onnx is not the pinned file \(the sha256 differs from the manifest\)\. Run `npm run setup -- --model`: it fetches it again\.$/);
});

test("a model this process cannot read is not ready, and says why: the health check and embedding_status stand", async (t) => {
  const denied = Object.assign(new Error("EACCES: permission denied, open '/models/bge-m3-onnx/config.json'"), { code: "EACCES", syscall: "open" });
  const { runtime } = runtimeWith({ verifyError: denied, env: { AI_DEV_RUNTIME: "docker" } });
  const status = await runtime.describe();
  assert.equal(status.available, false);
  // The image is Linux: only there does the folder resolve to its /models mount.
  if (process.platform !== "win32") assert.match(status.reason, /the model in \/models\/bge-m3-onnx cannot be read \(EACCES: permission denied, open '\/models\/bge-m3-onnx\/config\.json'\)\. The image runs as uid 1000: make the folder and its files readable to it on the host/);
  assert.equal(status.onnx.unreadable, "EACCES: permission denied, open '/models/bge-m3-onnx/config.json'");
  assert.equal("unreadable" in (await runtimeWith({}).runtime.describe()).onnx, false, "a readable model has no such field");
  await assert.rejects(runtime.embed({ texts: ["x"] }), /cannot be read/);
  // Its files are not missing, only unseen; one not there at all is.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-runtime-unread-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "onnx"));
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx"), "x");
  await fs.writeFile(path.join(dir, "config.json"), "{}");
  const whole = runtimeWith({ verifyError: denied, onnxModelDir: dir });
  assert.deepEqual((await whole.runtime.describe()).onnx.missing, []);
  await fs.rm(path.join(dir, "config.json"));
  const gap = runtimeWith({ verifyError: denied, onnxModelDir: dir });
  assert.deepEqual((await gap.runtime.describe()).onnx.missing, ["config.json"]);
  // A stopped download of the missing file beside it: what is said first is why the model cannot be read.
  await fs.writeFile(path.join(dir, "config.json.part"), "{\"half\":");
  await fs.writeFile(path.join(dir, "config.json.part.json"), JSON.stringify({ format: 1, revision: MANIFEST.revision, sha256: MANIFEST.files["config.json"], size: 182 }));
  const stopped = await runtimeWith({ verifyError: denied, onnxModelDir: dir }).runtime.describe();
  assert.deepEqual(stopped.partial, []);
  assert.match(stopped.reason, /cannot be read \(EACCES/);
  // A fault of the code is a check that could not be made, not a model that cannot be read.
  const fault = await runtimeWith({ verifyError: new TypeError("Cannot read properties of undefined (reading 'files')") }).runtime.describe();
  assert.equal(fault.available, false);
  assert.equal("unreadable" in fault.onnx, false);
  assert.equal(fault.onnx.unchecked, "Cannot read properties of undefined (reading 'files')", "the details say why");
  assert.equal(fault.reason, `Dense search is not ready: the model in ${path.resolve("/models/bge-m3-onnx")} could not be checked (Cannot read properties of undefined (reading 'files')).`);
  const local = runtimeWith({ verifyError: denied, onnxModelDir: "/home/me/.ai-dev/models/bge-m3-onnx" });
  assert.match((await local.runtime.describe()).reason, /cannot be read .*Make the folder and its files readable to the user this runs as\./);
});

test("the check trusts the record for a minute, and a refresh reads every file", async () => {
  let clock = 0;
  const { runtime, calls } = runtimeWith({ now: () => clock, stampDir: "/cache/dense-model" });
  await runtime.describe();
  await runtime.describe();
  clock = DENSE_PROBE_TTL_MS - 1;
  await runtime.describe();
  assert.equal(calls.verify.length, 1, "inside the minute the answer is kept");
  assert.equal(calls.verify[0].trustStamp, true);
  assert.match(calls.verify[0].stampFile, /verified-[0-9a-f]{16}\.json$/);
  clock = DENSE_PROBE_TTL_MS + 1;
  await runtime.describe();
  assert.equal(calls.verify.length, 2);
  await runtime.describe({ refresh: true });
  assert.deepEqual([calls.verify.length, calls.verify[2].trustStamp], [3, false]);
  const noStamp = runtimeWith();
  await noStamp.runtime.describe();
  assert.equal(noStamp.calls.verify[0].stampFile, "", "no record kept without a place for it");
});

test("a record rewritten by an install, import or remove ends the cached answer early", async (t) => {
  const stampDir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-runtime-stamp-"));
  t.after(() => fs.rm(stampDir, { recursive: true, force: true }));
  let clock = 0;
  const { runtime, calls } = runtimeWith({ now: () => clock, stampDir });
  await runtime.describe();
  clock = 1_000;
  await runtime.describe();
  assert.equal(calls.verify.length, 1, "nothing changed: the answer is kept");
  // What `setup -- --model` does between asking and embedding: the model goes in, the record is written.
  await fs.writeFile(calls.verify[0].stampFile, JSON.stringify({ format: 1, files: {} }));
  clock = 2_000;
  await runtime.describe();
  assert.equal(calls.verify.length, 2, "a new record is a new question, inside the minute too");
  await runtime.describe();
  assert.equal(calls.verify.length, 2, "and its answer is kept in turn");
  await fs.rm(calls.verify[0].stampFile);
  await runtime.describe();
  assert.equal(calls.verify.length, 3, "a removed record too");
});

test("2.x settings and weights left behind are named, with the one command", async () => {
  const { runtime } = runtimeWith({
    env: { AI_DEV_DENSE_BACKEND: "python", BGE_M3_PYTHON: "/venv/bin/python" },
    legacyModelDir: "/home/u/.ai-dev/models/bge-m3",
    exists: (target) => target === path.join("/home/u/.ai-dev/models/bge-m3", "pytorch_model.bin")
  });
  const chosen = await runtime.describe();
  assert.equal(chosen.available, true, "python asked for, onnx installed: the model there is used");
  assert.match(chosen.note, /AI_DEV_DENSE_BACKEND=python asks for the Python backend, which 3\.0 removed/);
  assert.equal(chosen.legacy.notes.length, 3);
  assert.equal(chosen.legacy.command, "npm run setup -- --model");
  assert.ok(chosen.legacy.notes.some((note) => note.includes("torch weights")));
});

test("status is the embedding_status payload: backend, folder, partial downloads, worker", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-runtime-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx.part"), Buffer.alloc(300));
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx.part.json"), JSON.stringify({ format: 1, revision: MANIFEST.revision, sha256: "b".repeat(64), size: 1000 }));
  const { runtime } = runtimeWith({ ready: false, onnxModelDir: dir });
  const status = await runtime.status({});
  assert.deepEqual([status.backend, status.installed, status.available, status.model_dir], ["onnx", false, false, dir]);
  assert.deepEqual(status.partial, [{ file: "onnx/model_int8.onnx", bytes: 300, size: 1000 }]);
  assert.match(status.reason, /^Dense search is not installed yet: the download of the model stopped partway \(onnx\/model_int8\.onnx\)\. Run `npm run setup -- --model` to continue it from there\.$/);
  assert.equal("partial" in status.dense_backend, false, "said once, at the top");
  assert.deepEqual(status.worker, { started: true, pending_requests: 0, load_seconds: 0.2 });
  assert.equal(status.dense_backend.backend, "onnx");
  assert.equal(status.dense_revision, MANIFEST.revision);
});
