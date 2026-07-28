import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "./project-intelligence.mjs";

test("detects frontend and backend components below a manifest-free root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-"));
  await fs.mkdir(path.join(root, "frontend", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "frontend", "package.json"), JSON.stringify({
    name: "web",
    scripts: { dev: "vite", test: "vitest", build: "vite build" },
    dependencies: { react: "1", vite: "1", typescript: "1" }
  }));
  await fs.writeFile(path.join(root, "backend", "requirements.txt"), "fastapi\nsqlalchemy\npytest\n");

  const result = await analyzeProject(root, { projectName: "fixture" });
  assert.equal(result.workspace.is_monorepo, true);
  assert.equal(result.components.length, 2);
  assert.ok(result.project_types.includes("frontend"));
  assert.ok(result.project_types.includes("backend"));
  assert.ok(result.project_types.includes("api"));
  assert.ok(result.stack.includes("React"));
  assert.ok(result.stack.includes("FastAPI"));
  assert.ok(result.architecture.source_roots.includes("frontend/src"));
  assert.ok(result.architecture.test_roots.includes("backend/tests"));
});
