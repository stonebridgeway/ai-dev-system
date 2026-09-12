import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createRulesTools } from "./rules.mjs";

test("rules tools detect packs from the stack and install projections", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rules-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dirty = [];
  const host = {
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    detectProject: async () => ({ stack: ["Python", "FastAPI", "Docker"], project_types: ["backend", "api"] }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createRulesTools]);
  const listed = await registry.handlers.get("list_rule_packs")({ project_path: root });
  assert.deepEqual(listed.detected.packs, ["python", "fastapi", "docker"]);
  assert.ok(listed.common.length >= 5);
  assert.ok(listed.targets.includes("claude-md"));
  assert.equal(listed.default_targets.includes("claude-md"), false);

  const dry = await registry.handlers.get("install_project_rules")({ project_path: root, dry_run: true });
  assert.equal(dry.action, "rules_planned");
  assert.equal(dirty.length, 0);

  const installed = await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["ai-dev", "agents-md"] });
  assert.equal(installed.action, "rules_installed");
  assert.deepEqual(installed.packs, ["python", "fastapi", "docker"]);
  assert.ok(installed.written.includes(".ai-dev/rules/python.md"));
  assert.ok(installed.written.includes(".ai-dev/rules/fastapi.md"));
  assert.ok(installed.written.includes("AGENTS.md"));
  assert.equal(installed.written.some((item) => item.startsWith(".claude/")), false);
  assert.equal(dirty.length, 1);
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /## Engineering Rules/);
  assert.deepEqual(installed.warnings, []);

  const imported = await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["claude-md"] });
  assert.ok(imported.written.includes("CLAUDE.md"));
  assert.match(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), /@\.ai-dev\/rules\/common\/security\.md/);
  assert.deepEqual(imported.warnings, []);

  const both = await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["claude", "claude-md"] });
  assert.match(both.warnings[0], /Keep one/);
});


test("distill_project_rules writes the draft and reports what it left alone", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rules-distill-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (const [name, body] of [
    ["a-one.mjs", "import fs from \"node:fs\";\nexport const a = 1;\n"],
    ["b-two.mjs", "import path from \"node:path\";\nexport const b = 2;\n"],
    ["c-three.mjs", "import os from \"node:os\";\nexport const c = 3;\n"]
  ]) {
    await fs.writeFile(path.join(root, "src", name), body, "utf8");
  }
  const dirty = [];
  const registry = createExtensionTools({
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    detectProject: async () => ({ project_name: "Atlas", stack: ["Node.js"], project_types: ["backend"] }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  }, [createRulesTools]);

  const planned = await registry.handlers.get("distill_project_rules")({ project_path: root, dry_run: true });
  assert.equal(planned.action, "planned");
  assert.match(planned.next_step, /^Nothing was written/);
  assert.deepEqual(dirty, []);

  const written = await registry.handlers.get("distill_project_rules")({ project_path: root });
  assert.equal(written.action, "written");
  assert.equal(written.path, ".ai-dev/rules/project.md");
  assert.match(written.content, /# Atlas: Conventions this codebase already keeps/);
  assert.match(written.next_step, /drop its `status: draft` line/);
  assert.deepEqual(dirty, ["project rules distilled"]);

  const kept = await registry.handlers.get("distill_project_rules")({ project_path: root });
  assert.equal(kept.action, "kept_draft");
  assert.match(kept.next_step, /Pass overwrite=true to regenerate it/);
  assert.deepEqual(dirty, ["project rules distilled"], "nothing was written, so the index is not dirtied");

  // install_project_rules does not touch the draft: it writes the packs and the
  // common rules, and project.md is neither.
  await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["ai-dev"] });
  assert.match(await fs.readFile(path.join(root, ".ai-dev", "rules", "project.md"), "utf8"), /status: draft/);
});
