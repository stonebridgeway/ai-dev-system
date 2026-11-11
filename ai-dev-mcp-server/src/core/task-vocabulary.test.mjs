import assert from "node:assert/strict";
import test from "node:test";
import {
  NAME_MATCH_SCORE,
  TASK_CONCEPTS,
  declaredStackTerms,
  expandTaskVocabulary,
  specialistMatchScore,
  splitSituationText,
  stackAlignment,
  taskConcepts,
  taskNamesSkill
} from "./task-vocabulary.mjs";

// Two imported skills, verbatim from the imported registry.
const TDD_WORKFLOW = {
  name: "tdd-workflow",
  use_when: "Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.",
  description: "Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.",
  categories: ["external", "testing-quality", "debugging"],
  languages: ["typescript", "javascript", "shell"],
  frameworks: ["react", "playwright", "github-actions", "redis"]
};
const HEXAGONAL = {
  name: "hexagonal-architecture",
  use_when: "introducing or refactoring toward Ports and Adapters, or when domain logic has become entangled with I/O",
  description: "Design, implement, and refactor Ports & Adapters systems with clear domain boundaries, dependency inversion, and testable use-case orchestration across TypeScript, Java, Kotlin, and Go services.",
  categories: ["external", "testing-quality"],
  languages: ["typescript", "java", "kotlin"],
  frameworks: ["spring"]
};

test("a Russian task names the concepts its English skills are written about", () => {
  assert.deepEqual(taskConcepts("настроить разработку через тесты"), ["tdd", "testing"]);
  assert.deepEqual(taskConcepts("отрефакторить по гексагональной архитектуре"), ["hexagonal", "refactor", "architecture"]);
  assert.ok(taskConcepts("проверить зависимости на уязвимости").includes("dependencies"));
  assert.ok(taskConcepts("развернуть в кубере").includes("container"));
  assert.deepEqual(taskConcepts(""), []);
  assert.deepEqual(taskConcepts(undefined), []);
  // "ё" is folded, so a task written either way matches.
  assert.deepEqual(taskConcepts("почини ретрай"), taskConcepts("почини ретрай"));
});

test("every concept carries a Russian trigger and English terms", () => {
  const ids = TASK_CONCEPTS.map((concept) => concept.id);
  assert.equal(new Set(ids).size, ids.length, "concept ids must be unique");
  for (const concept of TASK_CONCEPTS) {
    assert.ok(concept.ru instanceof RegExp, `${concept.id}: ru must be a regular expression`);
    assert.ok(concept.ru.flags.includes("i"), `${concept.id}: ru must be case-insensitive`);
    assert.ok(concept.en.split(/\s+/).length >= 4, `${concept.id}: en must list the synonyms a catalogue uses`);
    assert.equal(/[а-я]/i.test(concept.en), false, `${concept.id}: en is the English side`);
  }
});

test("the expansion keeps the task's own words apart from the translated ones", () => {
  const { concepts, terms, own_terms: own } = expandTaskVocabulary("настроить разработку через тесты", ["TypeScript", "Vite"]);
  assert.deepEqual(concepts, ["tdd", "testing"]);
  assert.ok(own.includes("typescript"), "the project stack is part of the task's own words");
  assert.ok(own.includes("тесты"));
  assert.equal(own.includes("coverage"), false, "a translated term is not one of the task's own words");
  assert.ok(terms.includes("coverage"));
  assert.ok(terms.includes("typescript"));
  assert.equal(terms.filter((term) => term.length <= 2).length, 0, "two-letter noise is dropped");
  assert.deepEqual(expandTaskVocabulary("").concepts, []);
});

test("an English task scores on its own words", () => {
  const { terms } = expandTaskVocabulary("set up test-driven development for the api layer");
  assert.ok(terms.includes("test-driven"));
  assert.ok(terms.includes("development"));
  assert.ok(specialistMatchScore(TDD_WORKFLOW, terms).use_when_hits >= 3);
});

test("the score is carried by the text that says when to use a skill", () => {
  const { terms } = expandTaskVocabulary("отрефакторить по гексагональной архитектуре");
  const hexagonal = specialistMatchScore(HEXAGONAL, terms);
  const tdd = specialistMatchScore(TDD_WORKFLOW, terms);
  assert.ok(hexagonal.score > tdd.score, `${hexagonal.score} should beat ${tdd.score}`);
  assert.ok(hexagonal.matched_terms.includes("adapters"));
  assert.ok(hexagonal.use_when_hits >= 3);

  // A name the task states outright is a signal of its own: it identifies the
  // skill where no amount of situation overlap would. The caller holds a named
  // skill to a lower score, so the flag has to say which kind of match it was.
  const nameOnly = specialistMatchScore({ name: "hexagonal-architecture", use_when: "", description: "" }, terms);
  assert.ok(nameOnly.score > 0);
  assert.equal(nameOnly.use_when_hits, 0);
  assert.equal(nameOnly.name_match, true);

  // An application skill named by one word of a sentence: one whole word in the
  // name, nothing in a situation nobody wrote.
  const gmail = specialistMatchScore(
    { name: "gmail", use_when: "", description: "Gmail integration. Use when the user wants to interact with Gmail data." },
    expandTaskVocabulary("send a notification through gmail when the build fails").terms
  );
  assert.equal(gmail.name_match, true);
  assert.ok(gmail.score >= NAME_MATCH_SCORE);

  // A term that only appears inside a longer name is not the task naming it.
  const partial = specialistMatchScore({ name: "hexagonal-architecture", use_when: "", description: "" }, ["hexagon"]);
  assert.equal(partial.name_match, false);
  assert.deepEqual(
    specialistMatchScore({}, terms),
    { score: 0, use_when_hits: 0, name_match: false, matched_terms: [], excluded_terms: [] }
  );
});

test("the half of use_when that says when not to use a skill counts against it", () => {
  // Verbatim from the imported registry: one sentence for the situation, one
  // for the situations the author excluded.
  const generalist = {
    name: "intent-driven-development",
    use_when: "a user asks to clarify a feature, define acceptance criteria, de-risk a security/data/migration/integration change, prepare implementation requirements for another agent, or make a complex request testable. Do not trigger for trivial edits, straightforward fixes, active debugging, code review, or implementation requests whose acceptance conditions are already clear unless the user explicitly invokes this skill",
    description: ""
  };
  const split = splitSituationText(generalist.use_when);
  assert.ok(split.wanted.includes("acceptance criteria"));
  assert.equal(split.wanted.includes("code review"), false, "the exclusion is not part of what the skill is for");
  assert.ok(split.excluded.includes("code review"));

  // A term only the exclusion names is subtracted, and the skill loses the
  // situation its author told it to stay out of.
  const review = specialistMatchScore(generalist, expandTaskVocabulary("сделать ревью пулл-реквеста").terms);
  assert.ok(review.excluded_terms.includes("review"), JSON.stringify(review));
  assert.ok(review.score <= 0, `code review should not score for this skill, got ${review.score}`);
  const debugging = specialistMatchScore(generalist, expandTaskVocabulary("починить баг").terms);
  assert.ok(debugging.excluded_terms.includes("debugging"));
  assert.ok(debugging.use_when_hits < 3, "and it cannot clear the situation-hit floor either");

  // A term both halves name is the skill's own subject and keeps its points:
  // "do not trigger for … implementation requests whose acceptance conditions
  // are already clear" must not cancel a use_when about acceptance criteria.
  const own = specialistMatchScore(generalist, ["acceptance", "criteria", "migration"]);
  assert.deepEqual(own.excluded_terms, []);
  assert.equal(own.score, 9);

  // Function words in the exclusion decide nothing; a subject word does.
  assert.deepEqual(
    specialistMatchScore({ use_when: "for migrations. Do not use for the review and before that", description: "" }, ["and", "before", "review"]).excluded_terms,
    ["review"]
  );

  // A skill with no exclusion is scored exactly as before.
  assert.deepEqual(splitSituationText(TDD_WORKFLOW.use_when).excluded, "");
});

test("a skill's declared ecosystem is read from the task and the project, never from the translation", () => {
  assert.deepEqual(declaredStackTerms(TDD_WORKFLOW), ["typescript", "javascript", "shell", "react", "playwright", "github-actions", "redis"]);
  assert.deepEqual(declaredStackTerms({}), []);

  const agnostic = { name: "intent-driven-development", use_when: "clarify a feature" };
  assert.equal(stackAlignment(agnostic, expandTaskVocabulary("почини баг").own_terms), "agnostic");

  const typescriptProject = expandTaskVocabulary("настроить тесты", ["TypeScript", "Vite"]).own_terms;
  assert.equal(stackAlignment(TDD_WORKFLOW, typescriptProject), "aligned");
  assert.equal(stackAlignment({ languages: ["php"], frameworks: ["laravel"] }, typescriptProject), "foreign");

  // The `tdd` concept translates to "test-driven development", not to "react":
  // the English side of the table must not be able to claim an ecosystem.
  const noStack = expandTaskVocabulary("настроить разработку через тесты").own_terms;
  assert.equal(stackAlignment(TDD_WORKFLOW, noStack), "foreign");
});

test("a skill is named only as a whole word, never as a fragment of one", () => {
  // Measured on the real catalogue: "set up a Slack notification integration
  // for our deploy pipeline" contained "eploy" — a UK recruitment system — and
  // containment scored it as though the task had asked for it by name, worth
  // +24 and a pass through the membrane floor.
  assert.equal(taskNamesSkill("set up a Slack notification for our deploy pipeline", "eploy"), false);
  assert.equal(taskNamesSkill("build a sandbox for the team", "box"), false);
  assert.equal(taskNamesSkill("send a message to a Slack channel", "slack"), true);
});

test("a hyphenated name is named by the words it is written from", () => {
  assert.equal(taskNamesSkill("upload the report to google drive", "google-drive"), true);
  assert.equal(taskNamesSkill("upload the report to google-drive", "google-drive"), true);
  assert.equal(taskNamesSkill("upload the report to google docs", "google-drive"), false);
});

test("an empty or one-character name is never named", () => {
  assert.equal(taskNamesSkill("anything at all", ""), false);
  assert.equal(taskNamesSkill("anything at all", "x"), false);
  assert.equal(taskNamesSkill("", "slack"), false);
});

test("one part of a compound name does not count as naming the skill", () => {
  // `octopus-deploy` is normalised to "octopus deploy" so that a task writing
  // the name in words still finds it. Left unguarded that same rewrite let
  // "deploy pipeline" claim the name match, and octopus-deploy outscored slack
  // 14 to 13 on a task that named only Slack.
  const octopus = { name: "octopus-deploy", use_when: "deploy releases", description: "" };
  const partial = specialistMatchScore(octopus, ["deploy", "pipeline"]);
  assert.equal(partial.name_match, false);

  const whole = specialistMatchScore(octopus, ["octopus", "deploy"]);
  assert.equal(whole.name_match, true);
  assert.ok(whole.score > partial.score, "naming every part must outscore naming one");
});

test("a single-word name still matches on its own word", () => {
  const slack = { name: "slack", use_when: "the user wants to interact with Slack data", description: "" };
  assert.equal(specialistMatchScore(slack, ["slack", "integration"]).name_match, true);
});
