import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-files.mjs";
import { runProcess } from "./process-runner.mjs";
import { LEFTOVER_PATTERNS, PLACEHOLDER_VALUE, PROTECTED_CONFIG_FILES, SECRET_FILE_PATTERN, SECRET_PATTERNS } from "./change-hygiene.mjs";

export const HOOK_FILES = ["lib.mjs", "fact-force.mjs", "git-hooks.mjs", "guard.mjs", "post-edit.mjs", "session-start.mjs", "session-end.mjs", "cost-capture.mjs", "compact-advisor.mjs", "stop-check.mjs"];
export const HOOK_TARGETS = ["claude", "cursor", "git"];
export const HOOK_PROFILES = ["minimal", "standard", "strict"];
export const HOOKS_RELATIVE_DIR = ".ai-dev/hooks";
export const POLICY_RELATIVE_PATH = ".ai-dev/policy.json";
/** Where `core.hooksPath` is pointed. Relative, so a linked worktree resolves it against its own root. */
export const GIT_HOOKS_RELATIVE_DIR = ".ai-dev/git-hooks";
/** The git hooks we install. Each is a stub that hands the work to `git-hooks.mjs`. */
export const GIT_HOOK_NAMES = ["pre-commit", "pre-push"];
const COMMAND_MARKER = ".ai-dev/hooks/";

/**
 * Default `.ai-dev/policy.json`: hookify-style rules the project can extend.
 *
 * @param {string} [profile]
 * @returns {object}
 */
export function defaultPolicy(profile = "standard") {
  return {
    schema_version: 1,
    profile: HOOK_PROFILES.includes(profile) ? profile : "standard",
    allow_config_edits: false,
    format_on_edit: true,
    // compact-advisor knobs. The context signal is the newest assistant usage
    // record in the transcript; `compact_context_threshold` pins the token
    // count to advise at, 0 derives it from the window (detected, or pinned
    // with `compact_context_window`). `compact_context_interval` is how many
    // tokens must pass before the same advice repeats.
    compact_tool_threshold: 50,
    compact_tool_interval: 25,
    compact_context_threshold: 0,
    compact_context_thresholds: { standard: 160000, large: 250000 },
    compact_context_window: 0,
    compact_context_interval: 60000,
    // Per-model price overrides for the usage report, in USD per million tokens:
    // { "claude-opus-5": { "input": 5, "output": 25, "cache_write": 6.25,
    // "cache_read": 0.5 } }. Published prices ship in src/core/usage-ledger.mjs;
    // this is where a project corrects one that moved, or prices a model the
    // table has never heard of. Cache prices left out are derived from the
    // multipliers (write 1.25x, read 0.1x).
    model_rates: {},
    // Completion-statement linter (src/core/completion-claims.mjs). It refuses
    // a `checkpoint_task` / `complete_task` report that rationalizes past a
    // check that did not pass. `enabled: false` turns it off wholesale; a
    // waiver turns off one rule where the reason is real, and only when the
    // report states that reason too:
    // { "rule": "tests_deferred", "reason": "…", "expires": "2026-12-31" }.
    completion_claims: { enabled: true, waivers: [] },
    // Fact forcing (hooks/fact-force.mjs), on under the strict profile. The
    // first edit of a file in a session is refused until the agent has written
    // a `FACTS <path>` block naming the importers, the API it changes, the data
    // it touches and the instruction it serves; the first destructive command
    // is refused until a `ROLLBACK:` line says how to get back. The gate reads
    // the transcript, so it judges nothing where there is none (Cursor), and it
    // stops refusing after `max_denials` refusals in one session. Defaults live
    // in FACT_FORCE_DEFAULTS; agent-hooks.test.mjs holds these two in step.
    fact_force: {
      enabled: profile === "strict",
      files: true,
      bash: true,
      expiry_minutes: 30,
      max_denials: 3,
      max_entries: 500,
      exempt_globs: ["**/*.md", "**/*.txt", "**/*.lock", "**/*.snap", ".ai-dev/**", ".claude/**", ".cursor/**"]
    },
    // Git hooks (hooks/git-hooks.mjs), installed by targets: ["git"] through
    // core.hooksPath so they run for every client and for a human at a
    // terminal. "block" refuses, "warn" says so and lets it through, "off" is
    // silent. pre-commit scans the staged diff for the findings hygiene calls
    // blocking; pre-push reads the active task's latest verification.
    git_hooks: { pre_commit: "block", pre_push: "warn" },
    allow_commands: [],
    rules: [
      {
        id: "warn-eval",
        event: "file",
        pattern: "\\beval\\s*\\(",
        action: "warn",
        message: "Dynamic code evaluation is a security smell; prefer explicit parsing or a sandboxed evaluator."
      },
      {
        id: "warn-inner-html",
        event: "file",
        pattern: "\\.innerHTML\\s*=|dangerouslySetInnerHTML",
        action: "warn",
        message: "Raw HTML injection: sanitize the value or use text APIs."
      },
      {
        id: "block-prod-migrations",
        event: "bash",
        pattern: "(migrate|migration).*(--prod|production)|prisma\\s+migrate\\s+deploy",
        action: "block",
        message: "Production migrations need explicit human approval."
      }
    ]
  };
}

/**
 * Serialize the server's secret, leftover and config patterns for the hooks so
 * the guard, the git hooks and the MCP hygiene scan never drift. The hooks are
 * copied into other repositories and cannot import the server, so this file is
 * how they read one table.
 *
 * @returns {object}
 */
export function renderHookPatterns() {
  return {
    generated_by: "ai-dev-system install_agent_hooks",
    secrets: SECRET_PATTERNS.map((rule) => ({
      id: rule.id,
      severity: rule.severity,
      source: rule.pattern.source,
      flags: rule.pattern.flags,
      placeholder_aware: Boolean(rule.placeholderAware)
    })),
    placeholder_value: PLACEHOLDER_VALUE.source,
    leftovers: LEFTOVER_PATTERNS.map((rule) => ({
      id: rule.id,
      severity: rule.severity,
      source: rule.pattern.source,
      flags: rule.pattern.flags,
      message: rule.message,
      languages: rule.languages ?? [],
      source_only: Boolean(rule.sourceOnly)
    })),
    secret_file: SECRET_FILE_PATTERN.source,
    protected_config_files: [...PROTECTED_CONFIG_FILES]
  };
}

function command(script, ...args) {
  return { type: "command", command: ["node", `${HOOKS_RELATIVE_DIR}/${script}`, ...args].join(" ") };
}

/**
 * Claude Code hook registrations for a profile.
 *
 * @param {string} profile
 * @returns {Record<string, object[]>}
 */
export function claudeHookEntries(profile = "standard") {
  const full = profile !== "minimal";
  const hooks = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ ...command("guard.mjs", "bash"), timeout: 10 }] },
      { matcher: "Write|Edit|MultiEdit", hooks: [{ ...command("guard.mjs", "file"), timeout: 10 }] }
    ],
    // Cost capture runs at every profile: it is a few milliseconds of reading
    // the transcript tail, and a session nobody measured is a session nobody
    // can price afterwards.
    Stop: [{ hooks: [{ ...command("session-end.mjs"), timeout: 30 }, { ...command("cost-capture.mjs"), timeout: 20 }] }],
    PreCompact: [{ hooks: [{ ...command("session-end.mjs", "--compact"), timeout: 30 }] }]
  };
  if (full) {
    hooks.PreToolUse.push({ matcher: "Edit|Write", hooks: [{ ...command("compact-advisor.mjs"), timeout: 5 }] });
    hooks.PostToolUse = [{ matcher: "Write|Edit|MultiEdit", hooks: [{ ...command("post-edit.mjs"), timeout: 30 }] }];
    hooks.SessionStart = [{ hooks: [{ ...command("session-start.mjs"), timeout: 10 }] }];
    hooks.Stop[0].hooks.push({ ...command("stop-check.mjs"), timeout: 30 });
  }
  return hooks;
}

/** The `.cursor/hooks.json` format this adapter writes by default. */
export const CURSOR_HOOKS_FORMAT_VERSION = 1;

/**
 * The Cursor hooks contract this adapter targets.
 *
 * `verified_on` is the date the document version, the event names, and the
 * blocking response shape below were reconstructed from secondary sources
 * (`sources`), not from a live Cursor or from cursor.com, which the sandbox this
 * ran in cannot reach. Confidence is not uniform, so `verification` records it
 * claim by claim: `"version": 1` and the deny shape are corroborated, the event
 * names are NOT. The published schema of the source package allows six events
 * (afterFileEdit, beforeMCPExecution, beforeReadFile, beforeShellExecution,
 * beforeSubmitPrompt, stop) with `additionalProperties: false`, and never
 * mentions sessionStart, sessionEnd or preCompact — the three this adapter
 * writes for session memory. Either that package lags Cursor 3.x, or those
 * three registrations are inert and Cursor-side session memory does not run.
 * Settle it against a real Cursor before trusting the memory story there.
 * When the format does move, add a builder to {@link CURSOR_HOOKS_BUILDERS} for
 * the new version and pin it here — do not rewrite the version-1 one, since
 * projects running an older Cursor still read what it writes.
 */
export const CURSOR_HOOKS_CONTRACT = {
  version: CURSOR_HOOKS_FORMAT_VERSION,
  verified_on: "2026-09-10",
  // Per claim, because the check could not reach Cursor itself:
  //   corroborated  - two independent secondary sources agree
  //   unverified    - asserted by the port this came from, contradicted or
  //                   simply absent in the sources that could be read
  verification: {
    version: "corroborated",
    deny_response: "corroborated",
    events: "unverified: sessionStart, sessionEnd and preCompact appear in no readable source; the cursor-hooks schema lists six events and forbids the rest",
    limits: "unverified: none of the readable sources state the first-entry-wins rule or the cloud-agent restriction"
  },
  sources: [
    "https://cursor.com/docs/hooks",
    "https://github.com/johnlindquist/cursor-hooks",
    "https://github.com/affaan-m/ECC/issues/2419"
  ],
  // Cursor event -> the Claude Code event the same script is registered on.
  events: {
    beforeShellExecution: "PreToolUse:Bash",
    afterFileEdit: "PostToolUse:Write|Edit|MultiEdit",
    // UNVERIFIED: absent from the cursor-hooks schema, which forbids unknown
    // keys. If Cursor really lacks them, session memory never runs there and
    // the capture belongs on `stop`, which is a documented event.
    sessionStart: "SessionStart",
    sessionEnd: "Stop (transcript capture)",
    preCompact: "PreCompact",
    stop: "Stop (open-work checks)"
  },
  // Only these answer with a permission decision; the rest are notifications
  // whose stdout Cursor ignores.
  blocking_events: ["beforeShellExecution"],
  deny_response: ["permission", "userMessage", "agentMessage"],
  limits: [
    "UNVERIFIED: Cursor is said to run the first entry registered for an event, so a foreign hook ahead of ours would shadow it. The warning this raises is cheap either way.",
    "Cursor has no before-write event in this format: the file guard (guard.mjs file) stays Claude Code only.",
    "Cursor payloads carry conversation_id, not transcript_path, so neither session-end nor cost-capture captures anything there until they do; cost-capture is registered for Claude Code only.",
    "UNVERIFIED: cloud agents are said to receive neither sessionStart/sessionEnd nor stop, leaving only command hooks."
  ]
};

function cursorHooksV1(profile) {
  const full = profile !== "minimal";
  const entry = (script, ...args) => ({ command: ["node", `${HOOKS_RELATIVE_DIR}/${script}`, ...args, "--cursor"].join(" ") });
  const hooks = {
    beforeShellExecution: [entry("guard.mjs", "bash")],
    sessionEnd: [entry("session-end.mjs")],
    preCompact: [entry("session-end.mjs", "--compact")]
  };
  if (full) {
    hooks.afterFileEdit = [entry("post-edit.mjs")];
    hooks.sessionStart = [entry("session-start.mjs")];
    hooks.stop = [entry("stop-check.mjs")];
  }
  return { version: 1, hooks };
}

/** One builder per `.cursor/hooks.json` format version. */
const CURSOR_HOOKS_BUILDERS = new Map([[1, cursorHooksV1]]);

export const CURSOR_HOOKS_FORMATS = [...CURSOR_HOOKS_BUILDERS.keys()];

/**
 * Cursor hook registrations for a profile, in a given `.cursor/hooks.json`
 * format version.
 *
 * @param {string} profile
 * @param {{ version?: number }} [options]
 * @returns {object}
 */
export function cursorHooksDocument(profile = "standard", { version = CURSOR_HOOKS_FORMAT_VERSION } = {}) {
  const build = CURSOR_HOOKS_BUILDERS.get(Number(version));
  if (!build) throw new Error(`Unknown .cursor/hooks.json format version: ${version}. Known: ${CURSOR_HOOKS_FORMATS.join(", ")}`);
  return build(HOOK_PROFILES.includes(profile) ? profile : "standard");
}

function isOurs(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
  return hooks.some((hook) => String(hook?.command || "").includes(COMMAND_MARKER));
}

/**
 * Merge our registrations into an existing Claude Code settings document:
 * previous AI Dev entries are replaced, everything else is preserved.
 *
 * @param {object} current - Existing settings.json content.
 * @param {Record<string, object[]>} entries - From {@link claudeHookEntries}.
 * @returns {object}
 */
export function mergeClaudeSettings(current, entries) {
  const document = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current) : {};
  const hooks = document.hooks && typeof document.hooks === "object" ? { ...document.hooks } : {};
  for (const event of Object.keys(hooks)) {
    if (Array.isArray(hooks[event])) hooks[event] = hooks[event].filter((entry) => !isOurs(entry));
    if (!hooks[event]?.length) delete hooks[event];
  }
  for (const [event, list] of Object.entries(entries)) {
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  document.hooks = hooks;
  return document;
}

/**
 * Merge our registrations into an existing Cursor hooks document. Foreign
 * entries keep their place; the document is stamped with the format version we
 * generated for, since that is what our entries speak.
 *
 * @param {object} current
 * @param {object} ours - From {@link cursorHooksDocument}.
 * @returns {object}
 */
export function mergeCursorHooks(current, ours) {
  const document = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current) : {};
  const hooks = document.hooks && typeof document.hooks === "object" ? { ...document.hooks } : {};
  for (const event of Object.keys(hooks)) {
    if (Array.isArray(hooks[event])) hooks[event] = hooks[event].filter((entry) => !isOurs(entry));
    if (!hooks[event]?.length) delete hooks[event];
  }
  for (const [event, list] of Object.entries(ours.hooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  return { ...document, version: ours.version || CURSOR_HOOKS_FORMAT_VERSION, hooks };
}

/**
 * What the merge could not decide for the user: a document written for another
 * format version, and events where a foreign hook runs ahead of ours (Cursor
 * runs the first entry of an event, so that one shadows the guard).
 *
 * @param {object | null} current
 * @param {object} ours - From {@link cursorHooksDocument}.
 * @returns {string[]}
 */
export function cursorHookWarnings(current, ours) {
  const warnings = [];
  const declared = Number(current?.version);
  if (Number.isFinite(declared) && declared !== ours.version) {
    warnings.push(`.cursor/hooks.json declared format version ${declared}; the installed entries use version ${ours.version}. Re-check Cursor's hooks reference before trusting the merged file.`);
  }
  for (const event of Object.keys(ours.hooks)) {
    const foreign = (Array.isArray(current?.hooks?.[event]) ? current.hooks[event] : []).filter((entry) => !isOurs(entry));
    if (foreign.length) {
      warnings.push(`.cursor/hooks.json: ${event} already lists ${foreign.length} foreign hook(s) before ours. Cursor runs the first entry of an event, so reorder by hand if the AI Dev hook must run.`);
    }
  }
  return warnings;
}

/**
 * The stub git runs. It is three lines of `sh` rather than a Node script so the
 * shebang question never comes up: Git for Windows runs hooks through its own
 * shell, and `node` is looked up on PATH exactly as it is on a Unix box. The
 * path to the implementation is relative to the stub, so moving or cloning the
 * repository keeps it working.
 *
 * @param {string} hook - `pre-commit` or `pre-push`.
 * @returns {string}
 */
export function gitHookStub(hook) {
  return [
    "#!/bin/sh",
    "# Installed by ai-dev-system (install_agent_hooks, targets: [\"git\"]).",
    "# Delete .ai-dev/git-hooks or unset core.hooksPath to remove it.",
    `exec node "$(dirname "$0")/../hooks/git-hooks.mjs" ${hook} "$@"`,
    ""
  ].join("\n");
}

async function git(projectRoot, args) {
  try {
    return await runProcess({ executable: "git", args: ["-C", projectRoot, ...args], cwd: projectRoot, timeoutMs: 15_000 });
  } catch {
    return { ok: false, exitCode: null, stdout: "", stderr: "" };
  }
}

/**
 * Hooks that will stop running once `core.hooksPath` moves: git consults one
 * directory, so an active `.git/hooks/pre-commit` is silently replaced rather
 * than chained. We install anyway and name them — chaining would bake an
 * absolute path into the stub, and a hook that only sometimes runs is worse
 * than one the user was told about.
 *
 * @param {string} projectRoot
 * @returns {Promise<string[]>}
 */
async function shadowedGitHooks(projectRoot) {
  const result = await git(projectRoot, ["rev-parse", "--git-path", "hooks"]);
  if (!result.ok) return [];
  const directory = path.resolve(projectRoot, result.stdout.trim());
  const names = await fs.readdir(directory).catch(() => []);
  return names.filter((name) => !name.endsWith(".sample"));
}

async function readJson(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot parse ${target}: ${error.message}`);
  }
}

async function readText(target) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Install the hook scripts, patterns, policy, and harness registrations into
 * a repository.
 *
 * @param {{ projectRoot: string, hooksSourceDir: string, targets?: string[], profile?: string, overwrite?: boolean, dryRun?: boolean, cursorFormatVersion?: number }} input
 * @returns {Promise<{ profile: string, targets: string[], written: string[], updated: string[], skipped: string[], planned: string[], backups: string[], warnings: string[], cursor_format_version: number }>}
 */
export async function installAgentHooks({ projectRoot, hooksSourceDir, targets = ["claude"], profile = "standard", overwrite = false, dryRun = false, cursorFormatVersion = CURSOR_HOOKS_FORMAT_VERSION }) {
  if (!HOOK_PROFILES.includes(profile)) throw new Error(`Unknown hook profile: ${profile}. Known: ${HOOK_PROFILES.join(", ")}`);
  for (const target of targets) {
    if (!HOOK_TARGETS.includes(target)) throw new Error(`Unknown hooks target: ${target}. Known: ${HOOK_TARGETS.join(", ")}`);
  }
  const root = path.resolve(projectRoot);
  const written = [];
  const updated = [];
  const skipped = [];
  const planned = [];
  const backups = [];
  const warnings = [];

  async function writeManaged(relativePath, content) {
    const absolute = path.join(root, ...relativePath.split("/"));
    const current = await readText(absolute);
    if (current === content) {
      skipped.push(`${relativePath} (current)`);
      return;
    }
    if (dryRun) {
      planned.push(relativePath);
      return;
    }
    await atomicWriteFile(absolute, content, "utf8");
    (current === null ? written : updated).push(relativePath);
  }

  for (const name of HOOK_FILES) {
    const source = await fs.readFile(path.join(hooksSourceDir, name), "utf8");
    await writeManaged(`${HOOKS_RELATIVE_DIR}/${name}`, source);
  }
  await writeManaged(`${HOOKS_RELATIVE_DIR}/patterns.json`, `${JSON.stringify(renderHookPatterns(), null, 2)}\n`);

  const policyPath = path.join(root, ...POLICY_RELATIVE_PATH.split("/"));
  const existingPolicy = await readText(policyPath);
  if (existingPolicy === null || overwrite) {
    await writeManaged(POLICY_RELATIVE_PATH, `${JSON.stringify(defaultPolicy(profile), null, 2)}\n`);
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(existingPolicy);
    } catch {
      skipped.push(`${POLICY_RELATIVE_PATH} (exists but is not valid JSON; fix it by hand)`);
    }
    if (parsed && parsed.profile !== profile) {
      await writeManaged(POLICY_RELATIVE_PATH, `${JSON.stringify({ ...parsed, profile }, null, 2)}\n`);
    } else if (parsed) {
      skipped.push(`${POLICY_RELATIVE_PATH} (kept)`);
    }
  }

  if (targets.includes("claude")) {
    const settingsPath = path.join(root, ".claude", "settings.json");
    const current = await readJson(settingsPath);
    const next = mergeClaudeSettings(current, claudeHookEntries(profile));
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    const currentText = current === null ? null : await readText(settingsPath);
    if (currentText === nextText) {
      skipped.push(".claude/settings.json (current)");
    } else if (dryRun) {
      planned.push(".claude/settings.json");
    } else {
      if (currentText !== null) {
        const backup = `${settingsPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await fs.copyFile(settingsPath, backup);
        backups.push(path.relative(root, backup).replaceAll("\\", "/"));
      }
      await atomicWriteFile(settingsPath, nextText, "utf8");
      (currentText === null ? written : updated).push(".claude/settings.json");
    }
  }

  if (targets.includes("git")) {
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      warnings.push("targets included \"git\" but this is not a Git working tree; no git hooks were installed.");
    } else {
      const configured = (await git(root, ["config", "--get", "core.hooksPath"])).stdout.trim();
      const foreign = configured && configured !== GIT_HOOKS_RELATIVE_DIR;
      if (!foreign) warnings.push(...(await shadowedGitHooks(root)).map((name) => (
        `.git/hooks/${name} will stop running: git consults one hooks directory, and core.hooksPath now points at ${GIT_HOOKS_RELATIVE_DIR}. Move it there to keep it.`
      )));
      for (const hook of GIT_HOOK_NAMES) {
        const relativePath = `${GIT_HOOKS_RELATIVE_DIR}/${hook}`;
        await writeManaged(relativePath, gitHookStub(hook));
        // Re-applied every time: a stub whose content is current may still have
        // lost its executable bit to a checkout, an unzip, or a copy.
        if (!dryRun) await fs.chmod(path.join(root, ...relativePath.split("/")), 0o755).catch(() => undefined);
      }
      if (foreign) {
        warnings.push(`core.hooksPath already points at ${configured}; it was left alone. Point it at ${GIT_HOOKS_RELATIVE_DIR}, or copy the two stubs there, to run these hooks.`);
      } else if (dryRun) {
        planned.push(`git config core.hooksPath ${GIT_HOOKS_RELATIVE_DIR}`);
      } else if (configured !== GIT_HOOKS_RELATIVE_DIR) {
        const set = await git(root, ["config", "core.hooksPath", GIT_HOOKS_RELATIVE_DIR]);
        if (set.ok) updated.push(`git config core.hooksPath ${GIT_HOOKS_RELATIVE_DIR}`);
        else warnings.push(`Could not set core.hooksPath: ${(set.stderr || "git config failed").trim()}`);
      }
    }
  }

  if (targets.includes("cursor")) {
    const cursorPath = path.join(root, ".cursor", "hooks.json");
    const current = await readJson(cursorPath);
    const ours = cursorHooksDocument(profile, { version: cursorFormatVersion });
    warnings.push(...cursorHookWarnings(current, ours));
    await writeManaged(".cursor/hooks.json", `${JSON.stringify(mergeCursorHooks(current, ours), null, 2)}\n`);
  }

  return { profile, targets, written, updated, skipped, planned, backups, warnings, cursor_format_version: Number(cursorFormatVersion) };
}

/**
 * Report what is installed.
 *
 * @param {string} projectRoot
 * @returns {Promise<object>}
 */
export async function agentHooksStatus(projectRoot) {
  const root = path.resolve(projectRoot);
  const files = {};
  for (const name of [...HOOK_FILES, "patterns.json"]) {
    files[name] = await readText(path.join(root, ".ai-dev", "hooks", name)) !== null;
  }
  const policyText = await readText(path.join(root, ".ai-dev", "policy.json"));
  let policy = null;
  try {
    policy = policyText ? JSON.parse(policyText) : null;
  } catch {
    policy = { error: "policy.json is not valid JSON" };
  }
  const hooksPath = (await git(root, ["config", "--get", "core.hooksPath"])).stdout.trim();
  const gitHooks = {};
  for (const hook of GIT_HOOK_NAMES) {
    gitHooks[hook] = await readText(path.join(root, ...GIT_HOOKS_RELATIVE_DIR.split("/"), hook)) !== null;
  }
  const claude = await readJson(path.join(root, ".claude", "settings.json")).catch(() => null);
  const cursor = await readJson(path.join(root, ".cursor", "hooks.json")).catch(() => null);
  const count = (document) => Object.values(document?.hooks ?? {}).flat().filter(isOurs).length;
  const cursorVersion = cursor === null ? null : Number(cursor?.version) || null;
  return {
    project_path: root,
    hooks_dir: HOOKS_RELATIVE_DIR,
    files,
    installed: Object.values(files).every(Boolean),
    profile: policy?.profile ?? null,
    policy_rules: Array.isArray(policy?.rules) ? policy.rules.length : 0,
    git_hooks: gitHooks,
    git_hooks_dir: GIT_HOOKS_RELATIVE_DIR,
    // Installed *and* reachable: stubs git is not pointed at never run.
    git_hooks_active: Object.values(gitHooks).every(Boolean) && hooksPath === GIT_HOOKS_RELATIVE_DIR,
    core_hooks_path: hooksPath,
    claude_entries: count(claude),
    cursor_entries: count(cursor),
    cursor_format_version: cursorVersion,
    // A file written for a format this adapter does not build is the signal to
    // add a builder, not to overwrite it.
    cursor_format_supported: cursorVersion === null ? null : CURSOR_HOOKS_FORMATS.includes(cursorVersion),
    cursor_contract: CURSOR_HOOKS_CONTRACT
  };
}
