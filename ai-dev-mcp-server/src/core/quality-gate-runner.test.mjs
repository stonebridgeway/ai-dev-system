import assert from "node:assert/strict";
import test from "node:test";
import {
  QUALITY_GATE_DEFAULT_MAX_COMMANDS,
  QUALITY_GATE_DEFAULT_TIMEOUT_MS,
  QUALITY_GATE_MAX_COMMANDS,
  QUALITY_GATE_MAX_TIMEOUT_MS,
  cleanQualityCommand,
  diagnoseQualityCommandFailure,
  engineAgreement,
  engineMatches,
  parseEngineRange,
  normalizeQualityLabel,
  parseQualityGateCommands,
  qualityCommandBlockReason,
  qualityGateMaxCommands,
  qualityGateReportMarkdown,
  qualityGateStatus,
  qualityGateTimeoutMs,
  selectQualityCommands,
  shouldSkipQualityLabel
} from "./quality-gate-runner.mjs";

const NO_DIAGRAMS = { enabled: false };

test("labels compare on their letters and digits alone", () => {
  assert.equal(normalizeQualityLabel("Type-check"), "typecheck");
  assert.equal(normalizeQualityLabel("  TEST  "), "test");
  assert.equal(normalizeQualityLabel("Тест"), "тест");
  assert.equal(normalizeQualityLabel("Lint [cwd=services/api]"), "lint");
  assert.equal(normalizeQualityLabel(undefined), "");
});

test("a command loses its markdown backticks", () => {
  assert.equal(cleanQualityCommand("  `npm test`  "), "npm test");
  assert.equal(cleanQualityCommand("``npm test``"), "npm test");
  assert.equal(cleanQualityCommand(null), "");
});

test("bullets are parsed with and without a label", () => {
  const commands = parseQualityGateCommands([
    "# Quality Gate",
    "",
    "- Test: `npm test`",
    "* Lint: `eslint .`",
    "- `tsc --noEmit`",
    "- Nothing: Not detected",
    "- prose with no command"
  ].join("\n"));
  assert.deepEqual(commands.map((item) => [item.label, item.command, item.source]), [
    ["Test", "npm test", "markdown bullet"],
    ["Lint", "eslint .", "markdown bullet"],
    ["Command", "tsc --noEmit", "markdown bullet"]
  ]);
});

test("a table row carries its own working directory, and the header is not a command", () => {
  const commands = parseQualityGateCommands([
    "| Task | Command | CWD |",
    "| --- | --- | --- |",
    "| Subdir check | `npm test` | sub |",
    "| Root check | `npm run lint` | |"
  ].join("\n"));
  assert.deepEqual(commands.map((item) => [item.label, item.command, item.cwd, item.source]), [
    ["Subdir check", "npm test", "sub", "markdown table"],
    ["Root check", "npm run lint", "", "markdown table"]
  ]);
});

test("a working directory written into the label is lifted out of it", () => {
  const [command] = parseQualityGateCommands("- Lint [cwd=services\\api]: `eslint .`");
  assert.equal(command.label, "Lint");
  assert.equal(command.cwd, "services/api");
});

test("the same command is kept once per label and working directory", () => {
  const commands = parseQualityGateCommands([
    "- Test: `npm test`",
    "- Test: `npm test`",
    "- Smoke: `npm test`",
    "| Test | `npm test` | sub |"
  ].join("\n"));
  assert.deepEqual(commands.map((item) => `${item.label}:${item.cwd}`), ["Test:", "Smoke:", "Test:sub"]);
});

test("labels that start, deploy or mutate are skipped by default", () => {
  for (const label of ["install", "Dev", "deploy", "MIGRATE", "seed", "manual"]) {
    assert.equal(shouldSkipQualityLabel(label), true, label);
  }
  for (const label of ["test", "lint", "typecheck", "build", ""]) {
    assert.equal(shouldSkipQualityLabel(label), false, label);
  }
});

test("the command policy's refusal is reported as the block reason", () => {
  assert.equal(qualityCommandBlockReason("npm run test"), "");
  assert.match(qualityCommandBlockReason("rm -rf /"), /\S/);
  assert.match(qualityCommandBlockReason('node -e "require(0)"'), /not approved for quality gates/);
});

test("with no labels everything but the side-effectful labels runs", () => {
  const parsed = parseQualityGateCommands("- Test: `npm test`\n- Deploy: `./deploy.sh`\n- Lint: `eslint .`");
  const { selected, skipped } = selectQualityCommands(parsed, [], 10);
  assert.deepEqual(selected.map((item) => item.label), ["Test", "Lint"]);
  assert.deepEqual(skipped.map((item) => [item.label, item.reason]), [["Deploy", "label skipped by default"]]);
});

test("naming labels selects exactly those, default-skipped ones included", () => {
  const parsed = parseQualityGateCommands("- Test: `npm test`\n- Deploy: `./deploy.sh`");
  const { selected, skipped } = selectQualityCommands(parsed, ["deploy"], 10);
  assert.deepEqual(selected.map((item) => item.label), ["Deploy"]);
  assert.deepEqual(skipped.map((item) => item.reason), ["label not selected"]);
  assert.deepEqual(selectQualityCommands(parsed, ["nothing"], 10).selected, []);
});

test("the cap stops selection and says why the rest were left", () => {
  const parsed = parseQualityGateCommands("- Test: `npm test`\n- Lint: `eslint .`\n- Build: `npm run build`");
  const { selected, skipped } = selectQualityCommands(parsed, [], 1);
  assert.deepEqual(selected.map((item) => item.label), ["Test"]);
  assert.deepEqual(skipped.map((item) => item.reason), ["max_commands limit reached", "max_commands limit reached"]);
});

test("the request is clamped into what the gate allows", () => {
  assert.equal(qualityGateMaxCommands(undefined), QUALITY_GATE_DEFAULT_MAX_COMMANDS);
  assert.equal(qualityGateMaxCommands(0), QUALITY_GATE_DEFAULT_MAX_COMMANDS);
  assert.equal(qualityGateMaxCommands(999), QUALITY_GATE_MAX_COMMANDS);
  assert.equal(qualityGateMaxCommands(-5), 1);
  assert.equal(qualityGateMaxCommands(3), 3);

  assert.equal(qualityGateTimeoutMs(undefined), QUALITY_GATE_DEFAULT_TIMEOUT_MS);
  assert.equal(qualityGateTimeoutMs(10), 1000);
  assert.equal(qualityGateTimeoutMs(10 ** 9), QUALITY_GATE_MAX_TIMEOUT_MS);
  assert.equal(qualityGateTimeoutMs(5000), 5000);
});

test("a failing command outranks a blocking diagram spec", () => {
  const failed = [{ status: "failed" }];
  assert.equal(qualityGateStatus({ dryRun: false, parsed: [1], results: failed, blocked: [], diagramSpecs: NO_DIAGRAMS }), "failed");
  assert.equal(qualityGateStatus({ dryRun: false, parsed: [1], results: [{ status: "timed_out" }], blocked: [], diagramSpecs: NO_DIAGRAMS }), "failed");
  assert.equal(qualityGateStatus({ dryRun: false, parsed: [1], results: [{ status: "passed" }], blocked: [], diagramSpecs: { enabled: true, status: "block" } }), "failed");
  // A dry run reports itself even when it selected commands that would fail.
  assert.equal(qualityGateStatus({ dryRun: true, parsed: [1], results: failed, blocked: [], diagramSpecs: NO_DIAGRAMS }), "dry_run");
});

test("the three kinds of nothing-happened are kept apart", () => {
  const base = { dryRun: false, diagramSpecs: NO_DIAGRAMS };
  assert.equal(qualityGateStatus({ ...base, parsed: [], results: [], blocked: [] }), "no_commands");
  assert.equal(qualityGateStatus({ ...base, parsed: [1], results: [], blocked: [{}] }), "blocked");
  assert.equal(qualityGateStatus({ ...base, parsed: [1], results: [], blocked: [] }), "no_commands_run");
});

test("a warning and a survivable block each have their own verdict", () => {
  assert.equal(qualityGateStatus({
    dryRun: false, parsed: [1], results: [{ status: "passed" }], blocked: [], diagramSpecs: { enabled: true, status: "warn" }
  }), "warn");
  assert.equal(qualityGateStatus({
    dryRun: false, parsed: [1], results: [{ status: "passed" }], blocked: [{}], diagramSpecs: NO_DIAGRAMS
  }), "passed_with_blocked");
  assert.equal(qualityGateStatus({
    dryRun: false, parsed: [1], results: [{ status: "passed" }], blocked: [], diagramSpecs: NO_DIAGRAMS
  }), "passed");
  // Diagram specs alone are enough for the run to have done something.
  assert.equal(qualityGateStatus({
    dryRun: false, parsed: [], results: [], blocked: [], diagramSpecs: { enabled: true, status: "pass" }
  }), "no_commands_run");
});

test("the report names every command, and an empty run says so", () => {
  const report = qualityGateReportMarkdown({
    finished_at: "2026-01-01T00:00:00.000Z",
    status: "failed",
    project_path: "/repo",
    results: [{ label: "Test", command: "npm test", status: "failed", exit_code: 1 }],
    blocked: [{ label: "Unsafe", command: "rm -rf /", reason: "not approved" }],
    skipped: [{ label: "Deploy", command: "./deploy.sh", reason: "label skipped by default" }],
    diagram_specs: { enabled: true, pattern: "docs/*.mmd", files: [{ status: "pass", path: "docs/a.mmd", type: "mermaid", warnings: 0 }] }
  });
  assert.match(report, /Updated: 2026-01-01T00:00:00\.000Z/);
  assert.match(report, /\| Test \| \. \| npm test \| failed \| 1 \|/);
  assert.match(report, /## Blocked Commands\n\n- Unsafe: `rm -rf \/` \(not approved\)/);
  assert.match(report, /## Skipped Commands\n\n- Deploy: `\.\/deploy\.sh` \(label skipped by default\)/);
  assert.match(report, /Pattern: `docs\/\*\.mmd`\n\n- pass: `docs\/a\.mmd` \(mermaid; 0 warning\(s\)\)/);

  const empty = qualityGateReportMarkdown({
    finished_at: "t", status: "no_commands", project_path: "/repo",
    results: [], blocked: [], skipped: [], diagram_specs: { enabled: true, pattern: "x", files: [] }
  });
  assert.match(empty, /\| None \| \. \|  \| no commands run \|  \|/);
  assert.match(empty, /- No matching diagram specifications\./);
  assert.equal(/## Blocked Commands/.test(empty), false);
});

// `node --test test/` fails on its own under Node >= 21, and the gate
// passed the failure through without anything that named the cause.
test("a `node --test <directory>` run that never reached a test is diagnosed", () => {
  // What npm actually prints: it echoes the script, and the runner reports the
  // directory as an unresolvable module before any test body runs.
  const npmOutput = [
    "",
    "> repro47@1.0.0 test",
    "> node --test test/",
    "",
    "TAP version 13",
    "# node:internal/modules/cjs/loader:1386",
    "#   throw err;",
    "# Error: Cannot find module '/home/dev/repro47/test'",
    "# Node.js v24.21.0",
    "not ok 1 - test",
    "# fail 1"
  ].join("\n");

  assert.match(
    diagnoseQualityCommandFailure({ command: "npm run test", stdout: npmOutput }),
    /glob patterns.*Use `node --test`/s
  );
  // The same diagnosis when the gate file names the command directly.
  assert.match(
    diagnoseQualityCommandFailure({
      command: "node --test test/",
      stderr: "Error: Cannot find module '/home/dev/repro47/test'"
    }),
    /glob patterns/
  );
  // Windows spells the resolved path with backslashes.
  assert.match(
    diagnoseQualityCommandFailure({
      command: "node --test tests\\",
      stderr: "Error: Cannot find module 'C:\\repo\\tests'"
    }),
    /glob patterns/
  );
});

test("an ordinary failure is left to speak for itself", () => {
  // A test that ran and failed says nothing about globs.
  assert.equal(diagnoseQualityCommandFailure({
    command: "npm test",
    stdout: "not ok 1 - sum\n  AssertionError: 4 !== 5\n# fail 1"
  }), "");
  // A missing dependency is a module Node could not find, but not the operand.
  assert.equal(diagnoseQualityCommandFailure({
    command: "node --test test/",
    stderr: "Error: Cannot find module 'chai'"
  }), "");
  // The glob spelling is what the hint recommends, so it never earns the hint.
  assert.equal(diagnoseQualityCommandFailure({
    command: 'node --test "test/**/*.test.js"',
    stderr: "Error: Cannot find module '/home/dev/repro47/test/**/*.test.js'"
  }), "");
  // A command that is not `node --test` at all.
  assert.equal(diagnoseQualityCommandFailure({
    command: "vitest run test/",
    stderr: "Error: Cannot find module '/home/dev/repro47/test'"
  }), "");
  assert.equal(diagnoseQualityCommandFailure(), "");
});

// The report named the Node that ran the commands and the project named
// the Node it wants, and nothing put the two side by side.
test("the engine ranges projects actually write are read", () => {
  const satisfied = [
    ["20", "v20.11.0"], ["20", "v20.0.0"],
    ["^20", "v20.5.1"], ["^20.1", "v20.9.0"], ["^20.1.2", "v20.1.2"],
    ["~20.1", "v20.1.9"], ["~20", "v20.99.0"],
    [">=20", "v24.0.0"], [">=20", "v20.0.0"], [">20", "v21.0.0"],
    ["<21", "v20.9.9"], ["<=20", "v20.99.0"],
    ["20.x", "v20.9.9"], ["20.X", "v20.0.1"], ["*", "v24.0.0"], ["x", "v18.0.0"],
    ["18 || 20", "v18.1.0"], ["18 || 20", "v20.1.0"],
    [">=18 <21", "v20.0.0"], [">=18 <21", "v18.0.0"],
    [" >=18   <21 ", "v19.4.0"],
    ["^0.2", "v0.2.9"], ["^0.0.3", "v0.0.3"]
  ];
  for (const [range, version] of satisfied) {
    assert.equal(engineMatches(range, version), true, `${range} should accept ${version}`);
  }

  const refused = [
    ["20", "v22.22.2"], ["20", "v19.9.9"],
    ["^20", "v21.0.0"], ["^20.1", "v20.0.9"], ["^20.1.2", "v20.1.1"],
    ["~20.1", "v20.2.0"], ["~20.1", "v20.0.9"],
    [">=20", "v18.20.4"], [">20", "v20.99.99"],
    ["<21", "v21.0.0"], ["<=20", "v21.0.0"],
    ["20.x", "v21.0.0"],
    ["18 || 20", "v22.0.0"], ["18 || 20", "v19.0.0"],
    [">=18 <21", "v22.0.0"], [">=18 <21", "v17.9.9"],
    ["^0.2", "v0.3.0"], ["^0.0.3", "v0.0.4"]
  ];
  for (const [range, version] of refused) {
    assert.equal(engineMatches(range, version), false, `${range} should refuse ${version}`);
  }
});

test("a range this does not read says so instead of guessing", () => {
  // A misparse that invents a warning is worse than the silence it replaced.
  for (const range of ["lts/*", "18 - 20", ">=18 <21 !=19", "node", "", "   ", ">=", "20.x.1", "^", "v"]) {
    assert.equal(engineMatches(range, "v22.0.0"), null, `${JSON.stringify(range)} is not a range this reads`);
    assert.equal(parseEngineRange(range), null);
  }
  assert.equal(engineMatches("20", "not-a-version"), null, "an unreadable running version claims nothing either");
  assert.equal(engineMatches(undefined, "v22.0.0"), null);
});

test("the gate warns about a Node the project did not choose, and stays quiet otherwise", () => {
  const mismatch = engineAgreement({ declared: "20", running: "v22.22.2" });
  assert.equal(mismatch.satisfied, false);
  assert.equal(mismatch.mismatch.declared, "20");
  assert.equal(mismatch.mismatch.running, "v22.22.2");
  assert.match(mismatch.mismatch.message, /engines\.node 20/);
  assert.match(mismatch.mismatch.message, /Node v22\.22\.2/);
  assert.match(mismatch.mismatch.message, /warning/i, "the gate warns; it does not block");

  // The three silences.
  const agreeing = engineAgreement({ declared: "22", running: "v22.22.2" });
  assert.equal(agreeing.satisfied, true);
  assert.equal(agreeing.mismatch, undefined);
  const wide = engineAgreement({ declared: ">=18", running: "v22.22.2" });
  assert.equal(wide.satisfied, true);
  assert.equal(wide.mismatch, undefined);
  assert.equal(engineAgreement({ declared: "", running: "v22.22.2" }), null, "a project with no engines says nothing");
  assert.equal(engineAgreement({ running: "v22.22.2" }), null);

  // Not read is not a mismatch.
  const unread = engineAgreement({ declared: "lts/*", running: "v22.22.2" });
  assert.equal(unread.satisfied, null);
  assert.equal(unread.mismatch, undefined, "an unreadable range raises nothing");
});
