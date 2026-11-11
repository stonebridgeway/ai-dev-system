import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_NODE,
  nodeVersionSupported,
  compareVersions,
  denseDoctorStages,
  renderDenseDoctorReport,
  runDenseDoctor,
  vectorNorm
} from "./dense-doctor.mjs";

const MANIFEST = Object.freeze({
  export: "Xenova/bge-m3",
  revision: "e".repeat(40),
  dtype: "int8",
  dimensions: 4
});

const unitVector = [0.5, 0.5, 0.5, 0.5];

function deps(overrides = {}) {
  return {
    nodeVersion: "v22.22.2",
    loadRuntime: async () => ({ InferenceSession: function InferenceSession() {} }),
    readManifest: () => MANIFEST,
    verifyFiles: async () => ({ ready: true, dir: "/models/bge-m3-onnx", present: ["a", "b"], missing: [], mismatched: [] }),
    loadModel: async () => ({ seconds: 2.1 }),
    embedProbe: async () => ({ vector: unitVector, seconds: 0.08 }),
    ...overrides
  };
}

const doctor = (overrides) => runDenseDoctor(denseDoctorStages(deps(overrides)));

test("versions compare by number, not by string", () => {
  assert.ok(compareVersions("22.16.0", MINIMUM_NODE) === 0);
  assert.ok(compareVersions("v24.1.0", "22.12.0") > 0);
  assert.ok(compareVersions("22.9.0", "22.12.0") < 0, "22.9 is older than 22.12, though it sorts later as text");
  assert.ok(compareVersions("22", "22.0.0") === 0);
});

test("the supported Node is 22.16 or a later 22.x, or 24 and newer — not 23", () => {
  for (const version of ["v22.16.0", "22.22.0", "v24.0.0", "26.1.0"]) assert.equal(nodeVersionSupported(version), true, version);
  for (const version of ["v22.15.1", "22.12.0", "v23.11.0", "23.0.0", "20.19.0"]) assert.equal(nodeVersionSupported(version), false, version);
});

test("a normalized vector is recognised and a raw one is not", () => {
  assert.deepEqual(vectorNorm(unitVector), { norm: 1, unit: true });
  assert.equal(vectorNorm([3, 4, 0, 0]).unit, false);
  assert.equal(vectorNorm([3, 4, 0, 0]).norm, 5);
});

test("a machine with everything in place reads READY, every stage ok", async () => {
  const result = await doctor();
  assert.equal(result.ready, true);
  assert.equal(result.failed, null);
  assert.deepEqual(result.stages.map((stage) => stage.status), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  const report = renderDenseDoctorReport(result);
  assert.match(report, /Dense search: READY/);
  assert.match(report, /Xenova\/bge-m3 @ eeeeeeeeeeee, int8/);
  assert.ok(!report.includes("What to do"), "a working machine is not told to do anything");
});

test("an empty model directory stops at the files stage and names the command", async () => {
  const result = await doctor({
    verifyFiles: async () => ({
      ready: false,
      dir: "/models/bge-m3-onnx",
      present: [],
      missing: ["config.json", "onnx/model_int8.onnx"],
      mismatched: []
    })
  });

  assert.equal(result.ready, false);
  assert.equal(result.failed.key, "files");
  const report = renderDenseDoctorReport(result);
  assert.match(report, /Dense search: UNAVAILABLE/);
  assert.match(report, /Stopped at: model files present and unmodified/);
  assert.match(report, /missing from \/models\/bge-m3-onnx: config\.json, onnx\/model_int8\.onnx/);
  assert.match(report, /What to do: Run `npm run setup -- --model` to start the download \(about 600 MB, no Python\)\./);
  assert.match(report, /AI_DEV_MODEL_MIRROR .* HTTPS_PROXY.*npm run model -- import <folder or \.zip>/s, "and the ways round a blocked download");
  assert.doesNotMatch(report, /AI_DEV_DENSE_BACKEND|python for the legacy/i);
});

test("a download that stopped partway is named, and continuing it is the advice", async () => {
  const result = await doctor({
    verifyFiles: async () => ({
      ready: false,
      dir: "/models/bge-m3-onnx",
      present: ["config.json"],
      missing: ["onnx/model_int8.onnx"],
      mismatched: [],
      partial: [{ file: "onnx/model_int8.onnx", bytes: 312 * 1024 * 1024, size: 568 * 1024 * 1024 }]
    })
  });
  const report = renderDenseDoctorReport(result);
  assert.match(report, /a download stopped partway: onnx\/model_int8\.onnx \(312 MB so far\)/);
  assert.match(report, /What to do: Run `npm run setup -- --model` to continue the download/);
});

test("a machine with no runtime build is told so at the runtime stage, and nothing is loaded", async () => {
  let loaded = 0;
  const result = await doctor({
    support: () => ({ supported: false, reason: "onnxruntime-node 1.30.0 has no build for darwin-x64 (Intel Mac), so the local model cannot run on this machine." }),
    loadRuntime: async () => {
      loaded += 1;
      return {};
    }
  });
  assert.equal(result.failed.key, "runtime");
  assert.equal(loaded, 0, "importing it would only produce a require stack");
  const report = renderDenseDoctorReport(result);
  assert.match(report, /darwin-x64 \(Intel Mac\)/);
  assert.match(report, /What to do: Dense search needs a machine with a build, or the Docker image/);
  assert.doesNotMatch(report, /npm rebuild/);
});

test("files that are there but wrong get different advice from files that are absent", async () => {
  const result = await doctor({
    verifyFiles: async () => ({
      ready: false,
      dir: "/models/bge-m3-onnx",
      present: ["config.json"],
      missing: [],
      mismatched: ["onnx/model_int8.onnx"]
    })
  });
  const report = renderDenseDoctorReport(result);
  assert.match(report, /do not match the manifest/);
  assert.match(report, /it fetches the files that do not match again/, "the download replaces a file that does not hash right");
  assert.ok(!/start the download/.test(report), "not the advice for files that are absent");
});

test("in the image, the host's folder at /models is fixed on the host, as the start report says", async () => {
  const lacking = async () => ({ ready: false, dir: "/models/bge-m3-onnx", present: ["config.json"], missing: ["tokenizer.json"], mismatched: [] });
  const report = renderDenseDoctorReport(await doctor({ inContainer: true, verifyFiles: lacking }));
  assert.match(report, /What to do: In this container, the folder is the host's, mounted read-only at \/models \(AI_DEV_MODEL_PATH\): put the model right there on the host/);
  assert.doesNotMatch(report, /model install`|setup -- --model|start the download/, "nothing installed into the volume fixes a mounted folder");
  const wrong = await doctor({ inContainer: true, verifyFiles: async () => ({ ...await lacking(), missing: [], mismatched: ["config.json"] }) });
  assert.match(renderDenseDoctorReport(wrong), /What to do: In this container, the folder is the host's/);
  // The volume's own folder, and the same path outside the image, keep the download's advice.
  const volume = await doctor({ inContainer: true, verifyFiles: async () => ({ ...await lacking(), dir: "/data/runtime-home/.ai-dev/models/bge-m3-onnx" }) });
  assert.match(renderDenseDoctorReport(volume), /to start the download/);
  assert.match(renderDenseDoctorReport(await doctor({ verifyFiles: lacking })), /to start the download/);
  // Files that verified and do not load: the host's folder is still put right on the host.
  const whole = async () => ({ ready: true, dir: "/models/bge-m3-onnx", present: ["config.json"], missing: [], mismatched: [] });
  const broken = async () => { throw new Error("Protobuf parsing failed"); };
  const load = renderDenseDoctorReport(await doctor({ inContainer: true, verifyFiles: whole, loadModel: broken }));
  assert.match(load, /What to do: The files verified but the runtime would not load them\. In this container, the folder is the host's/);
  assert.doesNotMatch(load, /model -- remove|model remove/);
  assert.match(renderDenseDoctorReport(await doctor({ verifyFiles: whole, loadModel: broken })), /npm run model -- remove`, then `npm run setup -- --model`/);
});

test("stages after a failure are skipped rather than run into a worse error", async () => {
  let loadCalls = 0;
  const result = await doctor({
    verifyFiles: async () => ({ ready: false, dir: "/d", present: [], missing: ["config.json"], mismatched: [] }),
    loadModel: async () => {
      loadCalls += 1;
      return { seconds: 0 };
    }
  });
  assert.equal(loadCalls, 0, "loading a model whose weights are absent produces a second, confusing error");
  assert.deepEqual(result.stages.map((stage) => stage.status), ["ok", "ok", "ok", "fail", "skipped", "skipped"]);
});

test("an old Node stops at the first stage and nothing else is attempted", async () => {
  let runtimeCalls = 0;
  const result = await doctor({
    nodeVersion: "v20.11.0",
    loadRuntime: async () => {
      runtimeCalls += 1;
      return {};
    }
  });
  assert.equal(result.failed.key, "node");
  assert.equal(runtimeCalls, 0);
  assert.match(renderDenseDoctorReport(result), /this is v20\.11\.0/);
});

test("a native binding that will not load is a sentence, never a stack trace", async () => {
  const result = await doctor({
    loadRuntime: async () => {
      const error = new Error("libonnxruntime.so.1: cannot open shared object file");
      error.stack = "Error: libonnxruntime...\n    at Object.<anonymous> (/deep/internal/path.js:1:1)";
      throw error;
    }
  });

  assert.equal(result.failed.key, "runtime");
  const report = renderDenseDoctorReport(result);
  assert.match(report, /cannot open shared object file/);
  assert.match(report, /Restore the package: run `npm ci` in ai-dev-mcp-server\//);
  assert.doesNotMatch(report, /npm rebuild/, "no command builds onnxruntime from source");
  assert.ok(!report.includes("    at Object"), "no stack frames reach the user");
});

test("a runtime that imports but exports nothing usable fails rather than passing", async () => {
  const result = await doctor({ loadRuntime: async () => ({}) });
  assert.equal(result.failed.key, "runtime");
});

test("a manifest that will not parse fails at its own stage", async () => {
  const result = await doctor({
    readManifest: () => {
      throw new Error("Dense model manifest is missing: revision.");
    }
  });
  assert.equal(result.failed.key, "manifest");
  assert.match(renderDenseDoctorReport(result), /manifest is missing: revision/);
});

test("a model that loads but embeds the wrong width is caught", async () => {
  const result = await doctor({ embedProbe: async () => ({ vector: [1, 0], seconds: 0.1 }) });
  assert.equal(result.failed.key, "embed");
  assert.match(renderDenseDoctorReport(result), /2 dimensions.*the manifest says 4/);
});

test("a model that embeds unnormalized vectors is caught, because scoring assumes it did not", async () => {
  const result = await doctor({ embedProbe: async () => ({ vector: [3, 4, 0, 0], seconds: 0.1 }) });
  assert.equal(result.failed.key, "embed");
  assert.match(renderDenseDoctorReport(result), /norm 5, .*vectors must be normalized/);
});

test("the trial embedding reports its latency when it passes", async () => {
  assert.match(renderDenseDoctorReport(await doctor()), /4 dimensions, norm 1, 0\.08s/);
});
