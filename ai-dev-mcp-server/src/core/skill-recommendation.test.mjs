import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMBRANE_POLICIES,
  membraneAllowed,
  projectFiltersMembrane,
  projectLooksBackend,
  projectRecommendedSkillRank,
  projectStackLooksFrontend,
  recommendSkillsFromRegistry,
  shouldSkipRecommendedSkill,
  skillQualityRankAdjustment,
  taskLooksBackend,
  taskLooksBetaFrontend,
  taskLooksFrontendGate,
  taskLooksFrontendProduct,
  taskLooksLandingConversion,
  taskLooksMembraneIntegration,
  taskLooksQuality,
  pickTaskSpecialist,
  taskLooksVisual
} from "./skill-recommendation.mjs";

/** Project context as the extension builds it, with nothing detected. */
const NO_PROJECT = Object.freeze({
  available: false,
  name: "",
  project_path: "",
  stack: [],
  project_types: [],
  card_path: "",
  card_text: "",
  context_text: ""
});

function projectContext(overrides = {}) {
  return { ...NO_PROJECT, available: true, name: "demo", ...overrides };
}

function registryItem(overrides = {}) {
  return {
    name: "feature-builder",
    source: "custom",
    type: "workflow",
    path: "custom/feature-builder/SKILL.md",
    primary_group: "repository-workflows",
    categories: ["workflow"],
    description: "implement a feature end to end",
    use_when: "the task changes product behaviour",
    maturity: "validated",
    trust_level: "trusted-local",
    quality_score: 90,
    quality_grade: "A",
    quality_status: "pass",
    skill_schema_version: 2,
    ...overrides
  };
}

test("membrane policies are exactly the three the tool accepts", () => {
  assert.deepEqual([...MEMBRANE_POLICIES], ["auto", "include", "exclude"]);
});

test("task intent patterns read both English and Russian", () => {
  assert.ok(taskLooksVisual("сделай лендинг"));
  assert.ok(taskLooksVisual("polish the UI"));
  assert.ok(!taskLooksVisual("rotate the database credentials"));

  assert.ok(taskLooksMembraneIntegration("add a gmail connector"));
  assert.ok(!taskLooksMembraneIntegration("rename a local variable"));

  assert.ok(taskLooksBackend("add a fastapi endpoint"));
  assert.ok(taskLooksQuality("run the linter and the tests"));
  assert.ok(taskLooksFrontendProduct("build a new marketing website from scratch"));
  assert.ok(taskLooksLandingConversion("improve the landing page CTA"));
});

test("compound intents need both halves of their signal", () => {
  assert.ok(taskLooksBetaFrontend("fix a layout bug in the admin panel"));
  assert.ok(!taskLooksBetaFrontend("design a brand new component library"));
  assert.ok(taskLooksFrontendGate("verify the responsive layout before release"));
  assert.ok(!taskLooksFrontendGate("verify the database migration"));
});

test("project predicates read the stack and the card text separately", () => {
  assert.ok(projectStackLooksFrontend({ stack: ["React", "Vite"] }));
  assert.ok(!projectStackLooksFrontend({ stack: ["python"] }));
  assert.ok(!projectStackLooksFrontend({ stack: [] }));
  assert.ok(projectLooksBackend({ context_text: "fastapi + postgres worker" }));
  assert.ok(projectFiltersMembrane({ card_text: "Membrane/app skills are noisy here" }));
  assert.ok(!projectFiltersMembrane({ card_text: "no opinion recorded" }));
});

test("membrane is allowed by explicit policy, by task intent, and never when the card says noisy", () => {
  const task = "rename a helper";
  assert.ok(membraneAllowed({ task, context: NO_PROJECT, membranePolicy: "include", includeMembrane: false }));
  assert.ok(membraneAllowed({ task, context: NO_PROJECT, membranePolicy: "auto", includeMembrane: true }));
  assert.ok(!membraneAllowed({ task, context: NO_PROJECT, membranePolicy: "exclude", includeMembrane: false }));
  assert.ok(!membraneAllowed({ task, context: NO_PROJECT, membranePolicy: "auto", includeMembrane: false }));
  assert.ok(membraneAllowed({ task: "add a slack webhook", context: NO_PROJECT, membranePolicy: "auto", includeMembrane: false }));
  assert.ok(!membraneAllowed({
    task: "add a slack webhook",
    context: projectContext({ membrane_noisy: true }),
    membranePolicy: "auto",
    includeMembrane: false
  }));
  // An explicit include outranks the project card's preference.
  assert.ok(membraneAllowed({
    task: "rename a helper",
    context: projectContext({ membrane_noisy: true }),
    membranePolicy: "include",
    includeMembrane: false
  }));
});

test("skip reasons cover overlays, membrane, narrow workflows and visual skills", () => {
  const base = { task: "rename a helper", context: NO_PROJECT, membranePolicy: "auto", includeMembrane: false };
  assert.match(shouldSkipRecommendedSkill(registryItem({ routing_priority: "disabled" }), base), /disabled by the local normalization overlay/);
  assert.match(shouldSkipRecommendedSkill(registryItem({ source: "membrane/app-skills" }), base), /Membrane\/app skills are filtered/);
  assert.match(shouldSkipRecommendedSkill(registryItem({ name: "knowledge-curator" }), base), /durable-knowledge update/);
  assert.match(shouldSkipRecommendedSkill(registryItem({ name: "repo-onboarding" }), base), /repository preparation/);
  assert.match(shouldSkipRecommendedSkill(registryItem({ name: "frontend-polisher" }), base), /neither task nor project is frontend/);
  assert.match(shouldSkipRecommendedSkill(registryItem({ name: "brandkit", source: "design/taste-skill" }), base), /Visual\/image-heavy skill/);
  assert.match(shouldSkipRecommendedSkill(registryItem({ name: "x", source: "design/taste-skill" }), base), /Design\/frontend skill/);
  assert.equal(shouldSkipRecommendedSkill(registryItem(), base), "");
});

test("a frontend project keeps frontend skills a non-visual task would drop", () => {
  const context = projectContext({ stack: ["React"] });
  const base = { task: "add a small helper", context, membranePolicy: "auto", includeMembrane: false };
  assert.equal(shouldSkipRecommendedSkill(registryItem({ name: "frontend-polisher" }), base), "");
  assert.equal(shouldSkipRecommendedSkill(registryItem({ name: "x", source: "design/taste-skill" }), base), "");
});

test("project card recommendations are ranked against the current task", () => {
  const context = projectContext();
  assert.equal(projectRecommendedSkillRank("feature-builder", "implement a new feature", context), 108);
  assert.equal(projectRecommendedSkillRank("bugfix-investigator", "fix the failing ci job", context), 108);
  assert.equal(projectRecommendedSkillRank("code-reviewer", "review this pull request", context), 108);
  assert.equal(projectRecommendedSkillRank("frontend-product-builder", "build a new marketing website from scratch", context), 180);
  assert.equal(projectRecommendedSkillRank("landing-conversion-reviewer", "improve the landing page CTA", context), 116);
  assert.equal(projectRecommendedSkillRank("knowledge-curator", "update the knowledge base", context), 108);
  assert.equal(projectRecommendedSkillRank("bugfix-investigator", "write documentation", context), 0);
  assert.equal(projectRecommendedSkillRank("not-a-skill", "implement a new feature", context), 0);
});

test("quality adjustment only applies to current-schema skills", () => {
  assert.equal(skillQualityRankAdjustment(null), 0);
  assert.equal(skillQualityRankAdjustment({ skill_schema_version: 1, quality_score: 100 }), 0);
  assert.equal(skillQualityRankAdjustment(registryItem({ maturity: "deprecated" })), -100);
  assert.equal(skillQualityRankAdjustment(registryItem({ quality_status: "fail" })), -30);
  assert.equal(skillQualityRankAdjustment(registryItem({ routing_priority: "disabled" })), -100 + 5 + 4 + 2);
});

test("quality adjustment rewards score, maturity, trust and routing priority", () => {
  // score 90 -> +5, validated -> +4, trusted-local -> +2
  assert.equal(skillQualityRankAdjustment(registryItem()), 11);
  assert.equal(skillQualityRankAdjustment(registryItem({ maturity: "reviewed" })), 9);
  assert.equal(skillQualityRankAdjustment(registryItem({ maturity: "draft", trust_level: "unverified" })), 5);
  assert.equal(skillQualityRankAdjustment(registryItem({ routing_priority: "high" })), 15);
  assert.equal(skillQualityRankAdjustment(registryItem({ routing_priority: "low" })), 5);
  // The score term is clamped to +/- 8.
  assert.equal(skillQualityRankAdjustment(registryItem({ quality_score: 100, maturity: "draft", trust_level: "unverified" })), 8);
  assert.equal(skillQualityRankAdjustment(registryItem({ quality_score: 0, maturity: "draft", trust_level: "unverified" })), -8);
});

test("a bug task routes to the bugfix workflow and never past the three-skill cap", () => {
  const items = [
    registryItem(),
    registryItem({ name: "bugfix-investigator", description: "find the root cause of a failure", use_when: "something is broken" }),
    registryItem({ name: "code-reviewer", description: "review a diff for risk", use_when: "a change needs review" })
  ];
  const result = recommendSkillsFromRegistry({ task: "fix the failing ci job", items, context: NO_PROJECT });

  assert.ok(result.length <= 3);
  assert.ok(result.some((item) => item.name === "bugfix-investigator"));
  assert.ok(result.every((item) => typeof item.score === "number"));
  // No project context: no project name and no "project context" evidence.
  assert.ok(result.every((item) => !("project" in item)));
});

test("the limit is clamped to three however it is asked for", () => {
  const items = Array.from({ length: 8 }, (_, index) => registryItem({
    name: `feature-skill-${index}`,
    description: "implement a feature",
    use_when: "the task changes product behaviour"
  }));
  for (const limit of [99, 8, 0, undefined, "nonsense"]) {
    assert.ok(recommendSkillsFromRegistry({ task: "implement a feature", limit, items, context: NO_PROJECT }).length <= 3);
  }
  assert.equal(recommendSkillsFromRegistry({ task: "implement a feature", limit: 1, items, context: NO_PROJECT }).length, 1);
});

test("membrane skills stay out by default and come back with an explicit policy", () => {
  // The task names the app skill but carries no integration wording, so only an
  // explicit policy can let it through.
  const task = "use the acme-portal export";
  const items = [
    registryItem(),
    registryItem({
      name: "acme-portal", source: "membrane/app-skills", primary_group: "integrations-automation",
      categories: [], description: "acme portal application skill", use_when: "the task uses the acme portal"
    })
  ];
  const membraneNames = (options) => recommendSkillsFromRegistry({ task, items, context: NO_PROJECT, ...options })
    .filter((item) => item.source.includes("membrane"))
    .map((item) => item.name);

  assert.deepEqual(membraneNames({}), []);
  assert.deepEqual(membraneNames({ membranePolicy: "exclude" }), []);
  assert.deepEqual(membraneNames({ membranePolicy: "include" }), ["acme-portal"]);
  assert.deepEqual(membraneNames({ includeMembrane: true }), ["acme-portal"]);
});

test("an integration task stops filtering app skills under the default policy", () => {
  // Whether one reaches the three-skill answer is a ranking question; the policy
  // question is only whether it is still filtered out before ranking.
  const appSkill = registryItem({
    name: "acme-portal", source: "membrane/app-skills", primary_group: "integrations-automation",
    categories: [], description: "acme portal application skill", use_when: "the task uses the acme portal"
  });
  const policy = { context: NO_PROJECT, membranePolicy: "auto", includeMembrane: false };
  assert.equal(shouldSkipRecommendedSkill(appSkill, { ...policy, task: "add an acme-portal webhook connector" }), "");
  assert.match(shouldSkipRecommendedSkill(appSkill, { ...policy, task: "rename a local variable" }), /Membrane\/app skills are filtered/);
});

test("a deprecated registry skill is dropped from the ranked candidates", () => {
  const deprecated = registryItem({ name: "legacy-helper", maturity: "deprecated", description: "a legacy helper", use_when: "legacy helper work" });
  const live = { ...deprecated, maturity: "validated" };
  const task = "legacy-helper cleanup";

  assert.ok(recommendSkillsFromRegistry({ task, items: [live], context: NO_PROJECT })
    .some((item) => item.name === "legacy-helper"));
  assert.ok(!recommendSkillsFromRegistry({ task, items: [deprecated], context: NO_PROJECT })
    .some((item) => item.name === "legacy-helper"));
});

test("a routing rule still names its skill when the registry does not carry it", () => {
  // `prioritizeRoutedRecommendations` synthesizes an entry for a routed name the
  // registry never matched, so the deterministic core survives a thin registry.
  const routed = recommendSkillsFromRegistry({ task: "implement a feature and review it", items: [], context: NO_PROJECT });
  assert.ok(routed.some((item) => item.name === "feature-builder"));
  assert.ok(routed.every((item) => typeof item.name === "string"));
});

test("project context adds the project name, its evidence and its card recommendations", () => {
  const items = [
    registryItem(),
    registryItem({ name: "bugfix-investigator", description: "root cause analysis", use_when: "something is broken" })
  ];
  const context = projectContext({
    stack: ["python", "fastapi"],
    context_text: "fastapi postgres worker",
    recommended_skills: ["`bugfix-investigator` - for regressions"]
  });
  const result = recommendSkillsFromRegistry({ task: "fix a regression in the api", items, context });

  assert.ok(result.length > 0);
  assert.ok(result.every((item) => item.project === "demo"));
  const bugfix = result.find((item) => item.name === "bugfix-investigator");
  assert.ok(bugfix);
  assert.ok(bugfix.evidence.length > 0);
});

test("card paths are attached when the card index knows the skill", () => {
  const items = [registryItem()];
  const cards = [{ source: "CUSTOM", name: "Feature-Builder", card_path: "03-skills-catalog/cards/custom/feature-builder.md" }];
  const [first] = recommendSkillsFromRegistry({ task: "implement a feature", items, cards, context: NO_PROJECT });
  assert.equal(first.card_path, "03-skills-catalog/cards/custom/feature-builder.md");
  const [withoutCards] = recommendSkillsFromRegistry({ task: "implement a feature", items, context: NO_PROJECT });
  assert.equal(withoutCards.card_path, undefined);
});

test("preferred groups join the routed groups reported on every recommendation", () => {
  const items = [registryItem()];
  const [first] = recommendSkillsFromRegistry({
    task: "implement a feature",
    items,
    context: NO_PROJECT,
    preferredGroups: ["frontend-ui", "not-a-group"]
  });
  assert.ok(first.routed_groups.includes("frontend-ui"));
  assert.ok(!first.routed_groups.includes("not-a-group"));
  // A comma string is accepted in place of an array.
  const [fromString] = recommendSkillsFromRegistry({
    task: "implement a feature",
    items,
    context: NO_PROJECT,
    preferredGroups: "frontend-ui"
  });
  assert.ok(fromString.routed_groups.includes("frontend-ui"));
});

test("an empty registry still answers with the deterministic routing", () => {
  const result = recommendSkillsFromRegistry({ task: "fix the failing ci job", items: [], context: NO_PROJECT });
  assert.ok(Array.isArray(result));
  assert.ok(result.length <= 3);
});

test("ranking is stable: the same inputs give the same order", () => {
  const items = [
    registryItem(),
    registryItem({ name: "code-reviewer", description: "review a diff", use_when: "a change needs review" }),
    registryItem({ name: "bugfix-investigator", description: "root cause", use_when: "something is broken" })
  ];
  const once = recommendSkillsFromRegistry({ task: "review the fix for this bug", items, context: NO_PROJECT });
  const twice = recommendSkillsFromRegistry({ task: "review the fix for this bug", items, context: NO_PROJECT });
  assert.deepEqual(once, twice);
});

test("each intent pattern names its skill for a task that matches it", () => {
  // One registry entry per case, so the only thing that can put the name in the
  // answer is the intent branch for it.
  const cases = [
    ["repo-onboarding", "onboard me to this repository and its AGENTS file"],
    ["feature-builder", "implement a new feature"],
    ["bugfix-investigator", "debug this flaky regression"],
    ["code-reviewer", "review this pull request"],
    ["beta-frontend-maintainer", "fix a layout bug in the admin panel"],
    ["frontend-quality-gate", "verify the responsive accessibility before release"],
    ["landing-conversion-reviewer", "improve the landing page cta conversion"],
    ["frontend-polisher", "polish the ui"],
    ["frontend-product-builder", "build a new marketing website from scratch"],
    ["archify", "draw an architecture diagram in mermaid"],
    ["design-taste-frontend", "a premium portfolio site"],
    ["image-to-code", "turn this reference image into a mockup"],
    ["brandkit", "create a brand kit with a logo"],
    ["knowledge-curator", "update the obsidian vault notes"],
    ["backend-api-engineer", "add a fastapi worker endpoint"],
    ["api-contract-reviewer", "keep the graphql endpoint backward compatible"],
    ["database-migration-guardian", "write an alembic schema migration"],
    ["devops-release-engineer", "set up the github actions deploy pipeline"],
    ["container-deployment-reviewer", "make the container image reproducible"],
    ["application-security-reviewer", "threat model the authorization boundary"],
    ["secrets-dependencies-auditor", "audit the lockfile for supply chain risk"],
    ["data-pipeline-engineer", "rebuild the etl ingestion lineage"],
    ["llm-integration-engineer", "add rag embeddings with prompt tool calling"]
  ];
  for (const [name, task] of cases) {
    const result = recommendSkillsFromRegistry({ task, items: [registryItem({ name })], context: NO_PROJECT });
    assert.ok(
      result.some((item) => item.name === name),
      `${name} missing for ${JSON.stringify(task)}: got ${result.map((item) => item.name).join(", ")}`
    );
  }
});

test("a redesign is frontend product work before it is a redesign skill", () => {
  // `redesign-existing-projects` ranks 132, below frontend-product-builder (190)
  // and frontend-quality-gate (148), so it loses the three slots to them. This
  // pins the precedence rather than pretending the lower rank wins.
  const result = recommendSkillsFromRegistry({
    task: "redesign the existing ui",
    items: [registryItem({ name: "redesign-existing-projects" })],
    context: NO_PROJECT
  });
  assert.deepEqual(result.map((item) => item.name).slice(0, 2), ["frontend-product-builder", "frontend-quality-gate"]);
  assert.ok(!result.some((item) => item.name === "redesign-existing-projects"));
});

test("quality tasks add review, and backend tasks add the backend pair", () => {
  const quality = recommendSkillsFromRegistry({
    task: "run the linter and the coverage gate",
    items: [registryItem({ name: "code-reviewer" })],
    context: NO_PROJECT
  });
  assert.ok(quality.some((item) => item.name === "code-reviewer"));

  const backendProject = recommendSkillsFromRegistry({
    task: "add a helper",
    items: [registryItem({ name: "backend-api-engineer" })],
    context: projectContext({ context_text: "fastapi postgres celery worker" })
  });
  assert.ok(backendProject.some((item) => item.name === "backend-api-engineer"));
});


// Д-1. 101 imported skills were in the index and none of them could ever be
// recommended: our own three fill every conventional slot, and an imported
// skill's English `use_when` shares no substring with a Russian task. The fix
// is a reserved slot plus the bilingual expansion, and the thing it must not do
// is cost us one of ours.
const IMPORTED_TDD = Object.freeze({
  name: "tdd-workflow",
  source: "external/ecc",
  type: "external-skill",
  path: "sources/external/ecc/skills/tdd-workflow/SKILL.md",
  // The auto-tagger's categories, mis-tags included: this entry is filed under
  // design and frontend in the real registry.
  categories: ["external", "frontend", "design", "ui", "testing-quality"],
  primary_group: "testing-quality",
  description: "Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.",
  use_when: "Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.",
  languages: ["typescript", "javascript"],
  frameworks: ["playwright"],
  maturity: "reviewed",
  trust_level: "known-upstream",
  quality_score: 91,
  quality_status: "pass",
  routing_priority: "normal",
  skill_schema_version: 2
});

// Same situation text and same name shape, so only the declared ecosystem
// separates them: one is a PHP skill, the other lists most of the world.
const NARROW_IMPORT = Object.freeze({
  ...IMPORTED_TDD,
  name: "alpha-testing",
  path: "sources/external/ecc/skills/alpha-testing/SKILL.md",
  languages: ["php"],
  frameworks: ["laravel"]
});
const BROAD_IMPORT = Object.freeze({
  ...IMPORTED_TDD,
  name: "omega-testing",
  path: "sources/external/ecc/skills/omega-testing/SKILL.md",
  languages: ["python", "go", "java", "kotlin", "ruby"],
  frameworks: ["django", "spring"]
});

test("an imported specialist is offered beside the routed three, never instead of one", () => {
  const items = [
    registryItem(),
    registryItem({ name: "code-reviewer", description: "review a diff for risk", use_when: "a change needs review" }),
    registryItem({ name: "backend-api-engineer", description: "backend contracts", use_when: "backend or API work" }),
    IMPORTED_TDD
  ];
  const task = "настроить разработку через тесты";
  const withoutImport = recommendSkillsFromRegistry({ task, items: items.slice(0, 3), context: NO_PROJECT });
  const withImport = recommendSkillsFromRegistry({ task, items, context: NO_PROJECT });

  assert.deepEqual(
    withImport.slice(0, withoutImport.length).map((item) => item.name),
    withoutImport.map((item) => item.name),
    "the routed core is untouched"
  );
  const specialist = withImport.at(-1);
  assert.equal(specialist.name, "tdd-workflow");
  assert.equal(specialist.source, "external/ecc");
  assert.equal(specialist.routing_role, "specialist");
  assert.match(specialist.routing_rule, /^use-when:/);
  assert.equal(specialist.type, "external-skill", "the registry metadata comes with it, not a synthesised stub");
  assert.ok(specialist.path, "the agent needs the path to read it");
});

test("a specialist has to answer the task's situation, and its ecosystem has to be plausible", () => {
  const base = [registryItem()];
  const context = (stack) => ({ ...NO_PROJECT, available: true, name: "demo", stack });

  // No project stack: a foreign ecosystem is a penalty, not a veto, and between
  // two equal matches the one that is not written for a single stack wins —
  // even though the narrow one sorts first by name.
  const noStack = pickTaskSpecialist({ task: "настроить разработку через тесты", items: [...base, NARROW_IMPORT, BROAD_IMPORT], context: NO_PROJECT });
  assert.equal(noStack.item.name, "omega-testing");
  assert.equal(noStack.stack, "foreign");

  // A project with a stack refuses a skill written for another one outright.
  assert.equal(
    pickTaskSpecialist({ task: "настроить разработку через тесты", items: [...base, NARROW_IMPORT], context: context(["TypeScript", "Vite"]) }),
    null
  );
  assert.equal(
    pickTaskSpecialist({ task: "настроить разработку через тесты", items: [...base, IMPORTED_TDD], context: context(["TypeScript", "Vite"]) }).stack,
    "aligned"
  );

  // A task that names no concept the table knows gets no specialist, and
  // neither does one whose only connection is the name.
  assert.equal(pickTaskSpecialist({ task: "поговори с заказчиком", items: [...base, IMPORTED_TDD], context: NO_PROJECT }), null);
  assert.equal(
    pickTaskSpecialist({
      task: "запусти tdd-workflow",
      items: [...base, { ...IMPORTED_TDD, use_when: "", description: "" }],
      context: NO_PROJECT
    }),
    null,
    "a name in the task text is not a situation match"
  );

  // An import that shadows one of ours by name is never offered.
  assert.equal(
    pickTaskSpecialist({
      task: "настроить разработку через тесты",
      items: [registryItem({ name: "tdd-workflow", description: "our own", use_when: "ours" }), IMPORTED_TDD],
      context: NO_PROJECT
    }),
    null
  );
  // Nor is a deprecated or disabled one.
  assert.equal(pickTaskSpecialist({ task: "настроить разработку через тесты", items: [...base, { ...IMPORTED_TDD, maturity: "deprecated" }], context: NO_PROJECT }), null);
  assert.equal(pickTaskSpecialist({ task: "настроить разработку через тесты", items: [...base, { ...IMPORTED_TDD, routing_priority: "disabled" }], context: NO_PROJECT }), null);
});

test("a skill that says it is not for this situation does not get the slot", () => {
  const base = [registryItem()];
  // The real shape of the generalist that used to take the slot: a use_when
  // that answers almost any task, with the situations it is not for listed in
  // the same sentence (docs/ecc-upgrades/DEBTS.md, Д-20).
  const generalist = {
    ...IMPORTED_TDD,
    name: "intent-driven-development",
    path: "sources/external/ecc/skills/intent-driven-development/SKILL.md",
    languages: [],
    frameworks: [],
    description: "Turn ambiguous or high-impact changes into scoped, verifiable acceptance criteria.",
    use_when: "a user asks to clarify a feature, define acceptance criteria, de-risk a security/data/migration/integration change, or make a complex request testable. Do not trigger for trivial edits, straightforward fixes, active debugging, code review, or implementation requests whose acceptance conditions are already clear"
  };
  const databaseSkill = {
    ...IMPORTED_TDD,
    name: "database-migrations",
    path: "sources/external/ecc/skills/database-migrations/SKILL.md",
    languages: ["sql"],
    frameworks: ["postgres"],
    description: "Plan and review database schema migrations.",
    use_when: "reviewing or writing a database migration: schema changes, indexes, backfills, and the rollback for each one"
  };

  // The two situations its author excluded.
  assert.equal(pickTaskSpecialist({ task: "починить баг: тесты падают в ci", items: [...base, generalist], context: NO_PROJECT }), null);
  const review = pickTaskSpecialist({
    task: "сделать ревью пулл-реквеста с миграцией базы данных",
    items: [...base, generalist, databaseSkill],
    context: NO_PROJECT
  });
  assert.equal(review.item.name, "database-migrations", "the skill for the subject beats the one that excluded it");

  // A skill that excludes nothing is unaffected: this is a rule about the
  // author's own sentence, not a penalty for being general.
  assert.equal(
    pickTaskSpecialist({ task: "настроить разработку через тесты", items: [...base, IMPORTED_TDD], context: NO_PROJECT })?.item.name,
    "tdd-workflow"
  );
});

test("an imported skill mis-tagged as design is still reachable for the work it is about", () => {
  // `hexagonal-architecture` carries design/frontend/ui/ux categories from the
  // importer and is a backend architecture skill. Filed under its own
  // primary_group it must survive a task that has nothing to do with design.
  const hexagonal = {
    ...IMPORTED_TDD,
    name: "hexagonal-architecture",
    use_when: "introducing or refactoring toward Ports and Adapters, or when domain logic has become entangled with I/O",
    description: "Design, implement, and refactor Ports & Adapters systems with clear domain boundaries, dependency inversion and testable use-case orchestration.",
    categories: ["external", "frontend", "design", "ui", "ux", "testing-quality"],
    primary_group: "testing-quality"
  };
  const picked = pickTaskSpecialist({ task: "отрефакторить по гексагональной архитектуре", items: [registryItem(), hexagonal], context: NO_PROJECT });
  assert.equal(picked.item.name, "hexagonal-architecture");

  // One whose primary_group really is design stays filtered.
  const frontend = { ...hexagonal, name: "liquid-glass-design", primary_group: "frontend-ui" };
  assert.equal(pickTaskSpecialist({ task: "отрефакторить по гексагональной архитектуре", items: [registryItem(), frontend], context: NO_PROJECT }), null);
});
