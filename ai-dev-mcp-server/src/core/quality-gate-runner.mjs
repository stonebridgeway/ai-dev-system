/**
 * The quality gate: reading it, choosing what to run, and reporting the run.
 *
 * A project's `.ai-dev/quality-gate.md` is prose an agent can edit, so the
 * commands in it are parsed rather than configured. Everything here is pure —
 * the text goes in, the plan and the report come out — and the extension in
 * `src/extensions/projects.mjs` runs what this module selects.
 */
import { parseSafeCommand } from "./command-policy.mjs";
import { mdCell } from "./text-format.mjs";

/** Default, and most, commands one run may execute. */
export const QUALITY_GATE_DEFAULT_MAX_COMMANDS = 6;
export const QUALITY_GATE_MAX_COMMANDS = 20;

/** Default, and most, milliseconds one command may take. */
export const QUALITY_GATE_DEFAULT_TIMEOUT_MS = 120000;
export const QUALITY_GATE_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** How many commands to run: the request, clamped into what the gate allows. */
export function qualityGateMaxCommands(value) {
  return Math.max(1, Math.min(Number(value) || QUALITY_GATE_DEFAULT_MAX_COMMANDS, QUALITY_GATE_MAX_COMMANDS));
}

/** How long one command may take: the request, clamped into what the gate allows. */
export function qualityGateTimeoutMs(value) {
  return Math.max(1000, Math.min(Number(value) || QUALITY_GATE_DEFAULT_TIMEOUT_MS, QUALITY_GATE_MAX_TIMEOUT_MS));
}

/** A label reduced to letters and digits, so `Type-check` and `typecheck` match. */
export function normalizeQualityLabel(label) {
  return String(label ?? "")
    .replace(/\s*\[cwd=[^\]]+\]\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "");
}

/** A command with its markdown backticks and surrounding space removed. */
export function cleanQualityCommand(command) {
  return String(command ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
}

/** Every command a quality-gate file offers.

 * Bullets carry a label (`- Test: \`npm test\``) or only a command; table rows
 * carry a label, a command and an optional working directory. A working
 * directory may also be written into the label as `[cwd=sub]`. Label, cwd and
 * command together identify a command, so the same command under two labels is
 * kept twice and a literal repeat is kept once. */
export function parseQualityGateCommands(text) {
  const commands = [];
  const seen = new Set();
  const add = (label, command, source, explicitCwd = "") => {
    const cleaned = cleanQualityCommand(command);
    if (!cleaned || /^not detected$/i.test(cleaned)) return;
    const rawLabel = String(label || "Command").trim();
    const cwdMatch = rawLabel.match(/\s*\[cwd=([^\]]+)\]\s*$/i);
    const cwd = String(explicitCwd || cwdMatch?.[1] || "").trim().replaceAll("\\", "/");
    const cleanLabel = rawLabel.replace(/\s*\[cwd=[^\]]+\]\s*$/i, "").trim();
    const key = `${normalizeQualityLabel(cleanLabel)}:${cwd}:${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    commands.push({
      label: cleanLabel,
      command: cleaned,
      cwd,
      source
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const bulletMatch = line.match(/^\s*[-*]\s+([^:`]+):\s*`([^`]+)`/);
    if (bulletMatch) {
      add(bulletMatch[1], bulletMatch[2], "markdown bullet");
      continue;
    }

    const bareBulletMatch = line.match(/^\s*[-*]\s+`([^`]+)`/);
    if (bareBulletMatch) {
      add("Command", bareBulletMatch[1], "markdown bullet");
      continue;
    }

    if (/^\s*\|/.test(line) && !/^\s*\|\s*-+/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length >= 2 && !/^task$/i.test(cells[0]) && !/^command$/i.test(cells[1])) {
        add(cells[0], cells[1].replace(/^`|`$/g, ""), "markdown table", cells[2] || "");
      }
    }
  }

  return commands;
}

/** Labels that start servers, deploy, or mutate data: never run unasked. */
export function shouldSkipQualityLabel(label) {
  return /^(install|dev|serve|start|watch|preview|deploy|publish|release|migrate|migration|seed|smoke|manual|integration)$/i.test(String(label ?? "").trim());
}

/** Why the command policy refuses this command, or `""` when it allows it. */
export function qualityCommandBlockReason(command) {
  try {
    parseSafeCommand(String(command ?? ""), { purpose: "quality" });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Which parsed commands to run, and why each of the rest was left out.

 * Naming labels selects exactly those, including ones skipped by default;
 * naming none takes everything but the side-effectful labels. */
export function selectQualityCommands(commands, labels, maxCommands) {
  const normalizedLabels = Array.isArray(labels)
    ? labels.map(normalizeQualityLabel).filter(Boolean)
    : [];
  const selected = [];
  const skipped = [];

  for (const item of commands) {
    if (normalizedLabels.length && !normalizedLabels.includes(normalizeQualityLabel(item.label))) {
      skipped.push({ ...item, reason: "label not selected" });
      continue;
    }
    if (!normalizedLabels.length && shouldSkipQualityLabel(item.label)) {
      skipped.push({ ...item, reason: "label skipped by default" });
      continue;
    }
    if (selected.length >= maxCommands) {
      skipped.push({ ...item, reason: "max_commands limit reached" });
      continue;
    }
    selected.push(item);
  }
  return { selected, skipped };
}

/** The run as it is written into the project card. */
export function qualityGateReportMarkdown(result) {
  const lines = [
    `Updated: ${result.finished_at}`,
    "",
    `Status: ${result.status}`,
    "",
    `Project path: \`${result.project_path}\``,
    "",
    "## Commands",
    "",
    "| Label | CWD | Command | Status | Exit |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const item of result.results) {
    lines.push(`| ${mdCell(item.label)} | ${mdCell(item.cwd || ".")} | ${mdCell(item.command)} | ${mdCell(item.status)} | ${mdCell(item.exit_code ?? "")} |`);
  }
  if (!result.results.length) {
    lines.push("| None | . |  | no commands run |  |");
  }

  if (result.blocked.length) {
    lines.push("", "## Blocked Commands", "");
    for (const item of result.blocked) {
      lines.push(`- ${item.label}: \`${item.command}\` (${item.reason})`);
    }
  }

  if (result.skipped.length) {
    lines.push("", "## Skipped Commands", "");
    for (const item of result.skipped) {
      lines.push(`- ${item.label}: \`${item.command}\` (${item.reason})`);
    }
  }

  if (result.diagram_specs?.enabled) {
    lines.push("", "## Diagram Specifications", "", `Pattern: \`${result.diagram_specs.pattern}\``, "");
    for (const item of result.diagram_specs.files) lines.push(`- ${item.status}: \`${item.path}\` (${item.type}; ${item.warnings || 0} warning(s))`);
    if (!result.diagram_specs.files.length) lines.push("- No matching diagram specifications.");
  }

  return lines.join("\n");
}

/**
 * The verdict over one run.
 *
 * A command that failed or timed out always outranks a diagram-spec warning,
 * and the three "nothing happened" verdicts are kept apart: a gate file with no
 * commands in it (`no_commands`), a gate whose every command the policy
 * refused (`blocked`), and a gate whose commands were all filtered out by the
 * request (`no_commands_run`).
 *
 * @param {object} run
 * @param {boolean} run.dryRun
 * @param {Array<object>} run.parsed - Every command the gate file offers.
 * @param {Array<object>} run.results - What actually ran.
 * @param {Array<object>} run.blocked - Commands the policy refused.
 * @param {{ enabled: boolean, status?: string }} run.diagramSpecs
 * @returns {string} One of the gate's statuses.
 */
export function qualityGateStatus({ dryRun, parsed, results, blocked, diagramSpecs }) {
  const commandsFailed = results.some((item) => item.status === "failed" || item.status === "timed_out");
  if (dryRun) return "dry_run";
  // A real command failure always outranks a diagram-spec warning.
  if (commandsFailed || diagramSpecs.status === "block") return "failed";
  if (!parsed.length && !diagramSpecs.enabled) return "no_commands";
  if (blocked.length && !results.length) return "blocked";
  if (diagramSpecs.status === "warn") return "warn";
  if (blocked.length) return "passed_with_blocked";
  if (!results.length) return "no_commands_run";
  return "passed";
}

/**
 * What to tell an agent about a `node --test <directory>` run that failed
 * before any test body executed.
 *
 * Node 21 made the positional arguments of `node --test` glob patterns. A bare
 * directory then matches itself, and the runner executes the directory as if it
 * were a test file, so a suite that passes under `node --test` fails under
 * `node --test test/` with a module-resolution error and nothing that names the
 * cause.
 */
export const NODE_TEST_DIRECTORY_HINT = "Node >= 21 treats positional arguments as glob patterns; a directory is run as a test file. Use `node --test` or `node --test \"test/**/*.test.js\"`.";

/** Every module path a `Cannot find module` line in this output names. */
function moduleNotFoundNames(output) {
  return [...String(output).matchAll(/Cannot find module ['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/**
 * The positional operands of every `node --test` invocation this text shows.
 *
 * The gate runs what the project wrote down, which is usually `npm run test`;
 * the `node --test …` line is then in the output, because npm echoes the script
 * it is about to run. So command and output are read the same way, and the TAP
 * and npm line prefixes (`#`, `>`) are stripped first.
 */
function nodeTestOperands(text) {
  const operands = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const tokens = rawLine.replace(/^[\s>#]+/, "").trim().split(/\s+/).filter(Boolean);
    const nodeAt = tokens.findIndex((token) => /(?:^|[\\/])node(?:\.exe)?$/i.test(token.replace(/^["']|["']$/g, "")));
    if (nodeAt < 0) continue;
    const testAt = tokens.indexOf("--test", nodeAt + 1);
    if (testAt < 0) continue;
    for (const token of tokens.slice(testAt + 1)) {
      if (token.startsWith("-")) continue;
      operands.push(token.replace(/^["']|["']$/g, ""));
    }
  }
  return operands;
}

/**
 * The hint for one failed command, or `""` when there is nothing certain to
 * say.
 *
 * Deliberately narrow: a hint is produced only when the operand Node could not
 * resolve is the very operand the command handed to `--test`. An ordinary
 * failing test says nothing about globs and gets no hint, and a command already
 * written as a glob is the spelling this hint recommends.
 *
 * @param {{ command?: string, stdout?: string, stderr?: string }} run
 * @returns {string} The hint, or `""`.
 */
export function diagnoseQualityCommandFailure({ command = "", stdout = "", stderr = "" } = {}) {
  const output = `${stdout}\n${stderr}`;
  const missing = moduleNotFoundNames(output);
  if (!missing.length) return "";
  for (const operand of nodeTestOperands(`${command}\n${output}`)) {
    const bare = operand.replace(/[\\/]+$/, "");
    if (!bare || /[*?]/.test(bare)) continue;
    const named = missing.some((name) => {
      const resolved = name.replaceAll("\\", "/");
      return resolved === bare || resolved.endsWith(`/${bare.replaceAll("\\", "/")}`);
    });
    if (named) return NODE_TEST_DIRECTORY_HINT;
  }
  return "";
}

/**
 * A version as `[major, minor, patch]`, with an absent or wildcard part left
 * `null`, or `null` when this is not a version at all.
 *
 * Partial is the normal case here: `engines.node` is written `20` far more
 * often than `20.0.0`, and the missing parts are what decides how wide the
 * range is. Prerelease and build metadata are dropped — Node's own releases
 * carry none, and a range that leans on them is not one this understands.
 */
function parseVersionParts(text) {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/
    .exec(String(text ?? "").trim());
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((part) => (
    part === undefined || /^[xX*]$/.test(part) ? null : Number(part)
  ));
  // `20.x.1` is not a range anybody means; once a part is open the rest is too.
  const firstOpen = parts.indexOf(null);
  if (firstOpen >= 0 && parts.slice(firstOpen).some((part) => part !== null)) return null;
  return parts;
}

/** The lowest version a partial covers: the missing parts are zero. */
function lowerBound(parts) {
  return parts.map((part) => part ?? 0);
}

/** The first version a partial no longer covers, or `null` when it covers everything. */
function upperBound([major, minor, patch]) {
  if (major === null) return null;
  if (minor === null) return [major + 1, 0, 0];
  if (patch === null) return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

/** The first version a caret range no longer covers. */
function caretUpperBound([major, minor, patch]) {
  if (major === null || major > 0) return [(major ?? 0) + 1, 0, 0];
  if (minor === null) return [1, 0, 0];
  if (minor > 0 || patch === null) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

/** The first version a tilde range no longer covers. */
function tildeUpperBound([major, minor]) {
  if (major === null) return null;
  if (minor === null) return [major + 1, 0, 0];
  return [major, minor + 1, 0];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** One comparator as the half-open interval it accepts, or `null` when unreadable. */
function comparatorInterval(comparator) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
  if (!match) return null;
  const [, operator = "", operand] = match;
  const parts = parseVersionParts(operand);
  if (!parts) return null;
  if (parts[0] === null) return { from: [0, 0, 0], to: null };
  const low = lowerBound(parts);
  switch (operator) {
    case ">=": return { from: low, to: null };
    case ">": return { from: upperBound(parts), to: null };
    case "<=": return { from: [0, 0, 0], to: upperBound(parts) };
    case "<": return { from: [0, 0, 0], to: low };
    case "^": return { from: low, to: caretUpperBound(parts) };
    case "~": return { from: low, to: tildeUpperBound(parts) };
    default: return { from: low, to: upperBound(parts) };
  }
}

/**
 * An `engines.node` range as the alternatives it offers, or `null` when this is
 * not a shape we read.
 *
 * Deliberately partial. It covers what `engines.node` is actually written as —
 * `20`, `^20`, `~20.1`, `>=20`, `20.x`, `18 || 20`, `>=18 <21` — and answers
 * `null` for everything else, including hyphen ranges and `lts/*`. A range this
 * cannot read produces no claim in either direction: a warning invented out of
 * a misparse is worse than the silence it replaced.
 *
 * @param {string} range
 * @returns {Array<Array<{ from: number[], to: number[]|null }>>|null}
 */
export function parseEngineRange(range) {
  const text = String(range ?? "").trim();
  if (!text) return null;
  const alternatives = [];
  for (const alternative of text.split("||")) {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return null;
    const intervals = [];
    for (const comparator of comparators) {
      const interval = comparatorInterval(comparator);
      if (!interval) return null;
      intervals.push(interval);
    }
    alternatives.push(intervals);
  }
  return alternatives.length ? alternatives : null;
}

/**
 * Whether a version satisfies an `engines.node` range.
 *
 * @param {string} range - As written in the project's package.json.
 * @param {string} version - As `process.version`.
 * @returns {boolean|null} `null` when the range, or the version, was not read.
 */
export function engineMatches(range, version) {
  const alternatives = parseEngineRange(range);
  if (!alternatives) return null;
  const parts = parseVersionParts(version);
  if (!parts || parts.some((part) => part === null)) return null;
  return alternatives.some((intervals) => intervals.every(({ from, to }) => (
    compareVersions(parts, from) >= 0 && (to === null || compareVersions(parts, to) < 0)
  )));
}

/**
 * What the gate has to say about the Node it ran on versus the one the project
 * asks for.
 *
 * On the Docker path the commands run on the image's Node, not the user's, and
 * a project pinned to another major got the "passes here, fails in the gate"
 * pair with nothing on the record to explain it. This
 * warns; it never blocks, and a range it could not read says so rather than
 * guessing.
 *
 * @param {object} input
 * @param {string} [input.declared] - The project's `engines.node`.
 * @param {string} input.running - As `process.version`.
 * @returns {{ declared: string, satisfied: boolean|null, mismatch?: object }|null}
 */
export function engineAgreement({ declared, running }) {
  const range = String(declared ?? "").trim();
  if (!range) return null;
  const satisfied = engineMatches(range, running);
  if (satisfied !== false) return { declared: range, satisfied };
  return {
    declared: range,
    satisfied,
    mismatch: {
      declared: range,
      running,
      message: `This project declares engines.node ${range}; the quality gate ran its commands on Node ${running}. `
        + "A command that behaves differently across majors will disagree with the project's own terminal. "
        + "This is a warning: the gate ran everything it was asked to."
    }
  };
}
