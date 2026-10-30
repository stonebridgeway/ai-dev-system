import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SEED_HISTORY_FILE,
  SEED_NEW_SUFFIX,
  SEED_STATE_FILE,
  compareVersions,
  describeSeedSync,
  describeSyncResult,
  evaluateVaultSeed,
  isSeedManifest,
  prepareUserVault,
  readSeedHistory,
  seedHistoryKey,
  syncSeed
} from "./seed-sync.mjs";

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-seed-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A seed folder as `npm run dist` ships one: the files and a manifest of their sha256. */
async function writeSeed(root, files) {
  await fs.rm(root, { recursive: true, force: true });
  const entries = [];
  for (const [relative, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  const fingerprint = sha(entries.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n"));
  await fs.writeFile(path.join(root, "public-seed.manifest.json"), JSON.stringify({ schema_version: 1, content_fingerprint: fingerprint, files: entries }));
  return root;
}

const read = (root, relative) => fs.readFile(path.join(root, relative), "utf8");
const exists = (target) => fs.access(target).then(() => true, () => false);

test("a new seed replaces what the user left alone and keeps what they changed, with the update's version beside it", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const v1 = await writeSeed(path.join(root, "seed-1"), {
    "01-system/Agent Rules.md": "rules v1\n",
    "01-system/Operating Model.md": "model v1\n",
    "04-agent-workflows/Code Reviewer.md": "reviewer v1\n",
    "06-prompts/Prompt Patterns.md": "patterns v1\n",
    "03-skills-catalog/sources/x/old/SKILL.md": "old skill\n"
  });
  const first = await syncSeed({ seedRoot: v1, contentRoot: vault, version: "3.0.0" });
  assert.equal(first.status, "synced");
  assert.equal(first.added, 5);
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules v1\n");

  // The user edits two notes and deletes one.
  await fs.writeFile(path.join(vault, "01-system", "Agent Rules.md"), "my rules\n");
  await fs.writeFile(path.join(vault, "06-prompts", "Prompt Patterns.md"), "my patterns\n");
  await fs.rm(path.join(vault, "04-agent-workflows", "Code Reviewer.md"));

  const v2 = await writeSeed(path.join(root, "seed-2"), {
    "01-system/Agent Rules.md": "rules v2\n",        // changed by both: a conflict
    "01-system/Operating Model.md": "model v2\n",    // changed by the seed only: replaced
    "04-agent-workflows/Code Reviewer.md": "reviewer v2\n", // deleted by the user: stays deleted
    "06-prompts/Prompt Patterns.md": "patterns v1\n", // changed by the user only: kept, no conflict
    "07-quality-gates/Quality Gate.md": "gate v2\n"   // new: added
    // sources/x/old/SKILL.md is dropped: removed, with its folders
  });
  const second = await syncSeed({ seedRoot: v2, contentRoot: vault, version: "3.1.0" });
  assert.equal(second.status, "synced");
  assert.deepEqual({ added: second.added, updated: second.updated, unchanged: second.unchanged, removed: second.removed },
    { added: 1, updated: 1, unchanged: 0, removed: 1 });
  assert.deepEqual(second.kept.sort(), ["01-system/Agent Rules.md", "06-prompts/Prompt Patterns.md"]);
  assert.deepEqual(second.conflicts, ["01-system/Agent Rules.md"]);

  assert.equal(await read(vault, "01-system/Agent Rules.md"), "my rules\n", "the user's file is never overwritten");
  assert.equal(await read(vault, `01-system/Agent Rules.md${SEED_NEW_SUFFIX}`), "rules v2\n", "the update's version sits beside it");
  assert.equal(await read(vault, "01-system/Operating Model.md"), "model v2\n");
  assert.equal(await read(vault, "06-prompts/Prompt Patterns.md"), "my patterns\n");
  assert.equal(await exists(path.join(vault, "06-prompts", `Prompt Patterns.md${SEED_NEW_SUFFIX}`)), false, "the seed did not change it: nothing to merge");
  assert.equal(await exists(path.join(vault, "04-agent-workflows", "Code Reviewer.md")), false, "what the user deleted stays deleted");
  assert.equal(await read(vault, "07-quality-gates/Quality Gate.md"), "gate v2\n");
  assert.equal(await exists(path.join(vault, "03-skills-catalog")), false, "a dropped file goes, and the folders it leaves empty");

  const described = await describeSeedSync(vault);
  assert.deepEqual(described.conflicts, ["01-system/Agent Rules.md"]);
  assert.equal(described.version, "3.1.0");
});

test("a conflict stays open until the user takes the update's version or deletes the .seed-new", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s1"), { "a.md": "a1\n", "b.md": "b1\n" }), contentRoot: vault, version: "3.0.0" });
  await fs.writeFile(path.join(vault, "a.md"), "mine a\n");
  await fs.writeFile(path.join(vault, "b.md"), "mine b\n");
  const v2 = await writeSeed(path.join(root, "s2"), { "a.md": "a2\n", "b.md": "b2\n" });
  assert.deepEqual((await syncSeed({ seedRoot: v2, contentRoot: vault, version: "3.1.0" })).conflicts, ["a.md", "b.md"]);

  // A start of the same version reads the record and changes nothing.
  const again = await syncSeed({ seedRoot: v2, contentRoot: vault, version: "3.1.0" });
  assert.equal(again.status, "current");
  assert.deepEqual(again.conflicts, ["a.md", "b.md"]);

  // a: the user keeps theirs and deletes the update's copy. b: the user takes it.
  await fs.rm(path.join(vault, `a.md${SEED_NEW_SUFFIX}`));
  await fs.copyFile(path.join(vault, `b.md${SEED_NEW_SUFFIX}`), path.join(vault, "b.md"));
  assert.deepEqual((await describeSeedSync(vault)).conflicts, [], "doctor stops naming them at once");

  // A later seed that leaves both alone: no conflict comes back, and the
  // copy the user already took is cleared away.
  const v3 = await writeSeed(path.join(root, "s3"), { "a.md": "a2\n", "b.md": "b2\n", "c.md": "c3\n" });
  const third = await syncSeed({ seedRoot: v3, contentRoot: vault, version: "3.2.0" });
  assert.deepEqual(third.conflicts, []);
  assert.equal(await exists(path.join(vault, `b.md${SEED_NEW_SUFFIX}`)), false);
  assert.equal(await read(vault, "a.md"), "mine a\n");

  // An open conflict the next seed does not touch is carried, not forgotten.
  await fs.writeFile(path.join(vault, "c.md"), "mine c\n");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s4"), { "a.md": "a2\n", "b.md": "b2\n", "c.md": "c4\n" }), contentRoot: vault, version: "3.3.0" });
  const fifth = await syncSeed({ seedRoot: await writeSeed(path.join(root, "s5"), { "a.md": "a2\n", "b.md": "b2\n", "c.md": "c4\n", "d.md": "d5\n" }), contentRoot: vault, version: "3.4.0" });
  assert.deepEqual(fifth.conflicts, ["c.md"]);
  assert.equal(await read(vault, `c.md${SEED_NEW_SUFFIX}`), "c4\n");
});

test("an older version leaves a newer vault alone; the same version with a new seed syncs", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const old = await writeSeed(path.join(root, "old"), { "a.md": "a1\n" });
  const fresh = await writeSeed(path.join(root, "new"), { "a.md": "a2\n" });
  await syncSeed({ seedRoot: old, contentRoot: vault, version: "3.0.0" });
  await syncSeed({ seedRoot: fresh, contentRoot: vault, version: "3.1.0" });
  const back = await syncSeed({ seedRoot: old, contentRoot: vault, version: "3.0.0" });
  assert.equal(back.status, "newer");
  assert.equal(back.version, "3.1.0");
  assert.equal(await read(vault, "a.md"), "a2\n", "a client still configured with the previous version does not roll the vault back");

  // A development build keeps its version while its seed changes.
  const dev = await writeSeed(path.join(root, "dev"), { "a.md": "a3\n" });
  assert.equal((await syncSeed({ seedRoot: dev, contentRoot: vault, version: "3.1.0" })).status, "synced");
  assert.equal(await read(vault, "a.md"), "a3\n");
});

test("what is not a file of the seed's is the user's: links, folders, files in the way are left alone", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const elsewhere = path.join(root, "elsewhere.md");
  await fs.writeFile(elsewhere, "the user's own note\n");
  await fs.mkdir(path.join(vault, "notes"), { recursive: true });
  await fs.symlink(elsewhere, path.join(vault, "notes", "linked.md"));
  await fs.mkdir(path.join(vault, "notes", "folder.md"));
  await fs.writeFile(path.join(vault, "blocked"), "a file where the seed has a folder\n");
  const seed = await writeSeed(path.join(root, "seed"), {
    "notes/linked.md": "seed\n",
    "notes/folder.md": "seed\n",
    "blocked/inner.md": "seed\n",
    "notes/fresh.md": "seed\n"
  });
  const result = await syncSeed({ seedRoot: seed, contentRoot: vault });
  assert.equal(result.added, 1);
  assert.deepEqual(result.kept.sort(), ["blocked/inner.md", "notes/folder.md", "notes/linked.md"]);
  assert.equal(await fs.readFile(elsewhere, "utf8"), "the user's own note\n", "a link is never written through");
  assert.equal((await fs.lstat(path.join(vault, "notes", "linked.md"))).isSymbolicLink(), true);
  assert.equal(await read(vault, "blocked"), "a file where the seed has a folder\n");
});

test("a seed made before the vault had a record: identical files are taken as shipped, different ones are the user's", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "same.md"), "same\n");
  await fs.writeFile(path.join(vault, "differs.md"), "the user's\n");
  const seed = await writeSeed(path.join(root, "seed"), { "same.md": "same\n", "differs.md": "seed\n" });
  const result = await syncSeed({ seedRoot: seed, contentRoot: vault });
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.conflicts, ["differs.md"]);
  assert.equal(await read(vault, "differs.md"), "the user's\n");
  assert.equal(await read(vault, `differs.md${SEED_NEW_SUFFIX}`), "seed\n");
  const state = JSON.parse(await read(vault, SEED_STATE_FILE));
  assert.equal(state.files["same.md"], sha("same\n"));
});

test("two servers starting at once sync once; a manifest that leaves the seed is refused", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const seed = await writeSeed(path.join(root, "seed"), Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`n/${index}.md`, `${index}\n`])));
  const results = await Promise.all([1, 2, 3].map(() => syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0" })));
  assert.deepEqual(results.map((result) => result.status).sort(), ["current", "current", "synced"]);
  assert.equal(results.reduce((sum, result) => sum + result.added, 0), 40);

  const evil = path.join(root, "evil");
  await fs.mkdir(evil, { recursive: true });
  await fs.writeFile(path.join(evil, "public-seed.manifest.json"), JSON.stringify({ content_fingerprint: "x", files: [{ path: "../outside.md", sha256: sha("") }] }));
  await assert.rejects(syncSeed({ seedRoot: evil, contentRoot: vault }), /not a path inside the seed/);
  await assert.rejects(syncSeed({ seedRoot: path.join(root, "nothing"), contentRoot: vault }), /has no readable public-seed\.manifest\.json/);
});

test("versions compare by number, a prerelease before its release", () => {
  assert.equal(compareVersions("3.10.0", "3.9.1"), 1);
  assert.equal(compareVersions("3.0.0", "3.0.0"), 0);
  assert.equal(compareVersions("v3.0.0", "3.0.0"), 0);
  assert.equal(compareVersions("3.0.0-beta.2", "3.0.0"), -1);
  assert.equal(compareVersions("3.0.0-beta.10", "3.0.0-beta.2"), 1);
  assert.equal(compareVersions("2.9.9", "3.0.0-rc.1"), -1);
});

test("at the server's start a package's vault is filled; a failure is said, not thrown; doctor names what to merge", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await prepareUserVault({ seedRoot: "", contentRoot: vault }, { log }), null, "a clone has no seed to sync");

  const seed = await writeSeed(path.join(root, "seed"), { "a.md": "a1\n", "b.md": "b1\n" });
  const first = await prepareUserVault({ seedRoot: seed, contentRoot: vault }, { version: "3.0.0", log });
  assert.equal(first.status, "synced");
  assert.match(lines.at(-1), /vault .* — seed 3\.0\.0: 2 added, 0 updated, 0 removed, 0 of yours kept\.$/);
  await prepareUserVault({ seedRoot: seed, contentRoot: vault }, { version: "3.0.0", log });
  assert.equal(lines.length, 1, "a start that changes nothing says nothing");

  const broken = await prepareUserVault({ seedRoot: path.join(root, "gone"), contentRoot: vault }, { version: "3.0.1", log });
  assert.equal(broken.status, "failed");
  assert.match(lines.at(-1), /not brought up to the seed: .*has no readable public-seed\.manifest\.json/);

  assert.equal(evaluateVaultSeed({ root: vault, ...await describeSeedSync(vault) }).status, "ok");
  assert.equal(evaluateVaultSeed({ root: vault, ...await describeSeedSync(path.join(root, "empty")) }).status, "warn", "never filled");

  for (const name of ["a.md", "b.md"]) await fs.writeFile(path.join(vault, name), `mine ${name}\n`);
  const update = await writeSeed(path.join(root, "seed-2"), { "a.md": "a2\n", "b.md": "b2\n" });
  const second = await prepareUserVault({ seedRoot: update, contentRoot: vault }, { version: "3.1.0", log });
  assert.match(describeSyncResult(second), /2 file\(s\) you changed were changed by this version too/);
  const verdict = evaluateVaultSeed({ root: vault, ...await describeSeedSync(vault) });
  assert.equal(verdict.status, "warn");
  assert.match(verdict.summary, /^2 file\(s\) you changed in .* were changed by an update too: a\.md, b\.md\. Yours were kept; the update's version is beside each as <file>\.seed-new\./);
  assert.match(describeSyncResult(await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0" })), /left as it is: it was brought up to 3\.1\.0/);
});

test("a package missing a seed file still fills the vault; the file arrives once the package is whole", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const seed = await writeSeed(path.join(root, "seed"), { "a/.gitignore": "x\n", "a/b.md": "b\n", "z.md": "z\n" });
  await fs.rm(path.join(seed, "a", ".gitignore"));
  const broken = await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0" });
  assert.equal(broken.status, "synced");
  assert.equal(broken.added, 2, "everything else arrives");
  assert.deepEqual(broken.missing, ["a/.gitignore"]);
  assert.equal(await read(vault, "z.md"), "z\n");
  const verdict = evaluateVaultSeed({ root: vault, ...await describeSeedSync(vault) });
  assert.equal(verdict.status, "warn");
  assert.match(verdict.summary, /^1 file\(s\) of the seed are missing from this install \(a\/\.gitignore\).*reinstall the package\.$/);
  assert.match(describeSyncResult(broken), /1 file\(s\) of the seed are missing from this install — reinstall it$/);

  await fs.writeFile(path.join(seed, "a", ".gitignore"), "x\n");
  const whole = await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0" });
  assert.equal(whole.status, "synced", "the same manifest is not current while a file of it never arrived");
  assert.equal(whole.added, 1);
  assert.deepEqual(whole.missing, []);
  assert.equal(await read(vault, "a/.gitignore"), "x\n");
  assert.equal((await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0" })).status, "current");
});

test("a seed rename by case only keeps the file; a linked folder of the user's is never written through", async (t) => {
  const root = await scratch(t);
  // Case: on Windows and macOS both names are one file — a hard link stands in for that
  // where the filesystem tells them apart.
  const vault = path.join(root, "vault");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "a1"), { "x/skill.md": "s\n" }), contentRoot: vault, version: "1.0.0" });
  const upper = path.join(vault, "x", "SKILL.md");
  if (!(await exists(upper))) await fs.link(path.join(vault, "x", "skill.md"), upper);
  const renamed = await syncSeed({ seedRoot: await writeSeed(path.join(root, "a2"), { "x/SKILL.md": "s\n" }), contentRoot: vault, version: "1.0.1" });
  assert.equal(renamed.removed, 0, "the old name is the same file: not removed");
  assert.equal(await read(vault, "x/skill.md"), "s\n");

  // A skills folder linked to the user's own repository.
  const linkedVault = path.join(root, "linked-vault");
  const repository = path.join(root, "my-repository");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "b1"), { "skills/a/SKILL.md": "a1\n", "skills/b/SKILL.md": "b1\n", "top.md": "t1\n" }), contentRoot: linkedVault, version: "1.0.0" });
  await fs.cp(path.join(linkedVault, "skills"), repository, { recursive: true });
  await fs.rm(path.join(linkedVault, "skills"), { recursive: true });
  await fs.symlink(repository, path.join(linkedVault, "skills"));
  const update = await syncSeed({ seedRoot: await writeSeed(path.join(root, "b2"), { "skills/a/SKILL.md": "a2\n", "top.md": "t2\n" }), contentRoot: linkedVault, version: "1.0.1" });
  assert.equal(await fs.readFile(path.join(repository, "a", "SKILL.md"), "utf8"), "a1\n", "not rewritten through the link");
  assert.equal(await fs.readFile(path.join(repository, "b", "SKILL.md"), "utf8"), "b1\n", "not removed through the link");
  assert.equal(await read(linkedVault, "top.md"), "t2\n", "the rest of the vault is updated as ever");
  assert.ok(update.kept.includes("skills/a/SKILL.md"));
});

test("a conflict resolved by deleting the file leaves no .seed-new behind; build metadata does not order versions", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s1"), { "n.md": "1\n" }), contentRoot: vault, version: "1.0.0" });
  await fs.writeFile(path.join(vault, "n.md"), "mine\n");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s2"), { "n.md": "2\n" }), contentRoot: vault, version: "1.0.1" });
  assert.equal(await read(vault, `n.md${SEED_NEW_SUFFIX}`), "2\n");
  await fs.rm(path.join(vault, "n.md"));
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s3"), { "n.md": "3\n" }), contentRoot: vault, version: "1.0.2" });
  assert.equal(await exists(path.join(vault, `n.md${SEED_NEW_SUFFIX}`)), false);
  assert.equal(await exists(path.join(vault, "n.md")), false, "and the file stays deleted");
  assert.equal(compareVersions("3.0.0+build.1", "3.0.0"), 0);
  assert.equal(compareVersions("3.0.1+a", "3.0.0+b"), 1);
});

test("a vault with no record — a 2.x volume `cp -n` filled — is read against the seed's history", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  // What 2.x images left: an old version of a note, a skill 3.0 dropped, both as shipped;
  // a note and a dropped skill the user changed; a note already current; the image's own link.
  const files = {
    "01-system/Agent Rules.md": "rules 2.0\n",
    "01-system/Operating Model.md": "model, edited by me\n",
    "03-skills-catalog/sources/x/culled/SKILL.md": "culled skill\n",
    "03-skills-catalog/sources/x/mine/SKILL.md": "culled skill, which I rewrote\n",
    "04-agent-workflows/Code Reviewer.md": "reviewer 3.0\n",
    "02-knowledge/Projects/notes.md": "my notes\n",
    "02-knowledge/copy of the rules.md": "rules 2.0\n"
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await fs.writeFile(path.join(vault, relative), content);
  }
  const image = path.join(root, "image-app");
  await fs.mkdir(image, { recursive: true });
  await fs.writeFile(path.join(image, "SKILL.md"), "rules 2.0\n");
  await fs.mkdir(path.join(vault, "09-mcp"), { recursive: true });
  await fs.symlink(image, path.join(vault, "09-mcp", "ai-dev-mcp-server"), "dir");

  const shippedBefore = new Set([
    seedHistoryKey("01-system/Agent Rules.md", sha("rules 2.0\n")),
    seedHistoryKey("01-system/Operating Model.md", sha("model 2.0\n")),
    seedHistoryKey("03-skills-catalog/sources/x/culled/SKILL.md", sha("culled skill\n")),
    seedHistoryKey("03-skills-catalog/sources/x/mine/SKILL.md", sha("culled skill\n")),
    // A path behind the image's link is not walked, even one the history names.
    seedHistoryKey("09-mcp/ai-dev-mcp-server/SKILL.md", sha("rules 2.0\n"))
  ]);
  const seed = await writeSeed(path.join(root, "seed-3"), {
    "01-system/Agent Rules.md": "rules 3.0\n",
    "01-system/Operating Model.md": "model 3.0\n",
    "04-agent-workflows/Code Reviewer.md": "reviewer 3.0\n"
  });
  let asked = 0;
  const result = await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history: async () => { asked += 1; return shippedBefore; } });
  assert.equal(result.status, "synced");
  assert.equal(result.recognised, 2, "the old note and the culled skill");
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules 3.0\n", "a 2.x version is updated");
  assert.equal(await exists(path.join(vault, "03-skills-catalog/sources/x/culled")), false, "a skill the seed dropped goes, with its folder");
  assert.equal(await read(vault, "03-skills-catalog/sources/x/mine/SKILL.md"), "culled skill, which I rewrote\n", "a rewritten one stays");
  assert.equal(await read(vault, "01-system/Operating Model.md"), "model, edited by me\n");
  assert.equal(await read(vault, `01-system/Operating Model.md${SEED_NEW_SUFFIX}`), "model 3.0\n");
  assert.deepEqual(result.conflicts, ["01-system/Operating Model.md"]);
  assert.equal(await read(vault, "02-knowledge/Projects/notes.md"), "my notes\n");
  assert.equal(await read(vault, "02-knowledge/copy of the rules.md"), "rules 2.0\n", "a shipped content at another path is the user's");
  assert.equal(await fs.readFile(path.join(image, "SKILL.md"), "utf8"), "rules 2.0\n", "nothing is read or removed through a link");
  assert.match(describeSyncResult(result), /2 file\(s\) recognised as an earlier seed's/);

  // With the record written, the next seed does not ask the history again.
  const next = await writeSeed(path.join(root, "seed-4"), { "01-system/Agent Rules.md": "rules 3.1\n" });
  await syncSeed({ seedRoot: next, contentRoot: vault, version: "3.1.0", history: async () => { asked += 1; return shippedBefore; } });
  assert.equal(asked, 1);
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules 3.1\n");
});

/** What a 2.x image's `cp -n` leaves in the vault's root beside its seed. */
const TWO_X_MANIFEST = `${JSON.stringify({ schema_version: 1, files: [{ path: "03-skills-catalog/sources/x/culled/SKILL.md" }] })}\n`;

test("a vault a 2.x image ran on since its last sync gives back what that image's `cp -n` put there again", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const shippedBefore = new Set([
    seedHistoryKey("03-skills-catalog/sources/x/culled/SKILL.md", sha("culled skill\n")),
    seedHistoryKey("01-system/Agent Rules.md", sha("rules 2.0\n")),
    seedHistoryKey("public-seed.manifest.json", sha(TWO_X_MANIFEST))
  ]);
  const history = async () => shippedBefore;
  const seed = await writeSeed(path.join(root, "seed-3"), { "01-system/Agent Rules.md": "rules 3.0\n" });
  assert.equal((await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history })).status, "synced");
  assert.equal((await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history })).status, "current");

  // Back to :2, whose entrypoint copies its seed in with `cp -n` — its manifest too —
  // while the user adds a skill of their own; then the 3.0 image again.
  const twoX = {
    "03-skills-catalog/sources/x/culled/SKILL.md": "culled skill\n",
    "public-seed.manifest.json": TWO_X_MANIFEST,
    "03-skills-catalog/sources/x/mine/SKILL.md": "a skill of my own\n"
  };
  for (const [relative, content] of Object.entries(twoX)) {
    await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await fs.writeFile(path.join(vault, relative), content);
  }
  const back = await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history });
  assert.equal(back.status, "synced", "the record's fingerprint is this seed's, and 2.x ran since");
  assert.equal(back.removed, 2, "the culled skill and 2.x's manifest");
  assert.match(describeSyncResult(back), /recognised as an earlier seed's, put back by a 2\.x image since the last sync/);
  assert.equal(await exists(path.join(vault, "03-skills-catalog/sources/x/culled")), false);
  assert.equal(await exists(path.join(vault, "public-seed.manifest.json")), false);
  assert.equal(await read(vault, "03-skills-catalog/sources/x/mine/SKILL.md"), "a skill of my own\n", "the user's own stays");
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules 3.0\n");
  assert.equal((await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history })).status, "current");

  // A 2.x manifest the history does not know — a later 2.x — goes too, so the next start is a read again.
  await fs.writeFile(path.join(vault, "public-seed.manifest.json"), JSON.stringify({ schema_version: 1, files: [{ path: "later.md" }] }));
  const later = await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history });
  assert.deepEqual([later.status, later.removed], ["synced", 1], "and is counted");
  assert.equal(await exists(path.join(vault, "public-seed.manifest.json")), false);
  assert.equal((await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history })).status, "current");

  // A file of the user's by that name, which is no seed manifest, is theirs.
  await fs.writeFile(path.join(vault, "public-seed.manifest.json"), "my notes on the seed\n");
  assert.equal((await syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0", history })).status, "current");
  assert.equal(await read(vault, "public-seed.manifest.json"), "my notes on the seed\n");
});

test("a seed manifest is told by its content: JSON with a files list, not just the name", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seed-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = (name, text) => fs.writeFile(path.join(root, name), text).then(() => path.join(root, name));
  assert.equal(isSeedManifest(await file("manifest.json", JSON.stringify({ files: [{ path: "a", sha256: "b" }] }))), true);
  assert.equal(isSeedManifest(await file("notes.json", JSON.stringify({ notes: "mine" }))), false);
  assert.equal(isSeedManifest(await file("notes.txt", "my notes about the seed")), false);
  assert.equal(isSeedManifest(path.join(root, "missing.json")), false);
});

test("the shipped history names versions by path and sha256, sorted and unique", async () => {
  const history = JSON.parse(await fs.readFile(SEED_HISTORY_FILE, "utf8"));
  assert.equal(history.schema_version, 1);
  assert.ok(history.pairs.length > 1000, `${history.pairs.length} versions`);
  assert.ok(history.pairs.every((key) => /^[0-9a-f]{16}$/.test(key)));
  assert.deepEqual(history.pairs, [...new Set(history.pairs)].sort());
  const keys = await readSeedHistory();
  assert.equal(keys.size, history.pairs.length);
  // The 2.x line's, from a named commit back, whatever the current manifest
  // holds: a 3.0 edit of a file 2.x shipped leaves its 2.x version known.
  // scripts/seed-history.test.mjs checks it against git.
  assert.match(history.base, /^[0-9a-f]{40}$/);
  assert.equal((await readSeedHistory(path.join(os.tmpdir(), "no-such-history.json"))).size, 0);
});
