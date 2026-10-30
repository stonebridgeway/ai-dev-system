import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateSkillQuality } from "../skill-quality.mjs";
import { addCustomSkill, createCustomSkill, listCustomSkills, removeCustomSkill, seedSkillNames, skillTemplate } from "./custom-skills.mjs";

async function stage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-custom-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const custom = path.join(root, "vault", "custom");
  await fs.mkdir(custom, { recursive: true });
  return { root, custom };
}

async function skillFolder(where, name, { frontmatterName = name, description = `Do ${name} when asked.`, extra = {} } = {}) {
  const folder = path.join(where, name);
  await fs.mkdir(folder, { recursive: true });
  const header = ["---", ...(frontmatterName ? [`name: ${frontmatterName}`] : []), ...(description ? [`description: ${description}`] : []), "---", `# ${name}`, ""].join("\n");
  await fs.writeFile(path.join(folder, "SKILL.md"), header);
  for (const [file, text] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await fs.writeFile(path.join(folder, file), text);
  }
  return folder;
}

test("a folder with a SKILL.md is copied under the name its frontmatter gives, without links or .git", async (t) => {
  const { root, custom } = await stage(t);
  const source = await skillFolder(path.join(root, "mine"), "folder-name", { frontmatterName: "release-notes", extra: { "refs/guide.md": "guide", ".git/HEAD": "ref" } });
  let linked = true;
  try {
    await fs.symlink(path.join(root, "outside.txt"), path.join(source, "outside"));
  } catch {
    linked = false; // Windows without the right to make links: the rest still holds.
  }
  const added = await addCustomSkill({ root: custom, source });
  assert.equal(added.name, "release-notes");
  assert.equal(added.files, 2, "SKILL.md and refs/guide.md");
  assert.deepEqual(added.skipped.sort(), [".git", ...(linked ? ["outside"] : [])].sort());
  assert.equal(await fs.readFile(path.join(custom, "release-notes", "refs", "guide.md"), "utf8"), "guide");
  await assert.rejects(fs.lstat(path.join(custom, "release-notes", ".git")), { code: "ENOENT" });
  // The SKILL.md itself is a source too; a name given wins over the frontmatter's.
  const again = await addCustomSkill({ root: custom, source: path.join(source, "SKILL.md"), name: "release-notes-two" });
  assert.equal(again.name, "release-notes-two");
  assert.deepEqual((await listCustomSkills({ root: custom })).map((skill) => [skill.name, skill.origin]), [["release-notes", "yours"], ["release-notes-two", "yours"]]);
});

test("a skill of that name is replaced only when asked, and one that came with AI Dev never", async (t) => {
  const { root, custom } = await stage(t);
  await skillFolder(custom, "seeded");
  const first = await skillFolder(path.join(root, "v1"), "mine", { extra: { "old.md": "old" } });
  const second = await skillFolder(path.join(root, "v2"), "mine", { extra: { "new.md": "new" } });
  await addCustomSkill({ root: custom, source: first });
  await assert.rejects(addCustomSkill({ root: custom, source: second }), /There is a skill mine already/);
  const replaced = await addCustomSkill({ root: custom, source: second, replace: true });
  assert.equal(replaced.replaced, true);
  assert.deepEqual((await fs.readdir(path.join(custom, "mine"))).sort(), ["SKILL.md", "new.md"], "the old copy's files are gone");
  assert.deepEqual((await fs.readdir(custom)).sort(), ["mine", "seeded"], "nothing left aside");
  const seed = await skillFolder(path.join(root, "v3"), "seeded");
  await assert.rejects(addCustomSkill({ root: custom, source: seed, replace: true, seedNames: new Set(["seeded"]) }), /comes with AI Dev/);
});

test("what is not a skill is refused before anything is written", async (t) => {
  const { root, custom } = await stage(t);
  await assert.rejects(addCustomSkill({ root: custom, source: path.join(root, "nowhere") }), /is not there/);
  await fs.mkdir(path.join(root, "empty"));
  await assert.rejects(addCustomSkill({ root: custom, source: path.join(root, "empty") }), /holds no SKILL\.md/);
  await fs.writeFile(path.join(root, "notes.md"), "# notes");
  await assert.rejects(addCustomSkill({ root: custom, source: path.join(root, "notes.md") }), /neither a folder nor a SKILL\.md/);
  const bad = await skillFolder(path.join(root, "bad"), "Bad Name", { frontmatterName: "Bad Name" });
  await assert.rejects(addCustomSkill({ root: custom, source: bad }), /lowercase letters, digits and hyphens/);
  await assert.rejects(addCustomSkill({ root: custom, source: bad, name: "../escape" }), /The name given must be/);
  const silent = await skillFolder(path.join(root, "silent"), "silent", { description: "" });
  await assert.rejects(addCustomSkill({ root: custom, source: silent }), /needs a description/);
  const big = await skillFolder(path.join(root, "big"), "big", { extra: { "a.md": "a", "b.md": "b", "c.md": "c" } });
  await assert.rejects(addCustomSkill({ root: custom, source: big, limits: { files: 2, bytes: 1e9 } }), /more than 2 files/);
  await assert.rejects(addCustomSkill({ root: custom, source: big, limits: { files: 100, bytes: 10 } }), /more than 10 B/);
  assert.deepEqual(await fs.readdir(custom), [], "nothing was written");
});

test("a new skill starts from the template, and its name and description are checked", async (t) => {
  const { custom } = await stage(t);
  const created = await createCustomSkill({ root: custom, name: "deploy-check", description: "  Check a deploy\nbefore calling it done.  " });
  assert.equal(created.description, "Check a deploy before calling it done.");
  const text = await fs.readFile(created.file, "utf8");
  assert.equal(text, skillTemplate("deploy-check", "Check a deploy before calling it done."));
  assert.match(text, /^---\nname: deploy-check\ndescription: Check a deploy before calling it done\.\n---\n\n# Deploy Check\n/);
  await assert.rejects(createCustomSkill({ root: custom, name: "deploy-check", description: "Again." }), /There is a skill deploy-check already/);
  await assert.rejects(createCustomSkill({ root: custom, name: "x", description: "" }), /needs a description/);
  await assert.rejects(createCustomSkill({ root: custom, name: "x", description: "d".repeat(1025) }), /at most 1024 characters/);
  await assert.rejects(createCustomSkill({ root: custom, name: "-x", description: "Fine." }), /lowercase letters/);
});

test("a skill just started from the template passes the structure check the health check holds it to", () => {
  for (const description of ["Check a deploy before calling it done.", "x"]) {
    const verdict = evaluateSkillQuality({ name: "deploy-check", description, source: "custom" }, skillTemplate("deploy-check", description));
    assert.equal(verdict.status, "pass", JSON.stringify(verdict.findings));
    assert.deepEqual(verdict.findings.filter((finding) => finding.severity === "error"), []);
    assert.ok(verdict.findings.every((finding) => /description|trigger/.test(finding.code)), "what is left to say is the person's own description");
  }
});

test("removing takes only a skill of yours: not the seed's, not a link, not a folder without a SKILL.md", async (t) => {
  const { root, custom } = await stage(t);
  await skillFolder(custom, "mine");
  await skillFolder(custom, "seeded");
  await fs.mkdir(path.join(custom, "notes"));
  await assert.rejects(removeCustomSkill({ root: custom, name: "seeded", seedNames: new Set(["seeded"]) }), /comes with AI Dev/);
  await assert.rejects(removeCustomSkill({ root: custom, name: "notes" }), /holds no SKILL\.md/);
  await assert.rejects(removeCustomSkill({ root: custom, name: "absent" }), /There is no skill absent of yours/);
  await assert.rejects(removeCustomSkill({ root: custom, name: "../custom" }), /lowercase letters/);
  try {
    await fs.symlink(path.join(custom, "mine"), path.join(custom, "linked"), "dir");
    await assert.rejects(removeCustomSkill({ root: custom, name: "linked" }), /is not a skill's folder/);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
  const removed = await removeCustomSkill({ root: custom, name: "mine" });
  assert.equal(removed.folder, path.join(custom, "mine"));
  assert.deepEqual((await fs.readdir(custom)).filter((name) => !name.startsWith("linked")).sort(), ["notes", "seeded"]);
  assert.equal(await fs.readFile(path.join(root, "vault", "custom", "seeded", "SKILL.md"), "utf8").then(Boolean), true);
});

test("the list leaves out folders being added or removed, and says which skills came with AI Dev", async (t) => {
  const { root, custom } = await stage(t);
  await skillFolder(custom, "seeded");
  await skillFolder(custom, "mine");
  await skillFolder(custom, ".mine.0000.adding");
  const manifest = path.join(root, "public-seed.manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ files: [{ path: "03-skills-catalog/sources/custom/seeded/SKILL.md" }, { path: "03-skills-catalog/sources/custom/seeded/refs/a.md" }, { path: "01-system/Agent Rules.md" }] }));
  const seedNames = await seedSkillNames({ manifestFile: manifest });
  assert.deepEqual([...seedNames], ["seeded"]);
  assert.deepEqual((await listCustomSkills({ root: custom, seedNames })).map((skill) => [skill.name, skill.origin, skill.description]), [
    ["mine", "yours", "Do mine when asked."],
    ["seeded", "seed", "Do seeded when asked."]
  ]);
  assert.deepEqual([...await seedSkillNames({ manifestFile: path.join(root, "absent.json") })], [], "no manifest: nothing came with AI Dev");
  assert.deepEqual(await listCustomSkills({ root: path.join(root, "absent") }), []);
});

test("a SKILL.md that is a link is copied as its text, and a name given is the one the SKILL.md says", async (t) => {
  const { root, custom } = await stage(t);
  // Dotfile managers keep the SKILL.md as a link: the copy is the file it leads to.
  const kept = await skillFolder(path.join(root, "dotfiles"), "linked-skill");
  const alone = path.join(root, "alone");
  const beside = path.join(root, "beside");
  await fs.mkdir(path.join(beside, "refs"), { recursive: true });
  await fs.mkdir(alone);
  await fs.writeFile(path.join(beside, "refs", "a.md"), "a");
  try {
    await fs.symlink(path.join(kept, "SKILL.md"), path.join(alone, "SKILL.md"));
    await fs.symlink(path.join(kept, "SKILL.md"), path.join(beside, "SKILL.md"));
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    t.skip("no right to make links here");
    return;
  }
  const text = await fs.readFile(path.join(kept, "SKILL.md"), "utf8");
  const first = await addCustomSkill({ root: custom, source: alone });
  assert.deepEqual([first.name, first.files, first.skipped], ["linked-skill", 1, []]);
  const second = await addCustomSkill({ root: custom, source: beside, name: "linked-beside" });
  assert.deepEqual([second.files, second.skipped], [2, []]);
  for (const name of ["linked-skill", "linked-beside"]) {
    assert.ok((await fs.lstat(path.join(custom, name, "SKILL.md"))).isFile(), `${name}: a file, not a link`);
  }
  assert.equal(await fs.readFile(path.join(custom, "linked-skill", "SKILL.md"), "utf8"), text);
  // The name given is written into the frontmatter, where the registry reads it, and nowhere else.
  assert.equal(await fs.readFile(path.join(custom, "linked-beside", "SKILL.md"), "utf8"), text.replace("name: linked-skill", "name: linked-beside"));
  const nameless = await skillFolder(path.join(root, "nameless"), "nameless", { frontmatterName: "" });
  await addCustomSkill({ root: custom, source: nameless, name: "named-now" });
  assert.match(await fs.readFile(path.join(custom, "named-now", "SKILL.md"), "utf8"), /^---\nname: named-now\ndescription: Do nameless when asked\.\n---\n/);
  // A copy of a seed skill under another name is that other skill, not a second `seeded`.
  const copy = await skillFolder(path.join(root, "copy"), "copy", { frontmatterName: "seeded" });
  await assert.rejects(addCustomSkill({ root: custom, source: copy, seedNames: new Set(["seeded"]) }), /seeded comes with AI Dev/);
  await addCustomSkill({ root: custom, source: copy, name: "my-seeded", seedNames: new Set(["seeded"]) });
  assert.match(await fs.readFile(path.join(custom, "my-seeded", "SKILL.md"), "utf8"), /^---\nname: my-seeded\n/);
  assert.deepEqual((await fs.readdir(custom)).sort(), ["linked-beside", "linked-skill", "my-seeded", "named-now"], "nothing staged or set aside is left");
});
