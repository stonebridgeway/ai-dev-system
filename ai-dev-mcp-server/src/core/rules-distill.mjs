/**
 * The conventions a codebase already keeps, written down (PLAN.md, stage 3.7).
 *
 * `install_project_rules` installs the rules this system believes in. This does
 * the opposite direction: it reads the repository and reports what it already
 * does — which module system, which test layout, how errors are raised — so the
 * rules an agent is given match the code it is editing rather than a house
 * style nobody here uses.
 *
 * Two things keep it honest:
 *
 * - **Every statement carries its count.** "173 of 181 files import with
 *   `import`" is a fact; "use ESM" is an opinion derived from it, and the draft
 *   shows both so a reader can disagree with the second without doubting the
 *   first.
 * - **A split convention is reported as split.** Below the agreement threshold
 *   nothing is asserted: the draft says the repository does both and how often,
 *   because a rule invented over a 55/45 split is how a linter starts rewriting
 *   half a codebase.
 *
 * The output is a *draft*: `.ai-dev/rules/project.md` with `status: draft` in
 * its frontmatter. It is a starting point for a person to edit, never installed
 * over an existing file, and it does not replace anything
 * `install_project_rules` writes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-files.mjs";
import { collectSourceFiles } from "./import-graph.mjs";
import { RULES_RELATIVE_DIR } from "./rules-library.mjs";

/** Where the draft goes. */
export const PROJECT_RULES_PATH = `${RULES_RELATIVE_DIR}/project.md`;

/** How many files a convention needs before it is stated at all. */
export const MIN_EVIDENCE_FILES = 3;

/** What share of the files that show a signal must agree before it is a rule. */
export const AGREEMENT_THRESHOLD = 0.7;

/** How many files the distillation reads. */
export const DISTILL_MAX_FILES = 1_500;

/**
 * The conventions looked for, as competing variants over the source.
 *
 * A probe returns the name of the variant a file follows, or "" when the file
 * says nothing about this convention. Keeping "says nothing" separate from "the
 * other variant" is what makes the counts mean anything: a file with no imports
 * is not a vote for CommonJS.
 */
export const CONVENTION_PROBES = Object.freeze([
  {
    id: "module_system",
    area: "Imports",
    question: "how a module reaches another module",
    applies: (file) => /\.(?:m|c)?jsx?$|\.tsx?$|\.mts$|\.cts$/i.test(file),
    variants: {
      esm: /^\s*import\s|^\s*export\s/m,
      commonjs: /\brequire\s*\(|\bmodule\.exports\b|\bexports\.\w+\s*=/
    },
    rule: {
      esm: "Use ES modules: `import` / `export`, never `require` or `module.exports`.",
      commonjs: "Use CommonJS: `require` and `module.exports`, not `import` / `export`."
    }
  },
  {
    id: "builtin_import_prefix",
    area: "Imports",
    question: "how Node built-ins are named",
    applies: (file) => /\.(?:m|c)?jsx?$|\.tsx?$/i.test(file),
    variants: {
      prefixed: /from\s+["']node:[a-z_/]+["']|require\(["']node:/,
      bare: /from\s+["'](?:fs|path|os|crypto|url|util|child_process|events|stream|http|https|zlib|assert)(?:\/[a-z]+)?["']|require\(["'](?:fs|path|os|crypto|url|util|child_process)["']/
    },
    rule: {
      prefixed: "Import Node built-ins with the `node:` prefix (`node:fs`, `node:path`).",
      bare: "Import Node built-ins by bare name (`fs`, `path`), without the `node:` prefix."
    }
  },
  {
    id: "python_import_style",
    area: "Imports",
    question: "how Python modules are imported",
    applies: (file) => file.toLowerCase().endsWith(".py"),
    variants: {
      absolute: /^\s*from\s+[a-zA-Z_][\w.]*\s+import\s/m,
      relative: /^\s*from\s+\.+\w*\s+import\s/m
    },
    rule: {
      absolute: "Import with absolute package paths (`from app.services import billing`).",
      relative: "Import within a package relatively (`from .services import billing`)."
    }
  },
  {
    id: "file_naming",
    area: "Naming",
    question: "how source files are named",
    applies: () => true,
    variants: {
      "kebab-case": (file) => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(stem(file)),
      snake_case: (file) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(stem(file)),
      camelCase: (file) => /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(stem(file)),
      PascalCase: (file) => /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/.test(stem(file))
    },
    rule: {
      "kebab-case": "Name source files in kebab-case (`task-worktrees.mjs`).",
      snake_case: "Name source files in snake_case (`task_worktrees.py`).",
      camelCase: "Name source files in camelCase (`taskWorktrees.ts`).",
      PascalCase: "Name source files in PascalCase (`TaskWorktrees.tsx`)."
    }
  },
  {
    id: "test_location",
    area: "Tests",
    question: "where a test file lives",
    applies: (file) => isTestFile(file),
    variants: {
      "beside the source": (file) => !/(?:^|\/)(?:tests?|spec|__tests__)\//i.test(file),
      "in a tests directory": (file) => /(?:^|\/)(?:tests?|spec|__tests__)\//i.test(file)
    },
    rule: {
      "beside the source": "Put a test next to the module it covers, not in a separate tree.",
      "in a tests directory": "Put tests under the project's `tests/` tree, mirroring the source layout."
    }
  },
  {
    id: "test_naming",
    area: "Tests",
    question: "how a test file is named",
    applies: (file) => isTestFile(file),
    variants: {
      "*.test.*": (file) => /\.test\.[a-z]+$/i.test(file),
      "*.spec.*": (file) => /\.spec\.[a-z]+$/i.test(file),
      "test_*.py": (file) => /(?:^|\/)test_[^/]+\.py$/i.test(file),
      "*_test.*": (file) => /_test\.[a-z]+$/i.test(file)
    },
    rule: {
      "*.test.*": "Name a test file after its subject with a `.test.` infix (`skill-router.test.mjs`).",
      "*.spec.*": "Name a test file after its subject with a `.spec.` infix (`skill-router.spec.ts`).",
      "test_*.py": "Name a test file `test_<subject>.py`.",
      "*_test.*": "Name a test file `<subject>_test.<ext>`."
    }
  },
  {
    id: "test_runner",
    area: "Tests",
    question: "which runner the tests are written for",
    applies: (file) => isTestFile(file),
    variants: {
      "node:test": /from\s+["']node:test["']|require\(["']node:test["']\)/,
      vitest: /from\s+["']vitest["']/,
      jest: /\bjest\.(?:fn|mock|spyOn)\b|@jest\/globals/,
      pytest: /^\s*import\s+pytest|^\s*from\s+pytest\s/m,
      unittest: /^\s*import\s+unittest|\bunittest\.TestCase\b/m
    },
    rule: {
      "node:test": "Write tests for the built-in runner: `node:test` plus `node:assert/strict`.",
      vitest: "Write tests for Vitest.",
      jest: "Write tests for Jest.",
      pytest: "Write tests for pytest.",
      unittest: "Write tests for `unittest`."
    }
  },
  {
    id: "error_style",
    area: "Error handling",
    question: "how a failure is raised",
    applies: (file) => /\.(?:m|c)?jsx?$|\.tsx?$|\.py$/i.test(file),
    variants: {
      "built-in Error": /\bthrow new (?:Error|TypeError|RangeError)\(|\braise (?:ValueError|TypeError|RuntimeError)\(/,
      "custom error class": /\bclass\s+\w*(?:Error|Exception)\b|\bthrow new [A-Z]\w*(?:Error|Exception)\(/
    },
    rule: {
      "built-in Error": "Raise failures with the built-in error types and a message that says what to do about it.",
      "custom error class": "Raise failures through the project's own error classes."
    }
  },
  {
    id: "swallowed_errors",
    area: "Error handling",
    question: "whether a caught error is acted on",
    applies: (file) => /\.(?:m|c)?jsx?$|\.tsx?$/i.test(file),
    variants: {
      "handled or commented": /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/|\/\*|[^}\s])/,
      "silently swallowed": /catch\s*(?:\([^)]*\))?\s*\{\s*\}/
    },
    rule: {
      "handled or commented": "An empty `catch` needs a comment saying why the failure is ignored; otherwise handle it or let it through.",
      "silently swallowed": "Errors are caught and discarded in this codebase; say so deliberately or start handling them."
    }
  }
]);

function stem(file) {
  return path.posix.basename(file).replace(/\.[^.]+$/, "").replace(/\.(?:test|spec|d)$/i, "");
}

function isTestFile(file) {
  return /(?:\.test\.|\.spec\.|(?:^|\/)test_|_test\.)/i.test(file) || /(?:^|\/)(?:tests?|spec|__tests__)\//i.test(file);
}

function matchesVariant(matcher, { relative, source }) {
  return typeof matcher === "function" ? Boolean(matcher(relative, source)) : matcher.test(source);
}

/**
 * Count every convention over a set of files.
 *
 * @param {Array<{ relative: string, source: string }>} samples
 * @param {{ probes?: typeof CONVENTION_PROBES, minFiles?: number, threshold?: number }} [options]
 * @returns {object[]} One observation per probe that saw anything.
 */
export function distillConventions(samples, {
  probes = CONVENTION_PROBES,
  minFiles = MIN_EVIDENCE_FILES,
  threshold = AGREEMENT_THRESHOLD
} = {}) {
  const files = Array.isArray(samples) ? samples : [];
  const observations = [];
  for (const probe of probes) {
    const applicable = files.filter((file) => probe.applies(file.relative, file.source));
    const counts = {};
    const examples = {};
    for (const name of Object.keys(probe.variants)) {
      counts[name] = 0;
      examples[name] = [];
    }
    for (const file of applicable) {
      for (const [name, matcher] of Object.entries(probe.variants)) {
        if (!matchesVariant(matcher, file)) continue;
        counts[name] += 1;
        if (examples[name].length < 3) examples[name].push(file.relative);
      }
    }
    const signalled = Object.values(counts).reduce((total, count) => total + count, 0);
    if (!signalled) continue;
    const ranked = Object.entries(counts).filter(([, count]) => count > 0).sort((left, right) => right[1] - left[1]);
    const [leader, leaderCount] = ranked[0];
    const share = leaderCount / signalled;
    const decided = ranked.length === 1 || (share >= threshold && leaderCount >= minFiles);
    observations.push({
      id: probe.id,
      area: probe.area,
      question: probe.question,
      status: decided ? "settled" : "split",
      variant: decided ? leader : "",
      statement: decided
        ? probe.rule[leader]
        : `This repository does both: ${ranked.map(([name, count]) => `${name} in ${count} file(s)`).join(", ")}. Pick one before making it a rule.`,
      share: Number(share.toFixed(2)),
      files_considered: applicable.length,
      files_with_signal: signalled,
      counts: Object.fromEntries(ranked),
      examples: examples[leader] ?? []
    });
  }
  return observations;
}

/**
 * The draft, as it is written to disk.
 *
 * @param {{ observations: object[], projectName?: string, scannedFiles: number, now?: string }} input
 * @returns {string}
 */
export function renderProjectRulesDraft({ observations, projectName = "", scannedFiles = 0, now = new Date().toISOString() }) {
  const settled = observations.filter((item) => item.status === "settled");
  const split = observations.filter((item) => item.status === "split");
  const lines = [
    "---",
    "status: draft",
    `generated_at: ${JSON.stringify(now)}`,
    `generated_by: ${JSON.stringify("ai-dev-system distill_project_rules")}`,
    `scanned_files: ${scannedFiles}`,
    "---",
    "",
    `# ${projectName ? `${projectName}: ` : ""}Conventions this codebase already keeps`,
    "",
    "Read out of the source, not chosen: every line below carries the count it",
    "came from. It is a **draft** — confirm the ones that are real, delete the",
    "ones that are accidents, then drop the `status: draft` line. Nothing reads",
    "this file while it says draft.",
    "",
    `Distilled from ${scannedFiles} source file(s) on ${now}.`,
    ""
  ];
  const areas = [...new Set(observations.map((item) => item.area))];
  for (const area of areas) {
    lines.push(`## ${area}`, "");
    for (const item of observations.filter((observation) => observation.area === area)) {
      const evidence = Object.entries(item.counts).map(([name, count]) => `${name}: ${count}`).join(", ");
      lines.push(`- ${item.statement}`);
      lines.push(`  - Evidence (${item.question}): ${evidence} — of ${item.files_with_signal} file(s) that say anything, ${Math.round(item.share * 100)}% agree.`);
      if (item.examples.length) lines.push(`  - For example: ${item.examples.map((example) => `\`${example}\``).join(", ")}.`);
    }
    lines.push("");
  }
  if (!observations.length) {
    lines.push("Nothing could be distilled: no source files this scan understands were found.", "");
  }
  lines.push(
    "## Not decided here",
    "",
    split.length
      ? `${split.length} convention(s) above are split and are stated as split. Deciding them is a change to the codebase, not to this file.`
      : "Every convention this scan looked for has one dominant form in this repository.",
    "",
    `Settled: ${settled.length}. Split: ${split.length}. This file complements \`install_project_rules\`, which installs the rules this system holds regardless of what a repository does today.`,
    ""
  );
  return lines.join("\n");
}

/**
 * Distil a repository's conventions into a draft rules file.
 *
 * @param {string} projectRoot
 * @param {{ projectName?: string, maxFiles?: number, dryRun?: boolean, overwrite?: boolean, now?: string }} [options]
 * @returns {Promise<object>}
 */
export async function distillProjectRules(projectRoot, {
  projectName = "",
  maxFiles = DISTILL_MAX_FILES,
  dryRun = false,
  overwrite = false,
  now = new Date().toISOString()
} = {}) {
  const root = path.resolve(projectRoot);
  const files = await collectSourceFiles(root, { maxFiles });
  const samples = [];
  for (const file of files) {
    const source = await fs.readFile(file.absolute, "utf8").catch(() => "");
    samples.push({ relative: file.relative, source });
  }
  const observations = distillConventions(samples);
  const content = renderProjectRulesDraft({ observations, projectName, scannedFiles: samples.length, now });
  const target = path.join(root, ...PROJECT_RULES_PATH.split("/"));
  const existing = await fs.readFile(target, "utf8").catch(() => null);
  // A file that is already there is never overwritten without being asked, and
  // the answer says which kind it is: a draft is safe to regenerate, one whose
  // `status: draft` line is gone has been confirmed by a person and is not.
  const stillDraft = existing !== null && /^status:\s*draft\s*$/m.test(existing.split("---")[1] ?? "");
  let action;
  if (existing !== null && !overwrite) {
    action = stillDraft ? "kept_draft" : "kept_confirmed";
  } else if (dryRun) {
    action = "planned";
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteFile(target, content, "utf8");
    action = existing === null ? "written" : "updated";
  }
  return {
    project_path: root,
    path: PROJECT_RULES_PATH,
    action,
    status: "draft",
    scanned_files: samples.length,
    settled: observations.filter((item) => item.status === "settled").length,
    split: observations.filter((item) => item.status === "split").length,
    observations,
    content
  };
}
