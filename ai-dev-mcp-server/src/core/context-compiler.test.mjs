import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileContextPack, contextPackFreshness } from "./context-compiler.mjs";

test("context compiler selects task files, excludes secrets, and stays bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-compiler-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, "src", "components", "Checkout.tsx"), "export const Checkout = () => <button>Pay</button>;\n"),
    fs.writeFile(path.join(root, "src", "server.ts"), "export const server = true;\n"),
    fs.writeFile(path.join(root, ".env"), "PAYMENT_SECRET=do-not-read\n")
  ]);
  const pack = await compileContextPack({
    projectRoot: root,
    task: "Исправь frontend checkout component",
    project: {
      project_name: "Shop",
      project_types: ["frontend"],
      stack: ["React", "TypeScript"],
      commands: [{ label: "Test", command: "npm test", cwd: "." }]
    },
    identity: { project_id: "project-shop" },
    acceptanceCriteria: ["Checkout action works on mobile."],
    projectState: { fingerprint: "state-one", dirty_files: [] },
    skills: [{ name: "frontend-product-builder", source: "custom" }],
    agentRules: "Keep changes scoped.",
    projectBrief: "Commerce checkout.",
    qualityGate: "Run npm test.",
    maxChars: 12_000
  });
  assert.equal(pack.selected_files[0].path, "src/components/Checkout.tsx");
  assert.doesNotMatch(pack.markdown, /PAYMENT_SECRET/);
  assert.ok(pack.budget.actual_chars <= 12_000);
  assert.equal(contextPackFreshness(pack, { fingerprint: "state-one" }).fresh, true);
  assert.equal(contextPackFreshness(pack, { fingerprint: "state-two" }).fresh, false);
});
