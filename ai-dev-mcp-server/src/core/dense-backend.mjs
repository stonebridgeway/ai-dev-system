/**
 * Whether dense search can run here, and what to tell the person if it cannot.
 *
 * Since 3.0 dense search has one backend: the pinned ONNX export, run by
 * onnxruntime-node in a worker thread. The legacy Python backend — a
 * virtualenv, torch and 2.3 GB of weights — is gone. What remains of it here
 * is its settings, read for one reason: whoever still has
 * `AI_DEV_DENSE_BACKEND=python` in a client
 * config, or a 2.x image's variables, is told in a sentence what replaced it
 * and the one command that moves them over, instead of being silently ignored.
 *
 * Every probe arrives as a value, so each state — including the ones only a
 * stranger's machine reaches — is a test case. What comes from the process
 * itself: how this install spells its commands (the install layout `hint()`
 * reads once), the platform where a caller names none, and in a container the
 * volume at its `/data`.
 */
import { DEFAULT_DOCKER_VOLUME, dataVolume } from "./docker-launch.mjs";
import { dockerCommand, hint } from "./install-layout.mjs";

/** The backend's name, as status payloads and index metadata record it. */
export const DENSE_ONNX_BACKEND = "onnx";

/** What `AI_DEV_DENSE_BACKEND` accepts. `python` is still recognised, to explain itself. */
export const DENSE_BACKEND_CHOICES = Object.freeze(["auto", DENSE_ONNX_BACKEND]);

/** The one command that installs the model and embeds the documents with it, as this install spells it. */
export const DENSE_INSTALL_COMMAND = hint("npm run setup -- --model");

/** The command that copies the model from a folder or archive another machine made. */
export const DENSE_IMPORT_COMMAND = hint("npm run model -- import <folder or .zip>");

/** Variables of the removed Python backend, each with what it used to do. */
export const LEGACY_DENSE_VARIABLES = Object.freeze({
  BGE_M3_PYTHON: "the interpreter of the Python backend",
  AI_DEV_EMBEDDINGS_PYTHON: "the interpreter of the Python backend",
  AI_DEV_PYTHON_BASE: "the Python that built the backend's virtualenv",
  BGE_M3_PYTHON_REVISION: "the revision of the Python backend's weights",
  BGE_M3_MODEL_DIR: "the folder of the Python backend's torch weights"
});

/**
 * The backend the environment asks for.
 *
 * An unreadable value is `auto`, with a note, rather than an error: this is
 * read on every search, and a typo in a shell profile must not stop the server
 * answering. `python` is `auto` too — the backend it named is gone — and the
 * note says what to do about it.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ requested: string, note: string }}
 */
export function requestedDenseBackend(env = {}) {
  const raw = String(env.AI_DEV_DENSE_BACKEND ?? "").trim().toLowerCase();
  if (!raw) return { requested: "auto", note: "" };
  if (DENSE_BACKEND_CHOICES.includes(raw)) return { requested: raw, note: "" };
  if (raw === "python") {
    return {
      requested: "auto",
      note: "AI_DEV_DENSE_BACKEND=python asks for the Python backend, which 3.0 removed: dense search runs on the "
        + `ONNX model now, with no Python. Run \`${DENSE_INSTALL_COMMAND}\` once — it installs the model and embeds the `
        + "documents again — and remove the variable."
    };
  }
  return {
    requested: "auto",
    note: `AI_DEV_DENSE_BACKEND=${raw} is not one of ${DENSE_BACKEND_CHOICES.join(", ")}; using auto.`
  };
}

/**
 * What is left of a 2.x Python install on this machine, as sentences.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ legacyWeightsDir?: string }} [found] - The folder holding 2.x torch weights, when there is one.
 * @returns {string[]}
 */
export function legacyDenseNotes(env = {}, { legacyWeightsDir = "" } = {}) {
  const notes = [];
  const { note } = requestedDenseBackend(env);
  if (/python/i.test(String(env.AI_DEV_DENSE_BACKEND ?? ""))) notes.push(note);
  for (const [name, meaning] of Object.entries(LEGACY_DENSE_VARIABLES)) {
    if (String(env[name] ?? "").trim()) {
      notes.push(`${name} is set and nothing reads it any more: it named ${meaning}, which 3.0 removed. Remove it.`);
    }
  }
  if (legacyWeightsDir) {
    notes.push(`${legacyWeightsDir} holds the Python backend's torch weights (about 2.3 GB), which nothing uses any more; `
      + "once dense search works with the ONNX model, the folder can be deleted.");
  }
  return notes;
}

/**
 * Whether dense search runs, and the sentence that says why or why not.
 *
 * Not installed is a state, not a failure: hybrid search runs its keyword and
 * sparse halves without any model. The sentence names
 * the command that changes it — a download, or a copy from another machine for
 * one that cannot reach the download — and, in a container, the mount.
 *
 * @param {object} [options]
 * @param {string} [options.requested] - "auto" or "onnx".
 * @param {boolean} [options.onnxReady] - Export verified against the manifest.
 * @param {boolean} [options.supported] - onnxruntime has a build for this machine.
 * @param {string} [options.supportReason]
 * @param {boolean} [options.inContainer]
 * @param {{ dir?: string, present?: string[], missing?: string[], mismatched?: string[], partial?: string[] }} [options.files]
 *   What the check found, so the sentence says which of "not here", "not all here",
 *   "stopped partway" and "not the pinned files" it is.
 * @returns {{ backend: string, available: boolean, reason: string, requested: string }}
 */
export function selectDenseBackend({ requested = "auto", onnxReady = false, supported = true, supportReason = "", inContainer = false, files = {} } = {}) {
  const choice = DENSE_BACKEND_CHOICES.includes(requested) ? requested : "auto";
  if (!supported) {
    return { backend: DENSE_ONNX_BACKEND, available: false, requested: choice, reason: supportReason || "This machine has no build of onnxruntime-node." };
  }
  if (onnxReady) {
    return {
      backend: DENSE_ONNX_BACKEND,
      available: true,
      requested: choice,
      reason: choice === DENSE_ONNX_BACKEND
        ? "AI_DEV_DENSE_BACKEND=onnx, and the verified ONNX export is on disk; no Python is involved."
        : "The verified ONNX export is on disk; no Python is involved."
    };
  }
  return { backend: DENSE_ONNX_BACKEND, available: false, requested: choice, reason: notReadyReason({ inContainer, files }) };
}

/** Where 2.x's Docker launchers mount the host's model (`AI_DEV_MODEL_PATH` → `/models`, read-only). */
export const DOCKER_MOUNTED_MODEL_DIR = "/models/bge-m3-onnx";

// Where a model goes in a container: the data volume — the default one by its name, as the start report names it — or,
// where /data holds a mount with no volume's name, what the sessions keep there.
const dataPlaceOf = (volume) => (volume === null ? "where your sessions keep /data"
  : volume === DEFAULT_DOCKER_VOLUME ? `into the default volume, ${volume}` : "into the data volume");

/**
 * What fixes the model inside a container, by the folder it is read from. The
 * host's folder at /models is a read-only mount, fixed on the host;
 * the volume's is fixed by installing the model into
 * it, with the network that one run needs — and where `/data` holds a
 * mount with no volume's name, into what the sessions keep there.
 *
 * @param {string} [dir] - The model folder the container reads.
 * @param {string | null} [volume] - The volume at `/data` ({@link dataVolume}).
 * @returns {string}
 */
export function containerModelAdvice(dir = "", volume = dataVolume()) {
  return dir === DOCKER_MOUNTED_MODEL_DIR
    ? "the folder is the host's, mounted read-only at /models (AI_DEV_MODEL_PATH): put the model right there on the host "
      + `(\`ai-dev model install --dir <that folder>/bge-m3-onnx\`), or drop the mount and install it ${dataPlaceOf(volume)}.`
    : `install it once ${dataPlaceOf(volume)}, with the network that run needs: `
      + `\`${dockerCommand("model install", volume)}\`; `
      + "the sessions after it keep --network none. Or mount a folder holding bge-m3-onnx/ at /models (AI_DEV_MODEL_PATH).";
}

/**
 * What to do about a model that could not be read, by why it could not: only
 * permissions are put right by making it readable.
 *
 * @param {string} unreadable - The error, as `EACCES: permission denied, …`.
 * @param {{ mounted?: boolean, platform?: string, volume?: string | null }} [options] - `mounted`: the host's folder at
 *   /models, in the image, whose host is not known; `platform`: this machine's, for a local install; `volume`: the one
 *   at the image's /data ({@link dataVolume}).
 * @returns {string}
 */
export function unreadableModelAdvice(unreadable, { mounted = false, platform = process.platform, volume = dataVolume() } = {}) {
  const code = /^([A-Z]+):/.exec(String(unreadable ?? ""))?.[1] ?? "";
  const orVolume = mounted ? `, or drop the mount and install the model ${dataPlaceOf(volume)}` : "";
  if (code === "EACCES") {
    return mounted
      ? `The image runs as uid 1000: make the folder and its files readable to it on the host${orVolume}.`
      : "Make the folder and its files readable to the user this runs as.";
  }
  // Not the file's mode, often: on macOS a folder under Documents, Desktop or
  // Downloads is kept from an app until it is given access.
  if (code === "EPERM") {
    if (mounted) {
      return "The image runs as uid 1000: make the folder and its files readable to it on the host (on macOS, give Docker "
        + `Desktop access to that folder in Privacy & Security)${orVolume}.`;
    }
    return platform === "darwin"
      ? "Make the folder and its files readable to the user this runs as, and give the app this runs in access to that "
        + "folder in Privacy & Security."
      : "Make the folder and its files readable to the user this runs as.";
  }
  if (code === "ENOTDIR") {
    return `On that path a file stands where a folder should be (the model's folder, one inside it, or one above it): put a folder there${orVolume}.`;
  }
  if (code === "ELOOP") return `A link on the way leads back to itself: point it at the folder that holds the model${orVolume}.`;
  if (SHARE_UNREACHABLE.has(code)) return `The disk or share it is on cannot be reached: reconnect it${orVolume}.`;
  return mounted ? `Look at that folder on the host${orVolume}.` : "Look at that folder.";
}

/** The errors of a disk or network share that is there and cannot be reached. */
export const SHARE_UNREACHABLE = new Set(["EIO", "ESTALE", "ENOTCONN", "EHOSTDOWN", "ETIMEDOUT", "ECONNABORTED", "ECONNRESET"]);

/** The model is not usable; say which way, and what changes it. */
function notReadyReason({ inContainer, files }) {
  const { dir = "", present = [], missing = [], mismatched = [], partial = [], unreadable = "", unchecked = "" } = files ?? {};
  const where = dir ? ` in ${dir}` : "";
  const names = (list) => list.join(", ");
  if (unchecked) return `Dense search is not ready: the model${where} could not be checked (${unchecked}).`;
  if (unreadable) {
    return `Dense search is not ready: the model${where} cannot be read (${unreadable}). `
      + unreadableModelAdvice(unreadable, { mounted: inContainer && dir === DOCKER_MOUNTED_MODEL_DIR });
  }
  if (mismatched.length) {
    const one = mismatched.length === 1;
    return `Dense search is not ready: ${names(mismatched)}${where} ${one ? "is not the pinned file" : "are not the pinned files"} `
      + `(the sha256 differs from the manifest). `
      + (inContainer ? `In this container, ${containerModelAdvice(dir)}` : `Run \`${DENSE_INSTALL_COMMAND}\`: it fetches ${one ? "it" : "them"} again.`);
  }
  if (partial.length && !inContainer) {
    return `Dense search is not installed yet: the download of the model stopped partway (${names(partial)}). `
      + `Run \`${DENSE_INSTALL_COMMAND}\` to continue it from there.`;
  }
  if (present.length && missing.length) {
    return `Dense search is not ready: the model${where} lacks ${names(missing)}. `
      + (inContainer ? `In this container, ${containerModelAdvice(dir)}`
        : `Run \`${DENSE_INSTALL_COMMAND}\` to fetch ${missing.length === 1 ? "it" : "them"}, or \`${DENSE_IMPORT_COMMAND}\` to copy the model from another machine.`);
  }
  return inContainer
    ? `Dense search is not installed in this container: ${containerModelAdvice(dir)}`
    : `Dense search is not installed: the model is not on this machine. Run \`${DENSE_INSTALL_COMMAND}\` to download it `
      + `(about 600 MB, no Python), or \`${DENSE_IMPORT_COMMAND}\` to copy it from another machine.`;
}
