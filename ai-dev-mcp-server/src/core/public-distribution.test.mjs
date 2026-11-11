import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCleanDistribution,
  auditDistributionTree,
  buildContextStaleness,
  copyDistributionTree,
  lineEndingOnlyMismatch,
  missingVendoredCatalogues,
  VENDORED_SEED_CATALOGUES,
  distributionPathFindings,
  distributionTextFindings,
  findDanglingImports,
  ownerUsername
} from "./public-distribution.mjs";

test("distribution path policy rejects private vault and runtime state", () => {
  assert.ok(distributionPathFindings("02-knowledge/Projects/client.md").length > 0);
  assert.ok(distributionPathFindings(".ai-dev/context/task.md").length > 0);
  assert.ok(distributionPathFindings("runtime/search.sqlite").length > 0);
  assert.equal(distributionPathFindings("03-skills-catalog/sources/custom/reviewer/SKILL.md").length, 0);
  assert.equal(distributionPathFindings("03-skills-catalog/sources/external/archify/node_modules/ajv/package.json").length, 0);
  assert.equal(distributionPathFindings("public-seed/03-skills-catalog/sources/external/archify/node_modules/ajv/package.json").length, 0);
  assert.ok(distributionPathFindings("03-skills-catalog/sources/custom/reviewer/node_modules/example/package.json").length > 0);
});

test("distribution text policy reports secret classes without echoing values", () => {
  const token = ["gh", "p_", "a".repeat(30)].join("");
  const findings = distributionTextFindings(`token=${token}`, "unsafe.txt");
  assert.deepEqual(findings, [{ rule: "github-token", path: "unsafe.txt" }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test("a staged tree that imports what it does not carry is reported before an image is built", async (t) => {
  // Measured: the published image died on startup with
  // ERR_MODULE_NOT_FOUND for core/public-distribution.mjs, because a shipped
  // module imported one the allowlist excluded. Nothing caught it until the
  // container ran.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dangling-imports-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const src = path.join(root, "src", "core");
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "left-out"), { recursive: true });

  await fs.writeFile(path.join(src, "kept.mjs"), 'export const kept = 1;\n', "utf8");
  await fs.writeFile(path.join(src, "server.mjs"), [
    'import { kept } from "./kept.mjs";',
    'import { gone } from "./left-out.mjs";',
    'import express from "express";',
    'const lazy = await import("./also-gone.mjs");',
    'export { kept, gone, lazy };'
  ].join("\n"), "utf8");
  // A module in node_modules is not the tree's own to account for.
  await fs.writeFile(path.join(root, "node_modules", "left-out", "index.mjs"), 'import "./nowhere.mjs";\n', "utf8");

  const findings = await findDanglingImports(root);
  assert.deepEqual(findings.map((item) => item.specifier), ["./also-gone.mjs", "./left-out.mjs"]);
  assert.equal(findings[0].file, "src/core/server.mjs");
  assert.equal(findings[0].resolved, "src/core/also-gone.mjs");

  // An extensionless specifier resolving to a real file is not a finding.
  await fs.writeFile(path.join(src, "left-out.mjs"), "export const gone = 2;\n", "utf8");
  await fs.writeFile(path.join(src, "also-gone.mjs"), "export default 3;\n", "utf8");
  assert.deepEqual(await findDanglingImports(root), []);
});

test("the Frontend QA runner's imports of the server resolve in the distribution's own layout", async (t) => {
  // The runner imports the server as `../ai-dev-mcp-server`. Every target
  // is laid out as the distribution is, so the staged tree answers for it as is:
  // a file the runner needs and the allowlist dropped is caught before a build.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-imports-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = path.join(root, "ai-dev-mcp-server", "src", "core");
  const runner = path.join(root, "frontend-qa");
  await fs.mkdir(core, { recursive: true });
  await fs.mkdir(runner, { recursive: true });
  await fs.writeFile(path.join(core, "command-policy.mjs"), "export const policy = 1;\n", "utf8");
  await fs.writeFile(path.join(runner, "frontend_qa_runner.mjs"), [
    'import { policy } from "../ai-dev-mcp-server/src/core/command-policy.mjs";',
    'import { run } from "../ai-dev-mcp-server/src/core/process-runner.mjs";',
    'export { policy, run };'
  ].join("\n"), "utf8");

  // One shipped, one not: only the missing one is a finding.
  const findings = await findDanglingImports(runner);
  assert.deepEqual(findings.map((item) => item.specifier), ["../ai-dev-mcp-server/src/core/process-runner.mjs"]);
  assert.equal(findings[0].file, "frontend_qa_runner.mjs");
  await fs.writeFile(path.join(core, "process-runner.mjs"), "export const run = 2;\n", "utf8");
  assert.deepEqual(await findDanglingImports(runner), []);
});

test("distribution audit accepts a clean allowlisted tree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-public-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "01-system"), { recursive: true });
  await fs.writeFile(path.join(root, "01-system", "Rules.md"), "# Public rules\n");
  const audit = await auditDistributionTree(root, { forbiddenTerms: ["private-owner"] });
  assert.equal(assertCleanDistribution(audit).total_files, 1);
});

test("distribution audit blocks owner context without exposing source text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-private-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "note.md"), "private-owner local context");
  const audit = await auditDistributionTree(root, { forbiddenTerms: ["private-owner"] });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.findings, [{ rule: "private-owner-context", path: "note.md" }]);
});

test("distribution audit rejects a NUL byte in a text file and nowhere else", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-nul-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // The shape upstream shipped: a run of NULs where a skill's description was.
  await fs.writeFile(path.join(root, "SKILL.md"), Buffer.concat([
    Buffer.from("# Confluent\n\n"), Buffer.alloc(150), Buffer.from("\n\nOfficial docs\n")
  ]));
  await fs.writeFile(path.join(root, "notes.txt"), Buffer.from("text\0"));
  // Images are binary and are meant to carry NULs; so is a program a skill
  // ships without an extension.
  await fs.writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(root, "bin", "tool"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]));
  await fs.writeFile(path.join(root, "clean.md"), "# Clean\n");
  const audit = await auditDistributionTree(root);
  assert.deepEqual(audit.findings, [
    { rule: "nul-byte-in-text", path: "notes.txt" },
    { rule: "nul-byte-in-text", path: "SKILL.md" }
  ]);
  assert.throws(() => assertCleanDistribution(audit, "public seed"), /nul-byte-in-text: SKILL\.md/);
});

test("ownerUsername returns a string without throwing", () => {
  assert.equal(typeof ownerUsername(), "string");
});

test("ownerUsername falls back to the environment when os.userInfo throws", (t) => {
  const originalUserInfo = os.userInfo;
  const originalUser = process.env.USER;
  const originalUsername = process.env.USERNAME;
  const originalLogname = process.env.LOGNAME;
  t.after(() => {
    os.userInfo = originalUserInfo;
    if (originalUser === undefined) delete process.env.USER; else process.env.USER = originalUser;
    if (originalUsername === undefined) delete process.env.USERNAME; else process.env.USERNAME = originalUsername;
    if (originalLogname === undefined) delete process.env.LOGNAME; else process.env.LOGNAME = originalLogname;
  });
  // Reproduces `docker run --user "$uid:$gid"` with no matching passwd entry.
  os.userInfo = () => {
    const error = new Error("uv_os_get_passwd returned ENOENT");
    error.code = "ERR_SYSTEM_ERROR";
    throw error;
  };
  delete process.env.USERNAME;
  delete process.env.LOGNAME;
  process.env.USER = "build-local-1000";
  assert.equal(ownerUsername(), "build-local-1000");
});

const ownerContext = (text, terms) =>
  distributionTextFindings(text, "f.md", { forbiddenTerms: terms }).some(
    (finding) => finding.rule === "private-owner-context"
  );

test("owner-context matching ignores ordinary words but catches distinctive identities", () => {
  assert.equal(ownerContext("The project root is /workspace.", ["root"]), false);
  assert.equal(ownerContext("Run the CI pipeline before merge.", ["ci"]), false);
  assert.equal(ownerContext("Author: sacha", ["sacha"]), true);
  assert.equal(ownerContext("see also sachathing/config", ["sacha"]), false);
});

test("owner-context home directories require a specific path", () => {
  assert.equal(ownerContext("HOME is /root here", ["/root"]), false);
  assert.equal(ownerContext("cloned into /home/sacha/vault", ["/home/sacha"]), true);
  assert.equal(ownerContext("C:/Users/sacha/vault", ["C:\\Users\\sacha"]), true);
});

test("a whole vendored catalogue set reports nothing missing", () => {
  const counts = Object.fromEntries(
    VENDORED_SEED_CATALOGUES.map(({ relative, minimumSkills }) => [relative, minimumSkills])
  );
  assert.deepEqual(missingVendoredCatalogues(counts), []);
});

test("a catalogue the seed refresh dropped is reported, not passed over", () => {
  // The defect this guards: `copySkillSources` reads an allowlist of vault
  // directories, the vendored catalogues live only in the checkout, and the
  // refresh replaces the seed wholesale — so a missing entry means 460 skills
  // silently leave the distribution.
  const counts = Object.fromEntries(
    VENDORED_SEED_CATALOGUES.map(({ relative, minimumSkills }) => [relative, minimumSkills])
  );
  delete counts["external/membrane"];
  assert.deepEqual(missingVendoredCatalogues(counts), [
    { relative: "external/membrane", expected: 460, found: 0 }
  ]);
});

test("a partially copied catalogue fails as loudly as a missing one", () => {
  const counts = Object.fromEntries(
    VENDORED_SEED_CATALOGUES.map(({ relative, minimumSkills }) => [relative, minimumSkills])
  );
  counts["external/understand-anything"] = 4;
  assert.deepEqual(missingVendoredCatalogues(counts), [
    { relative: "external/understand-anything", expected: 9, found: 4 }
  ]);
});

test("every vendored catalogue names a path and a positive count", () => {
  assert.ok(VENDORED_SEED_CATALOGUES.length > 0);
  for (const entry of VENDORED_SEED_CATALOGUES) {
    assert.match(entry.relative, /^(external|custom)\/[a-z0-9-]+$/);
    assert.ok(Number.isInteger(entry.minimumSkills) && entry.minimumSkills > 0);
  }
});

test("a nested node_modules survives inside an approved vendored tree", async () => {
  // archify ships pinned runtime dependencies, and ajv keeps its own copy of
  // fast-uri below them. The approval pattern reads a distribution-root path,
  // but the copy sees one relative to its own root, so without the explicit
  // flag the nested directory is dropped and archify loses a dependency.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendored-"));
  const source = path.join(root, "node_modules");
  await fs.mkdir(path.join(source, "ajv", "node_modules", "fast-uri"), { recursive: true });
  await fs.writeFile(path.join(source, "ajv", "index.js"), "export default 1;\n");
  await fs.writeFile(path.join(source, "ajv", "node_modules", "fast-uri", "index.js"), "export default 2;\n");

  const dropped = path.join(root, "dropped");
  await copyDistributionTree(source, dropped);
  assert.equal(await fs.access(path.join(dropped, "ajv", "index.js")).then(() => true).catch(() => false), true);
  assert.equal(
    await fs.access(path.join(dropped, "ajv", "node_modules", "fast-uri", "index.js")).then(() => true).catch(() => false),
    false
  );

  const kept = path.join(root, "kept");
  await copyDistributionTree(source, kept, { vendoredDependencyTree: true });
  assert.equal(
    await fs.access(path.join(kept, "ajv", "node_modules", "fast-uri", "index.js")).then(() => true).catch(() => false),
    true
  );

  await fs.rm(root, { recursive: true, force: true });
});

test("a context generated after the newest source is not stale", () => {
  const generatedAt = "2026-09-13T12:00:00.000Z";
  const newestSourceMs = Date.parse("2026-09-13T11:00:00.000Z");
  assert.deepEqual(buildContextStaleness({ generatedAt, newestSourceMs }), { stale: false, reason: "" });
});

test("a source newer than the context makes it stale, and the reason says both times", () => {
  const result = buildContextStaleness({
    generatedAt: "2026-09-13T11:00:00.000Z",
    newestSourceMs: Date.parse("2026-09-13T12:00:00.000Z")
  });
  assert.equal(result.stale, true);
  assert.match(result.reason, /2026-09-13T12:00:00\.000Z/);
  assert.match(result.reason, /2026-09-13T11:00:00\.000Z/);
});

test("a context that cannot say when it was made is treated as stale", () => {
  // Rather than trusted: an audit of an unknown tree reports findings about a
  // tree nobody can identify, which is how `scripts/models.mjs` was reported
  // as a dangling import of sources that never referenced it.
  assert.equal(buildContextStaleness({}).stale, true);
  assert.equal(buildContextStaleness({ generatedAt: "not a date", newestSourceMs: 1 }).stale, true);
});

test("an unreadable source tree does not make a dated context stale", () => {
  assert.equal(buildContextStaleness({ generatedAt: "2026-09-13T11:00:00.000Z" }).stale, false);
});

test("a CRLF copy of a listed file is recognised as a line-ending difference", () => {
  // A checkout older than .gitattributes keeps CRLF, and git does not rewrite
  // files already on disk when the rule arrives. Measured on Windows: 74 files,
  // each exactly its line count larger than the manifest entry.
  const lf = Buffer.from("first\nsecond\nthird\n", "utf8");
  const sha = createHash("sha256").update(lf).digest("hex");
  const crlf = Buffer.from("first\r\nsecond\r\nthird\r\n", "utf8");
  assert.equal(crlf.length - lf.length, 3, "one byte per line");
  assert.equal(lineEndingOnlyMismatch(crlf, sha), true);
});

test("an unchanged file and a genuinely different one are both not line endings", () => {
  const lf = Buffer.from("first\nsecond\n", "utf8");
  const sha = createHash("sha256").update(lf).digest("hex");
  assert.equal(lineEndingOnlyMismatch(lf, sha), false, "no CR at all");
  assert.equal(lineEndingOnlyMismatch(Buffer.from("other\r\ntext\r\n"), sha), false);
});

test("a lone CR is not treated as a line ending difference", () => {
  const lf = Buffer.from("a\nb\n", "utf8");
  const sha = createHash("sha256").update(lf).digest("hex");
  assert.equal(lineEndingOnlyMismatch(Buffer.from("a\rb\r"), sha), false);
  assert.equal(lineEndingOnlyMismatch("not a buffer", sha), false);
});
