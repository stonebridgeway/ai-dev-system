import assert from "node:assert/strict";
import test from "node:test";
import {
  QUALITY_GATE_DEFAULT_MAX_COMMANDS,
  QUALITY_GATE_DEFAULT_TIMEOUT_MS,
  QUALITY_GATE_MAX_COMMANDS,
  QUALITY_GATE_MAX_TIMEOUT_MS,
  cleanQualityCommand,
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
