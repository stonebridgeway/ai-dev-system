import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createProjectTools } from "./projects.mjs";

const GATE = [
  "# Quality Gate",
  "",
  "- Lint: `npm run lint`",
  "- Test: `npm run test`",
  "- Install: `npm ci`",
  "- Unsafe: `rm -rf /`",
  "",
  "| Task | Command | CWD |",
  "| --- | --- | --- |",
  "| Subdir check | `npm run test` | sub |"
].join("\n");

/**
 * A host whose filesystem is a fixture and whose command runner is a recorder:
 * the extension's own orchestration is exercised without running anything.
 */
function createFixture({ gate = GATE, exists = true, run = null, card = null } = {}) {
  const calls = [];
  const host = {
    vaultRoot: "/vault",
    safeProjectRoot: async (value) => `/repo/${value}`,
    safeProjectFile: (root, relative) => `${root}/${relative}`,
    safeProjectSubdir: async (root, relative) => (relative ? `${root}/${relative}` : root),
    pathExists: async () => exists,
    readProjectTextIfExists: async () => gate,
    truncateOutput: (value) => value,
    findProjectCard: async (root) => {
      calls.push(["findProjectCard", root]);
      if (!card) throw new Error("Project card not found.");
      return card;
    },
    updateProjectCard: async (args) => {
      calls.push(["updateProjectCard", args]);
      return { updated: true };
    },
    syncProjectCard: async (args) => {
      calls.push(["syncProjectCard", args]);
      return { synced: true };
    },
    registerProject: async (args) => {
      calls.push(["registerProject", args]);
      return { action: "created" };
    }
  };
  const registry = createExtensionTools(host, [createProjectTools]);
  const runner = run ?? (() => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1, truncated: false, command: { kind: "package-script", adapter: "npm" } }));
  return { host, calls, registry, runner };
}

const call = (registry, args) => registry.handlers.get("run_quality_gate")(args);

test("the extension exposes one tool, and it is not read-only", () => {
  const { registry } = createFixture();
  assert.deepEqual(registry.definitions.map((item) => item.name), ["run_quality_gate"]);
  assert.deepEqual(registry.readOnly, []);
  assert.equal(registry.definitions[0].inputSchema.required[0], "project_path");
});

test("a missing gate file names the path it looked for", async () => {
  const { registry } = createFixture({ exists: false });
  await assert.rejects(
    () => call(registry, { project_path: "atlas" }),
    /Quality gate file not found: \/repo\/atlas\/\.ai-dev\/quality-gate\.md/
  );
});

test("a dry run selects and blocks without executing anything", async () => {
  const { registry } = createFixture();
  const result = await call(registry, { project_path: "atlas", dry_run: true, update_registry: false });
  assert.equal(result.status, "dry_run");
  assert.equal(result.project_path, "/repo/atlas");
  assert.equal(result.quality_gate_path, ".ai-dev/quality-gate.md");
  assert.deepEqual(result.results.map((item) => [item.label, item.cwd, item.status]), [
    ["Lint", ".", "dry_run"], ["Test", ".", "dry_run"], ["Subdir check", "sub", "dry_run"]
  ]);
  assert.deepEqual(result.blocked.map((item) => item.label), ["Unsafe"]);
  assert.deepEqual(result.skipped.map((item) => [item.label, item.reason]), [["Install", "label skipped by default"]]);
  assert.equal(result.parsed_commands.length, 5);
  assert.deepEqual(result.diagram_specs, { enabled: false });
  assert.deepEqual(result.safety, {
    execution: "argv", shell: false, unsafe_bypass_honored: false, legacy_allow_unsafe_requested: false
  });
  assert.ok(result.started_at <= result.finished_at);
});

test("the legacy unsafe flag is recorded and never honoured", async () => {
  const { registry } = createFixture();
  const result = await call(registry, { project_path: "atlas", dry_run: true, update_registry: false, allow_unsafe_commands: true });
  assert.equal(result.safety.legacy_allow_unsafe_requested, true);
  assert.equal(result.safety.unsafe_bypass_honored, false);
  assert.deepEqual(result.blocked.map((item) => item.label), ["Unsafe"]);
});

test("labels and the cap narrow what runs", async () => {
  const { registry } = createFixture();
  // Naming a default-skipped label selects it, but the command policy still
  // has the last word: `npm ci` is an install, not a check.
  const labelled = await call(registry, { project_path: "atlas", labels: ["install"], dry_run: true, update_registry: false });
  assert.deepEqual(labelled.results, []);
  assert.deepEqual(labelled.blocked.map((item) => item.label), ["Install"]);
  assert.deepEqual(labelled.skipped.map((item) => item.reason), Array(4).fill("label not selected"));

  const capped = await call(registry, { project_path: "atlas", max_commands: 1, dry_run: true, update_registry: false });
  assert.deepEqual(capped.results.map((item) => item.label), ["Lint"]);
  assert.equal(capped.skipped.filter((item) => item.reason === "max_commands limit reached").length, 3);
});

test("a gate file with nothing runnable in it reports no_commands", async () => {
  const { registry } = createFixture({ gate: "# Quality Gate\n\nNothing here.\n" });
  const result = await call(registry, { project_path: "atlas", update_registry: false });
  assert.equal(result.status, "no_commands");
  assert.deepEqual(result.parsed_commands, []);
});

test("a gate whose every command the policy refuses reports blocked", async () => {
  const { registry } = createFixture({ gate: "# Quality Gate\n\n- Unsafe: `rm -rf /`\n" });
  const result = await call(registry, { project_path: "atlas", update_registry: false });
  assert.equal(result.status, "blocked");
  assert.equal(result.results.length, 0);
  assert.match(result.blocked[0].reason, /\S/);
});

test("the registry update writes the run onto the card and syncs it", async () => {
  const { registry, calls } = createFixture({ card: { name: "Atlas" } });
  const result = await call(registry, { project_path: "atlas", dry_run: true });
  assert.deepEqual(result.registry, { report: { updated: true }, synced: { synced: true } });
  const [, update] = calls.find(([name]) => name === "updateProjectCard");
  assert.equal(update.name, "Atlas");
  assert.equal(update.section, "Last Quality Gate Run");
  assert.equal(update.mode, "replace");
  assert.equal(update.update_index, false);
  assert.match(update.content, /Status: dry_run/);
  const [, sync] = calls.find(([name]) => name === "syncProjectCard");
  assert.deepEqual(sync, { project_path: "/repo/atlas", create_if_missing: false, update_index: true });
});

test("an unregistered project is skipped, or registered when asked", async () => {
  const skipped = createFixture();
  const result = await call(skipped.registry, { project_path: "atlas", dry_run: true });
  assert.equal(result.registry.action, "skipped");
  assert.match(result.registry.reason, /Project card not found\./);
  assert.equal(skipped.calls.some(([name]) => name === "registerProject"), false);

  const registered = createFixture();
  const second = await call(registered.registry, { project_path: "atlas", dry_run: true, register_if_missing: true });
  assert.deepEqual(second.registry, { action: "created" });
  const [, args] = registered.calls.find(([name]) => name === "registerProject");
  assert.equal(args.status, "registered via run_quality_gate");
  assert.equal(args.overwrite, false);
  assert.match(args.notes, /Status: dry_run/);
});

test("a dry run describes the diagram specs instead of validating them", async () => {
  const { registry } = createFixture();
  const result = await call(registry, { project_path: "atlas", dry_run: true, diagram_specs: "docs/*.mmd", update_registry: false });
  assert.deepEqual(result.diagram_specs, { enabled: true, pattern: "docs/*.mmd", files: [], status: "dry_run" });
});
