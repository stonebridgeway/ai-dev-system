/**
 * The settings a person changes in the interface — and with `settings_set` —
 * kept in `config.json` in the AI Dev home (`~/.ai-dev/config.json`).
 *
 * Most of them stand for an environment variable the server has always read:
 * the file is the default, a variable set in the environment still wins. So a
 * mirror chosen in the interface reaches the model download, a capability
 * profile reaches every client that sets none, and a person who sets the
 * variable by hand keeps the last word. `applySettingsToEnvironment` puts the
 * file's values into the environment of a process when it starts — the CLI
 * and the daemon it runs — for every variable the environment leaves unset.
 *
 * The rest (`projects_root`, `daemon_autostart`, `language`) are the
 * interface's own; the server stores and validates them.
 *
 * When a change takes effect is each setting's `applies`: `now` — read at
 * every use, in a session already connected too; `new_session` — a session
 * reads it when it starts, and the model folder belongs to the daemon, whose
 * search runtime loaded it (a new folder is a new daemon); `next_daemon` —
 * the daemon reads it when it starts; `app` — the interface reads it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { atomicWriteFile, withExclusiveFile } from "./atomic-files.mjs";
import { idleTimeoutMs } from "./daemon-idle.mjs";
import { findProfile, parseProfileSetting } from "./tool-profiles.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";
import { environmentObject } from "./session-env.mjs";

/** The file's format. A file of a newer one is read for the keys this version knows. */
export const SETTINGS_SCHEMA_VERSION = 1;

const nonEmpty = (value) => String(value ?? "").trim();

/** The interface's languages; empty is the system's. */
const LANGUAGES = Object.freeze(["", "ru", "en"]);

/** The environment cuts a value at a NUL, and a process given one does not start. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function absolutePath(name) {
  return (value) => {
    const text = nonEmpty(value);
    if (!text) return "";
    // The environment cuts a value at a NUL: every process would use another folder.
    if (CONTROL_CHARACTERS.test(text)) throw new Error(`${name} must not hold a NUL or another control character.`);
    if (!path.isAbsolute(text)) throw new Error(`${name} must be an absolute path, not ${JSON.stringify(text)}.`);
    return path.resolve(text);
  };
}

/**
 * Every setting: its type, default, how a value is checked, and the variable
 * it stands for, when it stands for one. `format: "path"` marks a folder, which
 * a terminal may give relative to where it stands; `choices`, the only values
 * a setting takes.
 */
export const SETTINGS = Object.freeze({
  projects_root: {
    type: "string",
    default: "",
    applies: "app",
    format: "path",
    description: "The folder your projects are in; the interface opens and lists projects from it.",
    validate: absolutePath("projects_root")
  },
  profiles: {
    type: "string",
    default: "",
    env: "AI_DEV_PROFILES",
    applies: "new_session",
    description: "Capability profiles listed to a client that sets no AI_DEV_PROFILES of its own; empty lists every profile an agent gets. The opt-in control profile is not one of them: a client that wants it names it itself.",
    validate(value) {
      const text = nonEmpty(value);
      if (!text) return "";
      const parsed = parseProfileSetting(text);
      if (parsed.unknown.length) throw new Error(`profiles names ${parsed.unknown.map((name) => JSON.stringify(name)).join(", ")}, which ${parsed.unknown.length === 1 ? "is not a profile" : "are not profiles"}.`);
      // This is what every agent client without its own AI_DEV_PROFILES gets:
      // the desktop app's tools stay out of it.
      const optIn = parsed.ids.filter((id) => findProfile(id)?.optIn);
      if (optIn.length) {
        // A value stored before this check keeps the rest of what it names:
        // `core,control` read back is `core`, not every profile.
        const rest = parsed.ids.filter((id) => !optIn.includes(id));
        throw Object.assign(new Error(`profiles cannot name ${optIn.join(", ")}: it is the desktop app's, and a client that wants it sets AI_DEV_PROFILES=${optIn.join(",")} itself.`), {
          kept: parsed.all ? "" : rest.join(","),
          keptNote: rest.length ? `${rest.join(",")} is kept.` : "The default is used."
        });
      }
      return parsed.all ? "" : parsed.ids.join(",");
    }
  },
  model_mirror: {
    type: "string",
    default: "",
    env: "AI_DEV_MODEL_MIRROR",
    applies: "now",
    description: "A Hugging Face mirror the local model is downloaded from first, such as https://hf-mirror.com.",
    validate(value) {
      const text = nonEmpty(value).replace(/\/+$/, "");
      if (!text) return "";
      if (CONTROL_CHARACTERS.test(text)) throw new Error("model_mirror must not hold a NUL or another control character.");
      let url;
      try {
        url = new URL(text);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error(`model_mirror must be an http(s) address, not ${JSON.stringify(text)}.`);
      if (url.username || url.password) throw new Error("model_mirror must not carry a user name or password: the file is not a place for credentials.");
      return text;
    }
  },
  model_dir: {
    type: "string",
    default: "",
    env: "BGE_M3_ONNX_DIR",
    applies: "new_session",
    format: "path",
    description: "Where the local model lives; empty is <AI Dev home>/models/bge-m3-onnx.",
    validate: absolutePath("model_dir")
  },
  daemon_idle_minutes: {
    type: "number",
    default: 30,
    env: "AI_DEV_IDLE_TIMEOUT_MS",
    applies: "next_daemon",
    toEnv: (minutes) => String(Math.round(minutes * 60_000)),
    // What the daemon makes of the variable, whatever it holds.
    fromEnv: (text) => idleTimeoutMs({ AI_DEV_IDLE_TIMEOUT_MS: text }) / 60_000,
    description: "How long the daemon stays without a client, in minutes, from 1 to 10080 (a week); 0 keeps it until it is stopped.",
    validate(value) {
      // A number, not something that converts to one: an emptied field is
      // not 0, and a fraction of a minute is not a timeout.
      if (typeof value !== "number" || !Number.isFinite(value) || (value !== 0 && (value < 1 || value > 7 * 24 * 60))) {
        throw new Error(`daemon_idle_minutes must be a number of minutes from 1 to 10080 (a week), or 0 to keep the daemon until it is stopped, not ${JSON.stringify(value)}.`);
      }
      return value;
    }
  },
  daemon_autostart: {
    type: "boolean",
    default: true,
    applies: "app",
    description: "Whether the desktop app starts the daemon when it starts.",
    validate(value) {
      if (typeof value !== "boolean") throw new Error("daemon_autostart must be true or false.");
      return value;
    }
  },
  language: {
    type: "string",
    default: "",
    applies: "app",
    choices: LANGUAGES,
    description: "The interface's language: ru, en, or empty for the system's.",
    validate(value) {
      const text = nonEmpty(value).toLowerCase();
      if (!LANGUAGES.includes(text)) throw new Error(`language must be ru, en or empty, not ${JSON.stringify(value)}.`);
      return text;
    }
  }
});

/**
 * Where the settings are kept: `config.json` in the AI Dev home.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function settingsPath(env = process.env) {
  return path.join(path.resolve(resolveRuntimeStateRoot("", env)), "config.json");
}

/**
 * The format a file says it was written in: an integer from 1, or null when
 * it says none or something no version writes — 1.5, 1e400, a word — which
 * is read as this version's and replaced by the next change.
 */
function declaredSchema(stored) {
  const value = Number(stored.schema_version);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** The file as stored, or an empty object; a file that is not JSON is reported, never overwritten silently. */
function readStored(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    // Node names the file in some read errors and not in others: a folder in
    // its place fails at the read, after the open.
    if (String(error?.message ?? "").includes(file)) throw error;
    throw Object.assign(new Error(`${file} cannot be read: ${error?.message ?? error}`), { code: error?.code });
  }
  let stored;
  try {
    stored = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error(`${file} is not JSON. Fix or remove it; the settings are not read until then.`);
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error(`${file} does not hold a settings object.`);
  return stored;
}

/**
 * The name `env` holds `name` under: itself, or — on Windows, where a name
 * ignores case and a plain copy of the environment keeps the spelling it was
 * given — the spelling it has there.
 */
function environmentKey(env, name, platform) {
  if (platform !== "win32" || Object.hasOwn(env, name)) return name;
  // Of two spellings, the one Node's spawn passes on: the first in sorted order.
  const wanted = name.toUpperCase();
  return Object.keys(env).filter((key) => key.toUpperCase() === wanted).sort()[0] ?? name;
}

/** A short fingerprint of a value the file put into the environment. */
const fingerprint = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8);

/**
 * The variables the settings file put into `env`, each with the fingerprint
 * of the value it put there: `AI_DEV_SETTINGS_APPLIED=NAME:1a2b3c4d,…`. A
 * variable that holds something else now was set by hand since — in a shell
 * that inherited the list — and is the person's; so is one listed
 * without a fingerprint, which says nothing of its value.
 */
function appliedVariables(env, platform) {
  const marks = new Map();
  for (const entry of String(env[environmentKey(env, "AI_DEV_SETTINGS_APPLIED", platform)] ?? "").split(",")) {
    const [name, mark] = entry.split(":");
    if (name) marks.set(platform === "win32" ? name.toUpperCase() : name, mark ?? null);
  }
  return {
    has(name) {
      const key = platform === "win32" ? name.toUpperCase() : name;
      if (!marks.has(key)) return false;
      const mark = marks.get(key);
      return mark !== null && mark === fingerprint(nonEmpty(env[environmentKey(env, name, platform)]));
    },
    set(name, value) {
      marks.set(platform === "win32" ? name.toUpperCase() : name, fingerprint(value));
    },
    delete(name) {
      marks.delete(platform === "win32" ? name.toUpperCase() : name);
    },
    text: () => [...marks.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, mark]) => (mark ? `${name}:${mark}` : name)).join(",")
  };
}

/**
 * The settings: each stored value checked, defaults for the rest, and where
 * the value in force comes from — the environment overrides the file.
 *
 * In force means for the process `env` belongs to — or the daemon session:
 * a setting that does not apply at once is the value its environment got
 * when it started, and a change of the file since is `pending`, for sessions
 * started afterwards or the next daemon.
 *
 * @param {{ env?: NodeJS.ProcessEnv, file?: string, platform?: string }} [options]
 * @returns {{ file: string, schema_version: number, settings: Record<string, unknown>, stored: Record<string, unknown>, sources: Record<string, string>, pending: Record<string, unknown>, problems: string[] }}
 *   `schema_version`: the file's own; a newer one than this version knows is a problem too.
 */
export function readSettings({ env = process.env, file = settingsPath(env), platform = process.platform } = {}) {
  const stored = readStored(file);
  const settings = {};
  const kept = {};
  const sources = {};
  const pending = {};
  const problems = [];
  const declared = declaredSchema(stored);
  const schemaVersion = declared ?? SETTINGS_SCHEMA_VERSION;
  if (schemaVersion > SETTINGS_SCHEMA_VERSION) {
    problems.push(`${file} was written by a newer AI Dev (settings schema ${schemaVersion}, this one knows ${SETTINGS_SCHEMA_VERSION}): the settings this version knows are read, and it does not change the file.`);
  } else if (declared === null && Object.hasOwn(stored, "schema_version")) {
    const shown = typeof stored.schema_version === "number" ? String(stored.schema_version) : JSON.stringify(stored.schema_version);
    problems.push(`${file} gives schema_version ${shown}, which is no version: it is read as ${SETTINGS_SCHEMA_VERSION}, and the next change writes ${SETTINGS_SCHEMA_VERSION}.`);
  }
  const applied = appliedVariables(env, platform);
  for (const [name, setting] of Object.entries(SETTINGS)) {
    let value = setting.default;
    let source = "default";
    if (Object.hasOwn(stored, name)) {
      try {
        value = setting.validate(stored[name]);
        kept[name] = value;
        source = "file";
      } catch (error) {
        if (error?.kept !== undefined) {
          value = error.kept;
          kept[name] = value;
          source = "file";
        }
        problems.push(`${name}: ${error.message} ${error?.keptNote ?? "The default is used."}`);
      }
    }
    const variable = setting.env ? nonEmpty(env[environmentKey(env, setting.env, platform)]) : "";
    if (variable && !applied.has(setting.env)) {
      // The value in force is the variable's, which the file does not change.
      source = `environment (${setting.env})`;
      value = setting.fromEnv ? setting.fromEnv(variable) : variable;
    } else if (setting.env && setting.applies !== "now") {
      // What the environment got from the file when it started — nothing, if
      // the file had nothing then — is what this process or session uses: a
      // model folder its daemon loaded, the profiles it listed.
      const started = variable ? (setting.fromEnv ? setting.fromEnv(variable) : variable) : setting.default;
      if (JSON.stringify(started) !== JSON.stringify(value)) {
        pending[name] = value;
        value = started;
        source = variable ? "file, as this session started" : "default, as this session started";
      }
    }
    settings[name] = value;
    sources[name] = source;
  }
  return { file, schema_version: schemaVersion, settings, stored: kept, sources, pending, problems };
}

/** How many links a chain may hold before it counts as a loop, as Linux counts them. */
const MAX_LINKS = 40;

/**
 * Where to write `file`: the file a link names — a dotfiles repository keeps
 * its link, and one whose file is not made yet gets it there
 * — or the path itself. A hard link to it is not kept: the file is replaced
 * whole. A link is read as the system reads it: from the folder it really
 * lies in, through a chain of links to its end; a link into a folder that is
 * not there is refused and named.
 */
async function writeTarget(file) {
  try {
    return await fs.promises.realpath(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!(await fs.promises.lstat(file).catch(() => null))?.isSymbolicLink()) return file;
  let link = file;
  for (let hops = 0; hops < MAX_LINKS; hops += 1) {
    const next = path.resolve(await fs.promises.realpath(path.dirname(link)), await fs.promises.readlink(link));
    if ((await fs.promises.lstat(next).catch(() => null))?.isSymbolicLink()) {
      link = next;
      continue;
    }
    const folder = await fs.promises.realpath(path.dirname(next)).catch(() => null);
    if (folder === null) {
      throw new Error(`${file} is a link to ${next}, whose folder ${path.dirname(next)} is not there: make or mount it, or put a file in place of the link.`);
    }
    return path.join(folder, path.basename(next));
  }
  throw Object.assign(new Error(`${file} is a chain of more than ${MAX_LINKS} links: one of them leads back to another.`), { code: "ELOOP" });
}

/** Whether the file gives `name` a value this version reads — one the person set. */
function names(stored, name) {
  if (!Object.hasOwn(stored, name)) return false;
  try {
    SETTINGS[name].validate(stored[name]);
    return true;
  } catch (error) {
    return error?.kept !== undefined;
  }
}

/**
 * Change some settings: each value checked first, nothing written when one is
 * wrong; `null` puts a setting back to its default. The file is rewritten
 * whole, under a lock, with mode 0600.
 *
 * @param {Record<string, unknown>} changes
 * @param {{ env?: NodeJS.ProcessEnv, file?: string, platform?: string, unsetOnly?: boolean, lockTimeoutMs?: number }} [options]
 *   `unsetOnly`: a setting the file already gives a value it reads keeps it —
 *   decided under the lock, so a value written meanwhile is not written over
 *   (the desktop app's language); `lockTimeoutMs`: how
 *   long to wait for the file's lock.
 * @returns {Promise<{ changed: string[], settings: Record<string, unknown>, pending: Record<string, unknown>, applies: Record<string, string> }>}
 *   `applies`: when each changed setting takes effect (`now`, `new_session`, `next_daemon`, `app`);
 *   `settings` and `pending` as {@link readSettings} has them.
 */
export async function writeSettings(changes, { env = process.env, file = settingsPath(env), platform = process.platform, unsetOnly = false, lockTimeoutMs } = {}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("settings_set takes an object of settings to change.");
  const unknown = Object.keys(changes).filter((name) => !Object.hasOwn(SETTINGS, name));
  if (unknown.length) throw new Error(`There is no setting ${unknown.map((name) => JSON.stringify(name)).join(", ")}. The settings are ${Object.keys(SETTINGS).join(", ")}.`);
  const checked = {};
  for (const [name, value] of Object.entries(changes)) checked[name] = value === null ? null : SETTINGS[name].validate(value);
  return withExclusiveFile(file, async () => {
    const stored = readStored(file);
    // A file a newer AI Dev wrote keeps its format: this version would write
    // its own schema over keys it does not know the meaning of.
    if ((declaredSchema(stored) ?? SETTINGS_SCHEMA_VERSION) > SETTINGS_SCHEMA_VERSION) {
      throw new Error(`${file} was written by a newer AI Dev (settings schema ${stored.schema_version}, this one knows ${SETTINGS_SCHEMA_VERSION}); change the settings with that version.`);
    }
    const next = { ...stored, schema_version: SETTINGS_SCHEMA_VERSION };
    const changed = [];
    for (const [name, value] of Object.entries(checked)) {
      if (unsetOnly && names(stored, name)) continue;
      const before = Object.hasOwn(stored, name) ? stored[name] : undefined;
      if (value === null) delete next[name];
      else next[name] = value;
      if (JSON.stringify(before) !== JSON.stringify(value === null ? undefined : value)) changed.push(name);
    }
    if (changed.length) {
      // Replaced whole and flushed, through a link to wherever the file
      // really lives.
      await atomicWriteFile(await writeTarget(file), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const applies = Object.fromEntries(changed.map((name) => [name, SETTINGS[name].applies]));
    const after = readSettings({ env, file, platform });
    return { changed, settings: after.settings, pending: after.pending, applies };
  }, { timeoutMs: lockTimeoutMs });
}

/**
 * Put the file's values into `env` for every variable it leaves unset, and
 * remember which ones came from the file — with the value each got — so a
 * later change of the file can replace them and a variable set by hand is
 * never touched.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ only?: string[], platform?: string }} [options] - `only`: these variables, and no other.
 * @returns {string[]} the variables set from the file
 */
export function applySettingsToEnvironment(env = process.env, { only, platform = process.platform } = {}) {
  let current;
  try {
    current = readSettings({ env, platform });
  } catch {
    // A broken file is reported where settings are read on purpose; a process
    // starting up goes on with its environment as it is.
    return [];
  }
  const applied = appliedVariables(env, platform);
  const ours = new Set(Object.values(SETTINGS).map((setting) => setting.env).filter((name) => name && applied.has(name)));
  for (const [name, setting] of Object.entries(SETTINGS)) {
    if (!setting.env || (only && !only.includes(setting.env))) continue;
    const key = environmentKey(env, setting.env, platform);
    if (nonEmpty(env[key]) && !ours.has(setting.env)) {
      // Set by hand: the person's, and no longer the file's to replace.
      applied.delete(setting.env);
      continue;
    }
    if (Object.hasOwn(current.stored, name)) {
      const value = current.stored[name];
      const text = setting.toEnv ? setting.toEnv(value) : String(value);
      if (text === "" && setting.type === "string") {
        delete env[key];
        applied.delete(setting.env);
        ours.delete(setting.env);
      } else {
        env[key] = text;
        applied.set(setting.env, text);
        ours.add(setting.env);
      }
    } else {
      if (ours.has(setting.env)) delete env[key];
      applied.delete(setting.env);
      ours.delete(setting.env);
    }
  }
  const markKey = environmentKey(env, "AI_DEV_SETTINGS_APPLIED", platform);
  const text = applied.text();
  if (text) env[markKey] = text;
  else delete env[markKey];
  return [...ours].sort();
}

/** The variables of the settings read at every use, in a session already connected too. */
const READ_AT_EVERY_USE = Object.values(SETTINGS).filter((setting) => setting.env && setting.applies === "now").map((setting) => setting.env);

/**
 * A session's environment as a tool that acts for it reads it: a copy that —
 * on Windows, as the daemon's own environment does — finds a variable
 * whatever the case of its name, with the settings that apply at once
 * read again: a mirror saved a moment ago counts in this very session, and a
 * variable the client set itself still wins. The model folder is not
 * one of them: the daemon's search loaded its folder when it started, and the
 * tools must look where it does — a new folder is a new session's.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function sessionEnvironment(env = process.env, { platform = process.platform } = {}) {
  const view = environmentObject({ ...env }, { platform });
  applySettingsToEnvironment(view, { only: READ_AT_EVERY_USE, platform });
  return view;
}
