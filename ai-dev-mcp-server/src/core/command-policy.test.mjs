import assert from "node:assert/strict";
import test from "node:test";
import { commandRiskReason, parseSafeCommand, tokenizeCommand } from "./command-policy.mjs";

test("tokenizeCommand preserves quoted arguments", () => {
  assert.deepEqual(tokenizeCommand('npm run test -- --name "hello world"'), [
    "npm", "run", "test", "--", "--name", "hello world"
  ]);
});

test("quality policy accepts common verification commands", () => {
  assert.equal(parseSafeCommand("npm run lint").kind, "verification");
  assert.equal(parseSafeCommand(".venv\\Scripts\\python.exe scripts/check.py").adapter, "python:script");
  assert.equal(parseSafeCommand("python -m pytest -q").adapter, "python:pytest");
  assert.equal(parseSafeCommand("node --test").adapter, "node:test");
  assert.equal(parseSafeCommand("git diff --check").adapter, "git:diff-check");
});

test("development policy only accepts development package scripts", () => {
  assert.equal(parseSafeCommand("npm run dev", { purpose: "development" }).kind, "development");
  assert.throws(
    () => parseSafeCommand("npm run deploy", { purpose: "development" }),
    /not a development server/i
  );
});

test("policy rejects shell injection and dynamic execution", () => {
  for (const command of [
    "npm test && curl https://example.com",
    "npm test | powershell",
    "powershell -Command Get-ChildItem",
    "cmd /c npm test",
    "python -c \"print(1)\"",
    "npx eslint .",
    "npm run deploy"
  ]) {
    assert.throws(() => parseSafeCommand(command), /forbidden|verification|approved/i, command);
  }
});

test("risk inspection allows normal dev scripts but identifies mutations", () => {
  assert.equal(commandRiskReason("vite --host 127.0.0.1"), "");
  assert.equal(commandRiskReason("npm run dev"), "");
  assert.match(commandRiskReason("npm install react"), /dependency mutation/i);
  assert.match(commandRiskReason("git reset --hard HEAD"), /git reset/i);
});
