/**
 * The channel between AI Dev's daemon and whoever talks to it: the `ai-dev mcp`
 * bridge an AI client starts, and `ai-dev daemon status|stop`.
 *
 * Three things keep the channel this user's:
 *
 * - the address is drawn at random on every start and published only in the
 *   daemon's descriptor, written with mode 0600 inside the user's runtime home —
 *   so no other process can create the pipe first and wait for clients on it;
 * - a Unix socket lives in a directory of mode 0700 that belongs to the user;
 * - the first line each side sends proves it holds the secret in the
 *   descriptor, without sending the secret: the client answers the daemon's
 *   nonce with an HMAC, and the daemon answers the client's with another. A
 *   process that reached the socket anyway learns nothing it can reuse, and a
 *   client that reached something other than the daemon — a stale address
 *   another process took over — finds out before it sends anything else.
 *
 * Then an MCP client sends one more line: its environment, which the daemon
 * runs the session in (`session-env.mjs`). After that the connection
 * carries MCP exactly as stdio does, one JSON-RPC message per line; or, on a
 * control connection, one request and one answer.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { renameOver } from "./atomic-files.mjs";
import { daemonIdentity } from "./session-env.mjs";

/** The handshake's version. A daemon that speaks another is replaced, never half-understood. */
export const DAEMON_PROTOCOL = 1;

/** How long one side waits for the other's handshake line. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** A handshake line longer than this is not a handshake. */
const HANDSHAKE_LINE_BYTES = 16 * 1024;

/**
 * The longest session line: a client's environment. Windows caps an
 * environment block at 32 767 characters, and elsewhere one is rarely more than
 * a few kilobytes; a megabyte is far past any real one.
 */
export const SESSION_LINE_BYTES = 1024 * 1024;

/**
 * The longest answer to a control request. `status` lists every client with
 * the name and version it gave itself; a client with a long name, or a few
 * hundred sessions, made the answer longer than a handshake line and both
 * `status` and `stop` fail.
 */
export const CONTROL_ANSWER_BYTES = 1024 * 1024;

const HEX_SECRET = /^[0-9a-f]{64}$/;
const HEX_NONCE = /^[0-9a-f]{32}$/;

/** A failure of the channel itself — refused, unanswered, unproven — as opposed to a bug. */
export class ChannelError extends Error {
  constructor(message, { code = "EDAEMONCHANNEL", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChannelError";
    this.code = code;
  }
}

/** A secret for one daemon's lifetime: 256 random bits, as hex. */
export const newSecret = () => crypto.randomBytes(32).toString("hex");

/** A nonce for one handshake: 128 random bits, as hex. */
export const newNonce = () => crypto.randomBytes(16).toString("hex");

function mac(secret, parts) {
  return crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(parts.join("\n")).digest("hex");
}

/** What a client sends to prove it holds the secret: bound to both nonces. */
export const clientProof = (secret, serverNonce, clientNonce) => mac(secret, ["ai-dev client", serverNonce, clientNonce]);

/** What the daemon sends back to prove the same: bound to both nonces and its pid. */
export const serverProof = (secret, serverNonce, clientNonce, pid) => mac(secret, ["ai-dev daemon", serverNonce, clientNonce, String(pid)]);

/** Compare two proofs in constant time. */
export function sameProof(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/**
 * Read one handshake line. What arrived after its newline is the start of the
 * stream that follows and is handed back, never dropped; the socket is left
 * paused, so nothing more is read until the next reader is attached.
 *
 * @param {import("node:net").Socket} socket
 * @param {{ timeoutMs?: number, buffered?: Buffer, maxBytes?: number, kind?: string }} [options] - `kind`
 *   names the line in the error a line past `maxBytes` ends with.
 * @returns {Promise<{ message: Record<string, unknown>, rest: Buffer }>}
 */
export function readLine(socket, { timeoutMs = HANDSHAKE_TIMEOUT_MS, buffered = Buffer.alloc(0), maxBytes = HANDSHAKE_LINE_BYTES, kind = "handshake line" } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = buffered;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const take = () => {
      const end = buffer.indexOf(0x0a);
      // Measured whether or not the line is whole yet: one that arrives in a
      // single read is as much too long as one that arrives in many.
      if ((end < 0 ? buffer.length : end) > maxBytes) {
        finish(new ChannelError(`The other side sent a ${kind} of more than ${maxBytes} bytes.`, { code: "E2BIG" }));
        return;
      }
      if (end < 0) return;
      const text = buffer.subarray(0, end).toString("utf8").replace(/\r$/, "");
      const rest = buffer.subarray(end + 1);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        finish(new ChannelError("The other side did not answer with a handshake: its first line is not JSON."));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish(new ChannelError("The other side did not answer with a handshake."));
        return;
      }
      finish(null, { message, rest });
    };
    const onData = (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      take();
    };
    const onError = (error) => finish(new ChannelError(`The connection failed during the handshake: ${error.code ?? error.message}.`, { code: error.code, cause: error }));
    const onClose = () => finish(new ChannelError("The other side closed the connection during the handshake.", { code: "ECONNRESET" }));
    const timer = setTimeout(() => finish(new ChannelError(`No handshake within ${timeoutMs} ms.`, { code: "ETIMEDOUT" })), timeoutMs);
    timer.unref?.();
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.resume();
    if (buffer.length) take();
  });
}

/** Write one handshake line. */
export function writeLine(socket, message) {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The daemon's side of the handshake: send a nonce, check the client's proof,
 * prove itself in return. A client that fails is told so and disconnected.
 *
 * @param {import("node:net").Socket} socket
 * @param {object} daemon
 * @param {string} daemon.secret
 * @param {number} daemon.pid
 * @param {string} daemon.version
 * @param {string} daemon.build
 * @param {(request: { mode: string, profiles: string | null }) => Promise<object> | object} [daemon.welcome] - Extra fields
 *   for the answer; a throw refuses the client with its message.
 * @param {number} [daemon.timeoutMs]
 * @returns {Promise<{ mode: "mcp" | "control", profiles: string | null, environment: Record<string, string> | null, rest: Buffer }>}
 *   `environment` is the client's, for an MCP session; null on a control connection.
 */
export async function acceptHandshake(socket, { secret, pid, version, build, welcome = () => ({}), timeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  const serverNonce = newNonce();
  await writeLine(socket, { ai_dev_daemon: DAEMON_PROTOCOL, nonce: serverNonce });
  const { message, rest } = await readLine(socket, { timeoutMs });
  const refuse = async (reason, code = "EAUTH") => {
    await writeLine(socket, { ok: false, error: reason }).catch(() => undefined);
    socket.end();
    throw new ChannelError(reason, { code });
  };
  if (message.protocol !== DAEMON_PROTOCOL) return refuse(`This daemon speaks handshake protocol ${DAEMON_PROTOCOL}, not ${JSON.stringify(message.protocol ?? null)}.`);
  if (typeof message.nonce !== "string" || !HEX_NONCE.test(message.nonce)) return refuse("The handshake carries no nonce.");
  if (!sameProof(message.proof, clientProof(secret, serverNonce, message.nonce))) return refuse("Authentication failed: the proof does not match this daemon's secret.");
  const mode = message.mode === "control" ? "control" : "mcp";
  const profiles = typeof message.profiles === "string" ? message.profiles : null;
  let extra;
  try {
    extra = await welcome({ mode, profiles });
  } catch (error) {
    // The daemon will not take this client — it is retiring, or stopping —
    // and says so, rather than leave it to guess from a closed connection.
    return refuse(error.message, error.code ?? "EREFUSED");
  }
  await writeLine(socket, { ...extra, ok: true, proof: serverProof(secret, serverNonce, message.nonce, pid), pid, version, build });
  if (mode !== "mcp") return { mode, profiles, environment: null, rest };
  // The client sends its environment only now, once this daemon has proven
  // itself: a process that took over the address never sees it.
  const { message: session, rest: after } = await readLine(socket, { timeoutMs, buffered: rest, maxBytes: SESSION_LINE_BYTES, kind: "session environment" });
  const environment = session.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.values(environment).some((value) => typeof value !== "string")) {
    socket.end();
    throw new ChannelError("The client sent no environment for its session.", { code: "EPROTO" });
  }
  return { mode, profiles, environment, rest: after };
}

/** The variables of `env` that have a value, as strings: what a session line carries. */
function sessionVariables(env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)]));
}

/**
 * Connect to the daemon `info` describes and prove each side to the other; for
 * an MCP session, then send the environment the session is to run in.
 *
 * @param {object} info - What the daemon's descriptor holds.
 * @param {{ mode?: "mcp" | "control", profiles?: string | null, environment?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {Promise<{ socket: import("node:net").Socket, welcome: Record<string, any>, rest: Buffer }>}
 */
export async function openChannel(info, { mode = "mcp", profiles = null, environment = process.env, timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  const session = mode === "mcp" ? `${JSON.stringify({ environment: sessionVariables(environment) })}\n` : "";
  if (Buffer.byteLength(session) > SESSION_LINE_BYTES) {
    throw new ChannelError(`This client's environment is ${Math.round(Buffer.byteLength(session) / 1024)} KB, more than the daemon takes (${SESSION_LINE_BYTES / 1024} KB).`, { code: "E2BIG" });
  }
  const socket = net.connect(info.address);
  // A reset after the handshake reaches whoever reads the socket next as a
  // `close`; without a listener of its own here it would end the process.
  socket.on("error", () => undefined);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ChannelError(`The daemon did not accept a connection within ${timeoutMs} ms.`, { code: "ETIMEDOUT" })), timeoutMs);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new ChannelError(`Cannot reach the daemon at ${info.address}: ${error.code ?? error.message}.`, { code: error.code, cause: error }));
      });
    });
    const { message: hello, rest: early } = await readLine(socket, { timeoutMs });
    if (hello.ai_dev_daemon !== DAEMON_PROTOCOL || typeof hello.nonce !== "string" || !HEX_NONCE.test(hello.nonce)) {
      throw new ChannelError(`What answers at ${info.address} is not a daemon of this version.`, { code: "EPROTO" });
    }
    const nonce = newNonce();
    await writeLine(socket, { protocol: DAEMON_PROTOCOL, nonce, proof: clientProof(info.secret, hello.nonce, nonce), mode, profiles });
    const { message: welcome, rest } = await readLine(socket, { timeoutMs, buffered: early });
    if (welcome.ok !== true) throw new ChannelError(`The daemon refused the connection: ${String(welcome.error ?? "no reason given").replace(/\.$/, "")}.`, { code: "EAUTH" });
    if (!sameProof(welcome.proof, serverProof(info.secret, hello.nonce, nonce, welcome.pid))) {
      throw new ChannelError(`What answers at ${info.address} cannot prove it is this user's daemon.`, { code: "EAUTH" });
    }
    if (Number(welcome.pid) !== Number(info.pid)) {
      throw new ChannelError(`The daemon at ${info.address} is pid ${welcome.pid}, not the pid ${info.pid} its descriptor names.`, { code: "EAUTH" });
    }
    if (session) await new Promise((resolve, reject) => socket.write(session, (error) => (error ? reject(error) : resolve())));
    return { socket, welcome, rest };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * The errors that say nothing listens at an address: refused, or no socket
 * there. Any other — `EAGAIN` from a listener whose queue is full because it
 * hangs, a busy pipe, a permission — leaves the address taken.
 */
const NOTHING_LISTENS = new Set(["ECONNREFUSED", "ENOENT", "ENOTDIR", "ENOTSOCK"]);

/**
 * Whether a failed connection, or a request over one, says nothing listens at
 * the address — and not that something does and did not answer.
 *
 * @param {{ code?: string } | null | undefined} error
 * @returns {boolean}
 */
export const nothingListens = (error) => NOTHING_LISTENS.has(error?.code);

/**
 * Whether something takes connections at a daemon's address: a daemon that is
 * alive — even one hung in a debugger, whose lock went stale, as the kernel
 * still accepts into its backlog — or nothing, when the process that listened
 * there is gone, whoever has its pid now. An address
 * that neither takes nor refuses within the time counts as taken.
 *
 * On macOS a full queue is refused like a dead socket, so there a hung daemon
 * met by some hundreds of connections looks gone: a retired one puts
 * its record back once it runs, a serving one finds its descriptor gone and
 * retires.
 *
 * @param {string} address
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function addressListening(address, { timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    if (!address) {
      resolve(false);
      return;
    }
    let socket;
    try {
      socket = net.connect(address);
    } catch {
      resolve(false);
      return;
    }
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", (error) => done(!nothingListens(error)));
  });
}

/**
 * One control request — `status`, `stop`, `retire` — and its answer.
 *
 * @param {object} info
 * @param {string} command
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function controlRequest(info, command, { timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  const { socket, rest } = await openChannel(info, { mode: "control", timeoutMs });
  try {
    await writeLine(socket, { control: command });
    const { message } = await readLine(socket, { timeoutMs, buffered: rest, maxBytes: CONTROL_ANSWER_BYTES, kind: "control answer" });
    return message;
  } finally {
    socket.destroy();
  }
}

/** Whether `info` is a descriptor this version wrote — 2.x's `daemon.json` had no protocol and no secret. */
function isDescriptor(info) {
  if (!info || typeof info !== "object") return false;
  if (info.protocol !== DAEMON_PROTOCOL || !Number.isInteger(info.pid) || typeof info.address !== "string") return false;
  return typeof info.secret === "string" && HEX_SECRET.test(info.secret);
}

/**
 * A daemon's descriptor, and in what state it was found: `missing` (no such
 * file), `unreadable` (the system refused it for a moment — Windows does while
 * a file is renamed over or scanned — or it is not JSON), `invalid` (not one
 * this version wrote), or `ok`. Only `missing` says the descriptor is gone.
 *
 * @param {string} file
 * @returns {Promise<{ state: "missing" | "unreadable" | "invalid" | "ok", info: Record<string, any> | null }>}
 */
export async function readDaemonInfoState(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    return { state: error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : "unreadable", info: null };
  }
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    return { state: "unreadable", info: null };
  }
  return isDescriptor(info) ? { state: "ok", info } : { state: "invalid", info: null };
}

/**
 * What a daemon's descriptor says, or null when there is none to use.
 *
 * @param {string} file
 * @returns {Promise<Record<string, any> | null>}
 */
export async function readDaemonInfo(file) {
  return (await readDaemonInfoState(file)).info;
}

/**
 * Publish a daemon's descriptor: written whole under another name with mode 0600, then
 * renamed over the old one, so a reader sees one complete descriptor or the
 * previous one, and nobody else can read the secret in it.
 *
 * @param {string} file
 * @param {object} info
 * @returns {Promise<void>}
 */
export async function writeDaemonInfo(file, info) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  try {
    await renameOver(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Remove a descriptor only while it still describes daemon `pid`: a daemon on
 * its way out must not take its successor's descriptor with it. The daemon
 * calls it while it still holds its lock, which no successor has then.
 *
 * @param {string} file
 * @param {number} pid
 * @returns {Promise<boolean>} whether it was removed
 */
export async function removeDaemonInfo(file, pid) {
  const info = await readDaemonInfo(file);
  if (info && info.pid !== pid) return false;
  await fs.rm(file, { force: true });
  return true;
}

/** What stands for the code: every source file's path, size and time. */
async function sourceFingerprint(serverRoot) {
  const hash = crypto.createHash("sha256");
  const walk = async (relative) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(serverRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(child);
      } else if (/\.(?:mjs|js|json)$/.test(entry.name) && !entry.name.endsWith(".test.mjs")) {
        const stat = await fs.stat(path.join(serverRoot, child)).catch(() => null);
        if (stat) hash.update(`${child.replaceAll("\\", "/")}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
      }
    }
  };
  for (const top of ["src", "bin", "hooks"]) await walk(top);
  const manifest = await fs.stat(path.join(serverRoot, "package.json")).catch(() => null);
  if (manifest) hash.update(`package.json:${manifest.size}:${Math.trunc(manifest.mtimeMs)}\n`);
  return hash.digest("hex");
}

/** A short digest of a variable's value: enough to compare two, nothing to read back. */
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

/**
 * Which build of the server a daemon is: its version, where its code is and
 * what that code is now, and where its data is (`daemonIdentity` in
 * `session-env.mjs`). A client of another build — a `git pull`, a new package,
 * another vault — is served by a daemon of its own build, never by a stale
 * one; two spellings of one folder are one build.
 * Each part appears as a digest: the build is printed by
 * `ai-dev daemon status` and kept in the descriptor, and a path may be one a
 * person would rather not show.
 *
 * @param {{ serverRoot: string, version: string, env?: NodeJS.ProcessEnv, platform?: string, execPath?: string }} options
 * @returns {Promise<{ id: string, version: string, root: string, source: string, environment: Record<string, string> }>}
 */
export async function describeBuild({ serverRoot, version, env = process.env, platform = process.platform, execPath = process.execPath }) {
  const root = await fs.realpath(serverRoot).catch(() => path.resolve(serverRoot));
  const source = (await sourceFingerprint(root)).slice(0, 16);
  const identity = daemonIdentity({ serverRoot: root, env, platform, execPath });
  const environment = Object.fromEntries(Object.entries(identity).map(([name, value]) => [name, digest(value)]));
  const id = crypto.createHash("sha256").update(JSON.stringify({ version, root, source, environment })).digest("hex").slice(0, 16);
  return { id, version, root, source, environment };
}

/** Two builds' environments: what differs, named as a person would change it. */
function environmentDifferences(mine = {}, theirs = {}) {
  const differ = [];
  const onlyHere = [];
  const onlyThere = [];
  for (const name of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (mine[name] === theirs[name]) continue;
    if (mine[name] === undefined) onlyThere.push(name);
    else if (theirs[name] === undefined) onlyHere.push(name);
    else differ.push(name);
  }
  return [
    ...(differ.length ? [`${differ.join(", ")} ${differ.length === 1 ? "differs" : "differ"}`] : []),
    ...(onlyThere.length ? [`${onlyThere.join(", ")} set only for it`] : []),
    ...(onlyHere.length ? [`${onlyHere.join(", ")} set only here`] : [])
  ];
}

/**
 * Why the daemon of build `theirs` is not the one for build `mine`, in words a
 * person can act on; empty when they are the same build.
 *
 * @param {{ version: string, root: string, source: string, environment: Record<string, string> }} mine
 * @param {{ version?: string, root?: string, source?: string, environment?: Record<string, string> } | null | undefined} theirs
 * @returns {string[]}
 */
export function buildDifferences(mine, theirs) {
  if (!theirs || typeof theirs !== "object") return ["a build it does not describe"];
  const reasons = [];
  if (theirs.version !== mine.version) reasons.push(`ai-dev ${theirs.version ?? "of an unknown version"} (here: ${mine.version})`);
  if (theirs.root !== mine.root) reasons.push(`the code at ${theirs.root} (here: ${mine.root})`);
  else if (theirs.version === mine.version && theirs.source !== mine.source) reasons.push("the code as it was before it changed on disk");
  const environment = environmentDifferences(mine.environment, theirs.environment);
  if (environment.length) reasons.push(`another environment: ${environment.join("; ")}`);
  return reasons;
}

/**
 * Whether a daemon of build `older` runs code that build `newer` replaced in
 * place: the same folder and environment, another version or source — a
 * `git pull`, an update of the package where it lies. Such a daemon is asked
 * to retire; a daemon of another folder or environment serves clients of its
 * own and is left alone. New code may count other parts of a build than the
 * code it replaced: the parts both builds have decide, or a daemon of the old
 * code would never be asked to go.
 *
 * @param {{ version: string, root: string, source: string, environment: Record<string, string> }} newer
 * @param {object | null | undefined} older
 * @returns {boolean}
 */
export function isSupersededBy(newer, older) {
  if (!older || older.root !== newer.root) return false;
  if (older.version === newer.version && older.source === newer.source) return false;
  const mine = newer.environment ?? {};
  const theirs = older.environment ?? {};
  const shared = Object.keys(mine).filter((name) => Object.hasOwn(theirs, name));
  return shared.length > 0 && shared.every((name) => mine[name] === theirs[name]);
}
