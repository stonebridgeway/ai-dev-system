/**
 * The vocabulary the generated skill catalog is written in.
 *
 * Two things live here because three different callers need the same answer:
 * where a generated note for a skill belongs in the vault, and which family a
 * registry item belongs to. `mcp-stdio.mjs` renders the taxonomy graph from
 * them, `skill-cards.mjs` renders cards, `skill-recommendation.mjs` filters
 * candidates and `src/extensions/skills.mjs` rebuilds the registries.
 *
 * Paths are vault-relative strings, never absolute: resolving them against a
 * vault root is the runtime's job, not this module's.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import { slugPart } from "./text-format.mjs";

/** Vault folder that holds the skill sources and every generated registry. */
export const SKILL_CATALOG_DIR = "03-skills-catalog";

/** Generated per-skill cards, one folder per source. */
export const SKILL_CARDS_DIR = `${SKILL_CATALOG_DIR}/cards`;

/** Generated taxonomy notes: one per group, plus the paged skill graph. */
export const SKILL_GROUPS_DIR = `${SKILL_CATALOG_DIR}/groups`;

/** Vault path of the generated note for one taxonomy group. */
export function skillGroupNotePath(groupId) {
  return `${SKILL_GROUPS_DIR}/${groupId}.md`;
}

/** Obsidian wiki link to a group note, labelled with the group's title. */
export function groupWikiLink(groupId, label = "") {
  const group = SKILL_GROUPS.find((item) => item.id === groupId);
  return `[[${skillGroupNotePath(groupId).replace(/\.md$/i, "")}|${label || group?.label || groupId}]]`;
}

/** Vault path of the generated card for one registry item. */
export function skillCardPath(item) {
  return `${SKILL_CARDS_DIR}/${slugPart(item.source, "source")}/${slugPart(item.name, "skill")}.md`;
}

/** Registry key that identifies one skill across sources. */
export function skillKey(item) {
  return `${item.source}:${item.name}`.toLowerCase();
}

/**
 * Find one registry item by name, optionally narrowed to a source substring.
 *
 * @param {object[]} items - Registry entries.
 * @param {string} name - Skill name, compared case-insensitively.
 * @param {string} [source] - Optional source substring.
 * @returns {object|undefined}
 */
export function findSkillItem(items, name, source = "") {
  const normalized = String(name ?? "").toLowerCase().trim();
  const normalizedSource = String(source ?? "").toLowerCase().trim();
  return items.find((item) => {
    const nameMatches = item.name.toLowerCase() === normalized;
    const sourceMatches = !normalizedSource || item.source.toLowerCase().includes(normalizedSource);
    return nameMatches && sourceMatches;
  });
}

/** Membrane application skills: the large, noisy per-app integration catalog. */
export function isMembraneSkill(item) {
  return String(item.source ?? "").toLowerCase().includes("membrane");
}

/**
 * Where the Membrane catalogue can sit, as source ids: a vault keeps it as a
 * source of its own, the bundled seed under `external/`. Code that meant
 * "Membrane" but tested one layout's path never matched the other, and in the
 * seed all 3 074 connectors were embedded and ranked like any other skill.
 */
export const MEMBRANE_SOURCE_IDS = Object.freeze(["membrane/application-skills", "external/membrane"]);

/**
 * The catalogue source a path belongs to — `<group>/<name>` right under
 * `03-skills-catalog/sources/` — or "" outside the catalogue. Lets code that
 * walks files ask `isMembraneSkill` the question the registry answers.
 *
 * @param {string} filePath - Vault-relative or absolute, either separator.
 * @returns {string}
 */
export function catalogSourceOfPath(filePath) {
  const parts = String(filePath ?? "").replaceAll("\\", "/").split("/");
  for (let index = 1; index < parts.length - 3; index += 1) {
    if (parts[index - 1] === "03-skills-catalog" && parts[index] === "sources") {
      return `${parts[index + 1]}/${parts[index + 2]}`.toLowerCase();
    }
  }
  return "";
}

/**
 * The Membrane catalogue in this vault: the first source id whose directory
 * exists, else the vault layout.
 *
 * @param {string} sourcesRoot - `<vault>/03-skills-catalog/sources`.
 * @param {(candidate: string) => boolean} [exists]
 * @returns {{ id: string, root: string }}
 */
export function membraneSourceLayout(sourcesRoot, exists = existsSync) {
  const layouts = MEMBRANE_SOURCE_IDS.map((id) => ({ id, root: path.join(sourcesRoot, ...id.split("/")) }));
  return layouts.find((layout) => exists(layout.root)) ?? layouts[0];
}

/** Design/frontend skills, by source folder or by declared category. */
export function isDesignSkill(item) {
  return String(item.source ?? "").toLowerCase().includes("design/") || (item.categories ?? []).some((category) => /design|frontend|ui|ux/i.test(category));
}

/**
 * Taxonomy groups whose skills are about what a user looks at.
 *
 * {@link isDesignSkill} reads the `categories` array, which for an imported
 * catalogue is the union of everything its auto-tagger guessed: ECC's
 * `hexagonal-architecture` carries `design`, `frontend`, `ui` and `ux` there and
 * is a backend architecture skill. `primary_group` is one value and it is the
 * one the taxonomy actually settled on, so a caller that must not filter out an
 * architecture skill on a mis-tag asks this instead.
 */
const DESIGN_FIRST_GROUPS = new Set(["frontend-ui", "design-content"]);

/** Design/frontend skills, by source folder or by the group the taxonomy settled on. */
export function isDesignFirstSkill(item) {
  return String(item?.source ?? "").toLowerCase().includes("design/") ||
    DESIGN_FIRST_GROUPS.has(String(item?.primary_group ?? ""));
}

/** Skills whose output is imagery rather than code. */
export function isVisualHeavySkill(item) {
  return /imagegen|image-to-code|brandkit|logo|identity/i.test(`${item.name} ${item.description ?? ""} ${item.use_when ?? ""}`);
}
