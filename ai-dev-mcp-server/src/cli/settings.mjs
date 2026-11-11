/**
 * `ai-dev settings [list | get | set | reset | path]` — the settings the
 * desktop app changes (`~/.ai-dev/config.json`), from a terminal: a server
 * with no desktop is configured here. The file, its checks and when each
 * setting takes effect are `core/settings.mjs`; this is the part that prints.
 *
 * Exit codes: 0 done, 1 failed (a value the setting does not take, a file that
 * cannot be read), 2 a usage mistake.
 */
import os from "node:os";
import path from "node:path";
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import { SETTINGS, readSettings, writeSettings } from "../core/settings.mjs";
import { ALWAYS_ON_PROFILE, TOOL_PROFILES } from "../core/tool-profiles.mjs";
import { tildify } from "./context.mjs";

const SUBCOMMANDS = ["list", "get", "set", "reset", "path"];

/** The profiles a person can list in `profiles`: the opt-in control API is the desktop app's. */
export const LISTED_PROFILES = Object.freeze(TOOL_PROFILES.filter((profile) => !profile.optIn));

/** When a change takes effect, as a person at a terminal reads it. */
export const APPLIES_NOTE = Object.freeze({
  now: "in force now, in AI sessions already connected too",
  new_session: "used by AI sessions started from now on; a client already connected keeps its value until it reconnects",
  next_daemon: "used by the daemon started next; `ai-dev daemon stop` ends the running one, and the next session starts a new one",
  app: "read by the desktop app"
});

export function usage() {
  const names = Object.keys(SETTINGS);
  const width = Math.max(...names.map((name) => name.length)) + 2;
  return [
    "Usage: ai-dev settings [command] [options]",
    "",
    "  list                    every setting: the value in force and where it comes from (the default)",
    "  get <name>              one setting's value, alone on a line",
    "  set <name> <value>      change one; the value is checked first, nothing is written when it is wrong",
    "  reset <name>... | --all back to the default",
    "  path                    where the settings file is",
    "",
    "  --json                  print the result as JSON",
    "",
    "Settings:",
    ...names.map((name) => `  ${name.padEnd(width)}${SETTINGS[name].description}`),
    "",
    "Values: a folder may be given relative to the current one, or with ~; on/off, yes/no or",
    `true/false for a switch; profiles as a comma list of ${LISTED_PROFILES.map((profile) => profile.id).join(", ")}`,
    `(${ALWAYS_ON_PROFILE} is always on), or "all". An environment variable set by hand still wins over the file.`
  ].join("\n");
}

/** A setting's name, or a usage error that names the closest one. */
function settingName(word) {
  if (Object.hasOwn(SETTINGS, word)) return word;
  const near = closest(word, Object.keys(SETTINGS));
  throw new CliUsageError(`There is no setting "${word}".${near ? ` Did you mean ${near}?` : ""} \`ai-dev settings list\` shows them.`);
}

const SWITCH = new Map([["on", true], ["off", false], ["true", true], ["false", false], ["yes", true], ["no", false], ["1", true], ["0", false]]);

/**
 * What a word typed at a terminal means for a setting: a number for a number,
 * a switch for a boolean, an absolute folder for a path. A word that is none
 * of these is handed on as it is, and the setting's own check says what it
 * takes.
 *
 * @param {string} name
 * @param {string} text
 * @param {{ cwd?: string, home?: string }} [where]
 * @returns {unknown}
 */
export function parseValue(name, text, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const setting = SETTINGS[name];
  const word = String(text).trim();
  if (setting.type === "number") return /^-?\d+(\.\d+)?$/.test(word) ? Number(word) : word;
  if (setting.type === "boolean") return SWITCH.has(word.toLowerCase()) ? SWITCH.get(word.toLowerCase()) : word;
  if (setting.format === "path" && word) {
    if (word === "~") return home;
    if (word.startsWith("~/") || word.startsWith("~\\")) return path.join(home, word.slice(2));
    return path.resolve(cwd, word);
  }
  return word;
}

/** A value as a person reads it in the list. */
export function shown(name, value) {
  const setting = SETTINGS[name];
  if (setting.type === "boolean") return value ? "on" : "off";
  if (value === "" || value === null || value === undefined) {
    if (name === "profiles") return "(every profile)";
    if (name === "language") return "(the system's)";
    if (name === "model_dir") return "(default: <AI Dev home>/models/bge-m3-onnx)";
    return "(not set)";
  }
  if (setting.format === "path") return tildify(String(value));
  return String(value);
}

/** When the settings a write changed take effect, one line per moment. */
export function appliesLines(applies) {
  const groups = new Map();
  for (const [name, when] of Object.entries(applies)) groups.set(when, [...(groups.get(when) ?? []), name]);
  return [...groups].map(([when, group]) => `  ${group.join(", ")}: ${APPLIES_NOTE[when] ?? when}.`);
}

/** The settings as a table, with what is not in force yet and what the file holds that is wrong. */
export function renderSettings(current) {
  const names = Object.keys(SETTINGS);
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const values = names.map((name) => shown(name, current.settings[name]));
  const valueWidth = Math.min(48, Math.max(...values.map((value) => value.length)) + 2);
  const lines = [`Settings · ${tildify(current.file)}`, ""];
  names.forEach((name, index) => {
    const source = current.sources[name];
    const where = source === "default" ? "" : source;
    const app = SETTINGS[name].applies === "app" ? " (desktop app)" : "";
    lines.push(`  ${name.padEnd(width)}${values[index].padEnd(valueWidth)}${`${where}${app}`.trim()}`.trimEnd());
  });
  const pending = Object.entries(current.pending ?? {});
  if (pending.length) {
    lines.push("", "Saved, not in force in this process yet:");
    for (const [name, value] of pending) lines.push(`  ${name} = ${shown(name, value)} (${APPLIES_NOTE[SETTINGS[name].applies]})`);
  }
  if (current.problems?.length) {
    lines.push("", "Problems:");
    for (const problem of current.problems) lines.push(`  ${problem}`);
  }
  return lines.join("\n");
}

/** Every setting's definition, as `settings_get` gives it. */
function definitions() {
  return Object.entries(SETTINGS).map(([name, setting]) => ({
    name,
    type: setting.type,
    default: setting.default,
    env: setting.env ?? null,
    applies: setting.applies,
    description: setting.description
  }));
}

/**
 * Change settings and say what happened: what changed, and when it takes effect.
 *
 * @param {import("./context.mjs").CliIo} io
 * @param {Record<string, unknown>} changes - `null` puts a setting back to its default.
 * @param {boolean} json
 */
export async function applyChanges(io, changes, json) {
  const result = await writeSettings(changes, { env: io.env });
  if (json) {
    io.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  if (!result.changed.length) {
    io.out("Nothing changed: every value was already this.");
    return EXIT.ok;
  }
  const after = readSettings({ env: io.env });
  for (const name of result.changed) {
    const stored = Object.hasOwn(after.stored, name);
    io.out(stored ? `${name} = ${shown(name, after.stored[name])}` : `${name} is back to its default: ${shown(name, SETTINGS[name].default)}`);
    // A variable set by hand wins over the file: say so, or the change looks lost.
    if (after.sources[name]?.startsWith("environment")) {
      io.out(`  ${SETTINGS[name].env} is set in this environment and wins over the file: unset it for the file's value to count.`);
    }
  }
  io.out("Saved:");
  for (const line of appliesLines(result.applies)) io.out(line);
  return EXIT.ok;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values, positionals } = parseCommandLine(argv, {
    command: "settings",
    options: { json: { type: "boolean" }, all: { type: "boolean" } },
    positionals: { max: Infinity, names: "arguments" }
  });
  if (values.help || positionals[0] === "help") {
    io.out(usage());
    return EXIT.ok;
  }
  const [command = "list", ...rest] = positionals;
  if (!SUBCOMMANDS.includes(command)) {
    // `ai-dev settings profiles` reads as asking for that setting.
    if (Object.hasOwn(SETTINGS, command) && !rest.length) return run(["get", command, ...(values.json ? ["--json"] : [])], io);
    const near = closest(command, SUBCOMMANDS);
    const setting = near ? null : closest(command, Object.keys(SETTINGS));
    const advice = near ? ` Did you mean \`ai-dev settings ${near}\`?` : setting ? ` Did you mean \`ai-dev settings get ${setting}\`?` : "";
    throw new CliUsageError(`\`ai-dev settings\` has no "${command}".${advice} It takes ${SUBCOMMANDS.join(", ")}.`);
  }
  if (values.all && command !== "reset") throw new CliUsageError("--all goes with `ai-dev settings reset` only.");
  const json = Boolean(values.json);
  const arity = { list: [0, 0], path: [0, 0], get: [1, 1], set: [2, 2], reset: [values.all ? 0 : 1, values.all ? 0 : Infinity] }[command];
  if (rest.length < arity[0] || rest.length > arity[1]) {
    const forms = {
      list: "`ai-dev settings list`",
      path: "`ai-dev settings path`",
      get: "`ai-dev settings get <name>`",
      set: "`ai-dev settings set <name> <value>` (quote a value with spaces)",
      reset: values.all ? "`ai-dev settings reset --all`, with no names" : "`ai-dev settings reset <name>...` or `ai-dev settings reset --all`"
    };
    throw new CliUsageError(`It is ${forms[command]}. See \`ai-dev help settings\`.`);
  }

  switch (command) {
    case "path": {
      const current = readSettings({ env: io.env });
      io.out(json ? JSON.stringify({ file: current.file }, null, 2) : current.file);
      return EXIT.ok;
    }
    case "list": {
      const current = readSettings({ env: io.env });
      io.out(json ? JSON.stringify({ ...current, definitions: definitions() }, null, 2) : renderSettings(current));
      return EXIT.ok;
    }
    case "get": {
      const name = settingName(rest[0]);
      const current = readSettings({ env: io.env });
      const value = current.settings[name];
      if (json) io.out(JSON.stringify({ name, value, source: current.sources[name], ...(Object.hasOwn(current.pending, name) ? { pending: current.pending[name] } : {}) }, null, 2));
      else io.out(typeof value === "string" ? value : JSON.stringify(value));
      return EXIT.ok;
    }
    case "set": {
      const name = settingName(rest[0]);
      return applyChanges(io, { [name]: parseValue(name, rest[1]) }, json);
    }
    case "reset": {
      const names = values.all ? Object.keys(SETTINGS) : [...new Set(rest.map(settingName))];
      return applyChanges(io, Object.fromEntries(names.map((name) => [name, null])), json);
    }
    default:
      return EXIT.usage;
  }
}
