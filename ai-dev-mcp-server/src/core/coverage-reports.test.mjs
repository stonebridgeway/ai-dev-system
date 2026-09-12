import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  guessFormat,
  lineRanges,
  normalizeReportPath,
  parseCobertura,
  parseGoCover,
  parseIstanbul,
  parseLcov,
  rankCoverageGaps,
  readCoverageReport,
  summarizeCoverage
} from "./coverage-reports.mjs";

const LCOV = [
  "TN:",
  "SF:/repo/src/router.ts",
  "FN:12,resolve",
  "FNDA:0,resolve",
  "FN:40,render",
  "FNDA:7,render",
  "DA:12,0",
  "DA:13,0",
  "DA:14,0",
  "DA:40,7",
  "LF:4",
  "LH:1",
  "BRF:4",
  "BRH:2",
  "end_of_record",
  "SF:src/index.ts",
  "DA:1,3",
  "LF:1",
  "LH:1",
  "end_of_record",
  ""
].join("\n");

test("lcov gives lines, functions and branches, with paths relative to the project", () => {
  const files = parseLcov(LCOV).map((file) => ({ ...file, path: normalizeReportPath("/repo", file.path) }));
  assert.deepEqual(files.map((file) => file.path), ["src/router.ts", "src/index.ts"]);
  assert.deepEqual(files[0].lines, { found: 4, hit: 1 });
  assert.deepEqual(files[0].uncovered_lines, [12, 13, 14]);
  assert.deepEqual(files[0].uncovered_functions, [{ name: "resolve", line: 12 }]);
  assert.deepEqual(files[0].branches, { found: 4, hit: 2 });
  assert.deepEqual(files[1].uncovered_lines, []);

  const totals = summarizeCoverage(files);
  assert.equal(totals.files, 2);
  assert.deepEqual(totals.lines, { found: 5, hit: 2 });
  assert.equal(totals.line_percent, 40);
  assert.equal(totals.uncovered_functions, 1);
  // Nothing to measure reads as covered rather than as zero.
  assert.equal(summarizeCoverage([]).line_percent, 100);
});

test("istanbul, cobertura and go coverprofiles land in the same shape", () => {
  const istanbul = parseIstanbul({
    "/repo/src/a.js": {
      path: "/repo/src/a.js",
      statementMap: { 0: { start: { line: 5 } }, 1: { start: { line: 6 } } },
      s: { 0: 2, 1: 0 },
      fnMap: { 0: { name: "parse", decl: { start: { line: 5 } } } },
      f: { 0: 0 },
      branchMap: { 0: {} },
      b: { 0: [1, 0] }
    }
  });
  assert.deepEqual(istanbul[0].uncovered_lines, [6]);
  assert.deepEqual(istanbul[0].uncovered_functions, [{ name: "parse", line: 5 }]);
  assert.deepEqual(istanbul[0].branches, { found: 2, hit: 1 });

  const cobertura = parseCobertura(`<?xml version="1.0"?>
<coverage line-rate="0.5"><packages><package><classes>
<class filename="app/service.py" line-rate="0.5">
  <methods>
    <method name="charge" signature=""><lines><line number="10" hits="0"/><line number="11" hits="0"/></lines></method>
    <method name="refund" signature=""><lines><line number="20" hits="4"/></lines></method>
  </methods>
  <lines><line number="10" hits="0"/><line number="11" hits="0"/><line number="20" hits="4"/></lines>
</class>
</classes></package></packages></coverage>`);
  assert.equal(cobertura.length, 1);
  assert.equal(cobertura[0].path, "app/service.py");
  assert.deepEqual(cobertura[0].lines, { found: 3, hit: 1 }, "a method's lines are the class's lines, counted once");
  assert.deepEqual(cobertura[0].uncovered_lines, [10, 11]);
  assert.deepEqual(cobertura[0].uncovered_functions, [{ name: "charge", line: 10 }]);

  const go = parseGoCover([
    "mode: set",
    "example.com/app/store.go:10.20,14.2 3 0",
    "example.com/app/store.go:20.2,21.5 1 4",
    "garbage line that is not a block"
  ].join("\n"));
  assert.equal(go.length, 1);
  assert.equal(go[0].path, "example.com/app/store.go");
  assert.deepEqual(go[0].lines, { found: 4, hit: 1 }, "go counts statements, not lines");
  assert.deepEqual(go[0].uncovered_lines, [10, 11, 12, 13, 14]);
});

test("line ranges fold what is consecutive and stop at the limit", () => {
  assert.deepEqual(lineRanges([12, 13, 14, 20, 31, 32]), ["12-14", "20", "31-32"]);
  assert.deepEqual(lineRanges([5, 5, 4]), ["4-5"]);
  assert.deepEqual(lineRanges([]), []);
  assert.deepEqual(lineRanges([1, 3, 5, 7], 2), ["1", "3"]);
  assert.deepEqual(lineRanges([0, -2, null, "x"]), []);
});

test("ranking puts the files the change touched first, and says so when it touched none", () => {
  const files = [
    { path: "src/router.ts", lines: { found: 10, hit: 4 }, branches: { found: 0, hit: 0 }, uncovered_lines: [1, 2, 3, 4, 5, 6], uncovered_functions: [{ name: "resolve", line: 1 }] },
    { path: "src/legacy.ts", lines: { found: 100, hit: 20 }, branches: { found: 0, hit: 0 }, uncovered_lines: Array.from({ length: 80 }, (item, index) => index + 1), uncovered_functions: [] },
    { path: "src/done.ts", lines: { found: 5, hit: 5 }, branches: { found: 0, hit: 0 }, uncovered_lines: [], uncovered_functions: [] }
  ];

  const changed = rankCoverageGaps({ files, changedFiles: ["src/router.ts"] });
  assert.equal(changed.scope, "changed");
  assert.equal(changed.changed_files_in_report, 1);
  assert.deepEqual(changed.gaps.map((gap) => gap.file), ["src/router.ts"]);
  assert.equal(changed.gaps[0].line_percent, 40);
  assert.deepEqual(changed.gaps[0].ranges, ["1-6"]);

  // With nothing in common, the whole project is the honest answer.
  const wide = rankCoverageGaps({ files, changedFiles: ["docs/readme.md"] });
  assert.equal(wide.scope, "project");
  assert.deepEqual(wide.gaps.map((gap) => gap.file), ["src/legacy.ts", "src/router.ts"], "the bigger gap leads when nothing is changed");
  assert.equal(wide.gaps.some((gap) => gap.file === "src/done.ts"), false, "a covered file is not a gap");

  // A go import path and a repository path are the same file.
  const suffix = rankCoverageGaps({ files: [{ ...files[0], path: "example.com/app/src/router.ts" }], changedFiles: ["src/router.ts"] });
  assert.equal(suffix.gaps[0].changed, true);

  const all = rankCoverageGaps({ files, changedFiles: ["src/router.ts"], changedOnly: false });
  assert.deepEqual(all.gaps.map((gap) => gap.file), ["src/legacy.ts", "src/router.ts"]);
});

test("readCoverageReport finds a report by convention, by name, and not at all", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-report-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await readCoverageReport(root), null);

  await fs.mkdir(path.join(root, "coverage"), { recursive: true });
  await fs.writeFile(path.join(root, "coverage", "lcov.info"), LCOV.replaceAll("/repo/", `${root}/`));
  const found = await readCoverageReport(root);
  assert.equal(found.format, "lcov");
  assert.equal(found.path, "coverage/lcov.info");
  assert.deepEqual(found.files.map((file) => file.path), ["src/router.ts", "src/index.ts"]);
  assert.ok(Date.parse(found.generated_at) > 0);

  await fs.writeFile(path.join(root, "custom.out"), "mode: set\nexample.com/a.go:1.1,2.2 1 0\n");
  const named = await readCoverageReport(root, { reportPath: "custom.out" });
  assert.equal(named.format, "go");
  assert.equal(named.files[0].path, "example.com/a.go");
  assert.equal(await readCoverageReport(root, { reportPath: "missing.info" }), null);

  // An empty or unparseable file is not a report, and the search moves on.
  await fs.writeFile(path.join(root, "coverage", "coverage-final.json"), "{ not json");
  assert.equal((await readCoverageReport(root)).format, "lcov");
  assert.equal(guessFormat("coverage/cobertura-coverage.xml"), "cobertura");
  assert.equal(guessFormat("anything"), "lcov");
});
