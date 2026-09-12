/**
 * The rules block of `.ai-dev/policy.json`, edited without hand-writing JSON.
 *
 * The installed guard (`hooks/guard.mjs`) reads the block on every Bash command
 * and every file write: each rule is `{ id, event, pattern, action, message }`,
 * the pattern is compiled case-insensitively, and a match either warns or blocks
 * the tool call. Nothing validates the block — a pattern that does not compile,
 * an event the guard never evaluates, or an `action` it does not know are all
 * skipped or downgraded in silence, so a rule someone wrote by hand can sit in
 * the file for months doing nothing.
 *
 * These functions are the writing end of that file. Every rule is checked
 * against what the guard actually does with it, and a new rule has to fire on an
 * example the caller provides: a rule nobody proved fires is the failure mode
 * this module exists to prevent. The example is stored with the rule, so
 * {@link listPolicyRules} can re-run it later and catch a pattern that stopped
 * matching after a hand edit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { POLICY_RELATIVE_PATH, defaultPolicy } from "./agent-hooks.mjs";
import { atomicWriteFile } from "./atomic-files.mjs";
import { findSecretsInLine } from "./change-hygiene.mjs";
import { DEFAULT_MATCH_BUDGET_MS, DEFAULT_MATCH_DEADLINE_MS, matchWithBudget, riskyPatternProbes } from "./regex-budget.mjs";

/** Hook events `guard.mjs` evaluates rules for. `all` fires on both. */
export const POLICY_RULE_EVENTS = ["bash", "file", "all"];

/** What a match does. The guard treats every action other than `block` as a warning. */
export const POLICY_RULE_ACTIONS = ["warn", "block"];

/** Flags `compileRegex` in `hooks/lib.mjs` compiles a rule pattern with. */
export const POLICY_RULE_REGEX_FLAGS = "i";

/** Fields {@link upsertPolicyRule} accepts. Anything else would be ignored by the guard. */
export const POLICY_RULE_FIELDS = Object.freeze([
  "id", "event", "pattern", "action", "message", "enabled", "example", "example_path", "counter_example"
]);

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const MAX_PATTERN_LENGTH = 400;
const MAX_EXAMPLE_LENGTH = 4000;

// A quantified group that itself contains an unbounded quantifier — `(a+)+`,
// `(\s*x)*`, `(ab{2,})+`. On input that almost matches, the two quantifiers
// multiply and the match takes exponential time: in the guard that stalls every
// file write until the client kills the hook, and here it would stall the
// server on the example. The check is deliberately conservative and runs after
// escapes and character classes are folded away, so `(a\+b)+` and `([+*]a)+`
// are not mistaken for it.
const NESTED_QUANTIFIER = /\([^()]*(?:[*+]|\{\d+,\})[^()]*\)\s*(?:[*+]|\{\d+,\})/;

/**
 * Compile a rule pattern the way the installed guard compiles it.
 *
 * @param {string} source
 * @returns {RegExp | null} `null` when the pattern does not compile.
 */
export function compilePolicyPattern(source) {
  try {
    return new RegExp(String(source ?? ""), POLICY_RULE_REGEX_FLAGS);
  } catch {
    return null;
  }
}

function hasNestedQuantifier(source) {
  const folded = String(source ?? "").replace(/\\./g, "x").replace(/\[[^\]]*\]/g, "C");
  return NESTED_QUANTIFIER.test(folded);
}

/**
 * The text the guard matches a rule against: the raw command on a Bash call,
 * the file path and the new content on a write.
 *
 * @param {string} hookEvent - `bash` or `file`.
 * @param {{ text?: string, file_path?: string }} sample
 * @returns {string}
 */
export function policyHaystack(hookEvent, { text = "", file_path: filePath = "" } = {}) {
  return hookEvent === "file" ? `${filePath}\n${text}` : String(text ?? "");
}

/** Which hook event an example exercises: a rule for both is checked as a write when it names a path. */
function sampleEvent(rule) {
  if (rule.event === "file") return "file";
  if (rule.event === "all") return rule.example_path ? "file" : "bash";
  return "bash";
}

/**
 * Everything that stops a rule from working as written. An empty list means the
 * guard will evaluate the rule exactly as the author meant it.
 *
 * @param {object} rule
 * @returns {string[]}
 */
export function policyRuleProblems(rule) {
  const problems = [];
  const id = String(rule?.id ?? "").trim();
  if (!id) {
    problems.push("No id: the guard reports the match as [policy:rule] and no tool can update or remove it.");
  } else if (!RULE_ID_PATTERN.test(id)) {
    problems.push(`Id "${id}" is not a slug: use 3-50 lowercase letters, digits and dashes, as in "block-prod-migrations".`);
  }
  const event = String(rule?.event ?? "");
  if (!POLICY_RULE_EVENTS.includes(event)) {
    problems.push(`Event "${event}" is never evaluated: the guard runs rules for ${POLICY_RULE_EVENTS.join(", ")}.`);
  }
  const action = String(rule?.action ?? "");
  if (!POLICY_RULE_ACTIONS.includes(action)) {
    problems.push(`Action "${action}" is not one of ${POLICY_RULE_ACTIONS.join(", ")}; the guard treats everything but "block" as a warning.`);
  }
  const pattern = String(rule?.pattern ?? "");
  if (!pattern) {
    problems.push("No pattern: the rule matches nothing.");
  } else if (pattern.length > MAX_PATTERN_LENGTH) {
    problems.push(`Pattern is ${pattern.length} characters; keep it under ${MAX_PATTERN_LENGTH} so the guard stays fast and the rule stays readable.`);
  } else if (!compilePolicyPattern(pattern)) {
    problems.push(`Pattern does not compile as a regular expression: ${compileError(pattern)}`);
  } else if (hasNestedQuantifier(pattern)) {
    problems.push("Pattern nests an unbounded quantifier inside a quantified group, as in (a+)+: on a long line that backtracks exponentially and stalls the guard. Bound the inner quantifier or drop the outer one.");
  }
  if (rule?.enabled !== undefined && typeof rule.enabled !== "boolean") {
    problems.push("Field \"enabled\" must be a boolean; the guard skips a rule only when it is exactly false.");
  }
  for (const field of ["example", "example_path", "counter_example", "message"]) {
    if (rule?.[field] !== undefined && typeof rule[field] !== "string") problems.push(`Field "${field}" must be a string.`);
  }
  if (typeof rule?.example === "string" && rule.example.length > MAX_EXAMPLE_LENGTH) {
    problems.push(`Example is ${rule.example.length} characters; keep it under ${MAX_EXAMPLE_LENGTH}.`);
  }
  return problems;
}

function compileError(pattern) {
  try {
    new RegExp(String(pattern), POLICY_RULE_REGEX_FLAGS);
    return "";
  } catch (error) {
    return error.message;
  }
}

/**
 * Run the rules against the samples stored with them, under a time budget.
 *
 * The budget is the point. A pattern that backtracks catastrophically cannot be
 * interrupted in this thread (Node has no such switch), so every match runs in
 * a worker that is killed when it overstays — see `regex-budget.mjs` and
 * docs/ecc-upgrades/DEBTS.md, Д-16. One worker serves the whole batch, so
 * listing a policy costs one thread, not one per rule.
 *
 * The batch also has a deadline, so a policy full of slow rules cannot make
 * this listing cost the sum of their budgets (Д-22). A rule the deadline cut
 * off comes back `not_checked`, which reads differently from "matched nothing".
 *
 * @param {object[]} rules
 * @returns {Promise<Array<{ fires_on_example: boolean | null, counter_example_matches: boolean | null, checked_as: string, timed_out: boolean, not_checked: boolean }>>}
 */
export async function verifyPolicyRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const jobs = [];
  const plan = list.map((rule) => {
    const event = sampleEvent(rule ?? {});
    const pattern = String(rule?.pattern ?? "");
    const compiles = Boolean(compilePolicyPattern(pattern));
    const slot = { checked_as: event, example: -1, counter: -1 };
    for (const [field, key] of [["example", "example"], ["counter_example", "counter"]]) {
      const value = typeof rule?.[field] === "string" ? rule[field].slice(0, MAX_EXAMPLE_LENGTH) : "";
      if (!compiles || !value) continue;
      slot[key] = jobs.length;
      jobs.push({ pattern, flags: POLICY_RULE_REGEX_FLAGS, haystack: policyHaystack(event, { text: value, file_path: rule?.example_path }) });
    }
    return slot;
  });
  const answers = await matchWithBudget(jobs);
  const read = (index) => (index === -1 ? null : answers[index]);
  return plan.map((slot) => {
    const example = read(slot.example);
    const counter = read(slot.counter);
    return {
      checked_as: slot.checked_as,
      fires_on_example: example ? example.matched : null,
      counter_example_matches: counter ? counter.matched : null,
      timed_out: Boolean(example?.timed_out || counter?.timed_out),
      not_checked: Boolean(example?.checked === false || counter?.checked === false)
    };
  });
}

/**
 * Run one rule against the samples stored with it.
 *
 * @param {object} rule
 * @returns {Promise<{ fires_on_example: boolean | null, counter_example_matches: boolean | null, checked_as: string, timed_out: boolean, not_checked: boolean }>}
 */
export async function verifyPolicyRule(rule) {
  const [verification] = await verifyPolicyRules([rule ?? {}]);
  return verification;
}

// The problems a verification adds on top of the structural ones.
function verificationProblems(verification) {
  const problems = [];
  if (verification.timed_out) {
    problems.push(`Matching this pattern against its own sample did not finish within ${DEFAULT_MATCH_BUDGET_MS} ms: it backtracks catastrophically, and the guard — which runs it on every Bash command and every file write — will abandon it instead of answering. Bound the quantifiers; a quantified group whose branches overlap, as in (a|a)+, is the usual cause.`);
  }
  if (verification.not_checked) {
    problems.push(`This rule was never matched against its sample: the ${DEFAULT_MATCH_DEADLINE_MS} ms this listing gets for all rules together ran out on the rules before it. Those rules are the ones to fix; until then nothing here says whether this one still works.`);
  }
  if (verification.fires_on_example === false) {
    problems.push("The example stored with the rule no longer matches: the pattern was narrowed, or the example was edited.");
  }
  if (verification.counter_example_matches === true) {
    problems.push("The counter-example stored with the rule now matches: the pattern grew broader than it was meant to be.");
  }
  return problems;
}

// One rule as a report, given a verification that was already run.
function describeVerifiedRule(rule, verification) {
  const enabled = rule?.enabled !== false;
  return {
    id: String(rule?.id ?? ""),
    event: String(rule?.event ?? ""),
    action: String(rule?.action ?? ""),
    effective_action: enabled ? (rule?.action === "block" ? "block" : "warn") : "none",
    enabled,
    pattern: String(rule?.pattern ?? ""),
    message: String(rule?.message ?? ""),
    example: typeof rule?.example === "string" ? rule.example : "",
    example_path: typeof rule?.example_path === "string" ? rule.example_path : "",
    counter_example: typeof rule?.counter_example === "string" ? rule.counter_example : "",
    fires_on_example: verification.fires_on_example,
    match_timed_out: verification.timed_out,
    match_not_checked: verification.not_checked,
    problems: [...policyRuleProblems(rule), ...verificationProblems(verification)]
  };
}

/**
 * Every rule as a report: what the guard would do with it, and what is wrong
 * with it. `effective_action` is the guard's reading, which is `warn` for every
 * action it does not recognise.
 *
 * @param {object[]} rules
 * @returns {Promise<object[]>}
 */
export async function describePolicyRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const verifications = await verifyPolicyRules(list);
  return list.map((rule, index) => describeVerifiedRule(rule, verifications[index]));
}

/**
 * One rule as a report. {@link describePolicyRules} is the same thing for a
 * whole policy, on one worker instead of one per rule.
 *
 * @param {object} rule
 * @returns {Promise<object>}
 */
export async function describePolicyRule(rule) {
  const [described] = await describePolicyRules([rule ?? {}]);
  return described;
}

function policyPathOf(projectRoot) {
  return path.join(path.resolve(projectRoot), ...POLICY_RELATIVE_PATH.split("/"));
}

async function readPolicyDocument(policyPath) {
  let text;
  try {
    text = await fs.readFile(policyPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, policy: null, error: "" };
    throw error;
  }
  try {
    const policy = JSON.parse(text);
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      return { exists: true, policy: null, error: `${POLICY_RELATIVE_PATH} is not a JSON object.` };
    }
    return { exists: true, policy, error: "" };
  } catch (error) {
    return { exists: true, policy: null, error: `${POLICY_RELATIVE_PATH} is not valid JSON: ${error.message}` };
  }
}

async function writePolicyDocument(policyPath, document) {
  await atomicWriteFile(policyPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/**
 * Every rule in a project's policy, with the guard's reading of it.
 *
 * @param {string} projectRoot
 * @returns {Promise<object>}
 */
export async function listPolicyRules(projectRoot) {
  const root = path.resolve(projectRoot);
  const policyPath = policyPathOf(root);
  const { exists, policy, error } = await readPolicyDocument(policyPath);
  const problems = error ? [error] : [];
  if (!exists) problems.push(`${POLICY_RELATIVE_PATH} does not exist; install_agent_hooks writes it with the default rules.`);
  if (policy && !Array.isArray(policy.rules)) problems.push(`${POLICY_RELATIVE_PATH} has no "rules" array, so the guard evaluates no project rules.`);
  const rules = await describePolicyRules(Array.isArray(policy?.rules) ? policy.rules : []);
  const enabled = rules.filter((rule) => rule.enabled);
  return {
    project_path: root,
    policy_path: POLICY_RELATIVE_PATH,
    exists,
    profile: typeof policy?.profile === "string" ? policy.profile : null,
    rules,
    problems,
    counts: {
      total: rules.length,
      enabled: enabled.length,
      blocking: enabled.filter((rule) => rule.effective_action === "block").length,
      warning: enabled.filter((rule) => rule.effective_action === "warn").length,
      broken: rules.filter((rule) => rule.problems.length > 0).length
    }
  };
}

function normalizeRuleInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("rule must be an object.");
  const unknown = Object.keys(input).filter((key) => !POLICY_RULE_FIELDS.includes(key));
  if (unknown.length) {
    throw new Error(`The guard ignores these rule fields, so writing them would be a rule that does nothing: ${unknown.join(", ")}. Supported: ${POLICY_RULE_FIELDS.join(", ")}.`);
  }
  const patch = {};
  for (const field of POLICY_RULE_FIELDS) {
    if (input[field] !== undefined) patch[field] = field === "enabled" ? input[field] : String(input[field]);
  }
  patch.id = String(input.id ?? "").trim();
  if (!patch.id) throw new Error("rule.id is required: it names the rule in the guard's message and in remove_policy_rule.");
  return patch;
}

/** The pattern two rules would both match on the same event. */
function collides(left, right) {
  const samePattern = String(left?.pattern ?? "") === String(right?.pattern ?? "");
  const sameEvent = left?.event === right?.event || left?.event === "all" || right?.event === "all";
  return samePattern && sameEvent;
}

function changedFields(previous, next) {
  if (!previous) return Object.keys(next);
  return Object.keys(next).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

/**
 * Add a rule, or update the one that already carries the id. An update is a
 * patch: fields the caller leaves out keep their current value, so
 * `{ id, enabled: false }` disables a rule without restating it.
 *
 * A new rule — and any change to an existing pattern or event — has to come with
 * an `example` the rule matches. The example is stored on the rule.
 *
 * @param {{ projectRoot: string, rule: object, dryRun?: boolean }} input
 * @returns {Promise<object>}
 */
export async function upsertPolicyRule({ projectRoot, rule, dryRun = false }) {
  const root = path.resolve(projectRoot);
  const policyPath = policyPathOf(root);
  const { exists, policy, error } = await readPolicyDocument(policyPath);
  if (error) throw new Error(`${error} Fix the file by hand before adding rules to it.`);
  const document = exists ? policy : defaultPolicy();
  const rules = Array.isArray(document.rules) ? [...document.rules] : [];
  const patch = normalizeRuleInput(rule);
  const index = rules.findIndex((entry) => String(entry?.id ?? "") === patch.id);
  const previous = index === -1 ? null : rules[index];
  if (!previous) {
    const missing = ["event", "action", "pattern", "message"].filter((field) => !String(patch[field] ?? "").trim());
    if (missing.length) {
      throw new Error(`A new rule needs ${missing.join(", ")}. There is no default: a rule filed under the wrong event never fires, and one with no message fires without saying why.`);
    }
  }
  const merged = previous ? { ...previous, ...patch } : { enabled: true, ...patch };

  const problems = policyRuleProblems(merged);
  if (!String(merged.message ?? "").trim()) {
    problems.push("No message: the guard prints it when the rule fires, and an agent that cannot read the reason cannot act on it.");
  }
  if (problems.length) throw new Error(`Rule "${merged.id}" would not work as written:\n- ${problems.join("\n- ")}`);

  // The example a rule ships with says whether the rule fires; it says nothing
  // about what the rule costs on input that *almost* matches, which is where
  // backtracking explodes. So the pattern is also run against input built from
  // its own alphabet, under the same budget the guard uses. `(a|a)+$` matches
  // "aaa" in microseconds and needs 38.8 seconds for twenty-eight characters
  // and a tail (docs/ecc-upgrades/DEBTS.md, Д-16): the probe is what separates
  // the two, and it needs no list of shapes to recognise.
  if (String(merged.pattern ?? "")) {
    const probes = riskyPatternProbes(merged.pattern);
    const costs = await matchWithBudget(probes.map((haystack) => ({ pattern: merged.pattern, flags: POLICY_RULE_REGEX_FLAGS, haystack })));
    const overrun = costs.findIndex((cost) => cost.timed_out);
    if (overrun !== -1) {
      throw new Error(`Rule "${merged.id}" backtracks catastrophically: matching its pattern against ${probes[overrun].length} characters built from the pattern's own alphabet did not finish within ${DEFAULT_MATCH_BUDGET_MS} ms. The guard runs this pattern on every Bash command and every file write, so one rule like this takes the whole hook pack out of service. Bound the quantifiers; a quantified group whose branches overlap, as in (a|a)+, is the usual cause.`);
    }
  }

  const duplicate = rules.find((entry, position) => position !== index && collides(entry, merged));
  if (duplicate) {
    throw new Error(`Rule "${duplicate.id}" already carries this pattern for the ${duplicate.event} event. Update that rule instead of adding a second one that fires on the same text.`);
  }

  const patternChanged = !previous || previous.pattern !== merged.pattern || previous.event !== merged.event;
  if (patternChanged && !String(merged.example ?? "").trim()) {
    throw new Error(`Rule "${merged.id}" needs an example: pass rule.example with a snippet the pattern must match (for a file rule, rule.example_path names the path it applies to). A rule nobody proved fires is a rule that silently does nothing.`);
  }
  const verification = await verifyPolicyRule(merged);
  if (verification.timed_out) {
    throw new Error(`Rule "${merged.id}" backtracks catastrophically on its own example: the match did not finish within ${DEFAULT_MATCH_BUDGET_MS} ms. The guard runs this pattern on every Bash command and every file write, so a rule like this one takes the whole hook pack out of service. Bound the quantifiers; a quantified group whose branches overlap, as in (a|a)+, is the usual cause.`);
  }
  if (verification.fires_on_example === false) {
    throw new Error(`Rule "${merged.id}" does not match its own example. The guard matches ${verification.checked_as === "file" ? "the file path, a newline, then the new content" : "the whole command line"} case-insensitively; check the escaping in the pattern.`);
  }
  if (verification.counter_example_matches === true) {
    throw new Error(`Rule "${merged.id}" also matches its counter-example, so it is broader than intended.`);
  }

  // The samples are stored on the rule, and the rule is committed. A caller
  // writing a rule *about* credentials may need a credential-shaped example, so
  // this is said rather than refused — but it is said.
  const warnings = [];
  for (const [field, value] of [["example", merged.example], ["counter_example", merged.counter_example]]) {
    const hits = findSecretsInLine(String(value ?? ""));
    if (hits.length) {
      warnings.push(`rule.${field} looks like a real ${hits[0].id.replaceAll("_", " ")} (${hits[0].masked}), and it is stored in ${POLICY_RELATIVE_PATH}, which is committed. Use a synthetic value, and rotate that one if it was ever real.`);
    }
  }

  const changed = changedFields(previous, merged);
  if (previous && changed.length === 0) {
    return {
      action: "unchanged", policy_path: POLICY_RELATIVE_PATH, created_policy: false, dry_run: Boolean(dryRun),
      rule: await describePolicyRule(merged), verification, warnings, changed_fields: [], rules_total: rules.length
    };
  }
  if (previous) rules[index] = merged;
  else rules.push(merged);
  if (!dryRun) await writePolicyDocument(policyPath, { ...document, rules });
  return {
    action: previous ? "updated" : "created",
    policy_path: POLICY_RELATIVE_PATH,
    created_policy: !exists && !dryRun,
    dry_run: Boolean(dryRun),
    rule: await describePolicyRule(merged),
    verification,
    warnings,
    changed_fields: changed,
    rules_total: rules.length
  };
}

/**
 * Remove a rule by id.
 *
 * @param {{ projectRoot: string, id: string }} input
 * @returns {Promise<object>}
 */
export async function removePolicyRule({ projectRoot, id }) {
  const root = path.resolve(projectRoot);
  const policyPath = policyPathOf(root);
  const { exists, policy, error } = await readPolicyDocument(policyPath);
  if (error) throw new Error(`${error} Fix the file by hand before removing rules from it.`);
  if (!exists) throw new Error(`${POLICY_RELATIVE_PATH} does not exist in ${root}; there is nothing to remove.`);
  const rules = Array.isArray(policy.rules) ? [...policy.rules] : [];
  const wanted = String(id ?? "").trim();
  const index = rules.findIndex((entry) => String(entry?.id ?? "") === wanted);
  if (index === -1) {
    const known = rules.map((entry) => String(entry?.id ?? "")).filter(Boolean);
    throw new Error(`No rule with id "${wanted}". ${known.length ? `Known rules: ${known.join(", ")}.` : "The policy has no rules."}`);
  }
  const [removed] = rules.splice(index, 1);
  await writePolicyDocument(policyPath, { ...policy, rules });
  return {
    action: "removed",
    policy_path: POLICY_RELATIVE_PATH,
    rule: await describePolicyRule(removed),
    rules_total: rules.length
  };
}
