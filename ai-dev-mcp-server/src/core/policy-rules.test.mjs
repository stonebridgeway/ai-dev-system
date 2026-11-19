import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultPolicy, installAgentHooks } from "./agent-hooks.mjs";
import {
  compilePolicyPattern,
  describePolicyRule,
  describePolicyRules,
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
  assert.deepEqual(await verifyPolicyRule({}), { checked_as: "bash", fires_on_example: null, counter_example_matches: null, timed_out: false, not_checked: false, not_run: null, match_error: null });
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


// `(a|a)+$` passes every structural check here — the quantifier is over an
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

test("a machine too busy to start a match: the rule is not written unchecked, and a listing says the machine, not the rules ahead", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const busy = async (jobs) => jobs.map(() => ({
    matched: null,
    checked: false,
    timed_out: false,
    error: "no match worker could start within 3000 ms — the machine is too busy — so this match was not run",
    truncated: false,
    not_run: "start"
  }));
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: busy }),
    /^Error: Rule "[^"]+" was not written: its pattern could not be checked, because no match worker could start within 3000 ms — the machine is too busy — so this match was not run\. Try again once the machine is less busy\.$/
  );
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === RULE.id), [], "nothing was written");
  const [described] = await describePolicyRules([RULE], { match: busy });
  assert.equal(described.match_not_checked, true);
  assert.equal(described.match_timed_out, false);
  assert.ok(described.problems.some((problem) => /^This rule was never matched against its sample: the machine is so busy that no match worker started within 3000 ms\./.test(problem)), JSON.stringify(described.problems));
  assert.ok(!described.problems.some((problem) => /rules before it/.test(problem)), "the rules ahead of it are not blamed");
});

test("the probes ran, the example did not: the rule is still not written", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  let call = 0;
  // The first batch is the pattern's probes, answered; the next is its example, which no worker reached.
  const exampleUnrun = async (jobs) => {
    call += 1;
    if (call === 1) return jobs.map(() => ({ matched: false, checked: true, timed_out: false, error: "", truncated: false }));
    return jobs.map(() => ({ matched: null, checked: false, timed_out: false, error: "", truncated: false, not_run: "start" }));
  };
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: exampleUnrun }),
    /^Error: Rule "[^"]+" was not written: its example could not be checked, because the machine is so busy that no match worker started within 3000 ms\. Try again once the machine is less busy\.$/
  );
  assert.equal(call, 2, "the probes were asked, then the example");
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === RULE.id), [], "nothing was written");

  call = 0;
  const exampleCutOff = async (jobs) => {
    call += 1;
    if (call === 1) return jobs.map(() => ({ matched: false, checked: true, timed_out: false, error: "", truncated: false }));
    return jobs.map(() => ({ matched: null, checked: false, timed_out: false, error: "", truncated: false, not_run: "deadline" }));
  };
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: RULE, match: exampleCutOff }), /its example could not be checked, because the matching ran out of the \d+ ms it gets/);
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === RULE.id), []);
});

// A worker that failed answers `checked: true` with its error: under a process limit, EAGAIN.
const failedMatch = { matched: null, checked: true, timed_out: false, error: "EAGAIN", truncated: false };
const ran = (matched) => ({ matched, checked: true, timed_out: false, error: "", truncated: false });

test("a match worker that failed checked nothing: the rule is not written, and a listing names the failure", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const nothingWritten = async () => assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === RULE.id), [], "nothing was written");

  // The probes of the pattern's cost.
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: async (jobs) => jobs.map(() => failedMatch) }),
    /^Error: Rule "block-force-push" was not written: its pattern could not be checked, because the match worker failed \(EAGAIN\)\. Nothing here says the pattern is wrong; try again once the server can start a worker thread\.$/
  );
  await nothingWritten();

  // The probes answered; the worker failed on the example, then on the counter-example alone.
  for (const [sample, answers] of [["example", [failedMatch, failedMatch]], ["counter-example", [ran(true), failedMatch]]]) {
    let call = 0;
    const match = async (jobs) => (++call === 1 ? jobs.map(() => ran(false)) : answers);
    await assert.rejects(
      upsertPolicyRule({ projectRoot: root, rule: RULE, match }),
      new RegExp(`^Error: Rule "block-force-push" was not written: its ${sample} could not be checked, because the match worker failed \\(EAGAIN\\)\\. Nothing here says the rule is wrong`)
    );
    assert.equal(call, 2, "the probes were asked, then the samples");
    await nothingWritten();
  }

  // Whatever a matcher answers besides — here nothing at all for the samples — a rule is not written unseen to fire:
  // a sample left without an answer could not be checked.
  let asked = 0;
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: async (jobs) => (++asked === 1 ? jobs.map(() => ran(false)) : []) }),
    /^Error: Rule "block-force-push" was not written: its example could not be checked, because the match worker failed \(it gave no answer for this match\)\./
  );
  await nothingWritten();

  // A rule already in the file, listed while the worker fails: its failure is its problem, and it is not vouched for.
  const listed = await tempProject(t, { ...defaultPolicy("standard"), rules: [...defaultPolicy("standard").rules, RULE] });
  const report = await listPolicyRules(listed, { match: async (jobs) => jobs.map(() => failedMatch) });
  const rule = report.rules.find((entry) => entry.id === RULE.id);
  assert.deepEqual([rule.fires_on_example, rule.match_not_checked, rule.match_timed_out, rule.match_error], [null, false, false, "EAGAIN"]);
  assert.deepEqual(rule.problems, ["This rule was never matched against its sample: the match worker failed (EAGAIN). Nothing here says the rule is wrong; list the rules again once the server can start a worker thread."]);
  assert.equal(report.counts.broken, 1, "the default rules carry no sample, so nothing failed for them");
  assert.deepEqual(report.rules.filter((entry) => entry.id !== RULE.id).map((entry) => entry.match_error), [null, null, null]);
});

test("a refusal names the sample it is about, and a sample that overran its budget is said before one left unchecked", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const after = (answers) => {
    let call = 0;
    return async (jobs) => (++call === 1 ? jobs.map(() => ran(false)) : answers);
  };
  const unrun = (notRun) => ({ matched: null, checked: false, timed_out: false, error: "", truncated: false, not_run: notRun });
  const overran = { matched: null, checked: true, timed_out: true, error: `the match did not finish within ${DEFAULT_MATCH_BUDGET_MS} ms`, truncated: false };
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: after([ran(true), unrun("start")]) }),
    /^Error: Rule "block-force-push" was not written: its counter-example could not be checked, because the machine is so busy that no match worker started within 3000 ms\./
  );
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: after([overran, unrun("deadline")]) }),
    /^Error: Rule "block-force-push" backtracks catastrophically on its own example: the match did not finish within/
  );
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: RULE, match: after([ran(true), overran]) }),
    /^Error: Rule "block-force-push" backtracks catastrophically on its own counter-example:/
  );
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === RULE.id), [], "nothing was written");
});

test("a sample's answer about the rule is said before a sample that could not be checked", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const after = (answers) => {
    let call = 0;
    return async (jobs) => (++call === 1 ? jobs.map(() => ran(false)) : answers);
  };
  const unrun = (notRun) => ({ matched: null, checked: false, timed_out: false, error: "", truncated: false, not_run: notRun });
  // The example answered no: that is about the rule, whatever happened to the counter-example.
  for (const counter of [failedMatch, unrun("deadline"), unrun("start")]) {
    await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: RULE, match: after([ran(false), counter]) }), /^Error: Rule "block-force-push" does not match its own example\./, JSON.stringify(counter));
  }
  // The counter-example answered yes: so is that, whatever happened to the example.
  for (const example of [failedMatch, unrun("start")]) {
    await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: RULE, match: after([example, ran(true)]) }), /^Error: Rule "block-force-push" also matches its counter-example, so it is broader than intended\.$/, JSON.stringify(example));
  }
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => rule.id === RULE.id), [], "nothing was written");
});

test("a match the matcher gave no answer for checked nothing: not a cost probe, not a sample, not in a listing", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const noAnswer = /could not be checked, because the match worker failed \(it gave no answer for this match\)\./;
  // No answers at all for the probes of a pattern the real matcher times out on.
  let call = 0;
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: CATASTROPHIC_RULE, match: async (jobs) => (++call === 1 ? [] : jobs.map(() => ran(true))) }),
    new RegExp(`^Error: Rule "catastrophic-pattern" was not written: its pattern ${noAnswer.source}`)
  );
  // Fewer answers than probes: the ones left out are no answers either.
  call = 0;
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: RULE, match: async (jobs) => (++call === 1 ? jobs.slice(1).map(() => ran(false)) : jobs.map(() => ran(true))) }), new RegExp(`its pattern ${noAnswer.source}`));
  // The example answered, the counter-example not — or answered with something that is no answer.
  for (const answers of [[ran(true)], [ran(true), { matched: null }], [ran(true), null]]) {
    call = 0;
    await assert.rejects(
      upsertPolicyRule({ projectRoot: root, rule: RULE, match: async (jobs) => (++call === 1 ? jobs.map(() => ran(false)) : answers) }),
      new RegExp(`^Error: Rule "block-force-push" was not written: its counter-example ${noAnswer.source}`),
      JSON.stringify(answers)
    );
  }
  assert.deepEqual((await readPolicy(root)).rules.filter((rule) => [RULE.id, CATASTROPHIC_RULE.id].includes(rule.id)), [], "nothing was written");

  // A listing whose matcher answers nothing does not vouch for a rule with a sample.
  const listed = await tempProject(t, { ...defaultPolicy("standard"), rules: [...defaultPolicy("standard").rules, RULE] });
  const report = await listPolicyRules(listed, { match: async () => [] });
  const rule = report.rules.find((entry) => entry.id === RULE.id);
  assert.deepEqual([rule.fires_on_example, rule.match_error], [null, "it gave no answer for this match"]);
  assert.match(rule.problems[0], /^This rule was never matched against its sample: the match worker failed \(it gave no answer for this match\)\./);
  assert.equal(report.counts.broken, 1);
});

test("what a failed match said is put in brackets without the full stop it ended with, and never left empty", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  const failing = (error) => async (jobs) => jobs.map(() => ({ ...failedMatch, error }));
  for (const [error, said] of [["spawn EAGAIN.", "spawn EAGAIN"], ["it stopped at v1.2. \n", "it stopped at v1.2"], ["", "it gave no reason"], [" . ", "it gave no reason"]]) {
    await assert.rejects(
      upsertPolicyRule({ projectRoot: root, rule: RULE, match: failing(error) }),
      (thrown) => thrown.message.includes(`the match worker failed (${said}). Nothing here says the pattern is wrong`),
      JSON.stringify(error)
    );
    const [described] = await describePolicyRules([RULE], { match: failing(error) });
    assert.equal(described.match_error, said, JSON.stringify(error));
    assert.ok(described.problems[0].includes(`the match worker failed (${said}). Nothing here says the rule is wrong`), described.problems[0]);
  }
});

test("a rule that is off after the edit is not matched at all: switched off or edited while off, it is written where no match can run; switched on, it is matched again", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  await upsertPolicyRule({ projectRoot: root, rule: RULE });
  // A worker that cannot be made, as under a process limit: every match fails. Each request is counted.
  let calls = 0;
  const failing = async (jobs) => {
    calls += 1;
    return jobs.map(() => failedMatch);
  };
  const stored = async (id) => (await readPolicy(root)).rules.find((rule) => rule.id === id);

  const off = await upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, enabled: false }, match: failing });
  assert.deepEqual([off.action, off.changed_fields, off.rule.effective_action, off.rule.match_error, off.rule.problems], ["updated", ["enabled"], "none", null, []]);
  assert.equal((await stored(RULE.id)).enabled, false);
  // Edited while it stays off: its message, its pattern with an example of its own.
  const edited = await upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, message: "Ask a human first." }, match: failing });
  assert.deepEqual([edited.action, edited.changed_fields], ["updated", ["message"]]);
  const narrowed = await upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, pattern: "git\\s+push\\s+-f\\b", example: "git push -f" }, match: failing });
  assert.deepEqual([narrowed.action, narrowed.changed_fields], ["updated", ["pattern", "example"]]);
  assert.equal((await upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, enabled: false }, match: failing })).action, "unchanged");
  // A default rule, which carries no sample: its pattern's cost is not probed either.
  assert.equal((await upsertPolicyRule({ projectRoot: root, rule: { id: "warn-eval", enabled: false }, match: failing })).action, "updated");
  // So is a rule written off from the start.
  const late = { id: "deploy-later", event: "bash", pattern: "deploy-prod", action: "block", message: "Deploys go through CI.", example: "./deploy-staging.sh", enabled: false };
  assert.equal((await upsertPolicyRule({ projectRoot: root, rule: late, match: failing })).action, "created");
  assert.equal(calls, 0, "no match was asked for a rule that is off");

  // Its shape is checked as before: a pattern that cannot work, or a new one with no example, is refused.
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, pattern: "(a+)+" }, match: failing }), /nests an unbounded quantifier/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { ...late, id: "off-and-unproved", pattern: "release-prod", example: undefined }, match: failing }), /needs an example/);
  assert.equal(calls, 0);

  // Switched on, it is matched again: here the worker fails, so the rule stays off.
  await assert.rejects(
    upsertPolicyRule({ projectRoot: root, rule: { id: RULE.id, enabled: true }, match: failing }),
    /^Error: Rule "block-force-push" was not written: its pattern could not be checked, because the match worker failed \(EAGAIN\)\./
  );
  assert.equal((await stored(RULE.id)).enabled, false);
  // A rule that stays on is matched as before.
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { id: "warn-inner-html", message: "Use textContent." }, match: failing }), /could not be checked, because the match worker failed \(EAGAIN\)/);
  assert.equal(calls, 2);
  // The rule written off from the start: switching it on is where its example is found not to match.
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { id: late.id, enabled: true } }), /^Error: Rule "deploy-later" does not match its own example\./);
  assert.equal((await stored(late.id)).enabled, false);
});

test("a rule that is off with a sample that answers against it is listed as one upsert_policy_rule will not switch on, not as one an edit disarmed", async (t) => {
  const root = await tempProject(t, defaultPolicy("standard"));
  // Written off, so their samples were never matched: the example never matched, the counter-example always did;
  // and the pattern that backtracks catastrophically on its example is one the guard does not run while it is off.
  const unproved = { id: "destroy-later", event: "bash", pattern: "terraform destroy", action: "block", message: "Ask a human.", example: "terraform plan", enabled: false };
  const broad = { id: "kubectl-later", event: "bash", pattern: "kubectl\\s+", action: "warn", message: "Careful.", example: "kubectl delete pod x", counter_example: "kubectl get pods", enabled: false };
  const slow = { ...CATASTROPHIC_RULE, id: "slow-later", example: `${"a".repeat(40)}!`, enabled: false };
  for (const rule of [unproved, broad, slow]) assert.equal((await upsertPolicyRule({ projectRoot: root, rule })).action, "created");
  const listed = await listPolicyRules(root);
  const byId = Object.fromEntries(listed.rules.map((rule) => [rule.id, rule]));
  assert.deepEqual(byId[unproved.id].problems, ["The example stored with the rule does not match its pattern: upsert_policy_rule will not switch the rule on until the pattern or the example is fixed."]);
  assert.deepEqual(byId[broad.id].problems, ["The counter-example stored with the rule matches its pattern: upsert_policy_rule will not switch the rule on until the pattern or the counter-example is fixed."]);
  assert.deepEqual([byId[slow.id].effective_action, byId[slow.id].match_timed_out], ["none", true]);
  assert.deepEqual(byId[slow.id].problems, [`Matching this pattern against its own sample did not finish within ${DEFAULT_MATCH_BUDGET_MS} ms: it backtracks catastrophically, and upsert_policy_rule will not switch the rule on until the pattern is fixed. Bound the quantifiers; a quantified group whose branches overlap, as in (a|a)+, is the usual cause.`]);
  assert.equal(listed.counts.broken, 3, "each is still counted");
  // As said: upsert_policy_rule will not switch any of them on.
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { id: unproved.id, enabled: true } }), /^Error: Rule "destroy-later" does not match its own example\./);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { id: broad.id, enabled: true } }), /^Error: Rule "kubectl-later" also matches its counter-example/);
  await assert.rejects(upsertPolicyRule({ projectRoot: root, rule: { id: slow.id, enabled: true } }), /^Error: Rule "slow-later" backtracks catastrophically/);
  // Switched on by hand, past those checks, the same samples are what an edit did to a rule that was on — and the
  // guard runs the slow one on every command.
  const policy = await readPolicy(root);
  for (const rule of policy.rules) if ([unproved.id, broad.id, slow.id].includes(rule.id)) rule.enabled = true;
  await fs.writeFile(path.join(root, ".ai-dev", "policy.json"), JSON.stringify(policy), "utf8");
  const edited = Object.fromEntries((await listPolicyRules(root)).rules.map((rule) => [rule.id, rule]));
  assert.match(edited[unproved.id].problems[0], /^The example stored with the rule no longer matches: the pattern was narrowed, or the example was edited\.$/);
  assert.match(edited[broad.id].problems[0], /^The counter-example stored with the rule now matches/);
  assert.match(edited[slow.id].problems[0], /: it backtracks catastrophically, and the guard — which runs it on every Bash command and every file write — will abandon it instead of answering\. /);
});

test("where no worker thread can be made at all, a rule is still switched off, and switching it on is refused", async (t) => {
  const root = await fs.realpath(await tempProject(t, defaultPolicy("standard")));
  await upsertPolicyRule({ projectRoot: root, rule: RULE });
  const module = pathToFileURL(fileURLToPath(new URL("./policy-rules.mjs", import.meta.url))).href;
  // Under --permission without --allow-worker no thread can be made: measured here with the real matcher.
  const script = `const { upsertPolicyRule } = await import(${JSON.stringify(module)});
const projectRoot = ${JSON.stringify(root)};
const off = await upsertPolicyRule({ projectRoot, rule: { id: "block-force-push", enabled: false } });
const on = await upsertPolicyRule({ projectRoot, rule: { id: "block-force-push", enabled: true } }).then(() => "written", (error) => error.message);
console.log(JSON.stringify({ off: [off.action, off.rule.match_error, off.rule.problems], on }));`;
  const run = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", `--allow-fs-write=${root}`, "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const said = JSON.parse(run.stdout);
  assert.deepEqual(said.off, ["updated", null, []], "switched off, and reported without a match");
  assert.match(said.on, /^Rule "block-force-push" was not written: its pattern could not be checked, because the match worker failed \(.*--allow-worker.*\)\./);
  assert.equal((await readPolicy(root)).rules.find((rule) => rule.id === RULE.id).enabled, false);
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
