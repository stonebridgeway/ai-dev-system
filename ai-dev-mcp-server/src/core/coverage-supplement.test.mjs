import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  atomicAppendFile,
  atomicWriteIfChanged,
  atomicWriteJson
} from "./atomic-files.mjs";
import { evidenceMatchesState } from "./evidence.mjs";
import { perceptualHashDistance } from "./png-perceptual.mjs";
import {
  distributionContentFingerprint,
  distributionPathFindings,
  distributionTextFindings
} from "./public-distribution.mjs";
import { repairSearchMojibake } from "./search-reranker.mjs";
import {
  createLocalRuntimeProfile,
  renderRuntimeDistribution
} from "./runtime-distribution.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-cov-"));
}

test("atomicWriteIfChanged only writes when content differs", async () => {
  const root = await tempDir();
  try {
    const file = path.join(root, "nested", "value.txt");
    const first = await atomicWriteIfChanged(file, "alpha");
    assert.equal(first.changed, true);
    const second = await atomicWriteIfChanged(file, "alpha");
    assert.equal(second.changed, false);
    const third = await atomicWriteIfChanged(file, "beta");
    assert.equal(third.changed, true);
    assert.equal(await fs.readFile(file, "utf8"), "beta");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atomicAppendFile creates then appends", async () => {
  const root = await tempDir();
  try {
    const file = path.join(root, "log.txt");
    await atomicAppendFile(file, "one\n");
    await atomicAppendFile(file, "two\n");
    assert.equal(await fs.readFile(file, "utf8"), "one\ntwo\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atomicWriteJson emits pretty JSON with a trailing newline", async () => {
  const root = await tempDir();
  try {
    const file = path.join(root, "data.json");
    await atomicWriteJson(file, { b: 1, a: 2 });
    const raw = await fs.readFile(file, "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(raw), { b: 1, a: 2 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("evidenceMatchesState compares fingerprints", () => {
  assert.equal(
    evidenceMatchesState({ source_state_fingerprint: "abc" }, { fingerprint: "abc" }),
    true
  );
  assert.equal(
    evidenceMatchesState({ source_state_fingerprint: "abc" }, { fingerprint: "def" }),
    false
  );
  assert.equal(evidenceMatchesState(null, { fingerprint: "abc" }), false);
});

test("perceptualHashDistance measures bit differences and rejects bad input", () => {
  const zero = "0".repeat(32);
  const one = `${"0".repeat(31)}1`;
  assert.equal(perceptualHashDistance(zero, zero), 0);
  assert.equal(perceptualHashDistance(zero, one), 1);
  assert.throws(() => perceptualHashDistance("xyz", zero), /128-bit hexadecimal/);
});

test("distribution path findings flag private vault zones and forbidden files", () => {
  assert.equal(distributionPathFindings("09-mcp/ai-dev-mcp-server/src/server.mjs").length, 0);
  assert.ok(
    distributionPathFindings("02-knowledge/Projects/Secret.md")
      .some((finding) => finding.rule === "private-vault-zone")
  );
  assert.ok(
    distributionPathFindings("node_modules/pkg/index.js")
      .some((finding) => finding.rule === "forbidden-directory")
  );
});

test("distribution text findings ignore placeholders but catch real credentials", () => {
  assert.equal(
    distributionTextFindings('api_key: "${AI_DEV_KEY}"', "config.yml").length,
    0
  );
  assert.ok(
    distributionTextFindings('password: "correct horse battery"', "config.yml")
      .some((finding) => finding.rule === "assigned-credential")
  );
  assert.ok(
    distributionTextFindings("owned by acme-corp internal", "README.md", {
      forbiddenTerms: ["acme-corp"]
    }).some((finding) => finding.rule === "private-owner-context")
  );
});

test("distributionContentFingerprint is order sensitive", () => {
  const a = [{ path: "a", bytes: 1, sha256: "x" }, { path: "b", bytes: 2, sha256: "y" }];
  const b = [a[1], a[0]];
  assert.notEqual(distributionContentFingerprint(a), distributionContentFingerprint(b));
});

test("repairSearchMojibake leaves clean text untouched", () => {
  assert.equal(repairSearchMojibake("plain english text"), "plain english text");
  assert.equal(repairSearchMojibake("обычный русский текст"), "обычный русский текст");
});

test("renderRuntimeDistribution produces the expected sections", () => {
  const manifest = {
    generated_at: "1970-01-01T00:00:00.000Z",
    profile: createLocalRuntimeProfile(),
    entrypoint: "src/server.mjs",
    tools: 83,
    commands: { start: "s", doctor: "d", acceptance: "a", backup: "b" },
    recovery: { backup_script: "bk.ps1", restore_script: "rs.ps1" }
  };
  const markdown = renderRuntimeDistribution(manifest);
  assert.match(markdown, /# Runtime Distribution/);
  assert.match(markdown, /MCP tools: 83/);
  assert.match(markdown, /AI_DEV_MCP_BEARER_TOKEN/);
  assert.match(markdown, /bk\.ps1/);
});
