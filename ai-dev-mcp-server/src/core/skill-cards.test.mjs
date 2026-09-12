import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSkillCard,
  skillCardPolicy,
  skillCardPublic,
  skillCardUnchanged,
  skillCardsMarkdownIndex
} from "./skill-cards.mjs";

const CUSTOM_SKILL = {
  name: "feature-builder",
  source: "custom",
  type: "workflow",
  path: "custom/feature-builder/SKILL.md",
  primary_group: "delivery",
  primary_group_label: "Delivery",
  subgroups: ["implementation"],
  task_types: ["feature"],
  platforms: ["node"],
  related_skills: ["code-reviewer"],
  frameworks: ["node"],
  languages: ["javascript"],
  conflicts: [],
  categories: ["workflow"],
  requires: ["git"],
  compatibility: "any repository",
  maturity: "validated",
  trust_level: "trusted-local",
  quality_score: 88,
  quality_grade: "B",
  quality_status: "pass",
  quality_profile: "custom",
  skill_schema_version: 2,
  description: "Ship   a   behaviour change",
  use_when: "the task changes product behaviour",
  homepage: "https://example.invalid",
  repository: "https://example.invalid/repo"
};

test("card policy is decided by source and type, most specific first", () => {
  assert.match(skillCardPolicy({ source: "membrane/app-skills" }).role, /External application/);
  assert.match(skillCardPolicy({ source: "custom" }).role, /Primary AI development/);
  assert.match(skillCardPolicy({ source: "x", type: "image-generation" }).role, /Visual reference/);
  assert.match(skillCardPolicy({ source: "x", type: "output-control" }).role, /output-control/);
  assert.match(skillCardPolicy({ source: "design/taste-skill" }).role, /Frontend\/design/);
  assert.match(skillCardPolicy({ source: "external/other" }).role, /local skill catalog/);
});

test("membrane wins over an image-generation type", () => {
  assert.match(skillCardPolicy({ source: "membrane/x", type: "image-generation" }).role, /External application/);
});

test("a rendered card carries its frontmatter, routing and quality sections", () => {
  const card = renderSkillCard(CUSTOM_SKILL, "2026-01-02T03:04:05.000Z");
  assert.match(card, /^---\ncard_kind: "skill-card"\n/);
  assert.match(card, /generated_at: "2026-01-02T03:04:05\.000Z"/);
  assert.match(card, /card_path: "03-skills-catalog\/cards\/custom\/feature-builder\.md"/);
  assert.match(card, /skill_path: "03-skills-catalog\/custom\/feature-builder\/SKILL\.md"/);
  assert.match(card, /tags: \["skill-card","skill-group\/delivery","skill-maturity\/validated","skill-quality\/pass","custom","workflow","workflow"\]/);
  assert.match(card, /\n# feature-builder\n/);
  assert.match(card, /Ship a behaviour change/);
  assert.match(card, /- Requires: `git`/);
  assert.match(card, /Score: \*\*88\/100\*\* \(B, `pass`\)/);
  assert.match(card, /## Related Skills/);
  assert.match(card, /- `code-reviewer`/);
  assert.match(card, /"name": "feature-builder"/);
});

test("a card without optional metadata falls back instead of printing undefined", () => {
  const card = renderSkillCard({ name: "bare", source: "external/x", path: "external/x/SKILL.md" }, "2026-01-01T00:00:00.000Z");
  assert.doesNotMatch(card, /undefined/);
  assert.match(card, /quality_score: 0/);
  assert.match(card, /maturity: "draft"/);
  assert.match(card, /trust_level: "unverified"/);
  assert.match(card, /- Type: `unknown`/);
  assert.match(card, /- Subgroups: none/);
  assert.match(card, /- Compatibility: not recorded/);
  assert.match(card, /None recorded\./);
  assert.match(card, /No description recorded\./);
  assert.match(card, /- Homepage: not recorded/);
});

test("the card index tallies by source and group and lists every card", () => {
  const index = skillCardsMarkdownIndex([
    { name: "a", source: "custom", type: "workflow", primary_group: "delivery", quality_score: 90, maturity: "validated", use_when: "x", card_path: "cards/custom/a.md" },
    { name: "b", source: "custom", type: "", primary_group: "delivery", quality_score: 10, maturity: "draft", description: "y | z", card_path: "cards/custom/b.md" },
    { name: "c", source: "design/taste-skill", card_path: "cards/design/c.md" }
  ]);
  assert.match(index, /Total cards: 3/);
  assert.match(index, /\| custom \| 2 \|/);
  assert.match(index, /\| design\/taste-skill \| 1 \|/);
  assert.match(index, /unclassified/);
  assert.match(index, /\| b \| delivery \| 10 \| draft \| custom \|  \| y \/ z \| `cards\/custom\/b\.md` \|/);
  assert.match(index, /\| c \| unclassified \| 0 \| draft \| design\/taste-skill \|  \|  \| `cards\/design\/c\.md` \|/);
});

test("the card index still renders when no cards exist", () => {
  const index = skillCardsMarkdownIndex([]);
  assert.match(index, /Total cards: 0/);
  assert.match(index, /## Cards/);
});

test("the public projection keeps routing fields and drops the rest", () => {
  const projected = skillCardPublic({ ...CUSTOM_SKILL, markdown: "secret", content_hash: "abc" });
  assert.equal(projected.name, "feature-builder");
  assert.deepEqual(projected.subgroups, ["implementation"]);
  assert.equal("markdown" in projected, false);
  assert.equal("content_hash" in projected, false);
  assert.deepEqual(skillCardPublic({ name: "bare", source: "x" }).related_skills, []);
});

test("a card that says the same thing is not rewritten for its stamp alone", () => {
  const item = {
    name: "tdd-workflow", source: "external/ecc", type: "external-skill",
    path: "sources/external/ecc/skills/tdd-workflow/SKILL.md",
    description: "Test-driven development.", use_when: "writing a new feature",
    categories: ["testing-quality"], maturity: "reviewed", quality_score: 91
  };
  const monday = renderSkillCard(item, "2026-02-01T00:00:00.000Z");
  const tuesday = renderSkillCard(item, "2026-02-02T00:00:00.000Z");
  assert.notEqual(monday, tuesday, "the stamp does move between renders");
  assert.equal(skillCardUnchanged(monday, tuesday), true, "and it is the only thing that moved");

  // A real change is a real change.
  const edited = renderSkillCard({ ...item, description: "Test-driven development, strictly." }, "2026-02-02T00:00:00.000Z");
  assert.equal(skillCardUnchanged(monday, edited), false);
  // Nothing on disk is not "unchanged".
  assert.equal(skillCardUnchanged("", monday), false);
});
