import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_CARD_KNOWN_SECTIONS,
  extractProjectCardSection,
  fencedCodeBlocks,
  generatedProjectImprovements,
  generatedProjectRisks,
  qualityGateFileSummaryMarkdown,
  qualityStatusFromCard,
  registrySnapshotTable,
  renderProjectCardMd
} from "./project-cards.mjs";

const present = (modified = "2026-01-01T00:00:00.000Z") => ({ exists: true, modified });
const missing = { exists: false, modified: "" };

const FILES = {
  agents: present(), readme: present(), project_brief: present(),
  project_map: present(), quality_gate: present(), frontend_product: missing
};

const DETECTED = {
  project_name: "Atlas",
  project_path: "/repo/atlas",
  package_manager: "npm",
  stack: ["Node.js", "React"],
  project_types: ["frontend"],
  scripts: { test: "vitest run" },
  commands: [{ label: "Test", command: "npm test", source: "package script" }],
  markers: ["README.md"],
  documentation: { files: [{ path: "README.md", exists: true, type: "file" }], has_readme: true },
  environment: { files: [], local_secret_files: [] },
  dangerous_scripts: [],
  has_git: true,
  is_frontend: true, is_backend: false, is_mobile: false, is_bot: false, is_api: false,
  quality_gaps: [],
  risk_signals: [],
  recommended_next_commands: ["сделай ревью"]
};

const IDENTITY = {
  project_id: "project-1234567890",
  repository_id: "repo-1",
  canonical_path: "/repo/atlas",
  aliases: ["/repo/atlas"]
};

const render = (overrides = {}) => renderProjectCardMd({
  detected: DETECTED,
  identity: IDENTITY,
  files: FILES,
  now: "2026-02-02T00:00:00.000Z",
  updatedAt: "2026-02-02T00:00:01.000Z",
  ...overrides
});

const sectionsOf = (card) => card.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());

test("every section the renderer emits is a known section, and emitted once", () => {
  const emitted = sectionsOf(render({ existingText: "## Notes\n\nkept\n" }));
  for (const name of emitted) {
    assert.ok(PROJECT_CARD_KNOWN_SECTIONS.includes(name), `${name} is not a known section`);
  }
  assert.equal(new Set(emitted).size, emitted.length, "a section is emitted twice");
});

test("a preserved gate run swallows a QA section that follows it", () => {
  // "Last Quality Gate Run" is read up to "Notes" or "Agent Rule" so a nested
  // report survives, which means a "Last Frontend QA Run" written between the
  // two is carried inside it and then emitted again under its own heading.
  const emitted = sectionsOf(render({
    existingText: "## Last Quality Gate Run\n\nran\n\n## Last Frontend QA Run\n\nqa\n"
  }));
  assert.equal(emitted.filter((name) => name === "Last Frontend QA Run").length, 2);
});

test("a card section keeps a nested report whose own headings are not card sections", () => {
  const card = [
    "## Last Quality Gate Run", "", "Status: passed", "", "## Commands", "", "| a |", "",
    "## Notes", "", "kept"
  ].join("\n");
  assert.match(extractProjectCardSection(card, "Last Quality Gate Run"), /## Commands/);
  assert.equal(extractProjectCardSection(card, "Notes"), "kept");
  assert.equal(extractProjectCardSection(card, "Absent"), "");
  // Any other section stops at the next known heading, "Commands" included.
  assert.equal(extractProjectCardSection("## Stack\n\n- a\n\n## Commands\n\nx", "Stack"), "- a");
  // A section with nothing known after it runs to the end.
  assert.equal(extractProjectCardSection("## Agent Rule\n\ntail\n", "Agent Rule"), "tail");
});

test("the gate status is read off the card, then guessed, then given up on", () => {
  assert.deepEqual(qualityStatusFromCard(""), { status: "not run", updated: "" });
  assert.deepEqual(
    qualityStatusFromCard("Status: `passed`\nUpdated: `2026-01-01T00:00:00.000Z`"),
    { status: "passed", updated: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(qualityStatusFromCard("", "All checks passed by hand.").status, "passed (reported manually)");
  assert.equal(qualityStatusFromCard("nothing useful").status, "not run");
});

test("generated risks name every missing agent file and every detected signal", () => {
  const risks = generatedProjectRisks({
    commands: [{ label: "Lint", command: "Not detected" }, { label: "Dev", command: "Not detected" }],
    markers: [],
    has_git: false,
    is_frontend: true,
    risk_signals: ["Script `deploy` may be unsafe."]
  }, { agents: missing, project_brief: missing, project_map: missing, quality_gate: missing, frontend_product: missing });
  assert.match(risks, /- Lint command is not detected\./);
  assert.equal(/Dev command/.test(risks), false);
  assert.match(risks, /- Root `AGENTS\.md` is missing\./);
  assert.match(risks, /- Frontend Product Quality v2 state is missing\./);
  assert.match(risks, /- Repository README is not detected\./);
  assert.match(risks, /- Git repository was not detected at this root\./);
  assert.match(risks, /- Script `deploy` may be unsafe\./);

  assert.equal(
    generatedProjectRisks({ commands: [], markers: ["README.md"], has_git: true, risk_signals: [] }, FILES),
    "- No automatically detected registry risks."
  );
});

test("generated improvements are numbered, and keyed to what is missing", () => {
  const improvements = generatedProjectImprovements({
    commands: [], is_frontend: true, documentation: { has_readme: false },
    environment: { local_secret_files: [".env"], has_example: false }
  }, { agents: missing, project_brief: missing, project_map: missing, quality_gate: missing, frontend_product: missing });
  assert.match(improvements, /^1\. Run `bootstrap_project`/);
  assert.match(improvements, /2\. Run `prepare_frontend_product`/);
  assert.match(improvements, /Add or document a reliable test\/check command\./);
  assert.match(improvements, /Add a README\.md with setup, run, test, and deployment notes\./);
  assert.match(improvements, /Add an `\.env\.example` with safe placeholder values\./);
  assert.equal(/refresh_project_memory/.test(improvements), false);

  const settled = generatedProjectImprovements({
    commands: [{ label: "Test", command: "npm test" }, { label: "Lint", command: "eslint ." }, { label: "Typecheck", command: "tsc" }],
    documentation: { has_readme: true }, environment: {}
  }, FILES);
  assert.match(settled, /1\. Run `refresh_project_memory`/);
  assert.match(settled, /2\. Run `refresh_project_map`/);

  // The "nothing to suggest" fallback is unreachable: the brief and the map
  // each add a bullet when present, and their absence adds the bootstrap one.
  assert.match(
    generatedProjectImprovements({
      commands: [{ label: "Test", command: "npm test" }, { label: "Lint", command: "x" }, { label: "Typecheck", command: "x" }],
      documentation: { has_readme: true }, environment: {}
    }, { ...FILES, project_brief: missing, project_map: missing }),
    /^1\. Run `bootstrap_project`/
  );
});

test("the snapshot table is told when the card was updated rather than asking a clock", () => {
  const rows = registrySnapshotTable({
    detected: DETECTED, identity: IDENTITY, description: "", status: "registered",
    files: FILES, qualityStatus: { status: "passed" }, frontendProductStatus: null,
    activeTaskCount: 2, updatedAt: "2026-02-02T00:00:01.000Z"
  });
  assert.match(rows, /\| Description \| Not recorded\. \|/);
  assert.match(rows, /\| Project brief \| present, modified 2026-01-01T00:00:00\.000Z \|/);
  assert.match(rows, /\| Frontend product phase \| not prepared \|/);
  assert.match(rows, /\| Frontend handoff gate \| not run \|/);
  assert.match(rows, /\| Active tasks \| 2 \|/);
  assert.match(rows, /\| Updated \| 2026-02-02T00:00:01\.000Z \|/);

  const gated = registrySnapshotTable({
    detected: { ...DETECTED, is_frontend: false }, identity: IDENTITY, description: "d", status: "s",
    files: { ...FILES, project_map: missing }, qualityStatus: { status: "not run" },
    frontendProductStatus: { phase: "handoff", handoff: { ok: true } }, updatedAt: "t"
  });
  assert.match(gated, /\| Project map \| missing \|/);
  assert.match(gated, /\| Frontend product phase \| handoff \|/);
  assert.match(gated, /\| Frontend handoff gate \| pass \|/);
  assert.match(gated, /\| Active tasks \| 0 \|/);

  const notApplicable = registrySnapshotTable({
    detected: { ...DETECTED, is_frontend: false }, identity: IDENTITY, description: "", status: "s",
    files: FILES, qualityStatus: { status: "x" }, frontendProductStatus: { handoff: { ok: false } }, updatedAt: "t"
  });
  assert.match(notApplicable, /\| Frontend product phase \| not applicable \|/);
  assert.match(notApplicable, /\| Frontend handoff gate \| block \|/);
});

test("fenced blocks are read back, empty ones dropped", () => {
  assert.deepEqual(fencedCodeBlocks("```sh\nnpm test\n```\n\n```\n\n```\ntext"), ["npm test"]);
  assert.deepEqual(fencedCodeBlocks("no fences"), []);
});

test("the gate-file digest lists the first commands and the missing checks", () => {
  const summary = qualityGateFileSummaryMarkdown([
    "# Quality Gate", "", "## Default Verification", "",
    "```", ...Array.from({ length: 8 }, (_, index) => `check-${index}`), "```", "",
    "## Missing Checks", "", "- Lint command is not detected."
  ].join("\n"));
  assert.match(summary, /^### Repo Quality Gate Summary/);
  assert.match(summary, /- `check-0`/);
  assert.match(summary, /- `check-5`/);
  assert.equal(/check-6/.test(summary), false);
  assert.match(summary, /Missing checks:\n\n- Lint command is not detected\./);
  assert.equal(qualityGateFileSummaryMarkdown("   "), "");
  assert.equal(qualityGateFileSummaryMarkdown("# Quality Gate\n"), "### Repo Quality Gate Summary");
});

test("a card states its identity in frontmatter and in prose", () => {
  const card = render();
  assert.match(card, /^---\nproject_name: "Atlas"\n/);
  assert.match(card, /project_id: "project-1234567890"\n/);
  assert.match(card, /project_aliases: "\[\\"\/repo\/atlas\\"\]"\n/);
  assert.match(card, /updated: "2026-02-02T00:00:00\.000Z"\n/);
  assert.match(card, /quality_gate_status: "not run"\n/);
  assert.match(card, /frontend_product_phase: "not prepared"\n/);
  assert.match(card, /\n# Atlas\n\nStatus: registered\n/);
  assert.match(card, /- Known aliases: `\/repo\/atlas`\n/);
  assert.match(card, /- Git repository detected: yes\n/);
  assert.ok(card.endsWith("finalizing development work.\n"));
});

test("the hand-written sections of an existing card survive a re-render", () => {
  const existing = [
    "## Architecture Summary", "", "A monolith with a queue.", "",
    "## Active Tasks", "", "- task-a", "- task-b", "",
    "## Known Weak Spots", "", "- The importer.", "",
    "## Next Practical Improvements", "", "1. Split the importer.", "",
    "## Notes", "", "Talk to the data team first.", "",
    "## Last Quality Gate Run", "", "Status: `passed`", "Updated: `2026-01-05T00:00:00.000Z`", "",
    "## Last Frontend QA Run", "", "No blocking issues.", ""
  ].join("\n");
  const card = render({ existingText: existing, notes: "ignored while notes exist" });
  assert.match(card, /## Architecture Summary\n\nA monolith with a queue\./);
  assert.match(card, /## Active Tasks\n\n- task-a\n- task-b/);
  assert.match(card, /## Risks And Weak Spots\n\n- The importer\./);
  assert.match(card, /## Next Practical Improvements\n\n1\. Split the importer\./);
  assert.match(card, /## Notes\n\nTalk to the data team first\./);
  assert.match(card, /## Last Quality Gate Run\n\nStatus: `passed`/);
  assert.match(card, /## Last Frontend QA Run\n\nNo blocking issues\./);
  // The preserved run is also what the status line and the frontmatter report.
  assert.match(card, /quality_gate_status: "passed"/);
  assert.match(card, /- Last run updated: `2026-01-05T00:00:00\.000Z`/);
  assert.match(card, /\| Active tasks \| 2 \|/);
});

test("an empty card falls back to generated sections and the supplied notes", () => {
  const card = render({ notes: "First note." });
  assert.match(card, /## Architecture Summary\n\nNot recorded yet\./);
  assert.match(card, /## Active Tasks\n\n- No active tasks recorded\./);
  assert.match(card, /\| Active tasks \| 0 \|/);
  assert.match(card, /## Notes\n\nFirst note\./);
  assert.match(card, /## Quality Gaps\n\n- No automatic quality gaps detected\./);
  assert.match(card, /## Risk Signals\n\n- No automatic risk signals detected\./);
  // This project is frontend with no product-quality state, which is a risk.
  assert.match(card, /## Risks And Weak Spots\n\n- Frontend Product Quality v2 state is missing\./);
  assert.match(
    render({ detected: { ...DETECTED, is_frontend: false } }),
    /## Risks And Weak Spots\n\n- No automatically detected registry risks\./
  );
  assert.match(render(), /## Notes\n\nNo durable notes recorded yet\./);
});

test("a prepared frontend project reports both gates, an unprepared one does not", () => {
  const prepared = render({
    files: { ...FILES, frontend_product: present() },
    frontendProductPrepared: true,
    frontendProductStatus: { phase: "implementation", implementation: { ok: true }, handoff: { ok: false } }
  });
  assert.match(prepared, /- Prepared: yes\n- Phase: `implementation`\n/);
  assert.match(prepared, /- Implementation gate: `pass`\n- Handoff gate: `block`\n/);
  assert.match(prepared, /frontend_product_phase: "implementation"/);

  assert.match(render(), /- Prepared: no\n- Phase: `not prepared`\n- Implementation gate: `not prepared`/);
  assert.match(
    render({ detected: { ...DETECTED, is_frontend: false } }),
    /- Phase: `not applicable`\n- Implementation gate: `not applicable`/
  );
});

test("existing quality notes and the gate file's own digest both reach the card", () => {
  const card = render({
    existingText: "## Quality Gate\n\nRun the importer suite too.\n",
    qualityGateFileText: "## Default Verification\n\n```\nnpm test\n```\n"
  });
  assert.match(card, /### Existing Quality Notes\n\nRun the importer suite too\./);
  assert.match(card, /### Repo Quality Gate Summary\n\nDefault command candidates:\n\n- `npm test`/);
  assert.equal(/### Existing Quality Notes/.test(render()), false);
});
