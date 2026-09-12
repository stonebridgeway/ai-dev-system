import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAIM_GATES,
  MINIMUM_REASON_LENGTH,
  RATIONALIZATION_PATTERNS,
  completionClaimFailure,
  completionClaimSignals,
  lintCompletionClaims,
  parseCompletionClaimPolicy,
  statedReason
} from "./completion-claims.mjs";

/** A task record with one verification carrying the given checks. */
function record(checks, { passed = true, fingerprint = "state-1" } = {}) {
  return {
    verifications: [{
      id: "verification-1",
      passed,
      checks,
      evidence: { source_state_fingerprint: fingerprint }
    }]
  };
}

const GREEN = [
  { type: "quality_gate", result: { status: "passed" } },
  { type: "change_hygiene", result: { status: "pass" } }
];

test("an honest report passes, whatever the checks say", () => {
  const honest = [
    "Implemented the retry with a regression test; the quality gate is green and change hygiene reports no findings.",
    "Fixed the pre-existing typo in the README and rebuilt the docs.",
    "3 tests fail in auth.test.ts because the fixture expects the old shape; fixing them now.",
    "Removed the eslint-disable comment that hid the unused import.",
    "The TODO in parser.mjs now points at issue #412.",
    "Checked the UI on desktop and mobile through verify_task with run_frontend=true.",
    "Refactored the cache and dropped the temporary workaround tracked in OPS-1421.",
    "Работает как задумано: тесты зелёные, гигиена без находок."
  ];
  for (const summary of honest) {
    // No verification at all: every gate is `null`, the hardest case for a
    // false positive.
    const result = lintCompletionClaims({ summary, signals: completionClaimSignals({}) });
    assert.equal(result.status, "ok", `${summary} → ${JSON.stringify(result.findings)}`);
    assert.deepEqual(result.findings, []);
  }
});

test("every rule fires on its own rationalization and names a real gate", () => {
  const samples = {
    pre_existing_failure: "The lint failure is a pre-existing issue in the vendor folder.",
    tests_deferred: "Skipping tests for now, the change is small.",
    tests_failing_deferred: "Tests are failing but I'll fix them later.",
    works_on_my_machine: "It works on my machine, CI is just slow.",
    unverified_claim: "The migration should work for both dialects.",
    untested_change: "The change is untested.",
    unrelated_or_flaky: "That failure is unrelated to my change.",
    suppressed_check: "Disabled the lint rule for this file.",
    leftover_marker: "Left a TODO in the parser for the streaming case.",
    good_enough: "Good enough for now, we can polish later.",
    inspection_only: "Marked the criterion met based on code inspection alone.",
    ui_unchecked: "Didn't check the UI, the change is CSS only.",
    manual_only: "Verified manually in the browser."
  };
  assert.deepEqual(
    RATIONALIZATION_PATTERNS.map((rule) => rule.id).sort(),
    Object.keys(samples).sort(),
    "every rule needs a sample here, and every sample a rule"
  );
  for (const rule of RATIONALIZATION_PATTERNS) {
    assert.ok(CLAIM_GATES[rule.gate], `${rule.id} points at an unknown gate ${rule.gate}`);
    assert.equal(rule.pattern.flags.includes("g"), false, `${rule.id} must not be a sticky pattern`);
    const result = lintCompletionClaims({ summary: samples[rule.id], signals: completionClaimSignals({}) });
    assert.ok(
      result.findings.some((item) => item.rule === rule.id && item.severity === "block"),
      `${rule.id} did not block ${JSON.stringify(samples[rule.id])}`
    );
  }
});

test("a rationalization blocks when its check is red and passes when it is green", () => {
  const summary = "Skipping tests for now; the endpoint is wired and returns the new shape.";
  const red = lintCompletionClaims({
    summary,
    signals: completionClaimSignals(record([
      { type: "quality_gate", result: { status: "failed" } }
    ], { passed: false }))
  });
  assert.equal(red.status, "blocked");
  assert.equal(red.blocked, 1);
  assert.equal(red.findings[0].rule, "tests_deferred");
  assert.equal(red.findings[0].gate, "quality_gate");
  assert.equal(red.findings[0].gate_status, "did not pass");
  assert.match(red.findings[0].excerpt, /Skipping tests for now/);

  // The same phrasing over a passing gate is only worth a warning: the
  // evidence is there, the wording undersells it.
  const green = lintCompletionClaims({ summary, signals: completionClaimSignals(record(GREEN)) });
  assert.equal(green.status, "ok");
  assert.equal(green.findings.length, 1);
  assert.equal(green.findings[0].severity, "warn");
  assert.match(green.findings[0].message, /passed/);
});

test("a check that never ran backs nothing", () => {
  const signals = completionClaimSignals(record([{ type: "change_hygiene", result: { status: "pass" } }]));
  assert.equal(signals.quality_gate, null);
  assert.equal(signals.change_hygiene, true);
  assert.equal(signals.verification, true);
  const result = lintCompletionClaims({
    summary: "Could not run the tests in this sandbox, but the handler is correct.",
    signals
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.findings[0].gate_status, "never ran");
});

test("a verification bound to another project state does not count as passing", () => {
  const stale = completionClaimSignals(record(GREEN, { fingerprint: "state-1" }), {
    projectState: { fingerprint: "state-2" }
  });
  assert.equal(stale.verification, false);
  const fresh = completionClaimSignals(record(GREEN, { fingerprint: "state-2" }), {
    projectState: { fingerprint: "state-2" }
  });
  assert.equal(fresh.verification, true);
});

test("notes are linted like the summary, and the finding says which field", () => {
  const result = lintCompletionClaims({
    summary: "Added the parser and its unit tests.",
    notes: "The e2e failure is flaky.",
    signals: completionClaimSignals(record(GREEN, { passed: false }))
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].field, "notes");
  assert.equal(result.findings[0].rule, "unrelated_or_flaky");
});

test("a waiver with a stated reason lets a real blocker through", () => {
  const policy = parseCompletionClaimPolicy(JSON.stringify({
    completion_claims: {
      waivers: [{
        rule: "tests_deferred",
        reason: "The integration suite needs a staging database this runner cannot reach (OPS-1421)."
      }]
    }
  }));
  assert.deepEqual(policy.warnings, []);
  const signals = completionClaimSignals(record([{ type: "change_hygiene", result: { status: "pass" } }]));

  // Waiver without the reason written into the report: still blocked.
  const silent = lintCompletionClaims({ summary: "Skipping tests for now.", signals, policy });
  assert.equal(silent.status, "blocked");
  assert.match(silent.findings[0].message, /state the reason itself/);

  const stated = lintCompletionClaims({
    summary: "Skipping tests for now, because the integration suite needs a staging database this runner cannot reach (OPS-1421).",
    signals,
    policy
  });
  assert.equal(stated.status, "ok");
  assert.equal(stated.waived, 1);
  assert.equal(stated.findings[0].severity, "warn");
  assert.equal(stated.findings[0].waiver.rule, "tests_deferred");
  assert.match(stated.stated_reason, /staging database/);
});

test("a waiver covers only its own rule, and `*` covers all of them", () => {
  const reason = "The vendored SDK ships a failing smoke test upstream (OPS-77).";
  const summary = `Skipping tests for now and the lint failure is a pre-existing issue. Reason: ${reason}`;
  const signals = completionClaimSignals({});
  const narrow = lintCompletionClaims({
    summary,
    signals,
    policy: parseCompletionClaimPolicy({ completion_claims: { waivers: [{ rule: "tests_deferred", reason }] } })
  });
  assert.equal(narrow.status, "blocked");
  assert.deepEqual(narrow.findings.filter((item) => item.severity === "block").map((item) => item.rule), ["pre_existing_failure"]);

  const wide = lintCompletionClaims({
    summary,
    signals,
    policy: parseCompletionClaimPolicy({ completion_claims: { waivers: [{ rule: "*", reason }] } })
  });
  assert.equal(wide.status, "ok");
  assert.equal(wide.waived, 2);
});

test("an expired waiver stops waiving", () => {
  const policy = parseCompletionClaimPolicy({
    completion_claims: {
      waivers: [{
        rule: "untested_change",
        reason: "The hardware test rig is offline until the lab move finishes.",
        expires: "2026-01-31"
      }]
    }
  });
  const summary = "The change is untested, because the hardware test rig is offline until the lab move finishes.";
  const signals = completionClaimSignals({});
  assert.equal(lintCompletionClaims({ summary, signals, policy, now: new Date("2026-01-01T00:00:00Z") }).status, "ok");
  assert.equal(lintCompletionClaims({ summary, signals, policy, now: new Date("2026-03-01T00:00:00Z") }).status, "blocked");
});

test("the policy turns the whole linter off, both ways of writing it", () => {
  for (const document of [{ completion_claims: false }, { completion_claims: { enabled: false } }]) {
    const result = lintCompletionClaims({
      summary: "Tests are failing but I'll fix them later.",
      signals: completionClaimSignals({}),
      policy: parseCompletionClaimPolicy(document)
    });
    assert.equal(result.status, "off");
    assert.deepEqual(result.findings, []);
    assert.match(result.reason, /policy\.json/);
  }
});

test("a policy that cannot be trusted leaves the linter on and says why", () => {
  const broken = parseCompletionClaimPolicy("{ not json");
  assert.equal(broken.enabled, true);
  assert.deepEqual(broken.waivers, []);
  assert.match(broken.warnings[0], /not valid JSON/);

  const sloppy = parseCompletionClaimPolicy({
    completion_claims: {
      waivers: [
        { rule: "tests_deferred", reason: "later" },
        { rule: "no_such_rule", reason: "A reason long enough to be taken seriously." },
        { rule: "untested_change", reason: "A reason long enough to be taken seriously.", expires: "soon" }
      ]
    }
  });
  assert.deepEqual(sloppy.waivers, []);
  assert.equal(sloppy.warnings.length, 3);
  assert.match(sloppy.warnings[0], new RegExp(`${MINIMUM_REASON_LENGTH} characters`));
  assert.match(sloppy.warnings[1], /unknown rule/);
  assert.match(sloppy.warnings[2], /expires/);

  // Warnings travel with the lint result so the tool response shows them.
  const result = lintCompletionClaims({ summary: "All green.", signals: {}, policy: sloppy });
  assert.equal(result.warnings.length, 3);

  assert.equal(parseCompletionClaimPolicy("").enabled, true);
  assert.equal(parseCompletionClaimPolicy(null).enabled, true);
  assert.deepEqual(parseCompletionClaimPolicy({ profile: "standard" }).waivers, []);
});

test("a stated reason has to be a reason", () => {
  assert.equal(statedReason("Skipped because later."), "");
  assert.equal(statedReason("Reason: the upstream API is down for maintenance until Friday."),
    "the upstream API is down for maintenance until Friday.");
  assert.match(statedReason("Причина: сервис аутентификации недоступен в песочнице."), /сервис/);
  assert.equal(statedReason("No justification here at all."), "");
});

test("the refusal text names the rule, the gate and the way out", () => {
  const result = lintCompletionClaims({
    summary: "Tests are failing but I'll fix them later.",
    signals: completionClaimSignals({})
  });
  const message = completionClaimFailure(result);
  assert.match(message, /tests_failing_deferred in summary/);
  assert.match(message, /never ran/);
  assert.match(message, /verify_task/);
  assert.match(message, /"rule":"tests_failing_deferred"/);
});


// Д-10, then Д-26. The list was measured against fifteen phrasings it had never
// seen, and ten more after that:
// one honest report was blocked and three ordinary rationalizations walked
// through. This is that measurement, kept as a test — eight honest phrasings
// that must survive a repository where nothing passed, and seven excuses that
// must not.
const HONEST_PHRASINGS = [
  // The false positive from the debt entry: a person explaining that the two
  // environments agree is the opposite of "works on my machine".
  "It works on my machine and in CI: both run the same command, output attached.",
  "Ran the suite locally and in CI; both green, and the CI run is linked below.",
  "3 tests fail in auth.test.ts: the token clock is mocked wrong. Fixing that now.",
  "The quality gate is red — eslint reports two errors in src/router.mjs, both introduced here.",
  "Coverage fell to 84%: the new branch in parseArgs has no test, recorded as a blocked criterion.",
  "I inspected the diff first and then ran the suite: 128 tests pass, 0 fail.",
  "Frontend QA ran with screenshots attached; the modal renders correctly at 375px.",
  "TODO(PROJ-412): split the router once the migration lands.",
  // Д-26. Where it failed plus the fix carried over: two facts, not an excuse.
  "This test was already failing on main, and I ported the fix from PR 12, so it is green here.",
  "Падало на main в auth.test.ts; перенёс починку из PR 12, здесь зелено."
];

const RATIONALIZED_PHRASINGS = [
  // The three the list used to miss.
  ["unrelated_or_flaky", "The remaining failures are unrelated to this task."],
  ["inspection_only", "Marked the criterion met based on code inspection alone."],
  ["unverified_claim", "Should be fine, I did not run the build."],
  // And four it already caught, kept so a widened pattern cannot lose them.
  ["tests_failing_deferred", "Tests are still failing but this is fine to merge."],
  ["works_on_my_machine", "Works on my machine, ship it."],
  ["tests_deferred", "Skipping tests for now."],
  ["pre_existing_failure", "This is a pre-existing failure in the vendor bundle."],
  // Д-26. The Russian halves: agents here report in Russian, and a rule that
  // exists in one language is a rule you walk around by switching layout.
  ["pre_existing_failure", "Эти падения были ещё до меня."],
  ["inspection_only", "Поставил критерий выполненным по чтению кода."],
  ["unverified_claim", "Наверное всё в порядке, сборку не запускал."],
  ["untested_change", "Тесты не запускал, изменение мелкое."],
  ["works_on_my_machine", "У меня всё работает."],
  ["tests_deferred", "Пока без тестов, напишу позже."],
  ["unrelated_or_flaky", "Падение не связано с моими правками."],
  ["good_enough", "Пока сойдёт, потом причешем."]
];

test("an exemption is read in the sentence it sits in, not across the report", () => {
  const nothingRan = completionClaimSignals({});
  // The honest sentence carries both facts, so the excuse in it is not one.
  assert.deepEqual(
    lintCompletionClaims({ summary: "This test was already failing on main, and I ported the fix from PR 12.", signals: nothingRan }).findings,
    []
  );
  // An honest sentence does not cover for a bare excuse in the next one.
  const mixed = lintCompletionClaims({
    summary: "I ported the fix from PR 12 for the lockfile. Also, the remaining test failures are pre-existing.",
    signals: nothingRan
  });
  assert.equal(mixed.status, "blocked");
  assert.deepEqual(mixed.findings.map((item) => item.rule), ["pre_existing_failure"]);
  // And naming the branch alone waives nothing: the fix has to have moved.
  assert.equal(lintCompletionClaims({ summary: "The failure is pre-existing on main.", signals: nothingRan }).status, "blocked");
});

test("twenty-five phrasings: the honest ones pass with every gate red, the excuses do not", () => {
  assert.equal(HONEST_PHRASINGS.length + RATIONALIZED_PHRASINGS.length, 25);
  // The hardest case for a false positive: nothing ran, so every gate is null
  // and any match is a block.
  const nothingRan = completionClaimSignals({});
  for (const summary of HONEST_PHRASINGS) {
    const result = lintCompletionClaims({ summary, signals: nothingRan });
    assert.deepEqual(result.findings, [], `blocked an honest report: ${summary}`);
    assert.equal(result.status, "ok");
  }
  for (const [expected, summary] of RATIONALIZED_PHRASINGS) {
    const result = lintCompletionClaims({ summary, signals: nothingRan });
    assert.equal(result.status, "blocked", `let a rationalization through: ${summary}`);
    assert.ok(
      result.findings.some((item) => item.rule === expected && item.severity === "block"),
      `${summary} → ${JSON.stringify(result.findings.map((item) => item.rule))}, expected ${expected}`
    );
  }
});

test("over a green gate the same twenty-five are at most a warning", () => {
  // Every gate passed: a rationalization is then wording, not a substitute for
  // evidence, so nothing may refuse the report.
  const green = completionClaimSignals(record([
    { type: "quality_gate", result: { status: "passed" } },
    { type: "change_hygiene", result: { status: "pass" } },
    { type: "frontend_qa", result: { gate: "pass" } }
  ]));
  for (const summary of [...HONEST_PHRASINGS, ...RATIONALIZED_PHRASINGS.map(([, text]) => text)]) {
    const result = lintCompletionClaims({ summary, signals: green });
    assert.equal(result.status, "ok", `${summary} → ${JSON.stringify(result.findings)}`);
    assert.equal(result.findings.every((item) => item.severity === "warn"), true);
  }
});
