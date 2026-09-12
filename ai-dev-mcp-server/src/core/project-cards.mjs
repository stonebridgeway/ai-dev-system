/**
 * The project registry card.
 *
 * A card is the durable record of a project in the vault: what it is, what it
 * is built from, how to verify it, and whatever an agent wrote into it by hand.
 * Rendering one is pure — every fact the card states arrives already gathered,
 * so the same inputs always produce the same card and the reader can be tested
 * against the writer.
 *
 * The caller (`buildRichProjectCardMd` in `src/mcp-stdio.mjs`) does the
 * reading: project identity, file snapshots, frontend product state and the
 * project's own quality-gate file.
 */
import path from "node:path";
import { FRONTEND_PRODUCT_PATHS } from "./frontend-product-quality.mjs";
import { mdCell, yamlString } from "./text-format.mjs";
import {
  asBulletList,
  bulletValues,
  commandsByStatus,
  commandsTable,
  dangerousScriptsMarkdown,
  documentationMarkdown,
  environmentMarkdown,
  extractMarkdownSection,
  recommendedSkillsMarkdown,
  scriptsTable
} from "./project-markdown.mjs";

/**
 * Every `##` heading this renderer emits.
 *
 * `extractProjectCardSection` reads a section up to the next heading in this
 * list rather than the next heading of any kind, which is what lets a section
 * hold a nested report without losing its tail.
 */
export const PROJECT_CARD_KNOWN_SECTIONS = [
  "Registry Snapshot",
  "Repository",
  "Project Profile",
  "Stack",
  "Documentation",
  "Environment And Secrets Risk",
  "Agent Configuration",
  "Commands",
  "Package Scripts",
  "Project Brief",
  "Project Map",
  "Quality Gate",
  "Quality Gate Status",
  "Frontend Product Quality",
  "Quality Gaps",
  "Risk Signals",
  "Dangerous Or Side-Effectful Scripts",
  "Recommended Skills",
  "Skill Routing",
  "Skill Routing Policy",
  "Architecture Summary",
  "Active Tasks",
  "Risks And Weak Spots",
  "Known Weak Spots",
  "Next Practical Improvements",
  "Recommended Next Commands",
  "Last Project Map Refresh",
  "Last Quality Gate Run",
  "Notes",
  "Agent Rule"
];

/** The body of one card section.

 * Unlike a plain markdown reader this stops only at a heading the card itself
 * defines, so a section that holds a quality-gate report full of its own `##`
 * headings survives a round trip. */
export function extractProjectCardSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return "";

  const nextSectionNames = sectionName.toLowerCase() === "last quality gate run"
    ? ["Notes", "Agent Rule"]
    : PROJECT_CARD_KNOWN_SECTIONS.filter((name) => name.toLowerCase() !== sectionName.toLowerCase());
  if (!nextSectionNames.length) {
    return lines.slice(start + 1).join("\n").trim();
  }
  const nextKnownPattern = new RegExp(
    `^##\\s+(${nextSectionNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`,
    "i"
  );
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextKnownPattern.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** The last recorded gate status, read back off the card. */
export function qualityStatusFromCard(text, fallbackText = "") {
  const combined = `${text || ""}\n${fallbackText || ""}`;
  if (!combined.trim()) return { status: "not run", updated: "" };
  const status = (combined.match(/Status:\s*([^\r\n]+)/i)?.[1]?.trim() || "").replaceAll("`", "");
  const updated = (combined.match(/Updated:\s*([^\r\n]+)/i)?.[1]?.trim() || "").replaceAll("`", "");
  const inferredStatus = /all checks passed|checks passed|passed/i.test(combined)
    ? "passed (reported manually)"
    : "not run";
  return {
    status: status || inferredStatus,
    updated
  };
}

/** The risks the detector can see, used when the card records none. */
export function generatedProjectRisks(detected, files) {
  const risks = [];
  const { missing } = commandsByStatus(detected.commands);
  for (const item of missing) {
    if (["Lint", "Typecheck", "Test", "Build"].includes(item.label)) {
      risks.push(`${item.label} command is not detected.`);
    }
  }
  if (!files.agents.exists) risks.push("Root `AGENTS.md` is missing.");
  if (!files.project_brief?.exists) risks.push("`.ai-dev/project-brief.md` is missing.");
  if (!files.project_map.exists) risks.push("`.ai-dev/project-map.md` is missing.");
  if (!files.quality_gate.exists) risks.push("`.ai-dev/quality-gate.md` is missing.");
  if (detected.is_frontend && !files.frontend_product?.exists) {
    risks.push("Frontend Product Quality v2 state is missing.");
  }
  if (!detected.markers.includes("README.md")) risks.push("Repository README is not detected.");
  if (!detected.has_git) risks.push("Git repository was not detected at this root.");
  for (const item of detected.risk_signals || []) risks.push(item);
  return risks.length ? asBulletList(risks) : "- No automatically detected registry risks.";
}

/** The next steps the detector can see, used when the card records none. */
export function generatedProjectImprovements(detected, files) {
  const improvements = [];
  if (!files.agents.exists || !files.project_brief?.exists || !files.project_map.exists || !files.quality_gate.exists) {
    improvements.push("Run `bootstrap_project` to create missing agent-facing files.");
  }
  if (detected.is_frontend && !files.frontend_product?.exists) {
    improvements.push("Run `prepare_frontend_product` before product UI or visual work.");
  }
  if (files.project_brief?.exists) {
    improvements.push("Run `refresh_project_memory` after meaningful structure, command, risk, or documentation changes.");
  }
  if (files.project_map.exists) {
    improvements.push("Run `refresh_project_map` after meaningful structure or command changes.");
  }
  if (!commandsByStatus(detected.commands).detected.some((item) => item.label === "Test")) {
    improvements.push("Add or document a reliable test/check command.");
  }
  if (!commandsByStatus(detected.commands).detected.some((item) => item.label === "Lint")) {
    improvements.push("Add or document a lint command when the project is ready.");
  }
  if (!commandsByStatus(detected.commands).detected.some((item) => item.label === "Typecheck")) {
    improvements.push("Add or document a typecheck command when useful for this stack.");
  }
  if (!detected.documentation?.has_readme) {
    improvements.push("Add a README.md with setup, run, test, and deployment notes.");
  }
  if (detected.environment?.local_secret_files?.length && !detected.environment?.has_example) {
    improvements.push("Add an `.env.example` with safe placeholder values.");
  }
  return improvements.length ? improvements.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No automatic improvements suggested.";
}

/** The one-glance table at the top of every card. */
export function registrySnapshotTable({
  detected,
  identity,
  description,
  status,
  files,
  qualityStatus,
  frontendProductStatus,
  activeTaskCount = 0,
  updatedAt
}) {
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| Status | ${mdCell(status)} |`,
    `| Description | ${mdCell(description || "Not recorded.")} |`,
    `| Project ID | \`${mdCell(identity.project_id)}\` |`,
    `| Repository | \`${mdCell(detected.project_path)}\` |`,
    `| Stack | ${mdCell(detected.stack.join(", ") || "Not detected")} |`,
    `| Package manager | ${mdCell(detected.package_manager)} |`,
    `| Project types | ${mdCell((detected.project_types || []).join(", ") || "unknown")} |`,
    `| Project brief | ${files.project_brief.exists ? `present, modified ${files.project_brief.modified}` : "missing"} |`,
    `| Project map | ${files.project_map.exists ? `present, modified ${files.project_map.modified}` : "missing"} |`,
    `| Quality gate | ${files.quality_gate.exists ? `present, modified ${files.quality_gate.modified}` : "missing"} |`,
    `| Last quality status | ${mdCell(qualityStatus.status)} |`,
    `| Frontend product phase | ${mdCell(frontendProductStatus?.phase || (detected.is_frontend ? "not prepared" : "not applicable"))} |`,
    `| Frontend handoff gate | ${mdCell(frontendProductStatus?.handoff?.ok ? "pass" : (frontendProductStatus?.handoff ? "block" : "not run"))} |`,
    `| Active tasks | ${activeTaskCount} |`,
    `| Updated | ${updatedAt} |`
  ].join("\n");
}

/** The bodies of the fenced code blocks in a markdown string. */
export function fencedCodeBlocks(markdown) {
  const blocks = [];
  const pattern = /```[A-Za-z0-9_-]*\s*([\s\S]*?)```/g;
  let match = null;
  while ((match = pattern.exec(markdown)) !== null) {
    const body = match[1].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/** A short digest of the project's own quality-gate file. */
export function qualityGateFileSummaryMarkdown(markdown) {
  if (!markdown.trim()) return "";
  const commands = fencedCodeBlocks(extractMarkdownSection(markdown, "Default Verification"))
    .flatMap((block) => block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .slice(0, 6);
  const missingChecks = bulletValues(extractMarkdownSection(markdown, "Missing Checks"));
  const lines = ["### Repo Quality Gate Summary", ""];
  if (commands.length) {
    lines.push("Default command candidates:", "");
    for (const command of commands) lines.push(`- \`${command}\``);
    lines.push("");
  }
  if (missingChecks.length) {
    lines.push("Missing checks:", "");
    for (const item of missingChecks) lines.push(`- ${item}`);
  }
  return lines.join("\n").trim();
}

/**
 * Render a project card.
 *
 * Sections an agent owns — architecture notes, active tasks, risks,
 * improvements, notes, and the last gate and QA runs — are carried over from
 * `existingText` when it has them and generated only when it does not. That
 * is what makes re-rendering a card safe.
 *
 * @param {object} input
 * @param {object} input.detected - The detected project, from `detectProject`.
 * @param {object} input.identity - Canonical identity, from `resolveProjectIdentity`.
 * @param {object} input.files - Snapshot per agent-facing file: `{ exists, modified }`.
 * @param {boolean} [input.frontendProductPrepared] - Whether Frontend Product Quality state exists.
 * @param {object|null} [input.frontendProductStatus] - Phase and gate verdicts, when it does.
 * @param {string} [input.qualityGateFileText] - The project's own `.ai-dev/quality-gate.md`.
 * @param {string} [input.existingText] - The card as it stands, whose hand-written sections are kept.
 * @param {string} [input.description]
 * @param {string} [input.status]
 * @param {string} [input.notes]
 * @param {string} input.now - Timestamp for the frontmatter.
 * @param {string} input.updatedAt - Timestamp for the registry snapshot row.
 * @returns {string} The card, frontmatter included.
 */
export function renderProjectCardMd({
  detected,
  identity,
  files,
  frontendProductPrepared = false,
  frontendProductStatus = null,
  qualityGateFileText = "",
  existingText = "",
  description = "",
  status = "registered",
  notes = "",
  now,
  updatedAt
}) {
  const lastQualityGateRun = extractProjectCardSection(existingText, "Last Quality Gate Run");
  const lastFrontendQaRun = extractProjectCardSection(existingText, "Last Frontend QA Run");
  const preservedQualityGateStatus = extractProjectCardSection(existingText, "Quality Gate Status");
  const preservedQualityGate = extractProjectCardSection(existingText, "Quality Gate");
  const qualityStatus = qualityStatusFromCard(lastQualityGateRun, `${preservedQualityGate}\n${preservedQualityGateStatus}`);
  const preservedArchitecture = extractProjectCardSection(existingText, "Architecture Summary");
  const preservedActiveTasks = extractProjectCardSection(existingText, "Active Tasks");
  const activeTasksMarkdown = preservedActiveTasks || "- No active tasks recorded.";
  const activeTaskCount = bulletValues(activeTasksMarkdown)
    .filter((item) => !/^no active tasks recorded\.?$/i.test(item))
    .length;
  const preservedRisks =
    extractProjectCardSection(existingText, "Risks And Weak Spots") ||
    extractProjectCardSection(existingText, "Known Weak Spots");
  const preservedImprovements = extractProjectCardSection(existingText, "Next Practical Improvements");
  const preservedNotes = extractProjectCardSection(existingText, "Notes");
  // `scan_agent_config` (PLAN.md 3.22) writes the A-F grade here. It is
  // preserved rather than generated, because re-rendering a card must not
  // silently claim a grade nobody measured.
  const preservedAgentConfig = extractProjectCardSection(existingText, "Agent Configuration");
  const frontendProductPhase = frontendProductStatus?.phase ||
    (detected.is_frontend ? "not prepared" : "not applicable");

  const frontmatter = [
    "---",
    `project_name: ${yamlString(detected.project_name)}`,
    `project_path: ${yamlString(detected.project_path)}`,
    `project_id: ${yamlString(identity.project_id)}`,
    `repository_id: ${yamlString(identity.repository_id || "")}`,
    `canonical_path: ${yamlString(identity.canonical_path)}`,
    `project_aliases: ${yamlString(JSON.stringify(identity.aliases))}`,
    `status: ${yamlString(status)}`,
    `description: ${yamlString(description)}`,
    `updated: ${yamlString(now)}`,
    `stack: ${yamlString(detected.stack.join(", "))}`,
    `project_types: ${yamlString((detected.project_types || []).join(", "))}`,
    `last_project_map_refresh: ${yamlString(files.project_map.modified || "")}`,
    `quality_gate_status: ${yamlString(qualityStatus.status)}`,
    `frontend_product_phase: ${yamlString(frontendProductPhase)}`,
    "---"
  ].join("\n");

  return `${frontmatter}
# ${detected.project_name}

Status: ${status}

## Registry Snapshot

${registrySnapshotTable({ detected, identity, description, status, files, qualityStatus, frontendProductStatus, activeTaskCount, updatedAt })}

## Repository

- Project ID: \`${identity.project_id}\`
- Canonical path: \`${identity.canonical_path}\`
- Repository path: \`${detected.project_path}\`
- Known aliases: ${identity.aliases.map((item) => `\`${item}\``).join(", ")}
- Git repository detected: ${detected.has_git ? "yes" : "no"}
- Agent files:
  - \`AGENTS.md\`: ${files.agents.exists ? `present, modified ${files.agents.modified}` : "missing"}
  - \`.ai-dev/README.md\`: ${files.readme.exists ? `present, modified ${files.readme.modified}` : "missing"}
  - \`.ai-dev/project-brief.md\`: ${files.project_brief.exists ? `present, modified ${files.project_brief.modified}` : "missing"}
  - \`.ai-dev/project-map.md\`: ${files.project_map.exists ? `present, modified ${files.project_map.modified}` : "missing"}
  - \`.ai-dev/quality-gate.md\`: ${files.quality_gate.exists ? `present, modified ${files.quality_gate.modified}` : "missing"}
  - \`${FRONTEND_PRODUCT_PATHS.state}\`: ${files.frontend_product.exists ? `present, modified ${files.frontend_product.modified}` : "missing"}

## Project Profile

- Types: ${detected.project_types.map((item) => `\`${item}\``).join(", ")}
- Frontend: ${detected.is_frontend ? "yes" : "no"}
- Backend: ${detected.is_backend ? "yes" : "no"}
- Mobile: ${detected.is_mobile ? "yes" : "no"}
- Bot: ${detected.is_bot ? "yes" : "no"}
- API: ${detected.is_api ? "yes" : "no"}

## Stack

${asBulletList(detected.stack)}

Package manager: \`${detected.package_manager}\`

## Documentation

${documentationMarkdown(detected)}

## Environment And Secrets Risk

${environmentMarkdown(detected)}

## Agent Configuration

${preservedAgentConfig || "Not graded yet. Run `scan_agent_config` to grade what this repository lets an agent do without being asked."}

## Commands

${commandsTable(detected.commands)}

## Package Scripts

${scriptsTable(detected.scripts)}

## Project Brief

- Path: \`${path.join(detected.project_path, ".ai-dev", "project-brief.md")}\`
- Exists: ${files.project_brief.exists ? "yes" : "no"}
- Last refreshed: \`${files.project_brief.modified || "not recorded"}\`
- Refresh command: \`refresh_project_memory\`

## Project Map

- Path: \`${path.join(detected.project_path, ".ai-dev", "project-map.md")}\`
- Exists: ${files.project_map.exists ? "yes" : "no"}
- Last refreshed: \`${files.project_map.modified || "not recorded"}\`
- Refresh command: \`refresh_project_map\`

## Quality Gate Status

- Path: \`${path.join(detected.project_path, ".ai-dev", "quality-gate.md")}\`
- Exists: ${files.quality_gate.exists ? "yes" : "no"}
- Last run status: \`${qualityStatus.status}\`
- Last run updated: \`${qualityStatus.updated || "not recorded"}\`
- Runner: \`run_quality_gate\`
${preservedQualityGate ? `
### Existing Quality Notes

${preservedQualityGate}
` : ""}
${qualityGateFileSummaryMarkdown(qualityGateFileText)}

## Frontend Product Quality

- Prepared: ${frontendProductPrepared ? "yes" : "no"}
- Phase: \`${frontendProductPhase}\`
- Implementation gate: \`${frontendProductStatus ? (frontendProductStatus.implementation?.ok ? "pass" : "block") : (detected.is_frontend ? "not prepared" : "not applicable")}\`
- Handoff gate: \`${frontendProductStatus ? (frontendProductStatus.handoff?.ok ? "pass" : "block") : (detected.is_frontend ? "not prepared" : "not applicable")}\`
- State: \`${path.join(detected.project_path, FRONTEND_PRODUCT_PATHS.state)}\`
- Builder: \`frontend_product_builder\`
- Strict QA: \`run_visual_reference_qa\`

## Quality Gaps

${detected.quality_gaps.length ? asBulletList(detected.quality_gaps) : "- No automatic quality gaps detected."}

## Risk Signals

${detected.risk_signals.length ? asBulletList(detected.risk_signals) : "- No automatic risk signals detected."}

## Dangerous Or Side-Effectful Scripts

${dangerousScriptsMarkdown(detected)}

## Recommended Skills

${recommendedSkillsMarkdown(detected)}

## Skill Routing Policy

- Use \`recommend_skills\` with this project name or path before implementation work.
- Use \`membrane_policy: "auto"\` for normal work.
- Use \`membrane_policy: "exclude"\` when app skills are noisy.
- Use \`membrane_policy: "include"\` only for explicit external app integrations.

## Architecture Summary

${preservedArchitecture || "Not recorded yet."}

## Active Tasks

${activeTasksMarkdown}

## Risks And Weak Spots

${preservedRisks || generatedProjectRisks(detected, files)}

## Next Practical Improvements

${preservedImprovements || generatedProjectImprovements(detected, files)}

## Recommended Next Commands

${asBulletList(detected.recommended_next_commands)}

${lastQualityGateRun ? `## Last Quality Gate Run

${lastQualityGateRun}

` : ""}${lastFrontendQaRun ? `## Last Frontend QA Run

${lastFrontendQaRun}

` : ""}## Notes

${preservedNotes || notes || "No durable notes recorded yet."}

## Agent Rule

When working on this project, read repo-local \`AGENTS.md\` first, then \`.ai-dev/project-map.md\`, then \`.ai-dev/quality-gate.md\`. Use \`recommend_skills\` and the project quality gate before finalizing development work.
`;
}
