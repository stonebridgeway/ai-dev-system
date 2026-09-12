import assert from "node:assert/strict";
import test from "node:test";
import {
  PROPOSAL_THRESHOLDS,
  errorSignature,
  observationsFileName,
  proposeInstincts,
  splitStatedRule
} from "./instinct-proposals.mjs";

/** One session's observation log, in the shape the `session-end` hook writes. */
function log(...events) {
  return events.map((event, index) => ({ ...event, i: index }));
}

const user = (t) => ({ k: "user", t });
const tool = (c, n = "Bash") => ({ k: "tool", n, c });
const fail = (c, t, n = "Bash") => ({ k: "error", n, c, t });

test("observation file names survive a hostile session id", () => {
  assert.equal(observationsFileName("abc-123"), "observe-abc-123.json");
  assert.equal(observationsFileName("../../etc/passwd"), "observe-.._.._etc_passwd.json");
  assert.equal(observationsFileName(""), "observe-unknown.json");
});

test("a stated rule splits into the condition it names and the behaviour it asks for", () => {
  assert.deepEqual(splitStatedRule("Always run npm run check before you push", "atlas"),
    { trigger: "before you push", action: "Always run npm run check" });
  assert.deepEqual(splitStatedRule("When the tests are slow, run only the changed package", "atlas"),
    { trigger: "when the tests are slow", action: "run only the changed package" });
  assert.deepEqual(splitStatedRule("Never commit generated files", "atlas"),
    { trigger: "when working in atlas", action: "Never commit generated files" });
  assert.deepEqual(splitStatedRule("Never commit generated files"),
    { trigger: "when working in this repository", action: "Never commit generated files" });
  // A condition with nothing left after it is not a split worth making.
  assert.deepEqual(splitStatedRule("when you are done", "atlas"),
    { trigger: "when working in atlas", action: "when you are done" });
});

test("error signatures generalise the parts that change between two runs of one failure", () => {
  const first = errorSignature("Error: Cannot find module '/home/a/build/x.js'\n    at run (/home/a/x.js:12:3)");
  const second = errorSignature("Error: Cannot find module '/srv/b/build/y.js'\n    at run (/srv/b/y.js:44:9)");
  assert.equal(first, second);
  assert.match(first, /Cannot find module/);
  assert.notEqual(errorSignature("Error: Cannot find module x"), errorSignature("TypeError: x is not a function"));
  assert.equal(errorSignature(""), "");
});

test("proposals come from corrections, stated rules, resolved errors and repeated commands", () => {
  const { proposals, signals } = proposeInstincts({
    projectName: "atlas",
    events: log(
      user("Add a --json flag to the report command"),
      tool("npm test"),
      user("No, do not edit the lockfile by hand"),
      user("Always run npm run check when you finish a change."),
      tool("npm test"),
      tool("npm run lint"),
      tool("npm test"),
      tool("npm run lint"),
      fail("node build.mjs", "Error: Cannot find module '/repo/dist/a.js'"),
      fail("node build.mjs", "Error: Cannot find module '/repo/dist/b.js'"),
      tool("npm ci")
    )
  });
  assert.deepEqual(signals, { events: 11, user_messages: 3, tool_calls: 6, errors: 2 });
  const byKind = Object.fromEntries(proposals.map((item) => [item.kind, item]));

  assert.equal(byKind.correction.action, "No, do not edit the lockfile by hand");
  assert.equal(byKind.correction.trigger, "when working in atlas");
  assert.match(byKind.correction.note, /The user corrected the agent/);

  assert.equal(byKind.stated_rule.trigger, "when you finish a change");
  assert.match(byKind.stated_rule.action, /^Always run npm run check/);

  assert.match(byKind.resolved_error.trigger, /when Bash fails with "Error: Cannot find module <value>"/);
  assert.equal(byKind.resolved_error.action, "run `npm ci`");
  assert.equal(byKind.resolved_error.domain, "debugging");
  assert.equal(byKind.resolved_error.observations, 2);

  assert.equal(byKind.repeated_command.action, "run `npm test`");
  assert.equal(byKind.repeated_command.trigger, "when the tests are run in this project");
  assert.equal(byKind.repeated_command.domain, "testing");
  assert.equal(byKind.repeated_command.observations, 3);

  assert.equal(byKind.repeated_chain.action, "run `npm test`, then `npm run lint`");

  // A proposal never reaches the confidence that would inject it into a pack.
  for (const item of proposals) assert.ok(item.confidence <= 0.5, `${item.kind} is too confident`);
  // Strongest first.
  assert.deepEqual(proposals.map((item) => item.observations), [...proposals.map((item) => item.observations)].sort((a, b) => b - a));
});

test("proposals hold back where the evidence does not reach", () => {
  // A correction before the agent has done anything is a request, not a rebuke.
  assert.deepEqual(proposeInstincts({ events: log(user("Don't use tabs")) }).proposals.filter((item) => item.kind === "correction"), []);
  assert.equal(proposeInstincts({ events: log(tool("ls"), user("Don't use tabs")) }).proposals[0].kind, "correction");

  // A failure seen once is an incident; the threshold is what makes it a pattern.
  const once = proposeInstincts({ events: log(fail("a", "Error: boom"), tool("b")) });
  assert.equal(once.proposals.some((item) => item.kind === "resolved_error"), false);
  assert.equal(PROPOSAL_THRESHOLDS.error, 2);

  // A failure nothing cleared proposes nothing: there is no action to take.
  const unresolved = proposeInstincts({ events: log(fail("a", "Error: boom"), fail("a", "Error: boom")) });
  assert.equal(unresolved.proposals.some((item) => item.kind === "resolved_error"), false);

  // And the command that kept failing is never proposed as the fix.
  const looped = proposeInstincts({ events: log(fail("npm t", "Error: boom"), fail("npm t", "Error: boom"), tool("npm t"), tool("npm ci")) });
  assert.equal(looped.proposals.find((item) => item.kind === "resolved_error").action, "run `npm ci`");

  // Two runs of a command are a coincidence; three are a habit.
  assert.equal(proposeInstincts({ events: log(tool("make"), tool("make")) }).proposals.some((item) => item.kind === "repeated_command"), false);
  assert.equal(proposeInstincts({ events: log(tool("make"), tool("make"), tool("make")) }).proposals[0].kind, "repeated_command");

  // Nothing at all, and events the hook never writes, are both empty.
  assert.deepEqual(proposeInstincts().proposals, []);
  assert.deepEqual(proposeInstincts({ events: [{ k: "thinking", t: "hmm" }, null] }).signals.events, 0);
});

test("the same rule stated twice is one proposal with twice the evidence", () => {
  const { proposals } = proposeInstincts({
    projectName: "atlas",
    events: log(user("Never commit generated files"), tool("git status"), user("Never commit generated files"))
  });
  const rule = proposals.filter((item) => item.action === "Never commit generated files");
  assert.equal(rule.length, 1);
  assert.equal(rule[0].observations, 2);
  assert.equal(proposeInstincts({ events: log(tool("a"), tool("b"), tool("a"), tool("b")), limit: 1 }).proposals.length, 1);
});
