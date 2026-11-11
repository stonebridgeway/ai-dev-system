import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceVerdict,
  coverageReporterFailed,
  renderAcceptanceReport,
  summarizeAcceptanceRun,
  testFailureCount
} from "./acceptance.mjs";

// The two shapes the gate actually produces, verbatim.
const CLEAN = ["# tests 942", "# pass 935", "# fail 0", "# skipped 7"].join("\n");
const REPORTER = [
  "# tests 942",
  "# pass 935",
  "# fail 0",
  "Warning: Could not report code coverage. SyntaxError: Unexpected end of JSON input"
].join("\n");
const BROKEN = ["# tests 942", "# pass 933", "# fail 2"].join("\n");

test("a run is read by what failed, not by whether something did", () => {
  assert.deepEqual(summarizeAcceptanceRun({ exitCode: 0, output: CLEAN }), {
    ok: true, test_failures: 0, coverage_reporter_failed: false, kind: "passed"
  });
  // Exit 1 with no failing test is the reporter, and saying "1 failure"
  // without saying which kind is what made the number meaningless.
  assert.equal(summarizeAcceptanceRun({ exitCode: 1, output: REPORTER }).kind, "coverage reporter");
  assert.equal(summarizeAcceptanceRun({ exitCode: 1, output: BROKEN }).kind, "tests failed");
  assert.equal(summarizeAcceptanceRun({ exitCode: 1, output: BROKEN }).test_failures, 2);
  // A run that died before any test body ran has no `# fail` line at all.
  assert.equal(summarizeAcceptanceRun({ exitCode: 1, output: "npm ERR! missing script" }).kind, "failed before the tests");
  assert.equal(testFailureCount("nothing here"), null);
  assert.equal(coverageReporterFailed(REPORTER), true);
});

test("the report ends in the line the project's rule asks for", () => {
  const runs = [
    { ok: true, kind: "passed", test_failures: 0, duration_ms: 31_000 },
    { ok: false, kind: "coverage reporter", test_failures: 0, duration_ms: 30_000 },
    { ok: true, kind: "passed", test_failures: 0 }
  ];
  const text = renderAcceptanceReport(runs);
  assert.match(text, /^✓ run  1 \(31s\): passed$/m);
  assert.match(text, /^✗ run  2 \(30s\): coverage reporter$/m);
  assert.match(text, /^1 failure out of 3$/m);
  assert.match(text, /None of the failures is a failing test: coverage reporter\./);

  const withRealFailures = renderAcceptanceReport([
    { ok: false, kind: "tests failed", test_failures: 2 },
    { ok: true, kind: "passed", test_failures: 0 }
  ]);
  assert.match(withRealFailures, /^1 failure out of 2$/m);
  assert.match(withRealFailures, /With failing tests: 1\./);
});

test("the verdict separates a failure of the code from a failure of the run", () => {
  const reporterOnly = [{ ok: true, kind: "passed" }, { ok: false, kind: "coverage reporter" }];
  assert.deepEqual(acceptanceVerdict(reporterOnly), { passed: false, failed_runs: 1, failing_tests: 0 });
  assert.deepEqual(acceptanceVerdict([{ ok: true, kind: "passed" }]), { passed: true, failed_runs: 0, failing_tests: 0 });
  assert.deepEqual(
    acceptanceVerdict([{ ok: false, kind: "tests failed" }, { ok: false, kind: "coverage reporter" }]),
    { passed: false, failed_runs: 2, failing_tests: 1 }
  );
});

test("the failure count is read from both runner spellings", () => {
  // Node 22 writes TAP comments, Node 24 an info line. Reading only the first
  // turned every Node 24 run into "failed before the tests": measured on
  // Windows with Node 24.19, ten runs each carrying two real test failures were
  // all classified as having failed before any test ran.
  assert.equal(testFailureCount("# tests 967\n# pass 965\n# fail 2\n# skipped 0"), 2);
  assert.equal(testFailureCount("ℹ tests 967\nℹ pass 965\nℹ fail 2\nℹ skipped 0"), 2);
  assert.equal(testFailureCount("ℹ fail 0"), 0);
  assert.equal(testFailureCount("nothing of the sort"), null);
  assert.equal(testFailureCount(undefined), null);
});

test("a Node 24 run with failing tests is called a test failure, not a mystery", () => {
  const run = summarizeAcceptanceRun({
    exitCode: 1,
    output: "ℹ tests 967\nℹ pass 965\nℹ fail 2\nℹ skipped 0"
  });
  assert.equal(run.kind, "tests failed");
  assert.equal(run.test_failures, 2);
  assert.equal(run.ok, false);
});

test("a count that only looks like the line is not read as one", () => {
  assert.equal(testFailureCount("the log says # fail 5 somewhere inline"), null);
  assert.equal(testFailureCount("# failures 5"), null);
});
