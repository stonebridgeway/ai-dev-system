import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  FINDING_FIELDS,
  analyzeChangeSet,
  collectChangeSet,
  findInterfaceSignals,
  findSecretsInLine,
  parseAddedLines,
  renderChangeHygieneMarkdown,
  verifyChangeHygiene
} from "./change-hygiene.mjs";

// Fixture secrets are assembled at runtime so the repository's own secret scan
// never sees a literal token in this file.
const fakeAwsKey = ["AKIA", "IOSFODNN7EXAMPL", "E"].join("");
const fakeGithubToken = ["ghp_", "a".repeat(36)].join("");
const fakeAssignment = ["password", " = ", "\"correct-horse-battery-staple\""].join("");

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function gitFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-hygiene-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.js"), "export const app = 1;\nexport const two = 2;\n");
  await fs.writeFile(path.join(root, "README.md"), "# fixture\n");
  runGit(root, ["init", "-q"]);
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=Hygiene", "-c", "user.email=hygiene@example.invalid", "commit", "-q", "-m", "init"]);
  return root;
}

test("findSecretsInLine detects real secrets and ignores placeholders", () => {
  assert.deepEqual(findSecretsInLine(`const key = "${fakeAwsKey}";`).map((hit) => hit.id), ["aws_access_key"]);
  assert.deepEqual(findSecretsInLine(`Authorization: token ${fakeGithubToken}`).map((hit) => hit.id), ["github_token"]);
  assert.equal(findSecretsInLine(fakeAssignment).length, 1);
  assert.equal(findSecretsInLine(fakeAssignment)[0].masked.includes("correct-horse"), false);
  assert.equal(findSecretsInLine("password = process.env.PASSWORD").length, 0);
  assert.equal(findSecretsInLine("api_key: \"<your-api-key>\"").length, 0);
  assert.equal(findSecretsInLine("token = \"REPLACE_ME\"").length, 0);
  assert.equal(findSecretsInLine("secret: \"${SECRET}\"").length, 0);
});

test("parseAddedLines tracks new-file line numbers across hunks and skips deletions", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,0 +2,2 @@",
    "+added two",
    "+added three",
    "@@ -10 +12 @@",
    "-old",
    "+replacement",
    "diff --git a/gone.js b/gone.js",
    "--- a/gone.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/img.png b/img.png",
    "Binary files differ",
    ""
  ].join("\n");
  const parsed = parseAddedLines(diff);
  assert.deepEqual([...parsed.keys()], ["src/a.js"]);
  assert.deepEqual(parsed.get("src/a.js"), [
    { line: 2, text: "added two" },
    { line: 3, text: "added three" },
    { line: 12, text: "replacement" }
  ]);
});

test("analyzeChangeSet reports leftovers, secrets, protected configs, and missing tests", () => {
  const result = analyzeChangeSet({
    files: [
      { path: "src/service.ts", kind: "modified", added: [
        { line: 3, text: "  console.log(\"debug\")" },
        { line: 4, text: "  debugger" },
        { line: 5, text: "  } catch (error) {}" },
        { line: 6, text: "  // TODO clean this up" },
        { line: 7, text: `  const secret = "${fakeGithubToken}";` },
        { line: 8, text: "<<<<<<< HEAD" }
      ] },
      { path: "src/service.test.ts", kind: "untracked", added: [{ line: 1, text: "it.only(\"works\", () => {})" }] },
      { path: ".eslintrc.json", kind: "modified", added: [{ line: 1, text: "{ \"rules\": {} }" }] },
      { path: ".env", kind: "untracked", added: [], skipped: "secret file" },
      { path: "src/handler.py", kind: "modified", added: [
        { line: 1, text: "except Exception:" },
        { line: 2, text: "    pass" },
        { line: 3, text: "breakpoint()" }
      ] }
    ]
  }, { lineCounts: { "src/service.ts": 950 } });
  const rules = new Set(result.findings.map((item) => item.rule));
  for (const expected of [
    "console_log", "debugger_statement", "empty_catch", "todo_without_reference", "secret:github_token",
    "merge_conflict_marker", "test_only", "protected_config_changed", "secret_file_in_change_set",
    "bare_except_pass", "breakpoint_call", "large_file", "sources_without_matching_test"
  ]) {
    assert.ok(rules.has(expected), `missing finding ${expected}`);
  }
  assert.equal(result.status, "block");
  assert.equal(result.findings[0].severity, "block");
  assert.ok(result.summary.block >= 5);
  assert.match(renderChangeHygieneMarkdown(result), /\[block\] merge_conflict_marker: `src\/service\.ts:8`/);

  const clean = analyzeChangeSet({ files: [{ path: "src/ok.ts", kind: "modified", added: [{ line: 1, text: "export const ok = true;" }] }] });
  assert.equal(clean.status, "warn");
  assert.deepEqual(clean.findings.map((item) => item.rule).sort(), ["docs_stale", "no_test_changes"]);
  const withTests = analyzeChangeSet({ files: [
    { path: "src/ok.ts", kind: "modified", added: [{ line: 1, text: "export const ok = true;" }] },
    { path: "src/ok.test.ts", kind: "modified", added: [{ line: 1, text: "test(\"ok\", () => {});" }] },
    { path: "README.md", kind: "modified", added: [{ line: 9, text: "`ok` is exported for callers." }] }
  ] });
  assert.equal(withTests.status, "pass");
  assert.equal(renderChangeHygieneMarkdown(withTests).includes("No hygiene findings"), true);
});

test("every finding uses the documented { rule, severity, file, line, message, excerpt } shape", () => {
  const result = analyzeChangeSet({
    files: [
      { path: "src/service.ts", kind: "modified", added: [
        { line: 4, text: "console.log(\"debug\");" },
        { line: 5, text: `const token = "${fakeGithubToken}";` },
        { line: 6, text: "<<<<<<< HEAD" }
      ] },
      { path: ".eslintrc.json", kind: "modified", added: [{ line: 1, text: "{ \"rules\": {} }" }] },
      { path: ".env", kind: "untracked", added: [], skipped: "secret file" }
    ]
  }, { lineCounts: { "src/service.ts": 950 } });

  assert.ok(result.findings.length >= 6);
  const severities = new Set(["block", "warn", "info"]);
  for (const item of result.findings) {
    assert.deepEqual(Object.keys(item).slice(0, FINDING_FIELDS.length), [...FINDING_FIELDS],
      `finding ${item.rule ?? "?"} must start with the canonical fields`);
    assert.equal(typeof item.rule, "string");
    assert.ok(item.rule.length > 0);
    assert.ok(severities.has(item.severity), `unknown severity ${item.severity}`);
    assert.equal(typeof item.file, "string");
    assert.equal(typeof item.line, "number");
    assert.ok(Number.isInteger(item.line) && item.line >= 0);
    assert.equal(typeof item.message, "string");
    assert.ok(item.message.length > 0);
    assert.equal(typeof item.excerpt, "string");
    for (const legacy of ["code", "path"]) {
      assert.equal(legacy in item, false, `finding ${item.rule} still carries the old field ${legacy}`);
    }
    for (const key of Object.keys(item).slice(FINDING_FIELDS.length)) {
      assert.ok(["files"].includes(key), `unexpected extra finding field ${key}`);
    }
  }

  const lineBound = result.findings.find((item) => item.rule === "console_log");
  assert.equal(lineBound.file, "src/service.ts");
  assert.equal(lineBound.line, 4);
  assert.equal(lineBound.excerpt, "console.log(\"debug\");");
  const fileBound = result.findings.find((item) => item.rule === "secret_file_in_change_set");
  assert.equal(fileBound.file, ".env");
  assert.equal(fileBound.line, 0);
  assert.equal(fileBound.excerpt, "");
  const changeSetWide = result.findings.find((item) => item.rule === "no_test_changes");
  assert.equal(changeSetWide.file, "");
  assert.deepEqual(changeSetWide.files, ["src/service.ts"]);
});

test("collectChangeSet and verifyChangeHygiene use git added lines and untracked files", async (t) => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, "src", "app.js"), "export const app = 1;\nconsole.log(\"x\");\nexport const two = 2;\n");
  await fs.writeFile(path.join(root, "src", "new.js"), `export const token = "${fakeAwsKey}";\n`);
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");

  const changeSet = await collectChangeSet(root);
  assert.equal(changeSet.git, true);
  assert.deepEqual(changeSet.files.map((file) => `${file.kind}:${file.path}`), [
    "untracked:.env", "modified:src/app.js", "untracked:src/new.js"
  ]);
  assert.deepEqual(changeSet.files[1].added, [{ line: 2, text: "console.log(\"x\");" }]);
  assert.equal(changeSet.files[0].skipped, "secret file");

  const result = await verifyChangeHygiene(root);
  assert.equal(result.status, "block");
  const rules = result.findings.map((item) => item.rule);
  assert.ok(rules.includes("secret:aws_access_key"));
  assert.ok(rules.includes("secret_file_in_change_set"));
  assert.ok(rules.includes("console_log"));
  assert.deepEqual(result.files, [".env", "src/app.js", "src/new.js"]);

  // Committed work compared against an explicit base ref is still covered.
  await fs.rm(path.join(root, ".env"));
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=Hygiene", "-c", "user.email=hygiene@example.invalid", "commit", "-q", "-m", "feat: work"]);
  const head = await verifyChangeHygiene(root);
  assert.equal(head.findings.length, 0, "nothing uncommitted");
  const branch = await verifyChangeHygiene(root, { baseRef: "HEAD~1" });
  assert.ok(branch.findings.some((item) => item.rule === "secret:aws_access_key"));

  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "change-hygiene-plain-"));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  const nonGit = await verifyChangeHygiene(plain);
  assert.equal(nonGit.git, false);
  assert.equal(nonGit.status, "pass");
});

test("findInterfaceSignals separates declarations from ordinary code", () => {
  assert.deepEqual(findInterfaceSignals("export function parse(input) {", "js"), ["export"]);
  assert.deepEqual(findInterfaceSignals("export { parse };", "js"), ["export"]);
  assert.deepEqual(findInterfaceSignals("module.exports = { parse };", "js"), ["export"]);
  assert.deepEqual(findInterfaceSignals("def parse(text):", "py"), ["export"]);
  assert.deepEqual(findInterfaceSignals("pub fn parse(text: &str) {", "rs"), ["export"]);
  assert.deepEqual(findInterfaceSignals("func Parse(text string) error {", "go"), ["export"]);
  assert.deepEqual(findInterfaceSignals("        inputSchema: { type: \"object\" },", "js"), ["tool_schema"]);
  assert.deepEqual(findInterfaceSignals("  parser.add_argument(\"--strict\")", "py"), ["cli_flag"]);
  assert.deepEqual(findInterfaceSignals("if (process.argv.includes(\"--check\")) {", "js"), ["cli_flag"]);

  // A body line, a private helper and a flag passed to someone else's program
  // are not the project's interface.
  assert.deepEqual(findInterfaceSignals("  const parsed = parse(input);", "js"), []);
  assert.deepEqual(findInterfaceSignals("def _helper(text):", "py"), []);
  assert.deepEqual(findInterfaceSignals("    def method(self):", "py"), []);
  assert.deepEqual(findInterfaceSignals("func parse(text string) error {", "go"), []);
  assert.deepEqual(findInterfaceSignals("await git(root, [\"diff\", \"--no-color\"]);", "js"), []);
});

test("docs_stale fires when the public interface moves and no document follows", () => {
  const stale = analyzeChangeSet({ files: [
    { path: "src/api.ts", kind: "modified", added: [{ line: 3, text: "export function publish(payload) {" }] },
    { path: "scripts/cli.mjs", kind: "modified", added: [{ line: 12, text: "if (args.includes(\"--dry-run\")) {" }] },
    { path: "src/api.test.ts", kind: "modified", added: [{ line: 1, text: "test(\"publish\", () => {});" }] }
  ] });
  const finding = stale.findings.find((item) => item.rule === "docs_stale");
  assert.equal(finding.severity, "warn");
  assert.equal(finding.file, "");
  assert.equal(finding.line, 0);
  assert.match(finding.message, /exports, CLI flags/);
  assert.deepEqual(finding.files, ["src/api.ts", "scripts/cli.mjs"]);
  assert.equal(stale.summary.interface_files, 2);
  assert.equal(stale.summary.documentation_files, 0);

  const documented = analyzeChangeSet({ files: [
    { path: "src/api.ts", kind: "modified", added: [{ line: 3, text: "export function publish(payload) {" }] },
    { path: "src/api.test.ts", kind: "modified", added: [{ line: 1, text: "test(\"publish\", () => {});" }] },
    { path: "docs/api.md", kind: "modified", added: [{ line: 20, text: "`publish(payload)` sends the payload." }] }
  ] });
  assert.equal(documented.findings.some((item) => item.rule === "docs_stale"), false);
  assert.equal(documented.summary.documentation_files, 1);

  // Tests, vendored trees and internal edits never carry the interface.
  const internal = analyzeChangeSet({ files: [
    { path: "src/api.test.ts", kind: "modified", added: [{ line: 1, text: "export const fixture = 1;" }] },
    { path: "node_modules/dep/index.js", kind: "modified", added: [{ line: 1, text: "export const dep = 1;" }] },
    { path: "src/api.ts", kind: "modified", added: [{ line: 9, text: "  return payload.id;" }] }
  ] });
  assert.equal(internal.findings.some((item) => item.rule === "docs_stale"), false);
  assert.equal(internal.summary.interface_files, 0);
});
