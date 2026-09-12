import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SKILL_IMPORT_EXCLUSION_GROUPS,
  SKILL_IMPORT_QUALITY_FLOOR,
  matchSkillImportExclusion,
  parseSkillFrontmatter,
  planSkillImport,
  readSkillImportCandidates,
  stageSelectedSkills
} from "./skill-import-policy.mjs";

function candidate(folder, overrides = {}) {
  return {
    folder,
    name: folder,
    description: `${folder} description`,
    directory: `/upstream/skills/${folder}`,
    quality_score: 90,
    quality_grade: "A",
    quality_status: "pass",
    privacy_findings: [],
    files: 1,
    bytes: 1000,
    ...overrides
  };
}

async function scratch(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return root;
}

test("exclusion rules match exact names and family prefixes", () => {
  assert.equal(matchSkillImportExclusion("logistics-exception-management")?.group, "domain-business");
  assert.equal(matchSkillImportExclusion("homelab-wireguard-vpn")?.group, "regulated-and-niche-domains");
  assert.equal(matchSkillImportExclusion("orch-build-mvp")?.rule, "orch-*");
  assert.equal(matchSkillImportExclusion("tdd-workflow"), null);
});

test("a family prefix matches the upstream folder even when frontmatter renames the skill", () => {
  // ECC ships skills/scientific-db-pubmed-database whose frontmatter name is
  // "pubmed-database"; matching only the registry name would let it through.
  const excluded = matchSkillImportExclusion("scientific-db-pubmed-database", "pubmed-database");
  assert.equal(excluded?.group, "regulated-and-niche-domains");
  assert.equal(excluded?.rule, "scientific-*");
});

test("reference skills the review routes through import_skill_repo stay importable", () => {
  for (const name of [
    "coding-standards", "git-workflow", "error-handling",
    "api-connector-builder", "hexagonal-architecture",
    "python-patterns", "rust-testing", "swiftui-patterns"
  ]) {
    assert.equal(matchSkillImportExclusion(name), null, `${name} must not be excluded`);
  }
});

test("every exclusion group carries a reason and a citation", () => {
  for (const group of SKILL_IMPORT_EXCLUSION_GROUPS) {
    assert.ok(group.id && group.reason && group.source, `${group.id} is missing metadata`);
    assert.ok(group.rules.length > 0, `${group.id} has no rules`);
  }
});

test("frontmatter parsing handles one-line and block descriptions", () => {
  assert.deepEqual(
    parseSkillFrontmatter("---\nname: alpha\ndescription: \"Use when routing.\"\n---\nBody", "folder"),
    { name: "alpha", description: "Use when routing." }
  );
  assert.deepEqual(
    parseSkillFrontmatter("---\ndescription: |\n  First line.\n  Second line.\nother: x\n---\n", "folder"),
    { name: "folder", description: "First line. Second line." }
  );
  assert.deepEqual(
    parseSkillFrontmatter("No frontmatter here.", "folder"),
    { name: "folder", description: "" }
  );
});

test("a local custom skill keeps its name and the upstream one stays out", () => {
  const plan = planSkillImport({
    candidates: [candidate("verification-loop"), candidate("tdd-workflow")],
    existingSkills: [{ name: "verification-loop", source: "custom", path: "sources/custom/verification-loop/SKILL.md" }]
  });
  assert.deepEqual(plan.selected.map((item) => item.name), ["tdd-workflow"]);
  assert.equal(plan.summary.rejected_by_name_conflict, 1);
  assert.deepEqual(plan.summary.custom_skill_conflicts, ["verification-loop"]);
  assert.equal(plan.conflicts[0].keeps, "custom:verification-loop");
  assert.equal(plan.conflicts[0].custom_skill, true);
});

test("a name owned by another source is reported separately from a custom conflict", () => {
  const plan = planSkillImport({
    candidates: [candidate("archify")],
    existingSkills: [{ name: "archify", source: "external/archify", path: "sources/external/archify/SKILL.md" }]
  });
  assert.equal(plan.selected.length, 0);
  assert.deepEqual(plan.summary.catalog_name_conflicts, ["archify"]);
  assert.deepEqual(plan.summary.custom_skill_conflicts, []);
});

test("the quality floor is applied and defaults to 75", () => {
  const plan = planSkillImport({
    candidates: [candidate("keeps", { quality_score: 75 }), candidate("drops", { quality_score: 74 })]
  });
  assert.equal(plan.quality_floor, SKILL_IMPORT_QUALITY_FLOOR);
  assert.deepEqual(plan.selected.map((item) => item.name), ["keeps"]);
  assert.equal(plan.summary.rejected_by_quality, 1);
  assert.match(plan.rejected[0].detail, /74 is under the 75 floor/);
});

test("a skill that would fail the seed privacy audit is never imported", () => {
  const plan = planSkillImport({
    candidates: [candidate("leaky", {
      privacy_findings: [{ rule: "assigned-credential", path: "leaky/SKILL.md" }]
    })]
  });
  assert.equal(plan.selected.length, 0);
  assert.equal(plan.summary.rejected_by_privacy, 1);
  assert.deepEqual(plan.rejected[0].findings, ["assigned-credential: leaky/SKILL.md"]);
});

test("a domain skill is rejected by rule regardless of its score or a name clash", () => {
  const plan = planSkillImport({
    candidates: [candidate("hipaa-compliance", { quality_score: 10 })],
    existingSkills: [{ name: "hipaa-compliance", source: "custom" }]
  });
  assert.equal(plan.summary.rejected_by_rule, 1);
  assert.equal(plan.summary.rejected_by_quality, 0);
  assert.equal(plan.summary.rejected_by_name_conflict, 0);
  assert.equal(plan.rejected[0].group, "regulated-and-niche-domains");
});

test("the summary accounts for every candidate exactly once", () => {
  const plan = planSkillImport({
    candidates: [
      candidate("tdd-workflow"),
      candidate("api-design"),
      candidate("seo"),
      candidate("thin", { quality_score: 20 }),
      candidate("code-reviewer")
    ],
    existingSkills: [{ name: "code-reviewer", source: "custom" }]
  });
  const { summary } = plan;
  assert.equal(summary.candidates, 5);
  assert.equal(summary.imported, 2);
  assert.equal(
    summary.rejected_by_rule + summary.rejected_by_quality
      + summary.rejected_by_name_conflict + summary.rejected_by_privacy,
    summary.rejected
  );
  assert.equal(summary.imported + summary.rejected, summary.candidates);
  assert.deepEqual(summary.rule_groups, { "domain-business": 1 });
});

test("candidates are read, scored, and privacy-audited from an upstream tree", async () => {
  const root = await scratch("skill-import-read-");
  const skills = path.join(root, "skills");
  await fs.mkdir(path.join(skills, "good"), { recursive: true });
  await fs.writeFile(path.join(skills, "good", "SKILL.md"), [
    "---",
    "name: good-skill",
    "description: Use when you need a repeatable review procedure with evidence.",
    "---",
    "",
    "## Workflow",
    "",
    "1. Read the diff and identify the touched modules.",
    "2. Run the test suite and record the result.",
    "3. Verify the acceptance criteria and report the evidence.",
    "",
    "## Guardrails",
    "",
    "Do not skip the verification step. Never weaken a linter to pass.",
    ""
  ].join("\n"));
  await fs.mkdir(path.join(skills, "leaky"), { recursive: true });
  await fs.writeFile(
    path.join(skills, "leaky", "SKILL.md"),
    "---\nname: leaky\ndescription: Example.\n---\n\npassword = \"hunter2-real-value\"\n"
  );
  await fs.mkdir(path.join(skills, "not-a-skill"), { recursive: true });
  await fs.writeFile(path.join(skills, "not-a-skill", "README.md"), "no SKILL.md here");

  try {
    const candidates = await readSkillImportCandidates(skills, { source: "external/fixture" });
    assert.deepEqual(candidates.map((item) => item.folder), ["good", "leaky"]);
    const good = candidates.find((item) => item.folder === "good");
    assert.equal(good.name, "good-skill");
    assert.ok(good.quality_score > 0);
    assert.deepEqual(good.privacy_findings, []);
    assert.equal(good.files, 1);
    const leaky = candidates.find((item) => item.folder === "leaky");
    assert.deepEqual(leaky.privacy_findings, [{ rule: "assigned-credential", path: "leaky/SKILL.md" }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a missing upstream skills directory yields no candidates", async () => {
  assert.deepEqual(await readSkillImportCandidates("/nonexistent/skills"), []);
});

test("staging copies only selected skills and drops what a re-import deselects", async () => {
  const root = await scratch("skill-import-stage-");
  const upstream = path.join(root, "upstream");
  const target = path.join(root, "vault", "skills");
  for (const name of ["keep", "drop"]) {
    await fs.mkdir(path.join(upstream, name, "references"), { recursive: true });
    await fs.writeFile(path.join(upstream, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    await fs.writeFile(path.join(upstream, name, "references", "notes.md"), "notes");
  }

  try {
    const first = await stageSelectedSkills(
      ["keep", "drop"].map((name) => ({ folder: name, directory: path.join(upstream, name) })),
      target
    );
    assert.deepEqual(first.folders, ["drop", "keep"]);
    assert.equal(await fs.readFile(path.join(target, "keep", "references", "notes.md"), "utf8"), "notes");

    const second = await stageSelectedSkills([{ folder: "keep", directory: path.join(upstream, "keep") }], target);
    assert.deepEqual(second.folders, ["keep"]);
    assert.deepEqual((await fs.readdir(target)).sort(), ["keep"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
