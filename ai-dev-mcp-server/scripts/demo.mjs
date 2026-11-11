#!/usr/bin/env node
/**
 * The demo in `docs/DEMO.md`, as something you can watch.
 *
 *   npm run demo
 *
 * It builds a throwaway API project in a temporary folder, runs one real task
 * through the real server - context, routed skills, a planted bug, a refused
 * report, a failing verification, the fix, a passing one, and the pull request
 * text - then deletes everything it made. Nothing touches your repositories or
 * your runtime home: the server and the skill registry check before it run with
 * a runtime home in the temporary folder. A clone
 * with no skill registry yet gets one built, as `npm run setup` builds it.
 *
 * This is also what to record: `docs/DEMO.md` quotes this script's output, so a
 * recording of one `npm run demo` is a recording of the product.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ESC = String.fromCharCode(27);
const plain = process.argv.includes("--no-color") || Boolean(process.env.NO_COLOR);
const paint = (code, text) => (plain ? text : `${ESC}[${code}m${text}${ESC}[0m`);
const dim = (text) => paint("2", text);
const bold = (text) => paint("1", text);
const green = (text) => paint("32", text);
const red = (text) => paint("31", text);
const cyan = (text) => paint("36", text);

let step = 0;
function scene(title, subtitle) {
  step += 1;
  process.stdout.write(`\n${bold(`  ${step}. ${title}`)}\n`);
  process.stdout.write(subtitle ? `${dim(`     ${subtitle}`)}\n\n` : "\n");
}
const say = (text) => process.stdout.write(`     ${text}\n`);
const quote = (text) =>
  process.stdout.write(`${String(text).trimEnd().split("\n").map((line) => dim(`     | ${line}`)).join("\n")}\n`);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-demo-"));
const projectRoot = path.join(tempRoot, "billing-api");
const stateRoot = path.join(tempRoot, "state");

const write = (relative, body) =>
  fs.mkdir(path.dirname(path.join(projectRoot, relative)), { recursive: true })
    .then(() => fs.writeFile(path.join(projectRoot, relative), body, "utf8"));

/** The repository the agent is handed: a tiny API with one route and one test. */
async function buildFixture() {
  await fs.mkdir(path.join(projectRoot, ".ai-dev"), { recursive: true });
  await write("package.json", `${JSON.stringify({ name: "billing-api", private: true, type: "module" }, null, 2)}\n`);
  await write("src/routes.mjs", 'export const routes = {\n  "/invoices": () => ({ status: 200, body: [{ id: 1, total: 4200 }] })\n};\n');
  await write("src/server.mjs", `import { routes } from "./routes.mjs";

export function handle(request) {
  const route = routes[request.path];
  if (!route) return { status: 404, body: "not found" };
  return route(request);
}
`);
  await write("test/routes.test.mjs", `import assert from "node:assert/strict";
import test from "node:test";
import { routes } from "../src/routes.mjs";

test("the invoices route returns invoices", () => {
  assert.equal(routes["/invoices"]().status, 200);
});
`);
  await write(".ai-dev/quality-gate.md", "# Quality Gate\n\n## Commands\n\n- Tests: `node --test`\n");

  const git = (args) => {
    const result = spawnSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", shell: false });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  };
  git(["init", "-b", "main"]);
  git(["add", "."]);
  git(["-c", "user.name=AI Dev Demo", "-c", "user.email=demo@example.invalid", "commit", "-m", "Billing API"]);
}

/** The buggy first attempt: a missing token is waved through instead of rejected. */
const BROKEN_AUTH = `export function authenticate(request) {
  const token = request.headers?.authorization;
  if (token === "Bearer demo-token") return { ok: true };
  return { ok: true, anonymous: true };
}
`;

/** The fix: a missing token is a missing token. */
const FIXED_AUTH = `export function authenticate(request) {
  const token = request.headers?.authorization;
  if (token === "Bearer demo-token") return { ok: true };
  return { ok: false, reason: "missing or invalid token" };
}
`;

async function writeAttempt(auth) {
  await write("src/auth.mjs", auth);
  await write("src/server.mjs", `import { authenticate } from "./auth.mjs";
import { routes } from "./routes.mjs";

export function handle(request) {
  const auth = authenticate(request);
  if (!auth.ok) return { status: 401, body: "unauthorized" };
  const route = routes[request.path];
  if (!route) return { status: 404, body: "not found" };
  return route(request);
}
`);
  await write("test/auth.test.mjs", `import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/server.mjs";

test("a request with no token is rejected", () => {
  assert.equal(handle({ path: "/invoices", headers: {} }).status, 401);
});

test("a request with a valid token is served", () => {
  assert.equal(handle({ path: "/invoices", headers: { authorization: "Bearer demo-token" } }).status, 200);
});
`);
}

// The server gets a runtime home of its own in the temporary folder: the search index it builds, and its claim on
// the index folder, go with the rest instead of into yours. So does the registry check
// before it — a process that loads the server claims the index folder of the home it is given. Every place the
// Codex-era migration takes from a `.codex` folder is named too, as the tests name them: whatever the server
// would move into its home goes when the demo deletes that home.
const runtimeHome = path.join(tempRoot, "home");
const serverEnv = {
  ...process.env,
  AI_DEV_HOME: runtimeHome,
  AI_DEV_STATE_ROOT: stateRoot,
  AI_DEV_SEARCH_INDEX_DIR: path.join(runtimeHome, "cache", "search-index"),
  AI_DEV_ARCHIFY_RECEIPTS_ROOT: path.join(runtimeHome, "state", "archify-receipts"),
  AI_DEV_FRONTEND_QA_ARTIFACT_ROOT: path.join(runtimeHome, "artifacts", "frontend-qa"),
  AI_DEV_ARCHIFY_ARTIFACT_ROOT: path.join(runtimeHome, "artifacts", "archify"),
  BGE_M3_ONNX_DIR: path.join(runtimeHome, "models", "bge-m3-onnx")
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(serverRoot, "src", "server.mjs")],
  cwd: serverRoot,
  env: serverEnv,
  stderr: "pipe"
});
const client = new Client({ name: "ai-dev-demo", version: "1.0.0" }, { capabilities: {} });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return {
    refused: Boolean(result.isError),
    text: result.content?.map((item) => item.text || "").join("\n") ?? "",
    data: result.structuredContent?.result
  };
}

/** @returns {string} The failing part of a quality-gate run, as the gate reported it. */
function failingTests(verification) {
  const gate = verification?.checks?.find((check) => check.type === "quality_gate");
  const run = gate?.result?.results?.find((item) => item.status === "failed");
  if (!run) return "";
  const lines = String(run.stdout || "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("not ok"));
  return [
    ...(start >= 0 ? lines.slice(start, start + 11) : []),
    ...lines.filter((line) => /^# (tests|pass|fail) /.test(line))
  ].join("\n");
}

const checkLine = (verification) =>
  verification.checks.map((check) => `${check.type}: ${check.result.status}`).join(", ");

let exitCode = 0;
try {
  await buildFixture();
  const registry = spawnSync(process.execPath, [path.join(serverRoot, "scripts", "ensure-skill-index.mjs")], { cwd: serverRoot, env: serverEnv, encoding: "utf8", shell: false });
  if (registry.status !== 0) throw new Error(`The skill registry could not be built: ${`${registry.stdout}\n${registry.stderr}`.trim()}`);
  await client.connect(transport);

  process.stdout.write(`\n${bold("  AI Dev System - one task, start to finish")}\n`);
  process.stdout.write(`${dim(`  a throwaway API project in ${projectRoot}`)}\n`);

  scene("You give the agent a task", 'begin_task - "Add authentication to the API"');
  const begun = await call("begin_task", { project_path: projectRoot, task: "Add authentication to the API" });
  const task = begun.data;
  say(`task ${cyan(task.id)} is open`);
  say("");
  say(bold("It loaded the project, without being told about it:"));
  const pack = task.context?.compiled_context ?? "";
  say(`  stack ${cyan((pack.match(/- Stack: (.*)/) ?? [, "unknown"])[1])}, ` +
      `${task.context?.selected_files?.length ?? 0} relevant files read`);
  for (const file of task.context?.selected_files?.slice(0, 3) ?? []) {
    say(dim(`    ${file.path} - ${file.reasons.join(", ")}`));
  }
  say("");
  // Both numbers measured, not written down.
  const library = await call("list_skill_groups", {});
  const total = Number(library.data?.total_skills ?? JSON.parse(library.text || "{}").total_skills);
  say(bold(`It routed ${(task.skills ?? []).length} skills out of ${total.toLocaleString("en-US")} - nobody named them:`));
  for (const skill of task.skills ?? []) {
    say(`  ${green(skill.name)} ${dim(`(${skill.routing_role ?? skill.role})`)}`);
  }
  say("");
  say(bold("And it wrote down what finished has to mean:"));
  for (const criterion of task.acceptance_criteria ?? []) say(dim(`  ${criterion.id} ${criterion.text}`));

  scene("The agent writes the code - and gets it wrong", "checkpoint_task, with a snapshot of the turn");
  await writeAttempt(BROKEN_AUTH);
  const checkpoint = await call("checkpoint_task", {
    task_id: task.id,
    summary: "Added token authentication middleware and covered it with tests.",
    changed_files: ["src/auth.mjs", "src/server.mjs", "test/auth.test.mjs"]
  });
  say(`checkpoint recorded, ${cyan(checkpoint.data.snapshot.snapshot_id)} holds ` +
      `${checkpoint.data.snapshot.file_count} files at commit ${dim(checkpoint.data.snapshot.commit.slice(0, 8))}`);
  say(dim("nothing was written to your branch, stash or index - rollback_task can undo this turn"));

  scene("It tries to talk its way past the problem", "and the completion linter refuses the report");
  const rationalized = await call("checkpoint_task", {
    task_id: task.id,
    summary: "Authentication is done.",
    notes: "One test is failing but it's a pre-existing issue, will fix later."
  });
  say(`${red("REFUSED")} - the report claimed more than the evidence showed`);
  say("");
  quote(rationalized.text.split("\n").slice(0, 4).join("\n"));

  scene("Verification runs the project's own checks", "verify_task");
  const first = await call("verify_task", { task_id: task.id, run_quality: true, run_frontend: false });
  say(`${red("FAILED")} - ${checkLine(first.data.verification)}`);
  say("");
  quote(failingTests(first.data.verification));

  scene("The agent fixes the real bug", "a missing token is now actually rejected");
  await writeAttempt(FIXED_AUTH);
  quote(FIXED_AUTH.split("\n").slice(2, 5).join("\n"));

  scene("Verification again", "verify_task");
  const second = await call("verify_task", { task_id: task.id, run_quality: true, run_frontend: false });
  say(`${green("PASSED")} - ${checkLine(second.data.verification)}`);
  say(dim(`recorded as ${second.data.verification.id}`));

  const pending = (second.data.task?.acceptance_criteria ?? []).filter((item) => item.status === "pending");
  if (pending.length) {
    await call("checkpoint_task", {
      task_id: task.id,
      summary: "Every acceptance criterion is bound to the passing verification.",
      criteria: pending.map((item) => ({
        id: item.id,
        status: "met",
        note: "Covered by the passing verification run.",
        evidence: [second.data.verification.id]
      }))
    });
  }

  scene("Now, and only now, the task can close", "complete_task");
  const completed = await call("complete_task", {
    task_id: task.id,
    summary: "Token authentication added, verified, and covered by tests.",
    write_report: false
  });
  say(`task ${green(completed.data.task.status)}`);
  say(`pull request description written to ${cyan(completed.data.pull_request.path)}`);
  say(dim(`  title: ${completed.data.pull_request.title}`));
  say("");
  const body = await fs.readFile(path.join(projectRoot, ".ai-dev", "pr", `${task.id}.md`), "utf8");
  quote(body.slice(body.indexOf("## Verification"), body.indexOf("## Test plan")));
  say(dim("nothing was pushed and no pull request was opened - both commands are returned as text"));

  process.stdout.write(`\n${bold(green("  Done."))} ${dim("The agent could not have claimed this without the evidence behind it.")}\n`);
  process.stdout.write(`${dim("  Full walkthrough: docs/DEMO.md - your own first task: README.md")}\n\n`);
} catch (error) {
  exitCode = 1;
  process.stderr.write(`\n${red("  The demo did not finish:")} ${error instanceof Error ? error.message : String(error)}\n\n`);
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(tempRoot, { recursive: true, force: true });
}
process.exit(exitCode);
