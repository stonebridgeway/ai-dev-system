import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultPolicy, installAgentHooks } from "./agent-hooks.mjs";
import {
  compilePolicyPattern,
  describePolicyRule,
  listPolicyRules,
  policyHaystack,
  policyRuleProblems,
  removePolicyRule,
  upsertPolicyRule,
  verifyPolicyRule
} from "./policy-rules.mjs";
import { DEFAULT_MATCH_BUDGET_MS } from "./regex-budget.mjs";

async function tempProject(t, policy) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-rules-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  if (policy !== undefined) {
    await fs.mkdir(path.join(root, ".ai-dev"), { recursive: true });
    await fs.writeFile(path.join(root, ".ai-dev", "policy.json"), typeof policy === "string" ? policy : `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  }
  return root;
}

async function readPolicy(root) {
  return JSON.parse(await fs.readFile(path.join(root, ".ai-dev", "policy.json"), "utf8"));
}

const RULE = {
  id: "block-force-push",
  event: "bash",
  pattern: "git\\s+push\\s+(?:[^|;]*\\s)?--force(?!-with-lease)",
  action: "block",
  message: "Force-pushing rewrites shared history; use --force-with-lease.",
  example: "git push --force origin main",
  counter_example: "git push --force-with-lease origin main"
};

test("a new rule is written with its example, and reported back with the guard's reading of it", async (t) => {
  const root = await tempProject(t, defaultPolicy("strict"));
  const result = await upsertPolicyRule({ projectRoot: root, rule: RULE });
  assert.equal(result.action, "created");
  assert.equal(result.created_policy, false);
  assert.equal(result.rule.effective_action, "block");
  assert.equal(result.verification.fires_on_example, true);
  assert.equal(result.verification.counter_example_matches, false);
  assert.deepEqual(result.warnings, []);

  const stored = await readPolicy(root);
  assert.equal(stored.profile, "strict", "the rest of the policy document is preserved");
  const written = stored.rules.at(-1);
  assert.equal(written.id, "block-force-push");
  assert.equal(written.enabled, true);
  assert.equal(written.example, RULE.example, "the example is stored so it can be re-checked later");

  const listed = await listPolicyRules(root);
  assert.equal(listed.counts.total, defaultPolicy().rules.length + 1);
  assert.equal(listed.counts.broken, 0);
  assert.equal(listed.counts.blocking, 2);
  assert.deepEqual(listed.rules.at(-1).problems, []);
  assert.equal(listed.rules.at(-1).fires_on_example, true);
});

test("an example that carries a real credential is written with a warning, not refused", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  const result = await upsertPolicyRule({
    projectRoot: root,
    rule: {
      id: "block-aws-keys",
      event: "file",
      pattern: "AKIA[A-Z0-9]{16}",
      action: "block",
      message: "Load AWS credentials from the environment.",
      // A rule about credentials needs a credential-shaped example, so this is
      // built the way the rest of the suite builds one.
      example: `const key = "${["AKIA", "Q".repeat(16)].join("")}";`
    }
  });
  assert.equal(result.action, "created");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /rule\.example looks like a real aws access key/);
  assert.match(result.warnings[0], /rotate that one if it was ever real/);
  assert.deepEqual((await upsertPolicyRule({ projectRoot: root, rule: { id: "block-aws-keys", enabled: false } })).warnings.length, 1);
});

test("policy.json is created from the defaults when the project has none", async (t) => {
  const root = await tempProject(t);
  const result = await upsertPolicyRule({ projectRoot: root, rule: RULE });
  assert.equal(result.created_policy, true);
  const stored = await readPolicy(root);
  assert.equal(stored.profile, "standard");
  assert.equal(stored.rules.length, defaultPolicy().rules.length + 1);
  assert.equal(stored.completion_claims.enabled, true, "the default policy block comes with it");
});

test("an update is a patch: enabled: false disables a rule without restating it", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  await upsertPolicyRule({ projectRoot: root, rule: RULE });
  const disabled = await upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, enabled: false } });
  assert.equal(disabled.action, "updated");
  assert.deepEqual(disabled.changed_fields, ["enabled"]);
  assert.equal(disabled.rule.effective_action, "none");
  const stored = await readPolicy(root);
  assert.equal(stored.rules.at(-1).pattern, RULE.pattern, "the pattern survives the patch");
  assert.equal(stored.rules.at(-1).example, RULE.example);

  const again = await upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, enabled: false } });
  assert.equal(again.action, "unchanged");
  assert.deepEqual(again.changed_fields, []);

  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, message: "   " } }),
    /No message/,
    "a patch cannot empty out the message either"
  );
});

test("dry_run runs every check and writes nothing", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  const before = await fs.readFile(path.join(root, ".ai-dev", "policy.json"), "utf8");
  const planned = await upsertPolicyRule({ projectRoot: root, rule: RULE, dryRun: true });
  assert.equal(planned.action, "created");
  assert.equal(planned.dry_run, true);
  assert.equal(planned.verification.fires_on_example, true);
  assert.equal(await fs.readFile(path.join(root, ".ai-dev", "policy.json"), "utf8"), before);
});

test("a rule that does not fire on its own example is refused", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { ...RULE, pattern: "git\\s+push\\s+--forse" } }),
    /does not match its own example/
  );
  const stored = await readPolicy(root);
  assert.equal(stored.rules.length, defaultPolicy().rules.length, "nothing was written");
});

test("a rule with no example, and one that also matches its counter-example, are refused", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  const { example, counter_example: counter, ...bare } = RULE;
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: bare }), /needs an example/);
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { ...RULE, pattern: "git\\s+push\\s+--force" } }),
    /also matches its counter-example/
  );
  assert.ok(example && counter);
});

test("a file rule is matched the way the guard matches it: the path, a newline, then the content", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  const created = await upsertPolicyRule({
    projectRoot: root,
    rule: {
      id: "warn-migration-edit",
      event: "file",
      pattern: "^db/migrations/.*\\n[\\s\\S]*drop\\s+column",
      action: "warn",
      message: "Dropping a column in a migration needs a backfill plan.",
      example: "ALTER TABLE users DROP COLUMN legacy_id;",
      example_path: "db/migrations/0007-drop-legacy.sql",
      counter_example: "ALTER TABLE users ADD COLUMN nickname text;"
    }
  });
  assert.equal(created.verification.checked_as, "file");
  assert.equal(created.verification.fires_on_example, true);
  assert.equal(
    compilePolicyPattern(created.rule.pattern).test(policyHaystack("file", { file_path: "db/migrations/0007-drop-legacy.sql", text: "ALTER TABLE users DROP COLUMN legacy_id;" })),
    true
  );
});

test("a second rule with the same pattern and an overlapping event is refused", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  await upsertPolicyRule({ projectRoot: root, rule: RULE });
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "block-force-push-again", event: "all" } }),
    /already carries this pattern/
  );
  const different = await upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "warn-force-push-in-files", event: "file" } });
  assert.equal(different.action, "created", "the same text on a different event is a different rule");
});

test("a pattern that cannot work is refused with the reason, one reason per problem", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "bad-regex", pattern: "git push (--force" } }), /does not compile/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "nested-quantifier", pattern: "(\\s*rm\\s*)+" } }), /backtracks exponentially/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "Bad Id" } }), /is not a slug/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "wrong-event", event: "prompt" } }), /never evaluated/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "wrong-action", action: "deny" } }), /is not one of/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "no-message", message: "" } }), /A new rule needs message/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...RULE, id: "unknown-field", conditions: ["staged"] } }), /ignores these rule fields/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { pattern: "x" } }), /rule.id is required/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: "block everything" }), /rule must be an object/);
  assert.deepEqual((await readPolicy(root)).rules, defaultPolicy().rules);
});

test("a rule missing everything but an id names all four fields it needs", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { id: "empty-rule" } }),
    /needs event, action, pattern, message/
  );
});

test("removing a rule takes it out by id and says what else is there", async (t) => {
  const root = await tempProject(t, defaultPolicy());
  const removed = await removePolicyRule({ projectRoot: root, id: "warn-eval" });
  assert.equal(removed.action, "removed");
  assert.equal(removed.rule.id, "warn-eval");
  assert.equal(removed.rules_total, defaultPolicy().rules.length - 1);
  assert.equal((await readPolicy(root)).rules.some((rule) => rule.id === "warn-eval"), false);
  await assert.rejects(removePolicyRule({ projectRoot: root, id: "warn-eval" }), /Known rules: warn-inner-html, block-prod-migrations/);
});

test("a policy file that is missing or unreadable is reported, not thrown past the caller", async (t) => {
  const empty = await tempProject(t);
  const listed = await listPolicyRules(empty);
  assert.equal(listed.exists, false);
  assert.deepEqual(listed.rules, []);
  assert.match(listed.problems[0], /does not exist/);
  await assert.rejects(removePolicyRule({ projectRoot: empty, id: "warn-eval" }), /does not exist/);

  const broken = await tempProject(t, "{ not json");
  const brokenList = await listPolicyRules(broken);
  assert.equal(brokenList.exists, true);
  assert.match(brokenList.problems[0], /not valid JSON/);
  await assert.rejects(upsertPolicyRule({ projectRoot: broken, rule: RULE }), /not valid JSON/);
  await assert.rejects(removePolicyRule({ projectRoot: broken, id: "warn-eval" }), /not valid JSON/);

  const notAnObject = await tempProject(t, "[1, 2]");
  assert.match((await listPolicyRules(notAnObject)).problems[0], /is not a JSON object/);

  const ruleless = await tempProject(t, { profile: "minimal" });
  const rulelessList = await listPolicyRules(ruleless);
  assert.match(rulelessList.problems[0], /has no "rules" array/);
  const added = await upsertPolicyRule({ projectRoot: ruleless, rule: RULE });
  assert.equal(added.rules_total, 1);
  assert.equal((await readPolicy(ruleless)).profile, "minimal");
});

test("a hand-edited rule that stopped working is reported instead of silently doing nothing", async (t) => {
  const root = await tempProject(t, {
    profile: "standard",
    rules: [
      { id: "broken-regex", event: "bash", pattern: "rm -rf (", action: "block", message: "No." },
      { id: "unknown-event", event: "prompt", pattern: "secret", action: "block", message: "No." },
      { id: "typo-action", event: "bash", pattern: "curl", action: "blok", message: "Ask first." },
      { id: "drifted", event: "bash", pattern: "terraform\\s+destroy", action: "block", message: "No.", example: "terraform apply -auto-approve" },
      { id: "widened", event: "bash", pattern: "kubectl\\s+", action: "warn", message: "Careful.", example: "kubectl delete pod x", counter_example: "kubectl get pods" }
    ]
  });
  const listed = await listPolicyRules(root);
  const byId = Object.fromEntries(listed.rules.map((rule) => [rule.id, rule]));
  assert.match(byId["broken-regex"].problems[0], /does not compile/);
  assert.match(byId["unknown-event"].problems[0], /never evaluated/);
  assert.match(byId["typo-action"].problems[0], /is not one of/);
  assert.equal(byId["typo-action"].effective_action, "warn", "the guard downgrades what it does not recognise");
  assert.match(byId.drifted.problems[0], /no longer matches/);
  assert.equal(byId.drifted.fires_on_example, false);
  assert.match(byId.widened.problems[0], /counter-example stored with the rule now matches/);
  assert.equal(listed.counts.broken, 5);
});

test("the rule reader answers for values it was never given", async () => {
  assert.deepEqual(await verifyPolicyRule({}), { checked_as: "bash", fires_on_example: null, counter_example_matches: null, timed_out: false, not_checked: false });
  const described = await describePolicyRule(undefined);
  assert.equal(described.id, "");
  assert.equal(described.effective_action, "warn");
  assert.equal(compilePolicyPattern("[unclosed"), null);
  assert.deepEqual(
    policyRuleProblems({ id: "ok-rule", event: "all", pattern: "x", action: "warn", enabled: "yes", example: 4 }),
    ["Field \"enabled\" must be a boolean; the guard skips a rule only when it is exactly false.", "Field \"example\" must be a string."]
  );
  assert.equal(policyRuleProblems({ id: "long-pattern", event: "bash", action: "warn", pattern: "a".repeat(401) }).length, 1);
  assert.equal(policyRuleProblems({ id: "long-example", event: "bash", action: "warn", pattern: "a", example: "b".repeat(4001) }).length, 1);
  assert.deepEqual(policyRuleProblems({ id: "escaped-plus", event: "bash", action: "warn", pattern: "(a\\+b)+" }), [], "an escaped quantifier inside a group is not a nested quantifier");
  assert.deepEqual(policyRuleProblems({ id: "class-plus", event: "bash", action: "warn", pattern: "([+*]a)+" }), [], "a quantifier character inside a class is not a quantifier");
});

// The hook pack is copied into other repositories, so it cannot import this
// module: the compile flags, the text a file rule is matched against and the
// "anything but block is a warning" reading are mirrored here from
// hooks/lib.mjs and hooks/guard.mjs. This runs the installed guard against
// rules written by upsertPolicyRule, so the mirror cannot drift in silence.
test("a rule written here is the rule the installed guard enforces", async (t) => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "policy-guard-"));
  t.after(() => fs.rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // The hooks resolve the project root with realpath, so the fixture hands out
  // a resolved path too (macOS /var -> /private/var).
  const root = await fs.realpath(created);
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  await installAgentHooks({ projectRoot: root, hooksSourceDir: path.join(serverRoot, "hooks"), targets: ["claude"], profile: "standard" });
  await upsertPolicyRule({
    projectRoot: root,
    rule: {
      id: "block-prod-deploy",
      event: "bash",
      pattern: "deploy\\s+--env\\s+prod",
      action: "block",
      message: "Production deploys need a human on the call.",
      example: "make deploy --env prod",
      counter_example: "make deploy --env staging"
    }
  });
  await upsertPolicyRule({
    projectRoot: root,
    rule: {
      id: "warn-inline-token",
      event: "file",
      pattern: "^tests/.*\\nconst token",
      action: "warn",
      message: "Build test credentials with the fixture factory.",
      example: "const token = makeToken();",
      example_path: "tests/auth.test.js"
    }
  });

  const guard = (mode, toolInput) => spawnSync(process.execPath, [path.join(root, ".ai-dev", "hooks", "guard.mjs"), mode], {
    cwd: root,
    input: JSON.stringify({ cwd: root, tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, AI_DEV_STATE_ROOT: path.join(root, "state") },
    timeout: 20_000,
    windowsHide: true
  });

  const blocked = guard("bash", { command: "make deploy --env prod" });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /policy:block-prod-deploy/);
  assert.equal(guard("bash", { command: "make DEPLOY --env PROD" }).status, 2, "the guard compiles the pattern case-insensitively, which is what the example was checked with");
  assert.equal(guard("bash", { command: "make deploy --env staging" }).status, 0);

  const warned = guard("file", { file_path: "tests/auth.test.js", content: "const token = makeToken();" });
  assert.equal(warned.status, 0);
  assert.match(warned.stdout, /policy:warn-inline-token/);
  const elsewhere = guard("file", { file_path: "src/auth.js", content: "const token = makeToken();" });
  assert.equal(elsewhere.stdout.includes("warn-inline-token"), false, "a file rule is matched against the path as well as the content");

  await upsertPolicyRule({ projectRoot: root, rule: { id: "block-prod-deploy", enabled: false } });
  assert.equal(guard("bash", { command: "make deploy --env prod" }).status, 0, "enabled: false stops the guard evaluating it");
  await removePolicyRule({ projectRoot: root, id: "warn-inline-token" });
  assert.equal(guard("file", { file_path: "tests/auth.test.js", content: "const token = makeToken();" }).stdout.includes("warn-inline-token"), false);
});


// Д-16. `(a|a)+$` passes every structural check here — the quantifier is over an
// alternation, not over another quantifier — and needs 38.8 seconds against
// twenty-eight characters. Two ways in, so two defences: the tool refuses to
// write it, and the guard refuses to spend more than the budget on it even when
// the rule arrived by hand.
const CATASTROPHIC_RULE = {
  id: "catastrophic-pattern",
  event: "bash",
  pattern: "(a|a)+$",
  action: "block",
  message: "Only here to measure what the pattern costs.",
  example: "aaa"
};

test("a pattern that backtracks catastrophically is refused, even though its own example matches fast", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const started = process.hrtime.bigint();
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: CATASTROPHIC_RULE }),
    /backtracks catastrophically/
  );
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < 8000, `the refusal must not itself hang; took ${Math.round(elapsed)} ms`);
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === CATASTROPHIC_RULE.id), []);

  // The overlapping-class form from the same debt entry, which the nested
  // quantifier heuristic also lets through.
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { ...CATASTROPHIC_RULE, id: "overlapping-classes", pattern: "(\\w|\\d)+$", example: "abc" } }),
    /backtracks catastrophically/
  );
});

test("a hand-written catastrophic rule is reported by the reader instead of hanging it", async (t) => {
  const root = await tempProject(t, { ...defaultPolicy("standard"), rules: [{ ...CATASTROPHIC_RULE, example: `${"a".repeat(40)}!` }] });
  const started = process.hrtime.bigint();
  const listed = await listPolicyRules(root);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < 8000, `listing must not hang on the rule; took ${Math.round(elapsed)} ms`);
  const rule = listed.rules.find((entry) => entry.id === CATASTROPHIC_RULE.id);
  assert.equal(rule.match_timed_out, true);
  assert.match(rule.problems[0], new RegExp(`did not finish within ${DEFAULT_MATCH_BUDGET_MS} ms`));
  assert.equal(listed.counts.broken, 1);
});

test("the installed guard answers on a catastrophic rule instead of stalling on it", async (t) => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "policy-redos-"));
  t.after(() => fs.rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = await fs.realpath(created);
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  await installAgentHooks({ projectRoot: root, hooksSourceDir: path.join(serverRoot, "hooks"), targets: ["claude"], profile: "standard" });
  // Straight into the file, the way a hand edit or an older server would put it.
  const policyPath = path.join(root, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  policy.rules.push(CATASTROPHIC_RULE);
  await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [path.join(root, ".ai-dev", "hooks", "guard.mjs"), "bash"], {
    cwd: root,
    input: JSON.stringify({ cwd: root, tool_input: { command: `echo ${"a".repeat(40)}!` } }),
    encoding: "utf8",
    env: { ...process.env, AI_DEV_STATE_ROOT: path.join(root, "state") },
    timeout: 20_000
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.status, 0, `the guard must answer, got status ${result.status}: ${result.stderr}`);
  // Claude Code kills a hook at ten seconds. Without the budget this command
  // never returns at all.
  assert.ok(elapsed < 9000, `the guard must answer well inside the client's timeout; took ${Math.round(elapsed)} ms`);
  assert.match(result.stdout, /policy:catastrophic-pattern\] this rule was not evaluated/);

  // The honest default rules in the same policy still fire.
  const blocked = spawnSync(process.execPath, [path.join(root, ".ai-dev", "hooks", "guard.mjs"), "bash"], {
    cwd: root,
    input: JSON.stringify({ cwd: root, tool_input: { command: "npm run migrate -- --prod" } }),
    encoding: "utf8",
    env: { ...process.env, AI_DEV_STATE_ROOT: path.join(root, "state") },
    timeout: 20_000
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /policy:block-prod-migrations/);
});
