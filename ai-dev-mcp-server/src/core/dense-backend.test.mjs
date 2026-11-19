import assert from "node:assert/strict";
import test from "node:test";
import {
  DENSE_BACKEND_CHOICES,
  DENSE_INSTALL_COMMAND,
  DENSE_ONNX_BACKEND,
  LEGACY_DENSE_VARIABLES,
  containerModelAdvice,
  legacyDenseNotes,
  requestedDenseBackend,
  selectDenseBackend,
  unreadableModelAdvice
} from "./dense-backend.mjs";

test("the environment variable is read, a typo degrades to auto with a note, and python says what replaced it", () => {
  assert.deepEqual(requestedDenseBackend({}), { requested: "auto", note: "" });
  assert.deepEqual(requestedDenseBackend({ AI_DEV_DENSE_BACKEND: "" }), { requested: "auto", note: "" });
  assert.equal(requestedDenseBackend({ AI_DEV_DENSE_BACKEND: "ONNX" }).requested, DENSE_ONNX_BACKEND);
  const typo = requestedDenseBackend({ AI_DEV_DENSE_BACKEND: "onxx" });
  assert.equal(typo.requested, "auto");
  assert.match(typo.note, /onxx is not one of auto, onnx; using auto/);
  const python = requestedDenseBackend({ AI_DEV_DENSE_BACKEND: " Python " });
  assert.equal(python.requested, "auto", "the backend it named is gone; the one there is runs");
  assert.match(python.note, /^AI_DEV_DENSE_BACKEND=python asks for the Python backend, which 3\.0 removed/);
  assert.ok(python.note.includes(`Run \`${DENSE_INSTALL_COMMAND}\` once`), "one command moves the user over");
  assert.deepEqual([...DENSE_BACKEND_CHOICES], ["auto", "onnx"]);
});

test("everything left of a 2.x Python install is named, each with what to do", () => {
  assert.deepEqual(legacyDenseNotes({}), []);
  const env = { AI_DEV_DENSE_BACKEND: "python", ...Object.fromEntries(Object.keys(LEGACY_DENSE_VARIABLES).map((name) => [name, "/x"])) };
  const notes = legacyDenseNotes(env, { legacyWeightsDir: "/home/u/.ai-dev/models/bge-m3" });
  assert.equal(notes.length, 1 + Object.keys(LEGACY_DENSE_VARIABLES).length + 1);
  assert.match(notes[0], /AI_DEV_DENSE_BACKEND=python/);
  for (const name of ["BGE_M3_PYTHON", "AI_DEV_EMBEDDINGS_PYTHON", "AI_DEV_PYTHON_BASE", "BGE_M3_PYTHON_REVISION", "BGE_M3_MODEL_DIR"]) {
    assert.ok(notes.some((note) => note.startsWith(`${name} is set and nothing reads it any more`) && note.endsWith("Remove it.")), name);
  }
  assert.match(notes.at(-1), /\/home\/u\/\.ai-dev\/models\/bge-m3 holds the Python backend's torch weights \(about 2\.3 GB\).*can be deleted/);
  assert.deepEqual(legacyDenseNotes({ BGE_M3_PYTHON: "   " }), [], "a blank variable is not set");
  assert.deepEqual(legacyDenseNotes({ AI_DEV_DENSE_BACKEND: "onnx" }), []);
});

test("with the export verified, dense search runs, and says no Python is involved", () => {
  const auto = selectDenseBackend({ onnxReady: true });
  assert.deepEqual([auto.backend, auto.available, auto.requested], [DENSE_ONNX_BACKEND, true, "auto"]);
  assert.equal(auto.reason, "The verified ONNX export is on disk; no Python is involved.");
  assert.match(selectDenseBackend({ requested: "onnx", onnxReady: true }).reason, /^AI_DEV_DENSE_BACKEND=onnx, and the verified ONNX export is on disk/);
});

test("without the model it is a state with two ways out, and in a container the way is a mount", () => {
  const missing = selectDenseBackend({ onnxReady: false });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /^Dense search is not installed: the model is not on this machine\./);
  assert.match(missing.reason, /npm run setup -- --model/);
  assert.match(missing.reason, /npm run model -- import <folder or \.zip>/);
  assert.doesNotMatch(missing.reason, /virtualenv|--dense-python|\.venv/, "nothing of the removed backend is advised");
  const container = selectDenseBackend({ onnxReady: false, inContainer: true, files: { dir: "/data/runtime-home/.ai-dev/models/bge-m3-onnx", present: [], missing: [], mismatched: [] } });
  assert.match(container.reason, /install it once into the default volume, ai-dev-system-data, with the network that run needs: `docker run --rm -it --network bridge .* ai-dev model install`/);
  assert.match(container.reason, /Or mount a folder holding bge-m3-onnx\/ at \/models/);
});

test("the sentence names what the check found: other files, some missing, a stopped download", () => {
  const dir = "/home/u/.ai-dev/models/bge-m3-onnx";
  const all = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_int8.onnx"];
  const tampered = selectDenseBackend({ files: { dir, present: all.slice(0, 4), missing: [], mismatched: ["onnx/model_int8.onnx"] } });
  assert.equal(tampered.reason, `Dense search is not ready: onnx/model_int8.onnx in ${dir} is not the pinned file (the sha256 differs from the manifest). `
    + "Run `npm run setup -- --model`: it fetches it again.");
  assert.doesNotMatch(tampered.reason, /not on this machine/, "the files are there");
  const several = selectDenseBackend({ files: { dir, present: [], missing: [], mismatched: all } });
  assert.match(several.reason, /config\.json, tokenizer\.json, .* are not the pinned files .* it fetches them again\.$/);
  const stopped = selectDenseBackend({ files: { dir, present: all.slice(0, 4), missing: ["onnx/model_int8.onnx"], mismatched: [], partial: ["onnx/model_int8.onnx"] } });
  assert.equal(stopped.reason, "Dense search is not installed yet: the download of the model stopped partway (onnx/model_int8.onnx). "
    + "Run `npm run setup -- --model` to continue it from there.");
  const lacking = selectDenseBackend({ files: { dir, present: all.slice(0, 4), missing: ["onnx/model_int8.onnx"], mismatched: [] } });
  assert.match(lacking.reason, /^Dense search is not ready: the model in .* lacks onnx\/model_int8\.onnx\. Run `npm run setup -- --model` to fetch it, or `npm run model -- import/);
  const empty = selectDenseBackend({ files: { dir, present: [], missing: all, mismatched: [] } });
  assert.match(empty.reason, /^Dense search is not installed: the model is not on this machine\./, "nothing there is the only 'not on this machine'");
  const mounted = selectDenseBackend({ inContainer: true, files: { dir: "/models/bge-m3-onnx", present: all.slice(1), missing: [], mismatched: ["config.json"] } });
  assert.match(mounted.reason, /config\.json in \/models\/bge-m3-onnx is not the pinned file .* In this container, the folder is the host's, mounted read-only at \/models/);
  assert.doesNotMatch(mounted.reason, /npm run setup/, "a read-only mount is not fixed by a download inside the container");
  const mountedPartial = selectDenseBackend({ inContainer: true, files: { dir: "/models/bge-m3-onnx", present: all.slice(1), missing: ["config.json"], partial: ["config.json"] } });
  assert.match(mountedPartial.reason, /lacks config\.json\. In this container, the folder is the host's/);
  // The volume's own folder is fixed by installing into it, not on the host.
  const volume = selectDenseBackend({ inContainer: true, files: { dir: "/data/runtime-home/.ai-dev/models/bge-m3-onnx", present: all.slice(1), missing: [], mismatched: ["config.json"] } });
  assert.match(volume.reason, /In this container, install it once into the default volume, ai-dev-system-data,/);
});

test("a machine with no runtime build is told so, whatever is on disk", () => {
  const intel = selectDenseBackend({ onnxReady: true, supported: false, supportReason: "onnxruntime-node 1.30.0 has no build for darwin-x64 (Intel Mac)" });
  assert.equal(intel.available, false);
  assert.match(intel.reason, /darwin-x64/);
  assert.match(selectDenseBackend({ supported: false }).reason, /no build of onnxruntime-node/);
  assert.equal(selectDenseBackend({ requested: "torch", onnxReady: true }).requested, "auto", "an unknown choice is auto");
  assert.equal(selectDenseBackend().available, false, "defaults alone are a valid call");
});

test("a model that cannot be read gets the advice its error calls for: only permissions are made readable", () => {
  const said = (code, mounted = false) => unreadableModelAdvice(`${code}: what the system said, '/models/bge-m3-onnx/config.json'`, { mounted });
  assert.equal(said("EACCES"), "Make the folder and its files readable to the user this runs as.");
  assert.equal(said("EACCES", true), "The image runs as uid 1000: make the folder and its files readable to it on the host, or drop the mount and install the model into the default volume, ai-dev-system-data.");
  // EPERM is often macOS keeping a folder from an app, not a mode: said where the host may be a Mac.
  assert.equal(said("EPERM", true), "The image runs as uid 1000: make the folder and its files readable to it on the host (on macOS, give Docker Desktop access to that folder in Privacy & Security), or drop the mount and install the model into the default volume, ai-dev-system-data.");
  const local = (platform) => unreadableModelAdvice("EPERM: operation not permitted, open '…/config.json'", { platform });
  assert.equal(local("darwin"), "Make the folder and its files readable to the user this runs as, and give the app this runs in access to that folder in Privacy & Security.");
  assert.equal(local("linux"), "Make the folder and its files readable to the user this runs as.");
  assert.equal(local("win32"), "Make the folder and its files readable to the user this runs as.");
  // A file where a folder should be, the model's own or one above or inside it: put a folder there.
  assert.equal(said("ENOTDIR", true), "On that path a file stands where a folder should be (the model's folder, one inside it, or one above it): put a folder there, or drop the mount and install the model into the default volume, ai-dev-system-data.");
  assert.equal(said("ENOTDIR"), "On that path a file stands where a folder should be (the model's folder, one inside it, or one above it): put a folder there.");
  assert.equal(said("ELOOP", true), "A link on the way leads back to itself: point it at the folder that holds the model, or drop the mount and install the model into the default volume, ai-dev-system-data.");
  // A share that dropped, on any engine: no Docker Desktop named.
  for (const code of ["EIO", "ESTALE", "ENOTCONN", "EHOSTDOWN", "ETIMEDOUT", "ECONNABORTED", "ECONNRESET"]) {
    assert.equal(said(code, true), "The disk or share it is on cannot be reached: reconnect it, or drop the mount and install the model into the default volume, ai-dev-system-data.", code);
  }
  assert.equal(said("EINVAL"), "Look at that folder.");
  assert.doesNotMatch(said("ENOTDIR") + said("ELOOP") + said("EIO") + said("EINVAL"), /readable/, "permissions are not the advice for other errors");
  assert.doesNotMatch(said("EIO", true) + said("ESTALE", true), /Docker Desktop/);
  // Where /data holds a mount with no volume's name, there is no data volume to install into.
  assert.equal(unreadableModelAdvice("EIO: i/o error, '/models/bge-m3-onnx/config.json'", { mounted: true, volume: null }),
    "The disk or share it is on cannot be reached: reconnect it, or drop the mount and install the model where your sessions keep /data.");
});

test("in a container the model goes into the volume at /data, and where /data holds a mount with no name, where the sessions keep it", () => {
  assert.equal(containerModelAdvice("", "team-data"), "install it once into the data volume, with the network that run needs: "
    + "`docker run --rm -it --network bridge --mount type=volume,source=team-data,target=/data <image> ai-dev model install`; "
    + "the sessions after it keep --network none. Or mount a folder holding bge-m3-onnx/ at /models (AI_DEV_MODEL_PATH).");
  assert.equal(containerModelAdvice("", null), "install it once where your sessions keep /data, with the network that run needs: "
    + "`docker run --rm -it --network bridge --mount <what your sessions mount at /data> <image> ai-dev model install`; "
    + "the sessions after it keep --network none. Or mount a folder holding bge-m3-onnx/ at /models (AI_DEV_MODEL_PATH).");
  assert.match(containerModelAdvice("/models/bge-m3-onnx", "team-data"), /, or drop the mount and install it into the data volume\.$/);
  assert.match(containerModelAdvice("/models/bge-m3-onnx", null), /, or drop the mount and install it where your sessions keep \/data\.$/);
  // The default volume by its name, as the start report names it.
  assert.match(containerModelAdvice("", "ai-dev-system-data"), /^install it once into the default volume, ai-dev-system-data, with .*source=ai-dev-system-data,target=\/data /);
  assert.match(unreadableModelAdvice("EIO: i/o error", { mounted: true, volume: "team-data" }), /install the model into the data volume\.$/);
});
