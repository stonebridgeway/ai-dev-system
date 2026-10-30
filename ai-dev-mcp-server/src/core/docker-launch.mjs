/**
 * The command a client starts the server in Docker with: `docker run -i --rm …`,
 * written into the client's config by `ai-dev clients install --docker`.
 *
 * 2.x wrote a launcher into the config instead — `docker/run-mcp.sh`,
 * `run-mcp.ps1`, or on Windows for Claude a C# proxy compiled on the user's
 * machine — and the launchers answered `initialize` themselves while the
 * container came up, so the server's instructions never reached the client.
 * The image answers in about a second, so the
 * client runs Docker itself and the server answers its own handshake.
 *
 * What the command mounts:
 * - the volume (`/data`): the vault, the index, the model;
 * - the host's state folder at {@link CONTAINER_STATE_ROOT}, named to the server
 *   by `AI_DEV_STATE_ROOT`: the one the agent hooks on the host keep their state
 *   in, so tasks, handoffs and the usage ledger are one;
 * - the projects folder at its own path on Linux and macOS, so a path the agent
 *   names is the path the server opens; on Windows, whose paths a Linux
 *   container cannot hold, at {@link CONTAINER_WORKSPACE}, as 2.x did;
 * - a host model folder, read-only at {@link CONTAINER_MODELS}, when one is named
 *   (2.x's `AI_DEV_MODEL_PATH`) — its `bge-m3-onnx` link at {@link CONTAINER_MODEL_DIR}
 *   when it is one ({@link modelMount}); otherwise the model is the volume's.
 *
 * The container runs as the image's user, uid 1000, as 2.x did: one owner for
 * everything in the volume, whichever launcher — a 3.0 entry or a 2.x one —
 * started the session. The host's state folder is shared only where that user
 * is the host's ({@link sharesHostState}): on Linux a file the server wrote as
 * uid 1000 with the image's umask is another user's to read, and one the hooks
 * wrote is not the server's to append to.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** The image a client runs unless told otherwise (`:latest` is the released line). */
export const DEFAULT_DOCKER_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest";

/** The named volume the data lives in; 2.x's name, so an upgrade keeps it. */
export const DEFAULT_DOCKER_VOLUME = "ai-dev-system-data";

/**
 * The named volume at a container's `/data`, from its `/proc/self/mountinfo`:
 * the host chose it (`--volume`, `AI_DEV_DATA_VOLUME`), and the root of a
 * volume's mount ends `volumes/<name>/_data` — Docker's, rootless Docker's and
 * Podman's alike, the name as Docker or Podman allows it; a folder of the
 * host's whose path ends so reads as that volume, as nothing in a container
 * tells the two apart. A run that mounts nothing there gets an anonymous
 * volume from the image's `VOLUME`, 64 hex digits that `--rm` removes: the
 * default's place, as with no `/data` at all — and so is a volume named so, as
 * `docker volume create` names one it is given no name for. Anything else at
 * `/data` — a folder of the host's, a volume made with a driver's options, a
 * volume's subfolder, a tmpfs — has no name to give: null.
 *
 * @param {string} mountinfo
 * @returns {string | null}
 */
export function volumeAtData(mountinfo) {
  // Fields: id, parent, device, root, mount point, …; of two mounts at /data the later is the one seen there.
  const fields = mountinfo.split("\n").map((line) => line.split(" ")).filter((line) => line[4] === "/data").at(-1);
  if (!fields) return DEFAULT_DOCKER_VOLUME;
  const name = /(?:^|\/)volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/_data$/.exec(fields[3] ?? "")?.[1];
  if (name === undefined) return null;
  return /^[0-9a-f]{64}$/.test(name) ? DEFAULT_DOCKER_VOLUME : name;
}

/**
 * How a command for the host mounts the data at `/data`: the volume by its
 * name, or, where `/data` holds a mount with none, a placeholder for that
 * mount.
 *
 * @param {string | null} volume
 * @returns {string}
 */
export function dataMount(volume) {
  return volume === null ? "<what your sessions mount at /data>" : `type=volume,source=${volume},target=/data`;
}

/**
 * Where a command with {@link dataMount} of `volume` puts what it writes, in
 * words: this volume, for a name read at `/data`; the default by its name,
 * since the image cannot tell it from a run with no volume of its own there;
 * where the sessions keep `/data`, for a mount with no name.
 *
 * @param {string | null} volume
 * @returns {string}
 */
export function dataPlace(volume) {
  if (volume === null) return "where your sessions keep /data";
  return volume === DEFAULT_DOCKER_VOLUME ? `in the default volume, ${volume}` : "in this volume";
}

let ownVolume;

const readMountinfo = (read) => {
  try {
    return read();
  } catch {
    // No /proc to read: the default.
    return "";
  }
};

/**
 * The volume the image's advice names ({@link volumeAtData}), read once;
 * outside the image, the default. A test gives `env` and `read` in place of
 * the process's.
 *
 * @param {{ env?: Record<string, string | undefined>, read?: () => string }} [options]
 * @returns {string | null}
 */
export function dataVolume({ env = process.env, read } = {}) {
  if (String(env.AI_DEV_RUNTIME ?? "").trim().toLowerCase() !== "docker") return DEFAULT_DOCKER_VOLUME;
  if (read) return volumeAtData(readMountinfo(read));
  if (ownVolume === undefined) ownVolume = volumeAtData(readMountinfo(() => readFileSync("/proc/self/mountinfo", "utf8")));
  return ownVolume;
}

/** Where the host's state folder is in the container. */
export const CONTAINER_STATE_ROOT = "/ai-dev-state";

/** Where the projects are in the container on Windows (2.x's place for them). */
export const CONTAINER_WORKSPACE = "/workspace";

/** Where a host model folder is mounted, read-only. */
export const CONTAINER_MODELS = "/models";

/** Where the server in the image looks for a host's model (`DOCKER_MOUNTED_MODEL_DIR` in dense-backend.mjs). */
export const CONTAINER_MODEL_DIR = `${CONTAINER_MODELS}/bge-m3-onnx`;

/**
 * Files that make a folder a model folder itself rather than the one holding
 * `bge-m3-onnx/`: the value 2.x documented, refused by every copy.
 */
export const MODEL_FOLDER_MARKERS = Object.freeze(["pytorch_model.bin", "modules.json", "config.json", "onnx"]);

/**
 * Docker reads a `--mount` value as one CSV record: a comma splits it, and a
 * double quote outside a quoted field fails every session ("bare \" in
 * non-quoted-field").
 */
function mountable(label, folder) {
  const bad = [",", "\""].find((character) => folder.includes(character));
  if (bad) throw new Error(`The ${label} folder ${folder} has ${bad === "," ? "a comma" : "a double quote"} in its path, which a docker --mount cannot hold. Choose a folder without one.`);
  return folder;
}

/**
 * The arguments of `docker run` for one client session.
 *
 * @param {object} input
 * @param {string} input.image
 * @param {string} [input.volume]
 * @param {string} [input.projects] - The host's projects folder.
 * @param {string | { source: string, target: string }} [input.model] - A host folder holding `bge-m3-onnx/`
 *   (mounted at {@link CONTAINER_MODELS}), or the mount {@link modelMount} chose for one.
 * @param {string} [input.state] - The host's state folder.
 * @param {string} [input.platform] - The host's platform.
 * @returns {string[]}
 */
export function dockerRunArgs({ image, volume = DEFAULT_DOCKER_VOLUME, projects = "", model = "", state = "", platform = process.platform }) {
  if (!image) throw new Error("No image to run: name one with --image.");
  const args = [
    "run", "-i", "--rm",
    "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--shm-size", "1g",
    "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"
  ];
  args.push("--mount", `type=volume,source=${mountable("volume", volume)},target=/data`);
  if (state) {
    args.push("--mount", `type=bind,source=${mountable("state", state)},target=${CONTAINER_STATE_ROOT}`, "--env", `AI_DEV_STATE_ROOT=${CONTAINER_STATE_ROOT}`);
  }
  if (projects) {
    const target = platform === "win32" ? CONTAINER_WORKSPACE : projects;
    args.push("--mount", `type=bind,source=${mountable("projects", projects)},target=${target}`);
  }
  if (model) {
    const mount = typeof model === "string" ? { source: model, target: CONTAINER_MODELS } : model;
    args.push("--mount", `type=bind,source=${mountable("model", mount.source)},target=${mount.target},readonly`);
  }
  args.push(image);
  return args;
}

/** The image's user: the owner of everything the container writes. */
export const IMAGE_UID = 1000;

/**
 * Whether the container may share the host's state folder: Docker Desktop
 * (macOS, Windows) maps a bind mount's ownership to the host user; on Linux the
 * image's user must be the host user.
 *
 * @param {{ platform?: string, uid?: number }} [host]
 * @returns {boolean}
 */
export function sharesHostState({ platform = process.platform, uid = process.getuid?.() } = {}) {
  return platform !== "linux" || uid === IMAGE_UID;
}

/**
 * Whether the image's user may share the host's state folder, tried rather than
 * inferred: a container of the image, as its user, makes a file there, and the
 * file must be the host user's. Where Docker maps the container's uid 1000 to
 * another host uid — rootless Docker, userns-remap, Podman — that container
 * cannot write the folder at all, and a state the server cannot write is worse
 * than one kept apart in the volume, as 2.x kept it.
 *
 * A Docker that did not run the image — an engine that does not answer, an
 * image not here yet, which the probe does not pull — has tried nothing:
 * `tried` says so, so that is not taken for a remapping host.
 *
 * @param {{ docker?: string, image: string, state: string, uid?: number, run?: typeof spawnSync }} input
 * @returns {{ shared: boolean, tried: boolean, reason: string }}
 */
export function probeStateSharing({ docker = "docker", image, state, uid = process.getuid?.(), run = spawnSync }) {
  const name = `.ai-dev-share-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const probe = path.join(state, name);
  const result = run(docker, [
    "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "touch",
    "--mount", `type=bind,source=${mountable("state", state)},target=${CONTAINER_STATE_ROOT}`, image, `${CONTAINER_STATE_ROOT}/${name}`
  ], { encoding: "utf8", shell: false, timeout: 120_000 });
  try {
    const said = String(result.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (result.status !== 0 || result.error) {
      // `touch` in the container answers "cannot touch"; anything else is Docker's own.
      const refused = said.find((line) => /cannot touch/i.test(line));
      if (refused && !result.error) return { shared: false, tried: true, reason: `the image's user could not write your state folder (${refused})` };
      const why = result.error?.message || said.find((line) => !/^Run 'docker run --help'/.test(line)) || `exit ${result.status}`;
      return { shared: false, tried: false, reason: `Docker did not run ${image} to try it (${why})` };
    }
    const owner = statSync(probe, { throwIfNoEntry: false })?.uid;
    if (owner === uid) return { shared: true, tried: true, reason: "" };
    return {
      shared: false,
      tried: true,
      reason: owner === undefined
        ? "what the image's user wrote into your state folder did not reach it"
        : `what the image's user writes into your state folder is uid ${owner}'s, not yours (uid ${uid}): Docker maps the container's users here (rootless Docker, userns-remap or Podman)`
    };
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * Where the Docker CLI is, by full path: a client started from the Dock or the
 * Start menu does not see the shell's PATH, and Docker Desktop on macOS puts the
 * CLI in /usr/local/bin, which such a client's PATH lacks. When none is found the
 * bare name is returned, for a machine whose client does find it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string, exists?: (file: string) => boolean }} [options]
 * @returns {string}
 */
export function resolveDockerCommand({ env = process.env, platform = process.platform, home = "", exists = isFile } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? ["docker.exe"] : ["docker"];
  const folders = String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform === "darwin") folders.push("/usr/local/bin", "/opt/homebrew/bin", ...(home ? [paths.join(home, ".docker", "bin")] : []), "/Applications/Docker.app/Contents/Resources/bin");
  if (platform === "win32") folders.push(paths.join(env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin"));
  for (const folder of folders) {
    for (const name of names) {
      const candidate = paths.join(folder, name);
      if (paths.isAbsolute(candidate) && exists(candidate)) return candidate;
    }
  }
  return "docker";
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuse a model folder that is not one: missing, or a model folder itself (2.x
 * documented that, and the server never found the files under it).
 *
 * @param {string} folder
 * @param {{ exists?: (target: string) => boolean }} [options]
 * @returns {string}
 */
export function checkModelFolder(folder, { exists = existsSync } = {}) {
  if (!exists(folder)) throw new Error(`The model folder ${folder} does not exist.`);
  const marker = MODEL_FOLDER_MARKERS.find((name) => exists(path.join(folder, name)));
  if (marker) {
    throw new Error(`${folder} holds model files itself (${marker}). Name the folder above it, the one that holds bge-m3-onnx/.`);
  }
  return folder;
}

/**
 * The mount a host model folder gets: the folder at {@link CONTAINER_MODELS} —
 * or, when its `bge-m3-onnx` is a link, that link at {@link CONTAINER_MODEL_DIR}.
 * A link inside a mounted folder is read in the container, where an absolute
 * target, or a relative one that leaves the folder, leads nowhere: the model
 * was "not installed". Docker resolves a mount's own
 * source on the host, so the link mounted itself is the folder it leads to.
 *
 * Where this runs on the host (`verify`), a link that leads nowhere here either
 * is refused: Docker would start no session over it. In the image, writing for
 * the host, the link's target is not to be seen; bootstrap.sh checks it first.
 *
 * @param {string} folder - A model folder {@link checkModelFolder} took.
 * A link to another disk is noted (`note`): Docker starts no session while
 * that disk is away.
 *
 * @param {{ verify?: boolean, join?: (...parts: string[]) => string, lstat?: typeof lstatSync, stat?: typeof statSync, readlink?: typeof readlinkSync }} [options]
 * @returns {{ source: string, target: string, note?: string }}
 */
export function modelMount(folder, { verify = true, join = path.join, lstat = lstatSync, stat = statSync, readlink = readlinkSync } = {}) {
  const model = join(folder, "bge-m3-onnx");
  let link = false;
  try {
    link = lstat(model).isSymbolicLink();
  } catch {
    // Not there yet: the folder is mounted, and the model is put there later.
  }
  if (!link) return { source: folder, target: CONTAINER_MODELS };
  if (!verify) return { source: model, target: CONTAINER_MODEL_DIR };
  let leadsTo = "";
  try {
    leadsTo = readlink(model);
  } catch {
    // Said without it.
  }
  let found;
  try {
    found = stat(model);
  } catch (error) {
    throw new Error(`${model} is a link${leadsTo ? ` to ${leadsTo}` : ""} that leads nowhere here (${error?.code ?? error?.message}): connect the disk it leads to, or name another model folder. Docker would start no session that mounts it.`);
  }
  // Docker refuses a mount whose source is gone, and the whole session with it: a disk the link leads to that is
  // unplugged later takes AI Dev out of every client, where a folder mounted above the link took dense search
  // only. So it is said when the entries are written, and `clients doctor` says it when it happens.
  let note = "";
  try {
    if (found.dev !== stat(folder).dev) {
      note = `${model} leads to ${leadsTo || "another folder"}, on another disk: every session mounts it from there, so while that disk is away Docker starts no session at all — \`ai-dev clients doctor\` names the entry then.`;
    }
  } catch {
    // The folder was checked a moment ago; a folder that went meanwhile is said by Docker.
  }
  return { source: model, target: CONTAINER_MODEL_DIR, ...(note ? { note } : {}) };
}

// The fields of one CSV record, as Go's encoding/csv reads the first record of a `--mount` value: a field that starts
// with a double quote runs to the closing one, `""` standing for a quote in it; a quote anywhere else is an error.
// Lines end in "\n" or "\r\n", a "\r" at the very end is dropped, and empty lines before the record are skipped, as
// Go's reader does. `null` where Docker would refuse to parse the value.
function csvRecord(value) {
  const text = value.replaceAll("\r\n", "\n").replace(/\r$/, "").replace(/^\n+/, "");
  if (!text) return null;
  const fields = [];
  let index = 0;
  for (;;) {
    let field = "";
    if (text[index] === "\"") {
      index += 1;
      for (;;) {
        const close = text.indexOf("\"", index);
        if (close === -1) return null;
        field += text.slice(index, close);
        index = close + 1;
        if (text[index] !== "\"") break;
        field += "\"";
        index += 1;
      }
      if (index < text.length && text[index] !== "," && text[index] !== "\n") return null;
    } else {
      let end = index;
      while (end < text.length && text[end] !== "," && text[end] !== "\n") end += 1;
      field = text.slice(index, end);
      if (field.includes("\"")) return null;
      index = end;
    }
    fields.push(field);
    if (index >= text.length || text[index] === "\n") return fields;
    index += 1;
  }
}

// The keys of a `--mount` value Docker's CLI knows (Docker 29), the ones it also takes alone, as `readonly`, and the
// booleans' spellings. Any other key, a field with no `=` that is not one of those, an empty value, and an option of
// one kind of mount on another ("cannot mix 'volume-*' options with mount type 'bind'") are refused.
const MOUNT_KEYS = new Set(["type", "source", "src", "target", "dst", "destination", "readonly", "ro", "consistency",
  "bind-propagation", "bind-recursive", "bind-create-src", "volume-subpath", "volume-nocopy", "volume-driver",
  "volume-label", "volume-opt", "image-subpath", "tmpfs-size", "tmpfs-mode"]);
const MOUNT_SWITCHES = new Set(["readonly", "ro", "bind-create-src", "volume-nocopy"]);
const MOUNT_BOOLEANS = new Map([["true", true], ["1", true], ["false", false], ["0", false]]);

// What Go's strings.TrimSpace takes off, Unicode's White_Space: not JavaScript's trim(), which also takes a BOM and
// leaves U+0085. Docker 29 trims a whole `--mount` value so, and refuses a key or a value inside it edged so.
const GO_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const GO_EDGE_SPACE = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, "g");
const goTrim = (text) => text.replace(GO_EDGE_SPACE, "");
// A container path as Docker cleans it before it mounts there: `/data/` and `//data` are `/data`.
const cleanTarget = (target) => (target ? path.posix.normalize(target).replace(/(?<=.)\/$/, "") : target);

/**
 * One `--mount` value read the way Docker's CLI reads it (`opts/mount.go`):
 * trimmed, then one CSV record, so a field may be double-quoted; keys, and the
 * `type` value, in any case; `src` is `source`, `dst` and `destination` are
 * `target`, and a key given twice keeps its last value; no `type` is a volume.
 * The target is the path Docker mounts at, cleaned (`/data/` is `/data`).
 * `createsSource` is `bind-create-src`: Docker makes a missing source itself.
 * `null` for a value Docker 29 would not parse. That is no verdict on the entry:
 * the CLIs before it read more (`readonly=TRUE`, `bind-nonrecursive`), so
 * `clients doctor` starts such an entry, and Docker says what it refuses.
 *
 * @param {string} value
 * @returns {{ type: string, source: string, target: string, createsSource: boolean } | null}
 */
function parseMount(value) {
  const fields = csvRecord(goTrim(String(value ?? "")));
  if (!fields) return null;
  const mount = { type: "volume", source: "", target: "", createsSource: false };
  const kinds = new Set();
  for (const field of fields) {
    const at = field.indexOf("=");
    const key = (at < 0 ? field : field.slice(0, at)).toLowerCase();
    const given = at < 0 ? null : field.slice(at + 1);
    if (given === null ? !MOUNT_SWITCHES.has(key) : !MOUNT_KEYS.has(key) || given === "" || goTrim(given) !== given) return null;
    if (MOUNT_SWITCHES.has(key) && given !== null && !MOUNT_BOOLEANS.has(given)) return null;
    if (key === "bind-recursive" && !["enabled", "disabled", "writable", "readonly"].includes(given)) return null;
    const kind = /^(bind|volume|image|tmpfs)-/.exec(key)?.[1];
    if (kind) kinds.add(kind);
    if (key === "type") mount.type = given.toLowerCase();
    else if (key === "source" || key === "src") mount.source = given;
    else if (key === "target" || key === "dst" || key === "destination") mount.target = given;
    else if (key === "bind-create-src") mount.createsSource = given === null || MOUNT_BOOLEANS.get(given);
  }
  mount.target = cleanTarget(mount.target);
  return [...kinds].every((kind) => kind === mount.type) ? mount : null;
}

// The options of `docker run` that take no value (`docker run --help`, Docker 29); every other one takes the next
// argument unless it is written --option=value. Short ones run together, as in -it, up to one that takes a value.
const RUN_SWITCHES = new Set(["detach", "disable-content-trust", "help", "init", "interactive", "no-healthcheck",
  "oom-kill-disable", "privileged", "publish-all", "quiet", "read-only", "rm", "sig-proxy", "tty", "use-api-socket"]);
const RUN_SHORT_SWITCHES = "dPiqt";

/**
 * A `docker run` command line read as Docker's CLI reads it: its options, each
 * `[name, value]` (`null` for a switch), up to the image — what follows the
 * image is the container's command, and a `--mount` there is not Docker's.
 *
 * @param {string[]} args
 * @returns {{ options: Array<[string, string | null]>, image: string }}
 */
function runOptions(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const options = [];
  let index = list[0] === "run" ? 1 : 0;
  for (; index < list.length; index += 1) {
    const argument = list[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (argument.startsWith("--")) {
      const at = argument.indexOf("=");
      const name = argument.slice(2, at < 0 ? undefined : at);
      // A value is the next argument, whatever it looks like: it is not read again as an option.
      if (at >= 0) options.push([name, argument.slice(at + 1)]);
      else if (RUN_SWITCHES.has(name)) options.push([name, null]);
      else options.push([name, list[++index] ?? null]);
    } else if (argument.startsWith("-") && argument.length > 1) {
      const taking = [...argument.slice(1)].findIndex((letter) => !RUN_SHORT_SWITCHES.includes(letter));
      if (taking !== -1) {
        const rest = argument.slice(taking + 2);
        options.push([argument[taking + 1], rest ? rest.replace(/^=/, "") : list[++index] ?? null]);
      }
    } else {
      break;
    }
  }
  return { options, image: list[index] ?? "" };
}

/**
 * Every `--mount` of a `docker run` command line Docker reads, given as
 * `--mount <value>` or `--mount=<value>`: `null` for one it cannot read.
 *
 * @param {string[]} args
 * @returns {Array<ReturnType<typeof parseMount>>}
 */
function mountsOf(args) {
  return runOptions(args).options.filter(([name]) => name === "mount").map(([, value]) => (value === null ? null : parseMount(value)));
}

/**
 * The `--mount` values of a `docker run` command line that Docker 29's CLI
 * cannot read: it refuses the whole command over one, before it looks at any
 * folder. Older CLIs read some of them, so they are the entry's to
 * try, not a verdict.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function unreadableMounts(args) {
  return runOptions(args).options.filter(([name, value]) => name === "mount" && (value === null || !parseMount(value))).map(([, value]) => value ?? "");
}

// What a `--mount` Docker 29 cannot read mounts at `/data` — its type and source — or null: read more leniently than
// any CLI reads one, each field trimmed and any other key let be, as `volume-nocopy=TRUE`.
function dataMountOf(value) {
  const mount = { type: "volume", source: "", target: "" };
  for (const field of csvRecord(goTrim(value)) ?? []) {
    const [name, ...rest] = field.split("=");
    const key = goTrim(name).toLowerCase();
    const given = goTrim(rest.join("="));
    if (key === "type") mount.type = given.toLowerCase();
    else if (key === "source" || key === "src") mount.source = given;
    else if (key === "target" || key === "dst" || key === "destination") mount.target = given;
  }
  return cleanTarget(mount.target) === "/data" ? mount : null;
}

// Docker's words for a `--mount` value its CLI refused, the value in Go's quotes (`%q`, strconv.Quote), wherever they
// are in what it wrote: a warning may come first. And Go's escapes of one character by a letter.
const MOUNT_REFUSED = /invalid argument ("(?:[^"\\\n]|\\.)*") for "--mount" flag/g;
const GO_ESCAPED = new Map([["a", "\u0007"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\v"], ["\\", "\\"], ["\"", "\""]]);

/**
 * A string Go quoted, as it was: `\xHH`, `\uHHHH` and `\UHHHHHHHH` give the
 * character of that number, `\a \b \f \n \r \t \v \\ \"` the one they stand
 * for. Read back, not quoted again here: which characters Go escapes follows
 * its own Unicode tables — Docker 29.8.2's Go is at Unicode 15.0, Node 22 at
 * 16.0 — and a character of 15.1 or 16.0 was quoted otherwise than Docker
 * quotes it.
 *
 * @param {string} quoted
 * @returns {string}
 */
function goUnquoted(quoted) {
  return quoted.slice(1, -1).replace(/\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|U([\da-fA-F]{8})|([abfnrtv\\"]))/g, (escape, byte, unit, wide, letter) => {
    if (letter) return GO_ESCAPED.get(letter);
    const code = Number.parseInt(byte ?? unit ?? wide, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}

/**
 * Which of `values` Docker's CLI refused to start a command over, by its own
 * words: it exits 125 and says `invalid argument "<value>" for "--mount" flag`
 * — CLI 24.0.9, 27.5.1 and 29.8.2 alike. None, when the command failed for
 * another reason: a `--mount` Docker 29 cannot read is no cause of a start that
 * an older CLI made and that failed otherwise. Each
 * value is compared as Docker was given it: as UTF-8, where a lone surrogate is
 * U+FFFD.
 *
 * @param {string[]} values
 * @param {{ code?: number | null, stderr?: string }} ended - How the command ended, and what it wrote to stderr.
 * @returns {string | undefined}
 */
export function refusedMount(values, { code, stderr = "" } = {}) {
  if (code !== 125) return undefined;
  const named = new Set(Array.from(stderr.matchAll(MOUNT_REFUSED), ([, quoted]) => goUnquoted(quoted)));
  return values.find((value) => named.has(String(value).toWellFormed()));
}

// Where a link leads, from where it is; "" for what is not a link, or one that cannot be read.
function linkTarget(file, { lstat, readlink, path: paths }) {
  try {
    return lstat(file).isSymbolicLink() ? paths.resolve(paths.dirname(file), readlink(file)) : "";
  } catch {
    return "";
  }
}

/**
 * Why `ai-dev clients install` could not make a folder that is not there, or
 * null when nothing here says it could not: on the way up to the nearest folder
 * that is there, a link that leads nowhere (`link`) or a file (`file`); or that
 * folder is not this user's to write in (`write`) — the root-owned mount point of
 * a disk that is not connected, say; or the way up ends
 * at a root that is not there (`gone`) — on Windows the drive of a disk that is
 * not connected, `E:\`, which no mkdir makes. Not a share: libuv's
 * table gives no `ENOENT` for a network path that is not reached
 * (ERROR_BAD_NETPATH and ERROR_BAD_NET_NAME are `UNKNOWN` in it), and a folder
 * whose `stat` fails otherwise is not said to be missing at all.
 *
 * @param {string} folder
 * @param {{ stat: (file: string) => unknown, lstat: typeof lstatSync, readlink: typeof readlinkSync, access: typeof accessSync, path: typeof path }} io
 * @returns {{ at: string, why: "link" | "file" | "write" | "gone", leadsTo?: string } | null}
 */
function unmakeable(folder, io) {
  const paths = io.path;
  for (let child = folder, parent = paths.dirname(folder); parent !== child; child = parent, parent = paths.dirname(parent)) {
    let found;
    try {
      found = io.stat(parent);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
      const leadsTo = linkTarget(parent, io);
      if (leadsTo) return { at: parent, why: "link", leadsTo };
      if (paths.parse(parent).root === parent) return { at: parent, why: "gone" };
      continue;
    }
    if (found?.isDirectory?.() === false) return { at: parent, why: "file" };
    try {
      io.access(parent, fsConstants.W_OK);
      return null;
    } catch {
      return { at: parent, why: "write" };
    }
  }
  return null;
}

/**
 * The `--mount type=bind,source=…` folders of a `docker run` command line
 * that are not there: Docker refuses to start a container over one, so a
 * client that runs the entry gets no server at all. Not there is
 * `ENOENT` or `ENOTDIR` only: a folder this user may not look into (`EACCES`)
 * is the daemon's to judge, and it may well mount it. A source that is
 * a link says where it leads (`leadsTo`), since it is the link's target that
 * is gone; one that is not says why install could not make it again, where
 * something says so (`unmakeable`). A mount with `bind-create-src` is not
 * missing anything: Docker makes its source. A `--mount` Docker 29 cannot read
 * is passed over, not the ones beside it: Docker 29 refuses the whole command
 * over it before it looks at any folder, but the CLIs before it read some such
 * values, and a folder gone is gone for every one of them — so `clients doctor`
 * starts such an entry, and says the folder unless the start answered.
 * `path` is the host's path rules, Windows' on Windows.
 *
 * @param {string[]} args
 * @param {{ stat?: (file: string) => unknown, lstat?: typeof lstatSync, readlink?: typeof readlinkSync, access?: typeof accessSync, path?: typeof path }} [options]
 * @returns {Array<{ source: string, target: string, leadsTo?: string, unmakeable?: ReturnType<typeof unmakeable> }>}
 */
export function missingBindSources(args, { stat = statSync, lstat = lstatSync, readlink = readlinkSync, access = accessSync, path: paths = path } = {}) {
  const missing = [];
  for (const mount of mountsOf(args)) {
    if (!mount || mount.type !== "bind" || !mount.source || mount.createsSource) continue;
    try {
      stat(mount.source);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") continue;
    }
    const leadsTo = linkTarget(mount.source, { lstat, readlink, path: paths });
    const blocked = leadsTo ? null : unmakeable(mount.source, { stat, lstat, readlink, access, path: paths });
    missing.push({ source: mount.source, target: mount.target, ...(leadsTo ? { leadsTo } : {}), ...(blocked ? { unmakeable: blocked } : {}) });
  }
  return missing;
}

/**
 * What `ai-dev clients install --docker` was given for an entry it wrote, read
 * back from the entry's command line ({@link dockerRunArgs}): the image (the
 * first argument after the options, which {@link dockerRunArgs} puts last), the
 * volume, the projects folder, the state folder and the model folder — the one
 * holding `bge-m3-onnx` when the link itself is mounted. A command that writes
 * the entry again keeps them. A `--mount` Docker 29 cannot read is
 * passed over, but for what it mounts at `/data`: written again without it,
 * the entry ran on the default volume, and the data of its own was out of
 * reach. `data` is a folder bound at `/data` in place of a volume,
 * which install does not write: no projects folder, and its data stays there.
 *
 * @param {string[]} args
 * @returns {{ image: string, volume: string, projects: string, state: string, model: string, data: string }}
 */
export function dockerEntryOptions(args) {
  const options = { image: runOptions(args).image, volume: "", projects: "", state: "", model: "", data: "" };
  const atData = (mount) => {
    if (mount.type === "volume") options.volume = mount.source;
    else if (mount.type === "bind") options.data = mount.source;
  };
  for (const value of unreadableMounts(args)) {
    const mount = dataMountOf(value);
    if (mount?.source) atData(mount);
  }
  for (const mount of mountsOf(args).filter(Boolean)) {
    if (mount.target === "/data") atData(mount);
    else if (mount.type !== "bind") continue;
    else if (mount.target === CONTAINER_STATE_ROOT) options.state = mount.source;
    else if (mount.target === CONTAINER_MODELS) options.model = mount.source;
    else if (mount.target === CONTAINER_MODEL_DIR) options.model = mount.source.replace(/[\\/]+bge-m3-onnx[\\/]*$/, "");
    else options.projects = mount.source;
  }
  return options;
}

/**
 * The projects and model folders an entry mounts: a 3.0 entry's binds, a 2.x
 * entry's `AI_DEV_PROJECT_PATH` and `AI_DEV_MODEL_PATH`. What bootstrap keeps
 * when it is named none.
 *
 * @param {unknown} entry
 * @returns {{ projects: string, model: string }}
 */
export function entryFolders(entry) {
  if (!entry || typeof entry !== "object") return { projects: "", model: "" };
  if (isDirectDockerEntry(entry)) {
    const { projects, model } = dockerEntryOptions(entry.args.map(String));
    return { projects, model };
  }
  const env = entry.env && typeof entry.env === "object" ? entry.env : {};
  return { projects: String(env.AI_DEV_PROJECT_PATH ?? ""), model: String(env.AI_DEV_MODEL_PATH ?? "") };
}

/**
 * The command line a client config gets for the image.
 *
 * @param {object} input
 * @param {string} [input.docker] - The Docker CLI, by full path ({@link resolveDockerCommand}).
 * @param {string} [input.image]
 * @param {string} [input.volume]
 * @param {string} [input.projects]
 * @param {string | { source: string, target: string }} [input.model]
 * @param {string} [input.state]
 * @param {string} [input.platform]
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function dockerLaunch({ docker = "docker", image = DEFAULT_DOCKER_IMAGE, ...rest } = {}) {
  return { command: docker, args: dockerRunArgs({ image, ...rest }), env: {} };
}

/**
 * Whether an entry starts the server in Docker by itself, as 3.0 writes one,
 * rather than through a 2.x launcher.
 *
 * @param {{ command?: unknown, args?: unknown }} entry
 * @returns {boolean}
 */
export function isDirectDockerEntry(entry) {
  const command = String(entry?.command ?? "");
  const name = command.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, "");
  return name === "docker" && Array.isArray(entry?.args) && entry.args[0] === "run";
}
