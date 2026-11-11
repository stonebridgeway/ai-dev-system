/**
 * The subgroup notes of the skill taxonomy (`03-skills-catalog/groups/<group>/<subgroup>.md`):
 * one per subgroup that has members, and none for a subgroup that has lost them.
 *
 * Every rebuild wrote the notes of the subgroups it found and left the others
 * where they were, so a subgroup emptied by a seed update kept its old note —
 * listing skills that no longer exist, and indexed for search like any note.
 * Only notes this generator wrote are removed: a
 * file is one when its frontmatter names the group and a subgroup, as
 * `renderSkillSubgroupNote` writes it; anything else in the folder is left alone.
 */
import fs from "node:fs/promises";
import path from "node:path";

const HEAD_BYTES = 1024;

/**
 * Whether a note's opening lines are the frontmatter of a generated subgroup note of `groupId`.
 *
 * @param {string} head
 * @param {string} groupId
 * @returns {boolean}
 */
export function isGeneratedSubgroupNote(head, groupId) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(head));
  if (!match) return false;
  const frontmatter = match[1];
  return new RegExp(`^skill_group:\\s*"?${groupId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*$`, "m").test(frontmatter)
    && /^skill_subgroup:\s*\S/m.test(frontmatter);
}

async function readHead(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Write the note of every subgroup with members and remove the generated notes
 * of the subgroups without.
 *
 * @param {object} input
 * @param {string} input.groupsRoot - Absolute `03-skills-catalog/groups`.
 * @param {Array<{ id: string, subgroups: Array<{ id: string }> }>} input.groups
 * @param {Array<{ primary_group?: string, subgroups?: string[] }>} input.items
 * @param {(group: object, subgroup: object, members: object[]) => string} input.render
 * @param {(relative: string, text: string) => Promise<void>} input.writeText - `relative` to `groupsRoot`, forward slashes.
 * @returns {Promise<{ written: string[], removed: string[] }>}
 */
export async function writeSkillSubgroupNotes({ groupsRoot, groups, items, render, writeText }) {
  const written = [];
  const removed = [];
  for (const group of groups) {
    const kept = new Set();
    for (const subgroup of group.subgroups ?? []) {
      const members = items.filter((item) => item.primary_group === group.id && (item.subgroups || []).includes(subgroup.id));
      if (!members.length) continue;
      const relative = `${group.id}/${subgroup.id}.md`;
      await writeText(relative, render(group, subgroup, members));
      kept.add(`${subgroup.id}.md`);
      written.push(relative);
    }
    const directory = path.join(groupsRoot, group.id);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || kept.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (!isGeneratedSubgroupNote(await readHead(file).catch(() => ""), group.id)) continue;
      await fs.rm(file, { force: true });
      removed.push(`${group.id}/${entry.name}`);
    }
  }
  return { written, removed };
}
