/**
 * The one argument parser of the `ai-dev` CLI.
 *
 * Every command used to parse its own flags, and they disagreed: one script
 * printed a stack trace for an unknown flag, another printed its help and
 * exited 1, a third ignored it. Here `node:util`'s `parseArgs` does the parsing
 * (`--flag`, `--no-flag`, `--name=value`, `--name value`, `-y`, `--`) and every
 * mistake becomes one sentence naming the command, with the nearest real
 * option when there is one, and exit code 2.
 */
import { parseArgs } from "node:util";

/** Exit codes, the same for every command. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, interrupted: 130 });

/** A command line the command cannot take. Its message is the whole answer. */
export class CliUsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = EXIT.usage;
  }
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

/**
 * The candidate closest to `word`, when it is close enough to be a typo.
 *
 * @param {string} word
 * @param {string[]} candidates
 * @returns {string} "" when nothing is close.
 */
export function closest(word, candidates) {
  let best = "";
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(1, Math.min(2, Math.floor(word.length / 3))) ? best : "";
}

function optionNames(options) {
  return Object.keys(options).map((name) => `--${name}`);
}

/**
 * The option `parseArgs` names in its message: `'--bogus'`, `'-x'`,
 * `'--clients <value>'` or `'-y, --yes'`.
 */
function namedOption(message, options) {
  const quoted = /'([^']+)'/.exec(message)?.[1] ?? "";
  const long = /--([\w-]+)/.exec(quoted)?.[1];
  if (long) return { written: `--${long}`, name: long };
  const short = /(?:^|\s)-(\w)/.exec(quoted)?.[1];
  if (!short) return { written: quoted, name: "" };
  const name = Object.keys(options).find((key) => options[key].short === short) ?? "";
  return { written: `-${short}`, name };
}

/** One sentence for what `parseArgs` refused. */
function describeRefusal(error, options, command) {
  const where = `\`ai-dev ${command}\``;
  const message = String(error?.message ?? "");
  const { written, name } = namedOption(message, options);
  if (error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const near = closest(written.startsWith("--") ? written : `--${written.slice(1)}`, optionNames(options));
    return `${where} has no option ${written}.${near ? ` Did you mean ${near}?` : ""} See \`ai-dev help ${command}\`.`;
  }
  if (error?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && options[name]) {
    if (options[name].type === "boolean") return `${where}: --${name} is a switch and takes no value.`;
    return `${where}: --${name} needs a value, as --${name}=<value>.`;
  }
  return `${where}: ${message.split("\n")[0]}`;
}

/**
 * Parse a command's arguments.
 *
 * @param {string[]} argv - What follows the command's name.
 * @param {object} spec
 * @param {string} spec.command - Its name, for messages (`clients install`).
 * @param {Record<string, { type: "boolean" | "string", short?: string, default?: unknown, multiple?: boolean }>} [spec.options]
 * @param {{ min?: number, max?: number, names?: string }} [spec.positionals] - How many
 *   plain arguments it takes, and what to call them in a message.
 * @returns {{ values: Record<string, unknown>, positionals: string[] }} `--no-x`
 *   gives `x: false`; `--help`/`-h` is understood by every command.
 * @throws {CliUsageError}
 */
export function parseCommandLine(argv, { command, options = {}, positionals = {} }) {
  const all = { help: { type: "boolean", short: "h" }, ...options };
  // `parseArgs` negates only switches; `--no-clients` turns a valued option
  // off as well, and reads as `clients: false`.
  const negated = [];
  const terminator = argv.indexOf("--");
  const args = argv.filter((argument, index) => {
    const name = argument.startsWith("--no-") && (terminator < 0 || index < terminator) ? argument.slice(5) : "";
    if (all[name]?.type !== "string") return true;
    negated.push(name);
    return false;
  });
  let parsed;
  try {
    parsed = parseArgs({ args, options: all, allowPositionals: true, allowNegative: true, strict: true });
  } catch (error) {
    throw new CliUsageError(describeRefusal(error, all, command));
  }
  // A plain object: `parseArgs` hands back one without a prototype.
  const values = { ...parsed.values };
  for (const name of negated) values[name] = false;
  if (values.help) return { values, positionals: parsed.positionals };
  const { min = 0, max = 0, names = "argument" } = positionals;
  const count = parsed.positionals.length;
  if (count > max) {
    const extra = parsed.positionals.slice(max).map((value) => JSON.stringify(value)).join(" ");
    throw new CliUsageError(`\`ai-dev ${command}\` takes ${max ? `at most ${max} ${names}` : `no ${names}`}, and was given ${extra} as well. `
      + `See \`ai-dev help ${command}\`.`);
  }
  if (count < min) throw new CliUsageError(`\`ai-dev ${command}\` needs ${min === 1 ? `a ${names}` : `${min} ${names}`}. See \`ai-dev help ${command}\`.`);
  return { values, positionals: parsed.positionals };
}
