/**
 * Skill card rendering.
 *
 * A skill card is the short, routing-oriented note an agent reads before
 * committing to a full SKILL.md: what the skill is for, when not to reach for
 * it, and how good the registry thinks it is. Everything here maps an already
 * classified registry item to text — reading the registry and writing the cards
 * is `src/extensions/skills.mjs` and `mcp-stdio.mjs`.
 */
import { countBy } from "./system-health.mjs";
import {
  groupWikiLink,
  isDesignSkill,
  isMembraneSkill,
  skillCardPath
} from "./skill-catalog.mjs";
import { cleanDescription, shorten, yamlString } from "./text-format.mjs";

/**
 * The "what is this for / when not to use it" triple shown on a card.
 *
 * Source and type decide it, most specific first: an app integration skill is
 * never a general workflow skill, and a design skill is not a backend one.
 *
 * @param {object} item - Classified registry entry.
 * @returns {{ role: string, use: string, avoid: string }}
 */
export function skillCardPolicy(item) {
  if (isMembraneSkill(item)) {
    return {
      role: "External application integration skill.",
      use: "Use only when the task explicitly involves this external app or API.",
      avoid: "Do not use for normal repository coding, architecture work, or generic debugging unless the app is part of the task."
    };
  }
  if (item.source === "custom") {
    return {
      role: "Primary AI development workflow skill.",
      use: "Use as a workflow guide before editing code or updating the knowledge base.",
      avoid: "Do not stack too many workflow skills at once; choose the one that matches the current intent."
    };
  }
  if (String(item.type || "").includes("image-generation")) {
    return {
      role: "Visual reference generation skill.",
      use: "Use when the deliverable needs generated visual references, brand boards, or mockups.",
      avoid: "Do not use when the user only asked for code changes and no visual reference is needed."
    };
  }
  if (String(item.type || "").includes("output-control")) {
    return {
      role: "Completion and output-control support skill.",
      use: "Use when the main risk is incomplete, truncated, or placeholder-heavy output.",
      avoid: "Do not use as a default coding workflow; pair it only with tasks where completeness is the bottleneck."
    };
  }
  if (isDesignSkill(item)) {
    return {
      role: "Frontend/design quality skill.",
      use: "Use for visually important UI, UX, landing pages, redesigns, and design-system work.",
      avoid: "Do not use for backend-only work unless the task has a visible product surface."
    };
  }
  return {
    role: "Skill from the local skill catalog.",
    use: "Use when the task matches the skill description and source.",
    avoid: "Do not use when a narrower custom workflow skill fits better."
  };
}

/**
 * Render one skill card.
 *
 * @param {object} item - Classified registry entry.
 * @param {string} [generatedAt] - Stamp written into the frontmatter. Defaults
 *   to now; passing it keeps a test's output stable.
 * @returns {string} Markdown with YAML frontmatter.
 */
/** The `generated_at` line of a rendered card, which changes on every render. */
const CARD_STAMP = /^generated_at:.*$/m;

/**
 * Whether a card already on disk says the same thing as a freshly rendered one.
 *
 * Every render stamps `generated_at`, so writing a card that has not changed
 * still moves its mtime — and 142 cards moving made the search index report
 * itself stale seconds after it was built. Comparing the two without their
 * stamps is what makes "write only when it changed" mean anything here, and it
 * gives `generated_at` the meaning a reader expects: when this card last said
 * something different.
 *
 * @param {string} previous - What is on disk, or "" when nothing is.
 * @param {string} next - The freshly rendered card.
 * @returns {boolean}
 */
export function skillCardUnchanged(previous, next) {
  if (!previous) return false;
  const strip = (card) => String(card ?? "").replace(CARD_STAMP, "generated_at: <stamp>");
  return strip(previous) === strip(next);
}

export function renderSkillCard(item, generatedAt = new Date().toISOString()) {
  const policy = skillCardPolicy(item);
  const cardPath = skillCardPath(item);
  const categories = Array.isArray(item.categories) ? item.categories : [];
  const requires = Array.isArray(item.requires) ? item.requires : [];
  const tags = [
    "skill-card",
    item.primary_group ? `skill-group/${item.primary_group}` : "",
    item.maturity ? `skill-maturity/${item.maturity}` : "",
    item.quality_status ? `skill-quality/${item.quality_status}` : "",
    item.source,
    item.type,
    ...categories
  ].filter(Boolean).map((value) => String(value).replace(/\s+/g, "-"));

  return `---
card_kind: "skill-card"
name: ${yamlString(item.name)}
source: ${yamlString(item.source)}
type: ${yamlString(item.type)}
primary_group: ${yamlString(item.primary_group || "unclassified")}
subgroups: ${JSON.stringify(item.subgroups || [])}
task_types: ${JSON.stringify(item.task_types || [])}
platforms: ${JSON.stringify(item.platforms || [])}
related_skills: ${JSON.stringify(item.related_skills || [])}
frameworks: ${JSON.stringify(item.frameworks || [])}
languages: ${JSON.stringify(item.languages || [])}
conflicts: ${JSON.stringify(item.conflicts || [])}
maturity: ${yamlString(item.maturity || "draft")}
trust_level: ${yamlString(item.trust_level || "unverified")}
quality_score: ${Number(item.quality_score || 0)}
quality_grade: ${yamlString(item.quality_grade || "F")}
quality_status: ${yamlString(item.quality_status || "fail")}
skill_schema_version: ${Number(item.skill_schema_version || 0)}
skill_path: ${yamlString(`03-skills-catalog/${item.path}`)}
card_path: ${yamlString(cardPath)}
generated_at: ${yamlString(generatedAt)}
categories: ${JSON.stringify(categories)}
tags: ${JSON.stringify(tags)}
---

# ${item.name}

## Purpose

${policy.role}

${cleanDescription(item.description || item.use_when || "No description recorded.")}

## Use When

${cleanDescription(item.use_when || policy.use)}

## Do Not Use When

${policy.avoid}

## Routing

- Source: \`${item.source}\`
- Type: \`${item.type || "unknown"}\`
- Group: ${groupWikiLink(item.primary_group || "unclassified", item.primary_group_label || item.primary_group || "Unclassified")}
- Subgroups: ${(item.subgroups || []).length ? item.subgroups.map((value) => `\`${value}\``).join(", ") : "none"}
- Task types: ${(item.task_types || []).length ? item.task_types.map((value) => `\`${value}\``).join(", ") : "none"}
- Categories: ${categories.length ? categories.map((value) => `\`${value}\``).join(", ") : "none"}
- Requires: ${requires.length ? requires.map((value) => `\`${value}\``).join(", ") : "none"}
- Compatibility: ${item.compatibility || "not recorded"}

## Quality

- Maturity: \`${item.maturity || "draft"}\`
- Trust: \`${item.trust_level || "unverified"}\`
- Score: **${Number(item.quality_score || 0)}/100** (${item.quality_grade || "F"}, \`${item.quality_status || "fail"}\`)
- Profile: \`${item.quality_profile || "unknown"}\`
- Frameworks: ${(item.frameworks || []).length ? item.frameworks.map((value) => `\`${value}\``).join(", ") : "none detected"}
- Languages: ${(item.languages || []).length ? item.languages.map((value) => `\`${value}\``).join(", ") : "none detected"}
- Conflicts: ${(item.conflicts || []).length ? item.conflicts.map((value) => `\`${value}\``).join(", ") : "none recorded"}

Trust records provenance and validation status; it is not an absolute security guarantee.

## Related Skills

${(item.related_skills || []).length ? item.related_skills.map((value) => `- \`${value}\``).join("\n") : "None recorded."}

## Agent Workflow

1. Start with this card when choosing whether the skill fits the task.
2. If it fits, call \`read_skill\` for the full skill instructions.
3. Combine it with project context, AGENTS.md, project-map, and quality-gate before editing code.
4. After important work, update durable project or knowledge notes when useful.

## MCP Commands

\`\`\`json
{
  "tool": "read_skill",
  "arguments": {
    "name": "${item.name}",
    "source": "${item.source}"
  }
}
\`\`\`

## Source

- Skill file: \`03-skills-catalog/${item.path}\`
- Card file: \`${cardPath}\`
- Homepage: ${item.homepage || "not recorded"}
- Repository: ${item.repository || "not recorded"}
`;
}

/**
 * Render the catalog note that indexes every generated card.
 *
 * @param {object[]} cards - Public card records, already in display order.
 * @returns {string}
 */
export function skillCardsMarkdownIndex(cards) {
  const bySource = countBy(cards, (card) => card.source);
  const byGroup = countBy(cards, (card) => card.primary_group || "unclassified");
  const output = [
    "# Skill Cards",
    "",
    "Autogenerated index of AI Dev System skill cards.",
    "",
    `Total cards: ${cards.length}`,
    "",
    "## By Source",
    "",
    "| Source | Cards |",
    "|---|---|"
  ];
  for (const [source, count] of Object.entries(bySource).sort((a, b) => a[0].localeCompare(b[0]))) {
    output.push(`| ${source} | ${count} |`);
  }
  output.push("", "## By Group", "", "| Group | Cards |", "|---|---:|");
  for (const [group, count] of Object.entries(byGroup).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    output.push(`| ${groupWikiLink(group)} | ${count} |`);
  }
  output.push(
    "",
    "## Cards",
    "",
    "| Skill | Group | Quality | Maturity | Source | Type | Use when | Card |",
    "|---|---|---:|---|---|---|---|---|"
  );
  for (const card of cards) {
    output.push(`| ${card.name} | ${card.primary_group || "unclassified"} | ${card.quality_score || 0} | ${card.maturity || "draft"} | ${card.source} | ${card.type || ""} | ${shorten(card.use_when || card.description || "", 160)} | \`${card.card_path}\` |`);
  }
  output.push("");
  return output.join("\n");
}

/**
 * The card fields the card index and the card tools expose. Keeps the machine
 * index free of the full registry entry.
 */
export function skillCardPublic(item) {
  return {
    name: item.name,
    source: item.source,
    type: item.type,
    categories: item.categories,
    primary_group: item.primary_group,
    primary_group_label: item.primary_group_label,
    subgroups: item.subgroups || [],
    task_types: item.task_types || [],
    platforms: item.platforms || [],
    related_skills: item.related_skills || [],
    frameworks: item.frameworks || [],
    languages: item.languages || [],
    conflicts: item.conflicts || [],
    maturity: item.maturity,
    trust_level: item.trust_level,
    quality_score: item.quality_score,
    quality_grade: item.quality_grade,
    quality_status: item.quality_status,
    skill_schema_version: item.skill_schema_version,
    use_when: item.use_when,
    skill_path: item.skill_path,
    card_path: item.card_path,
    generated_at: item.generated_at
  };
}
