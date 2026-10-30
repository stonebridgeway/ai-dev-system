import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isGeneratedSubgroupNote, writeSkillSubgroupNotes } from "./skill-group-notes.mjs";

const render = (group, subgroup, members) => [
  "---",
  `tags: ["skill-group", "skill-group/${group.id}", "skill-subgroup/${subgroup.id}"]`,
  `skill_group: "${group.id}"`,
  `skill_subgroup: "${subgroup.id}"`,
  `skill_count: ${members.length}`,
  "---",
  "",
  `# ${subgroup.id}`,
  ...members.map((item) => `- ${item.name}`),
  ""
].join("\n");

async function makeGroups(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-group-notes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, text) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  };
  return { root, write };
}

test("a generated subgroup note is recognised by its own group and a subgroup in the frontmatter", () => {
  const note = render({ id: "integrations-automation" }, { id: "crm-sales" }, []);
  assert.equal(isGeneratedSubgroupNote(note, "integrations-automation"), true);
  assert.equal(isGeneratedSubgroupNote(note, "security"), false, "another group's note is not this group's");
  assert.equal(isGeneratedSubgroupNote(note.replace(/^skill_subgroup:.*$/m, ""), "integrations-automation"), false);
  assert.equal(isGeneratedSubgroupNote("# My own notes about CRM\n", "integrations-automation"), false);
  assert.equal(isGeneratedSubgroupNote(note.replaceAll("\n", "\r\n"), "integrations-automation"), true, "CRLF too");
});

test("subgroups with members get notes; a subgroup that lost its members loses its note", async (t) => {
  const { root, write } = await makeGroups(t);
  const group = { id: "integrations-automation", subgroups: [{ id: "developer-tools" }, { id: "crm-sales" }] };
  const before = [
    { name: "github", primary_group: group.id, subgroups: ["developer-tools"] },
    { name: "hubspot", primary_group: group.id, subgroups: ["crm-sales"] }
  ];
  const first = await writeSkillSubgroupNotes({ groupsRoot: root, groups: [group], items: before, render, writeText: write });
  assert.deepEqual(first, { written: ["integrations-automation/developer-tools.md", "integrations-automation/crm-sales.md"], removed: [] });

  // A note someone wrote by hand in the same folder is not the generator's.
  await write("integrations-automation/my-notes.md", "# Which CRM do we use\n");
  // After the update the taxonomy no longer has the subgroup at all, as
  // summarizeSkillTaxonomy leaves out subgroups without members.
  const after = [{ name: "github", primary_group: group.id, subgroups: ["developer-tools"] }];
  const second = await writeSkillSubgroupNotes({
    groupsRoot: root,
    groups: [{ id: group.id, subgroups: [{ id: "developer-tools" }] }],
    items: after,
    render,
    writeText: write
  });
  assert.deepEqual(second, { written: ["integrations-automation/developer-tools.md"], removed: ["integrations-automation/crm-sales.md"] });
  const left = (await fs.readdir(path.join(root, group.id))).sort();
  assert.deepEqual(left, ["developer-tools.md", "my-notes.md"]);
});

test("a group without a folder yet, or without subgroups, is not an error", async (t) => {
  const { root, write } = await makeGroups(t);
  const result = await writeSkillSubgroupNotes({
    groupsRoot: root,
    groups: [{ id: "mobile", subgroups: [] }, { id: "security" }],
    items: [],
    render,
    writeText: write
  });
  assert.deepEqual(result, { written: [], removed: [] });
});
