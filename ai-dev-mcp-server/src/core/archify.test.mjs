import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ARCHIFY_TYPES, archifyCliPath, runArchify } from "./archify.mjs";
import {
  validateArchifyDeliveryReceipt,
  validateArchifyVisualCheckEvidence
} from "./archify-receipt.mjs";
import { vaultRoot } from "../mcp-stdio.mjs";

const cliPath = archifyCliPath(vaultRoot);
const available = existsSync(cliPath);

test("Archify core exposes all supported diagram types and resolves its vendored CLI path", () => {
  assert.deepEqual(ARCHIFY_TYPES, ["architecture", "workflow", "sequence", "dataflow", "lifecycle"]);
  assert.equal(cliPath, path.join(vaultRoot, "03-skills-catalog", "sources", "external", "archify", "bin", "archify.mjs"));
});

test("Archify core runs doctor shell-free", { skip: available ? false : "vendored Archify is unavailable" }, async () => {
  const result = await runArchify({ vaultRoot, args: ["doctor"], cwd: path.dirname(cliPath) });
  assert.equal(result.ok, true, result.stderr || result.stdout);
  assert.match(result.stdout, /Archify is ready\./);
});

test("delivery receipt validation enforces the stated acceptance bar", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archify-receipt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const htmlPath = path.join(dir, "diagram.html");
  await fs.writeFile(htmlPath, "<html>diagram</html>", "utf8");
  const artifactSha = crypto.createHash("sha256").update(await fs.readFile(htmlPath)).digest("hex");
  const specSha = "a".repeat(64);
  const base = {
    kind: "archify_deliver",
    spec_sha256: specSha,
    artifact_sha256: artifactSha,
    quality: "showcase",
    errors: 0,
    warnings: 0,
    checks_passed: 9,
    check_count: 9
  };

  assert.equal((await validateArchifyDeliveryReceipt(base, htmlPath)).ok, true);

  const standard = await validateArchifyDeliveryReceipt({ ...base, quality: "standard" }, htmlPath);
  assert.equal(standard.ok, false);
  assert.match(standard.problems.join(" "), /quality profile/);

  const warned = await validateArchifyDeliveryReceipt({ ...base, warnings: 2 }, htmlPath);
  assert.equal(warned.ok, false);
  assert.match(warned.problems.join(" "), /warning/);

  await assert.rejects(
    validateArchifyDeliveryReceipt({ ...base, artifact_sha256: "b".repeat(64) }, htmlPath),
    /SHA-256 does not match/
  );
});

test("visual-check evidence passes only on clean containment", () => {
  assert.equal(
    validateArchifyVisualCheckEvidence({ kind: "archify_visual_check", status: "pass", containment_status: "pass" }, "x.html").ok,
    true
  );
  assert.equal(
    validateArchifyVisualCheckEvidence({ kind: "archify_visual_check", status: "fail", containment_status: "fail" }, "x.html").ok,
    false
  );
});
