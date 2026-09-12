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
