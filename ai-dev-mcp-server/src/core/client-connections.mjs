/**
 * Which MCP clients run this install, and putting it into them or taking it
 * out: what `ai-dev clients` and `ai-dev setup` print and the control tools
 * (`clients_list`, `clients_install`, `clients_remove`) answer. Reading and
 * writing each client's config file is `mcp-clients.mjs`; this decides which
 * clients, with which command, and records what was written.
 */
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stableLaunch } from "./app-bundle.mjs";
import { APP_MARKER, appCli, appFolder } from "./app-home.mjs";
import { EXIT } from "./cli-args.mjs";
import { DEFAULT_DOCKER_IMAGE, DEFAULT_DOCKER_VOLUME, IMAGE_UID, checkModelFolder, dockerLaunch, modelMount, probeStateSharing, resolveDockerCommand, sharesHostState } from "./docker-launch.mjs";
import { DISTRIBUTION_MARKER, PACKAGE_NAME, currentInstallLayout } from "./install-layout.mjs";
import {
  SERVER_NAME,
  clientEntry,
  describeEntry,
  discoverClients,
  installServer,
  parseClientSelection,
  readServerEntries,
  removeServer
} from "./mcp-clients.mjs";
import { explicitRuntimeHome, resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** `ai-dev-mcp-server/` of this install. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI a client config runs. */
export const CLI_PATH = path.join(SERVER_ROOT, "bin", "ai-dev.mjs");

/** A path under the home folder written as `~/…`, as a person reads it. */
export function tildify(target, home = os.homedir()) {
  if (!home || !target) return target;
  const relative = path.relative(home, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return `~${path.sep}${relative}`;
}

/**
 * Where the record of written configs lives: the state folder the agent hooks
 * use — AI_DEV_STATE_ROOT, else the runtime home's — where a Docker install's
 * record goes too, so `clients remove` finds what either wrote. A record kept
 * in the runtime home before, with the variable set, stays the one used.
 */
export function clientStatePath(env = process.env) {
  const runtimeRecord = path.join(resolveRuntimeStateRoot("", env), "state", "mcp-clients.json");
  const stateRoot = String(env.AI_DEV_STATE_ROOT ?? "").trim();
  if (!stateRoot) return runtimeRecord;
  const record = path.join(path.resolve(stateRoot), "mcp-clients.json");
  return !existsSync(record) && existsSync(runtimeRecord) ? runtimeRecord : record;
}

/** The Obsidian vault this server sits in, if it sits in one (`<vault>/09-mcp/ai-dev-mcp-server`). */
function vaultAround(serverRoot) {
  const candidate = path.resolve(serverRoot, "..", "..");
  return existsSync(path.join(candidate, "03-skills-catalog")) || existsSync(path.join(candidate, "01-system")) ? candidate : "";
}

/** The CLI of the copy `setup` installed in the app home for this very package, or "". */
function installedAppCli(layout) {
  try {
    const distribution = JSON.parse(readFileSync(path.join(layout.root, DISTRIBUTION_MARKER), "utf8"));
    const folder = appFolder(layout.runtimeRoot, distribution);
    const marker = JSON.parse(readFileSync(path.join(folder, APP_MARKER), "utf8"));
    return marker.content_fingerprint === distribution.content_fingerprint && existsSync(appCli(folder)) ? appCli(folder) : "";
  } catch {
    return "";
  }
}

/**
 * The command line a client starts this install with: this Node, by its full
 * path, so a client that does not inherit the shell's PATH (Claude Desktop on
 * macOS, any GUI app launched from the Dock) still finds it; this CLI's file;
 * `mcp`. A vault install passes its vault on, as 2.x did, and a runtime folder
 * named by `AI_DEV_HOME` goes with it too: a client started from the Dock does
 * not see the shell's variables, and its server would look for the index,
 * the state and a package's vault in ~/.ai-dev instead.
 *
 * A package npx runs from its cache is launched from the copy `setup`
 * installed in the app home, never from the cache npm may clear. The Windows
 * install is launched through its stable link, `<runtime>/app/current`: the
 * Node and the CLI of whichever runtime the app made current, so an update
 * changes no config (`app-bundle.mjs`) — or, on a drive that holds no link,
 * from the copy the app runs; never from the program's folder.
 *
 * @param {{ env?: NodeJS.ProcessEnv, execPath?: string, cliPath?: string, serverRoot?: string, layout?: import("./install-layout.mjs").InstallLayout, appCliPath?: () => string, stable?: (layout: import("./install-layout.mjs").InstallLayout) => { command: string, cli: string } | null }} [options]
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function localLaunch({ env = process.env, execPath = process.execPath, cliPath = CLI_PATH, serverRoot = SERVER_ROOT, layout = currentInstallLayout(), appCliPath = () => installedAppCli(layout), stable = stableLaunch } = {}) {
  const vault = env.AI_DEV_VAULT_ROOT ? path.resolve(env.AI_DEV_VAULT_ROOT) : vaultAround(serverRoot);
  const runtimeHome = explicitRuntimeHome(env);
  let cli = cliPath;
  let command = execPath;
  const link = layout.kind === "package" ? stable(layout) : null;
  if (link) {
    command = link.command;
    cli = link.cli;
  } else if (layout.kind === "package" && layout.bundle && !existsSync(path.join(layout.root, APP_MARKER))) {
    // The installer's own runtime, in the program's folder: an update moves
    // that folder aside, and a file a client holds there stops it.
    throw Object.assign(new Error(`This is the runtime in AI Dev's program folder (${layout.root}), which an update replaces, so a client config must not name it. `
      + "Start AI Dev once: it copies the runtime into its data folder and connects the clients to that copy."), { exitCode: EXIT.failed });
  } else if (layout.kind === "package" && layout.ephemeral) {
    cli = appCliPath();
    if (!cli) {
      throw Object.assign(new Error(`This copy runs from npx's cache (${layout.root}), which npm may clear, so a client config must not name it. `
        + `Run \`npx ${PACKAGE_NAME} setup\` first: it installs a copy that stays, and connects the clients to it.`), { exitCode: EXIT.failed });
    }
  }
  return {
    command,
    args: [cli, "mcp"],
    env: { ...(vault ? { AI_DEV_VAULT_ROOT: vault } : {}), ...(runtimeHome ? { AI_DEV_HOME: runtimeHome } : {}) }
  };
}

/**
 * The targets a selection picks: every detected one for `all`, every target
 * of a named client whether detected or not.
 *
 * @param {import("./mcp-clients.mjs").ClientTarget[]} targets
 * @param {string | undefined} spec - `all`, or client names separated by commas.
 * @returns {{ chosen: import("./mcp-clients.mjs").ClientTarget[], skipped: import("./mcp-clients.mjs").ClientTarget[] }}
 */
export function chooseTargets(targets, spec) {
  const selection = parseClientSelection(spec ?? "all");
  if (selection.all) {
    return { chosen: targets.filter((target) => target.detected), skipped: targets.filter((target) => !target.detected) };
  }
  const chosen = targets.filter((target) => selection.ids.includes(target.client)
    // The Store build's own config exists only where that build is installed.
    && (target.variant !== "store" || target.detected));
  return { chosen, skipped: [] };
}

/** A target's name as a person reads it. */
export function clientLabel(target) {
  return target.variant === "store" ? `${target.label} (Store)` : target.label;
}

/**
 * What a Docker entry runs, from what `ai-dev clients install --docker` was
 * given — on the host, or in the image on the host's behalf (`bootstrap.sh`
 * names the host's home, platform and user, which the container's are not).
 *
 * On the host, with `apply`, the folders a bind mount needs are made — Docker
 * refuses to start a container whose mount source does not exist, every session
 * after — and on Linux the sharing of the state folder is tried before it is
 * written into an entry ({@link probeStateSharing}). In the image neither can
 * be done: its root is read-only and holds none of the host's folders but the
 * clients' and the state's, and it has no Docker. There `bootstrap.sh` made the
 * folders and tried the sharing itself, and says so with `shareState`.
 *
 * @param {object} input
 * @param {string} [input.image]
 * @param {string} [input.volume]
 * @param {string} [input.projects] - Default: `<home>/AI-Dev-Projects`, as 2.x's bootstrap had it.
 * @param {string} [input.model]
 * @param {string} [input.state] - The host's state folder; default: `AI_DEV_STATE_ROOT` on the host, else the runtime home's `state` — where the hooks keep theirs.
 * @param {"yes"|"no"|"untried"|""} [input.shareState] - Whether the state folder is shared, decided by the host (`untried`: it could not try); default: on a Linux host tried, elsewhere by uid.
 * @param {boolean} [input.tryState] - Try the sharing on a Linux host: with `apply`, and for `entry`, which prints what install would write.
 * @param {string} [input.docker] - The Docker CLI; default: found on PATH.
 * @param {string} [input.home]
 * @param {string} [input.platform]
 * @param {number} [input.uid] - The host user's; the installer run in the image runs as them.
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {boolean} [input.apply]
 * @param {typeof probeStateSharing} [input.probe]
 * @returns {Promise<{ docker: string, image: string, volume: string, projects: string, model: "" | { source: string, target: string }, state: string, record: string, platform: string, sharedState: boolean, sharedStateKind: "shared"|"refused"|"untried"|"dry", sharedStateReason: string, sharedStateGiven: boolean }>}
 */
export async function dockerOptions({ image = DEFAULT_DOCKER_IMAGE, volume = DEFAULT_DOCKER_VOLUME, projects = "", model = "", state = "", shareState = "", docker = "", home = os.homedir(), platform = process.platform, uid = process.getuid?.(), env = process.env, apply = true, tryState = apply, probe = probeStateSharing } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const onHost = String(env.AI_DEV_RUNTIME ?? "").trim().toLowerCase() !== "docker";
  const hostState = paths.resolve(state
    || (onHost && String(env.AI_DEV_STATE_ROOT ?? "").trim())
    || paths.join(resolveRuntimeStateRoot("", { ...env, HOME: home, USERPROFILE: home }), "state"));
  const resolved = {
    image,
    volume,
    platform,
    projects: paths.resolve(projects || paths.join(home, "AI-Dev-Projects")),
    // Its bge-m3-onnx mounted itself when it is a link; checked for leading somewhere where the host is to be seen.
    model: model ? modelMount(checkModelFolder(paths.resolve(model)), { verify: onHost, join: paths.join }) : "",
    // The record of written configs stays the host's either way.
    record: hostState,
    docker: docker || resolveDockerCommand({ env, platform, home })
  };
  if (apply && onHost) for (const folder of [resolved.projects, hostState]) await fs.mkdir(folder, { recursive: true });
  const probing = !shareState && platform === "linux" && onHost && tryState;
  // The probe mounts the state folder, as install would: made for it, as install makes it.
  if (probing && !apply) await fs.mkdir(hostState, { recursive: true });
  const byUid = sharesHostState({ platform, uid });
  // On Linux the sharing is tried, whatever the uid: a remapping Docker may give
  // a uid-1000 user's folder to someone else, and another uid's to them.
  // Docker Desktop on macOS and Windows maps it to the user.
  let sharing;
  if (shareState === "yes") sharing = { shared: true, kind: "shared", reason: "" };
  else if (shareState === "no") sharing = { shared: false, kind: "refused", reason: byUid ? TRIED_AND_REFUSED : "" };
  else if (shareState === "untried") sharing = { shared: false, kind: "untried", reason: "bootstrap could not try it with the image" };
  else if (platform !== "linux" || !onHost) sharing = { shared: byUid, kind: byUid ? "shared" : "refused", reason: "" };
  else if (!probing) sharing = { shared: byUid, kind: "dry", reason: "" };
  else {
    const tried = probe({ docker: resolved.docker, image, state: hostState, uid });
    sharing = { shared: tried.shared, kind: tried.shared ? "shared" : tried.tried ? "refused" : "untried", reason: tried.reason };
  }
  // Decided by the caller (`--shared-state`), it is the caller's to explain: bootstrap.sh says it once,
  // in its own words, and not once per run of the installer.
  return { ...resolved, state: sharing.shared ? hostState : "", sharedState: sharing.shared, sharedStateKind: sharing.kind, sharedStateReason: sharing.reason, sharedStateGiven: Boolean(shareState) };
}

const TRIED_AND_REFUSED = "trying it, the image's user could not write your state folder as you (rootless Docker, userns-remap or Podman map the container's users to others)";

/** Why the state is not shared, or was not tried, when that is so: for the install's output. */
export function unsharedStateNote(docker, uid = process.getuid?.()) {
  if (!docker || docker.sharedStateGiven) return "";
  if (docker.sharedStateKind === "dry") {
    return "On Linux, sharing your state folder with the server is tried with the image when the configs are written; a dry run does not try it (docs/INSTALL.md).";
  }
  if (docker.sharedState) return "";
  if (docker.sharedStateKind === "untried") {
    return `Your state folder is not shared with the server for now: ${docker.sharedStateReason || "the sharing could not be tried"}. `
      + "The server keeps its state in the volume; run `ai-dev clients install --docker` again once Docker runs the image.";
  }
  const why = docker.sharedStateReason
    || `the image's user (uid ${IMAGE_UID}) is not yours (uid ${uid}), so a folder of yours is not one the container may share`;
  return `The agent hooks keep their state apart from the server's: ${why}. The server keeps its state in the volume, as 2.x did, `
    + "and cannot write into your projects. On this machine the local install is the one to use (docs/INSTALL.md).";
}

/**
 * Put this install into the chosen clients — or, with `docker`, the image, run
 * by `docker run -i --rm …` ({@link dockerOptions}).
 *
 * @param {object} options
 * @param {string | undefined} options.spec - `all` (the default) or client names.
 * @param {boolean} [options.apply]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.platform]
 * @param {Awaited<ReturnType<typeof dockerOptions>>} [options.docker]
 * @returns {Promise<Array<object>>} Results, skipped clients included.
 */
export async function installClients({ spec, apply = true, env = process.env, home = os.homedir(), platform = process.platform, docker = null }) {
  const targets = await discoverClients({ home, env, platform });
  const { chosen, skipped } = chooseTargets(targets, spec);
  const launch = docker ? dockerLaunch(docker) : localLaunch({ env });
  const results = await installServer({
    targets: chosen,
    entryFor: (target) => clientEntry(target, launch),
    apply,
    // In the image on the host's behalf, the record goes where the host's
    // `ai-dev clients remove` reads it: its state folder, mounted in.
    statePath: docker ? path.join(docker.record, "mcp-clients.json") : clientStatePath(env)
  });
  return [
    ...results,
    ...skipped.map((target) => ({ client: target.client, label: target.label, file: target.file, status: "skipped", reason: `not installed (no ${tildify(target.marker, home)})` }))
  ];
}

/**
 * Take this server out of the chosen clients — every config it could be in
 * when none are named, installed or not.
 *
 * @param {{ spec?: string, apply?: boolean, env?: NodeJS.ProcessEnv, home?: string }} options
 * @returns {Promise<Array<object>>}
 */
export async function removeClients({ spec, apply = true, env = process.env, home = os.homedir() }) {
  const targets = await discoverClients({ home, env });
  const { chosen } = spec ? chooseTargets(targets, spec) : { chosen: targets };
  return removeServer({ targets: chosen, apply, statePath: clientStatePath(env) });
}

/**
 * Every client target, whether it is installed, and what its `ai-dev` entry
 * runs: this install, another one, Docker, the 2.x name, or nothing.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {Promise<Array<{ client: string, variant?: string, label: string, file: string, found: boolean, connected: boolean, entry: string, legacy: string[], error?: string, row: object }>>}
 */
export async function listClients({ env = process.env, home = os.homedir() } = {}) {
  let launch = null;
  try {
    launch = localLaunch({ env });
  } catch {
    // From npx's cache before setup: nothing here is "this install" yet.
  }
  const rows = await readServerEntries(await discoverClients({ home, env }));
  return rows.map((row) => {
    const current = row.entries[SERVER_NAME];
    const kind = current === undefined ? "none" : describeEntry(current, launch ? clientEntry(row, launch) : undefined).kind;
    const legacy = Object.keys(row.entries).filter((name) => name !== SERVER_NAME && row.entries[name] !== undefined);
    return {
      client: row.client,
      ...(row.variant ? { variant: row.variant } : {}),
      label: clientLabel(row),
      file: row.file,
      found: Boolean(row.detected),
      connected: kind === "current",
      entry: row.error ? "unreadable" : current === undefined ? (legacy.length ? "2.x" : "none") : kind === "current" ? "this install" : kind,
      legacy,
      ...(row.error ? { error: row.error } : {}),
      row
    };
  });
}
