/**
 * `ai-dev menu` — what `ai-dev` alone opens at a terminal: every setting and
 * everything a person adds or changes, chosen by number, for a server with
 * no desktop app (over SSH too). Each choice runs one of the commands
 * (`ai-dev settings set …`, `ai-dev skills new …`) with the answers given, so
 * the menu does nothing the commands do not, and says the command it ran.
 *
 * Exit codes: 0 left with q (or the input ended: Ctrl-D), 2 not at a terminal, 130 Ctrl-C.
 *
 * Answers reach the commands as option values (`--pattern=<text>`) or after a
 * `--`, so a pattern such as `--no-verify` is the pattern, never an option.
 */
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { statSync } from "node:fs";
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { SETTINGS, readSettings } from "../core/settings.mjs";
import { ALWAYS_ON_PROFILE } from "../core/tool-profiles.mjs";
import { packageVersion, tildify } from "./context.mjs";
import { LISTED_PROFILES, shown } from "./settings.mjs";

export function usage() {
  return [
    "Usage: ai-dev menu      (or `ai-dev` alone, at a terminal)",
    "",
    "A menu over everything you set up and change: the settings, the AI clients, your skills,",
    "a repository's rules, the MCP servers, the local model, the daemon, a backup. Type a",
    "number and Enter; b goes back, q leaves. Each choice runs an `ai-dev` command and says",
    "which, so the same thing can go into a script."
  ].join("\n");
}

/** Ctrl-C at a question: the menu ends with 130, as every command does. */
class Interrupted extends Error {}

/**
 * Questions at the terminal. A terminal gets a fresh readline for each one —
 * nothing holds it in raw mode while a command runs, so Ctrl-C reaches the
 * command — and piped input (a test, a script) is read line by line.
 */
export function createPrompter(io) {
  const input = io.stdin ?? process.stdin;
  const output = io.stdout;
  const terminal = Boolean(input.isTTY && output.isTTY);
  let piped = null;
  if (!terminal) {
    const lines = [];
    const waiting = [];
    let ended = false;
    const reader = readline.createInterface({ input, terminal: false });
    reader.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
    reader.on("close", () => {
      ended = true;
      for (const resolve of waiting.splice(0)) resolve(null);
    });
    piped = {
      next: () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((resolve) => waiting.push(resolve))),
      close: () => reader.close()
    };
  }

  let closedByCtrlD = false;

  /** One line typed, or null when the input ended. */
  async function line(prompt) {
    if (piped) {
      output.write(prompt);
      const answer = await piped.next();
      output.write(answer === null ? "\n" : `${answer}\n`);
      return answer;
    }
    if (closedByCtrlD) return null;
    const reader = readlinePromises.createInterface({ input, output });
    // Ctrl-C and Ctrl-D both close the question: the key read says which it was.
    let interrupted = false;
    const ctrlC = (_, key) => {
      if (key?.ctrl && key.name === "c") interrupted = true;
    };
    input.on("keypress", ctrlC);
    try {
      return await reader.question(prompt);
    } catch (error) {
      if (error?.code !== "ABORT_ERR" && error?.name !== "AbortError") throw error;
      output.write("\n");
      if (interrupted) throw new Interrupted("Stopped with Ctrl-C.");
      // Ctrl-D: the input ended, here as at a pipe, and every question after it is unanswered.
      closedByCtrlD = true;
      return null;
    } finally {
      input.off("keypress", ctrlC);
      reader.close();
    }
  }

  const prompter = {
    line,
    /** Text, trimmed; `fallback` for a bare Enter; null when the input ended. */
    async text(question, fallback = "") {
      const answer = await line(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      if (answer === null) return null;
      return answer.trim() || fallback;
    },
    /** Yes or no; the fallback for a bare Enter. No when the input ended (Ctrl-D): nobody said yes. */
    async confirm(question, fallback = false) {
      const answer = await line(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `);
      if (answer === null) return false;
      if (!answer.trim()) return fallback;
      return /^(y|yes|д|да)$/i.test(answer.trim());
    },
    /**
     * A choice from a numbered list: its id, or null for back (b, Enter, or
     * the end of the input). q leaves the whole menu. Without `back` (the
     * main menu) b and Enter are not choices: only q and the end of the input leave it.
     */
    async choose(title, items, { back = "Back" } = {}) {
      output.write(`\n${title}\n`);
      const width = Math.max(0, ...items.filter((item) => item.hint).map((item) => item.label.length)) + 3;
      items.forEach((item, index) => output.write(`  ${String(item.key ?? index + 1).padStart(2)}  ${item.hint ? `${item.label.padEnd(width)}${item.hint}` : item.label}\n`));
      output.write(`${back ? `   b  ${back}\n` : ""}   q  Quit\n`);
      for (;;) {
        const answer = await line("Choose: ");
        if (answer === null) return null;
        const word = answer.trim().toLowerCase();
        if (word === "q") throw new Leave();
        if (back && (word === "b" || word === "")) return null;
        if (word === "") continue;
        // A number, or the choice itself typed out: "ru", "on", "block".
        const found = items.find((item, index) => String(item.key ?? index + 1) === word)
          ?? items.find((item) => item.id.toLowerCase() === word || item.label.toLowerCase() === word);
        if (found) return found.id;
        output.write(`There is no ${JSON.stringify(answer.trim())} here: a number from the list${back ? ", b" : ""} or q.\n`);
      }
    },
    close: () => piped?.close()
  };
  return prompter;
}

/** q: the menu ends, from wherever it is. */
class Leave extends Error {}

/**
 * The menu's own io for the commands it runs: their yes/no questions are the
 * menu's, read from the same input.
 */
function commandIo(io, prompter) {
  return { ...io, interactive: true, ask: (question, fallback) => prompter.confirm(question, fallback) };
}

/** A folder typed at a question: ~ is the home folder, a relative one is from the current folder. */
function folderFrom(text, cwd = process.cwd()) {
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(cwd, text);
}

function isFolder(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** A word in a shown command: quoted when it holds what a shell would split on. */
const shellWord = (word) => (/^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * The menu.
 *
 * @param {import("./context.mjs").CliIo} io
 * @param {{ main: (argv: string[], io: object) => Promise<number | null> }} cli - What runs a command line.
 */
export async function runMenu(io, { main }) {
  const ask = createPrompter(io);
  const sub = commandIo(io, ask);
  const session = { project: process.cwd() };
  const say = (text = "") => io.out(text);
  const command = async (...words) => {
    say(`\n$ ai-dev ${words.map(shellWord).join(" ")}`);
    const code = await main(words, sub);
    if (code) say(`(exit ${code})`);
    return code;
  };

  const project = async () => {
    for (;;) {
      const answer = await ask.text("The repository's folder", tildify(session.project));
      if (answer === null) return false;
      const folder = folderFrom(answer);
      if (isFolder(folder)) {
        session.project = folder;
        return true;
      }
      say(`${folder} is not a folder.`);
    }
  };

  const menus = {
    async settings() {
      for (;;) {
        let current;
        try {
          current = readSettings({ env: io.env });
        } catch (error) {
          say(error.message);
          return;
        }
        const names = Object.keys(SETTINGS);
        const items = names.map((name) => ({ id: name, label: name, hint: `${shown(name, current.settings[name])}${current.sources[name].startsWith("environment") ? `  (${current.sources[name]})` : ""}` }));
        items.push({ id: "reset", key: "r", label: "Put every setting back to its default" });
        const choice = await ask.choose(`Settings · ${tildify(current.file)}`, items);
        if (choice === null) return;
        if (choice === "reset") {
          if (await ask.confirm("Put every setting back to its default?", false)) await command("settings", "reset", "--all");
          continue;
        }
        await changeSetting(choice, current);
      }
    },

    async clients() {
      for (;;) {
        const choice = await ask.choose("AI clients: the ai-dev entry in Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini", [
          { id: "list", label: "List them", hint: "installed or not, and what their ai-dev entry runs" },
          { id: "install", label: "Connect every client found here" },
          { id: "some", label: "Connect some", hint: "by name" },
          { id: "remove", label: "Disconnect" },
          { id: "doctor", label: "Check that each answers" }
        ]);
        if (choice === null) return;
        if (choice === "list") await command("clients", "list");
        if (choice === "install") await command("clients", "install");
        if (choice === "doctor") await command("clients", "doctor");
        if (choice === "some" || choice === "remove") {
          const names = await ask.text("Clients: all, or some of claude-code, claude-desktop, cursor, vscode, codex, gemini", choice === "remove" ? "" : "all");
          if (!names) continue;
          if (choice === "some") await command("clients", "install", `--clients=${names.replace(/\s+/g, "")}`);
          else if (await ask.confirm(`Take ai-dev out of ${names}?`, false)) await command("clients", "remove", `--clients=${names.replace(/\s+/g, "")}`);
        }
      }
    },

    async skills() {
      for (;;) {
        const choice = await ask.choose("Skills", [
          { id: "search", label: "Find skills", hint: "by what they do" },
          { id: "mine", label: "Your skills" },
          { id: "new", label: "Start a new skill", hint: "from a template, then write its SKILL.md" },
          { id: "add", label: "Add a skill from a folder", hint: "one with a SKILL.md" },
          { id: "remove", label: "Remove one of yours" },
          { id: "import", label: "Import from GitHub", hint: "a repository of skills" },
          { id: "show", label: "Read a skill" },
          { id: "groups", label: "The groups" },
          { id: "rebuild", label: "Rebuild the registry" }
        ]);
        if (choice === null) return;
        if (choice === "mine" || choice === "groups" || choice === "rebuild") {
          await command("skills", choice);
          continue;
        }
        if (choice === "search") {
          const words = await ask.text("What should the skill do?");
          if (words) await command("skills", "search", "--", ...words.split(/\s+/));
        } else if (choice === "new") {
          const name = await ask.text("Its name (lowercase letters, digits, hyphens)");
          const description = name ? await ask.text("What it does and when to use it, in one sentence") : null;
          if (name && description) await command("skills", "new", "--", name, description);
        } else if (choice === "add") {
          const folder = await ask.text("The skill's folder");
          if (!folder) continue;
          const words = ["skills", "add", folderFrom(folder)];
          if (await command(...words) && await ask.confirm("Replace a skill of yours of that name, if that is what stopped it?", false)) await command(...words, "--replace");
        } else if (choice === "remove" || choice === "show") {
          const name = await ask.text(choice === "remove" ? "The name of the skill to remove" : "The skill's name");
          if (name) await command("skills", choice, "--", name);
        } else if (choice === "import") {
          const url = await ask.text("The repository's address (https://github.com/…)");
          if (!url) continue;
          const select = await ask.confirm("Only its skills/<name> folders that pass the import policy (recommended for a large catalog)?", true);
          await command("skills", "import", ...(select ? ["--select"] : []), "--", url);
        }
      }
    },

    async rules() {
      for (;;) {
        const choice = await ask.choose(`Rules · ${tildify(session.project)}`, [
          { id: "list", label: "Guard rules", hint: "what the agent hooks block or warn about" },
          { id: "add", label: "Add a guard rule" },
          { id: "switch", label: "Switch a rule on or off" },
          { id: "remove", label: "Remove a guard rule" },
          { id: "hooks", label: "Agent hooks", hint: "whether they are installed" },
          { id: "install-hooks", label: "Install the agent hooks" },
          { id: "packs", label: "Engineering rule packs" },
          { id: "install", label: "Install the engineering rules", hint: "AGENTS.md, .claude/rules, .cursor/rules…" },
          { id: "project", key: "p", label: "Another repository" }
        ]);
        if (choice === null) return;
        const where = ["--project", session.project];
        if (choice === "project") await project();
        if (choice === "list" || choice === "packs") await command("rules", choice, ...where);
        if (choice === "hooks") await command("rules", "hooks", ...where);
        if (choice === "add") {
          const id = await ask.text("Its id (such as no-force-push)");
          const pattern = id ? await ask.text("The pattern it matches (a regular expression, case-insensitive)") : null;
          const example = pattern ? await ask.text("A sample it must match") : null;
          const message = example ? await ask.text("What the agent is told to do instead") : null;
          if (!message) continue;
          const event = await ask.choose("What it watches", [{ id: "bash", label: "Shell commands" }, { id: "file", label: "File writes" }, { id: "all", label: "Both" }]);
          const action = event && await ask.choose("What a match does", [{ id: "block", label: "Refuse the call" }, { id: "warn", label: "Let it through, with the message" }]);
          if (action) await command("rules", "add", `--pattern=${pattern}`, `--example=${example}`, `--message=${message}`, "--event", event, "--action", action, ...where, "--", id);
        }
        if (choice === "switch") {
          const id = await ask.text("The rule's id");
          const state = id && await ask.choose(`${id}:`, [{ id: "on", label: "On" }, { id: "off", label: "Off" }]);
          if (state) await command("rules", state, ...where, "--", id);
        }
        if (choice === "remove") {
          const id = await ask.text("The rule's id");
          if (id) await command("rules", "remove", ...where, "--", id);
        }
        if (choice === "install-hooks") {
          const profile = await ask.choose("How much the hooks do", [
            { id: "minimal", label: "minimal", hint: "the guard rules and session capture" },
            { id: "standard", label: "standard", hint: "and session context, formatting, stop checks" },
            { id: "strict", label: "strict", hint: "and push warnings, grounding for a first edit" }
          ]);
          if (profile && !await command("rules", "hooks", "install", "--profile", profile, "--dry-run", ...where) && await ask.confirm("Install them?", true)) {
            await command("rules", "hooks", "install", "--profile", profile, ...where);
          }
        }
        if (choice === "install" && !await command("rules", "install", "--dry-run", ...where) && await ask.confirm("Write them?", true)) {
          await command("rules", "install", ...where);
        }
      }
    },

    async servers() {
      if (!await project()) return;
      const mine = await ask.confirm("Your own configs too (they apply to every repository)?", false);
      await command("servers", "--project", session.project, ...(mine ? ["--mine"] : []));
    },

    async model() {
      for (;;) {
        const choice = await ask.choose("The local search model (BGE-M3, about 600 MB): dense search; word search works without it", [
          { id: "status", label: "Status" },
          { id: "install", label: "Download and install it" },
          { id: "import", label: "Import it from a folder or a .zip" },
          { id: "verify", label: "Check its files" },
          { id: "doctor", label: "Load it and embed a probe" }
        ]);
        if (choice === null) return;
        if (choice === "import") {
          const source = await ask.text("The folder or .zip");
          if (source) await command("model", "import", folderFrom(source));
        } else if (choice !== "install" || await ask.confirm("Download about 600 MB now?", true)) {
          await command("model", choice);
        }
      }
    },

    async daemon() {
      for (;;) {
        const choice = await ask.choose("The daemon: one warm server every AI client of yours is handed to", [
          { id: "status", label: "Status" },
          { id: "start", label: "Start it" },
          { id: "stop", label: "Stop it", hint: "the next AI session starts a new one" }
        ]);
        if (choice === null) return;
        await command("daemon", choice);
      }
    }
  };

  async function changeSetting(name, current) {
    const setting = SETTINGS[name];
    say(`\n${name}: ${setting.description}`);
    say(`Now: ${shown(name, current.settings[name])}${current.sources[name] === "default" ? "" : ` (${current.sources[name]})`}`);
    let value;
    if (setting.type === "boolean") {
      value = await ask.choose(`${name}:`, [{ id: "on", label: "On" }, { id: "off", label: "Off" }]);
    } else if (setting.choices) {
      value = await ask.choose(`${name}:`, setting.choices.map((choice) => ({ id: choice || "-", label: choice || "The default" })));
    } else if (name === "profiles") {
      LISTED_PROFILES.forEach((profile, index) => say(`  ${String(index + 1).padStart(2)}  ${profile.id.padEnd(10)}${profile.summary}`));
      const answer = await ask.text(`Numbers or names, separated by spaces (${ALWAYS_ON_PROFILE} is always on); all for every one; Enter keeps it`);
      if (answer) {
        const words = answer.split(/[\s,]+/).filter(Boolean);
        value = words.map((word) => (/^\d+$/.test(word) ? LISTED_PROFILES[Number(word) - 1]?.id ?? word : word)).join(",");
      }
    } else {
      const hint = setting.type === "number" ? "minutes" : setting.format === "path" ? "a folder" : "the value";
      value = await ask.text(`New value: ${hint}; Enter keeps it, - puts back the default`);
    }
    if (!value) return;
    if (value === "-") await command("settings", "reset", name);
    else await command("settings", "set", "--", name, value);
  }

  const items = [
    { id: "status", label: "Status", hint: "model, index, clients, health checks" },
    { id: "settings", label: "Settings", hint: "profiles, model folder and mirror, daemon idle time" },
    { id: "clients", label: "AI clients", hint: "connect Claude Code, Cursor, VS Code, Codex, Gemini" },
    { id: "skills", label: "Skills", hint: "find, add your own, import from GitHub" },
    { id: "rules", label: "Rules", hint: "a repository's guard rules and engineering rules" },
    { id: "servers", label: "MCP servers", hint: "what the AI clients start for a repository" },
    { id: "model", label: "Local model", hint: "dense search" },
    { id: "daemon", label: "Daemon" },
    { id: "backup", label: "Back up", hint: "the vault and AI Dev's state, as a ZIP" },
    { id: "help", key: "h", label: "Every command" }
  ];
  say(`AI Dev ${packageVersion()} · type a number and Enter; b goes back, q leaves.`);
  try {
    for (;;) {
      const choice = await ask.choose("AI Dev", items, { back: null });
      if (choice === null) return EXIT.ok;
      if (menus[choice]) await menus[choice]();
      else await command(choice === "help" ? "help" : choice);
    }
  } catch (error) {
    if (error instanceof Leave) return EXIT.ok;
    if (error instanceof Interrupted) return EXIT.interrupted;
    throw error;
  } finally {
    ask.close();
  }
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values } = parseCommandLine(argv, { command: "menu" });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  if (!io.interactive) {
    io.err("The menu asks questions, and nobody can answer here: run it at a terminal. `ai-dev help` lists the commands it runs.");
    return EXIT.usage;
  }
  const { main } = await import("./main.mjs");
  return runMenu(io, { main });
}
