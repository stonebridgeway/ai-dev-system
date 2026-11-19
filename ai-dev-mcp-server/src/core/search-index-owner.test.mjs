import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { noteIdentity } from "./search-documents.mjs";
import { CLAIM_SUFFIX, DEFAULT_INDEX_FILE, vaultIndexPath } from "./search-index-owner.mjs";
import { loadSqlite, sqliteSupport } from "./search-sqlite.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

/**
 * An index as an earlier version left it: the notes of `builtFrom` at these
 * paths, with the times it recorded for them, other documents beside them,
 * and the vault it names, if any.
 */
function earlierIndex(file, { builtFrom = "", notes = [], others = [], vaultRoot = "" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(file);
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL, mtime REAL NOT NULL, content_hash TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO documents(id, path, source, mtime, content_hash) VALUES (?, ?, ?, ?, ?)");
    notes.forEach((relative, index) => {
      const note = noteIdentity(builtFrom, relative);
      insert.run(`note-${index}`, relative, "vault-note", note.mtime, note.contentHash);
    });
    others.forEach((relative, index) => insert.run(`other-${index}`, relative, "skill-registry", 0, ""));
    if (vaultRoot) db.prepare("INSERT INTO meta(key, value) VALUES ('vault_root', ?)").run(vaultRoot);
  } finally {
    db.close();
  }
}

/** A note at `relative` in `vault`, written `secondsAgo` before now. */
function note(vault, relative, secondsAgo = 3600, text = "# note\n") {
  const file = path.join(vault, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const when = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, when, when);
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "index-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["vault-a", "vault-b", "vault-c"]) fs.mkdirSync(path.join(root, name));
  return root;
}

test("the first vault keeps the index file a runtime home always had; every other vault gets one of its own", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  const a = vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-a") });
  assert.deepEqual([a.path, a.reason], [path.join(dir, DEFAULT_INDEX_FILE), "claimed"]);
  assert.equal(JSON.parse(fs.readFileSync(`${a.path}${CLAIM_SUFFIX}`, "utf8")).vault_root, path.join(root, "vault-a"));
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-a") }).reason, "own");

  const b = vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b") });
  const c = vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-c") });
  assert.match(path.basename(b.path), /^ai-dev-search-[0-9a-f]{12}\.sqlite$/);
  assert.notEqual(b.path, c.path);
  assert.deepEqual([b.reason, b.owner], ["another-vault", path.join(root, "vault-a")]);
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b") }).path, b.path, "the same file every time");
  // The same vault, spelled another way, is the same vault.
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b", "..", "vault-a", "") }).path, a.path);
});

test("an index written before claims existed goes to the vault it was built from, whichever starts first", needsSqlite, (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  const a = path.join(root, "vault-a");
  const b = path.join(root, "vault-b");
  // vault-a: its own notes and the skills both vaults have; vault-b: the skills alone, as a seed beside a full vault.
  const notes = ["02-knowledge/one.md", "02-knowledge/two.md", "05-projects/p.md", "03-skills-catalog/s.md"];
  for (const relative of notes) note(a, relative);
  note(b, "03-skills-catalog/s.md", 60);
  earlierIndex(path.join(dir, DEFAULT_INDEX_FILE), { builtFrom: a, notes, others: ["03-skills-catalog/registries/s", "/elsewhere/project/README.md"] });
  const first = vaultIndexPath({ dir, vaultRoot: b });
  assert.deepEqual([first.reason, path.basename(first.path) === DEFAULT_INDEX_FILE], ["another-vault", false], "a shell with another vault does not take it");
  assert.equal(fs.existsSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`)), false, "and claims nothing");
  assert.deepEqual([vaultIndexPath({ dir, vaultRoot: a }).path, vaultIndexPath({ dir, vaultRoot: a }).reason], [path.join(dir, DEFAULT_INDEX_FILE), "own"]);

  // An index that names its vault goes to that vault.
  const named = path.join(root, "named");
  earlierIndex(path.join(named, DEFAULT_INDEX_FILE), { builtFrom: a, notes: ["03-skills-catalog/s.md"], vaultRoot: b });
  assert.equal(vaultIndexPath({ dir: named, vaultRoot: a }).reason, "another-vault");
  assert.equal(vaultIndexPath({ dir: named, vaultRoot: path.join(b, "") }).reason, "claimed");

  // No document to tell by, or not an index at all: the first vault takes it, as before.
  const unknown = path.join(root, "unknown");
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, DEFAULT_INDEX_FILE), "not a database");
  assert.equal(vaultIndexPath({ dir: unknown, vaultRoot: b }).reason, "claimed");
});

test("a vault holding only some of the index's notes is not the one it was built from, however they came; the one that is keeps it, edited, pulled or cloned again in place", needsSqlite, (t) => {
  const root = tempRoot(t);
  const owner = path.join(root, "vault-a");
  const seedCopy = path.join(root, "vault-b");
  const stranger = path.join(root, "vault-c");
  // The owner: the seed's notes and ten of its own; the other vault: a copy
  // of the seed made later — every seed path exists in both.
  const seed = Array.from({ length: 30 }, (_, index) => `03-skills-catalog/skill-${index}.md`);
  const own = Array.from({ length: 10 }, (_, index) => `02-knowledge/note-${index}.md`);
  const notes = [...seed, ...own];
  for (const relative of notes) note(owner, relative);
  for (const relative of seed) note(seedCopy, relative, 60);
  const indexIn = (name) => {
    const dir = path.join(root, name);
    earlierIndex(path.join(dir, DEFAULT_INDEX_FILE), { builtFrom: owner, notes });
    return dir;
  };
  const dir = indexIn("index");
  assert.equal(vaultIndexPath({ dir, vaultRoot: seedCopy }).reason, "another-vault", "the seed's copy, starting first, does not take it");
  assert.equal(fs.existsSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`)), false);

  // A vault of its own with one of the owner's notes copied over, time and all.
  for (const relative of ["02-knowledge/mine-1.md", "02-knowledge/mine-2.md"]) note(stranger, relative, 30, `# ${relative}\n`);
  fs.mkdirSync(path.join(stranger, "02-knowledge"), { recursive: true });
  fs.copyFileSync(path.join(owner, own[0]), path.join(stranger, own[0]));
  const { atime, mtime } = fs.statSync(path.join(owner, own[0]));
  fs.utimesSync(path.join(stranger, own[0]), atime, mtime);
  assert.equal(vaultIndexPath({ dir: indexIn("copied-note"), vaultRoot: stranger }).reason, "another-vault", "one note of the sample is not the index's vault");

  // The owner edited some notes after the index was built: still its index.
  for (const relative of notes.slice(0, 15)) note(owner, relative, 10);
  const kept = vaultIndexPath({ dir, vaultRoot: owner });
  assert.deepEqual([path.basename(kept.path), kept.reason], [DEFAULT_INDEX_FILE, "claimed"]);
  for (const relative of notes.slice(0, 15)) note(owner, relative);

  // A pull removed a few notes and changed a few: still its index.
  const pulled = indexIn("pulled");
  for (const relative of notes.slice(0, 5)) fs.rmSync(path.join(owner, relative));
  for (const relative of notes.slice(5, 10)) note(owner, relative, 5, "# changed by the pull\n");
  assert.equal(vaultIndexPath({ dir: pulled, vaultRoot: owner }).reason, "claimed");
  for (const relative of notes.slice(0, 10)) note(owner, relative);

  // Cloned again into the same folder: every note the same bytes, written now.
  const recloned = indexIn("recloned");
  for (const relative of notes) note(owner, relative, 1);
  assert.equal(vaultIndexPath({ dir: recloned, vaultRoot: owner }).reason, "claimed", "a reinstall in place keeps it");
  for (const relative of notes) note(owner, relative);

  // A copy of the whole vault cannot be told from it: the first to start takes it.
  const whole = path.join(root, "whole-copy");
  for (const relative of notes) note(whole, relative, 60);
  assert.equal(vaultIndexPath({ dir: indexIn("whole"), vaultRoot: whole }).reason, "claimed");

  // Most notes changed since: in doubt, a file of its own rather than another's index.
  const changed = indexIn("changed");
  for (const relative of notes.slice(0, 30)) note(owner, relative, 5, "# rewritten\n");
  assert.equal(vaultIndexPath({ dir: changed, vaultRoot: owner }).reason, "another-vault");

  // A note of the same name written in the same instant — files written
  // together share the clock's tick — is not the same note: its content differs.
  const twin = path.join(root, "twin");
  const twinOwner = path.join(twin, "vault-a");
  const twinOther = path.join(twin, "vault-b");
  for (const relative of ["02-knowledge/storage.md", "02-knowledge/deploy.md", "02-knowledge/auth.md"]) note(twinOwner, relative, 100, `# ${relative} A\n`);
  note(twinOther, "02-knowledge/storage.md", 100, "# Storage B\n");
  const instant = fs.statSync(path.join(twinOwner, "02-knowledge", "storage.md"));
  fs.utimesSync(path.join(twinOther, "02-knowledge", "storage.md"), instant.atime, instant.mtime);
  assert.equal(noteIdentity(twinOther, "02-knowledge/storage.md").mtime, noteIdentity(twinOwner, "02-knowledge/storage.md").mtime, "the same instant");
  earlierIndex(path.join(twin, "index", DEFAULT_INDEX_FILE), { builtFrom: twinOwner, notes: ["02-knowledge/storage.md", "02-knowledge/deploy.md", "02-knowledge/auth.md"] });
  assert.equal(vaultIndexPath({ dir: path.join(twin, "index"), vaultRoot: twinOther }).reason, "another-vault");
  assert.equal(vaultIndexPath({ dir: path.join(twin, "index"), vaultRoot: twinOwner }).reason, "claimed");

  // No note to tell by — only documents every vault has — goes to the first vault, as before.
  const noNotes = path.join(root, "no-notes");
  earlierIndex(path.join(noNotes, DEFAULT_INDEX_FILE), { others: ["03-skills-catalog/registries/s"] });
  assert.equal(vaultIndexPath({ dir: noNotes, vaultRoot: seedCopy }).reason, "claimed");
});

test("the notes the server writes itself do not tell whose vault an index is: a set-up vault cloned again into its folder keeps it", needsSqlite, (t) => {
  const root = tempRoot(t);
  const owner = path.join(root, "vault-a");
  const seedCopy = path.join(root, "vault-b");
  // A set-up vault: the seed's notes, two of its own, and more of what setup
  // and the server write — skill cards, group notes, project cards, the
  // dashboards — than of anything else, as in a real one.
  const seed = Array.from({ length: 20 }, (_, index) => `04-agent-workflows/flow-${index}.md`);
  const own = ["02-knowledge/mine-1.md", "02-knowledge/mine-2.md"];
  const generated = [
    ...Array.from({ length: 60 }, (_, index) => `03-skills-catalog/cards/custom/skill-${index}.md`),
    ...Array.from({ length: 10 }, (_, index) => `03-skills-catalog/groups/delivery/sub-${index}.md`),
    "02-knowledge/Projects/Shop Backend.md",
    "01-system/System Dashboard.md",
    "03-skills-catalog/Skill Quality Dashboard.md"
  ];
  const text = (relative, stamp = "2026-01-01T00:00:00Z") => (generated.includes(relative) ? `---\ngenerated_at: "${stamp}"\n---\n# ${relative}\n` : `# ${relative}\n`);
  const notes = [...seed, ...own, ...generated];
  for (const relative of notes) note(owner, relative, 3600, text(relative));
  for (const relative of seed) note(seedCopy, relative, 60, text(relative));
  const indexIn = (name) => {
    const dir = path.join(root, name);
    earlierIndex(path.join(dir, DEFAULT_INDEX_FILE), { builtFrom: owner, notes });
    return dir;
  };
  const recloned = indexIn("recloned");
  const regenerated = indexIn("regenerated");
  const other = indexIn("other");

  // Cloned again into the same folder: what git carries comes back with the
  // same bytes and new times; what the server wrote is gone.
  fs.rmSync(owner, { recursive: true, force: true });
  for (const relative of [...seed, ...own]) note(owner, relative, 1, text(relative));
  assert.equal(vaultIndexPath({ dir: recloned, vaultRoot: owner }).reason, "claimed", "a reinstall by a fresh clone keeps it");
  // Then setup writes them again, each with a new stamp.
  for (const relative of generated) note(owner, relative, 1, text(relative, "2026-10-12T00:00:00Z"));
  assert.equal(vaultIndexPath({ dir: regenerated, vaultRoot: owner }).reason, "claimed", "and so does one set up again since");
  // A copy of the seed is still not the vault: the owner's own notes are not there.
  assert.equal(vaultIndexPath({ dir: other, vaultRoot: seedCopy }).reason, "another-vault");
});

test("a claim that cannot be read is nobody's to share, and a folder that takes no claim keeps the old file", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`), "{ half a claim");
  for (const vault of ["vault-a", "vault-b"]) {
    assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, vault) }).reason, "another-vault", vault);
  }
  // A folder that cannot be made (a file is in the way): nothing to claim in.
  const blocked = path.join(root, "file");
  fs.writeFileSync(blocked, "");
  const unclaimed = vaultIndexPath({ dir: path.join(blocked, "index"), vaultRoot: path.join(root, "vault-a") });
  assert.deepEqual([unclaimed.path, unclaimed.reason], [path.join(blocked, "index", DEFAULT_INDEX_FILE), "unclaimed"]);
});

test("vaults starting at the same moment agree on one owner", async (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  const vaults = Array.from({ length: 8 }, (_, index) => {
    const vault = path.join(root, `racer-${index}`);
    fs.mkdirSync(vault);
    return vault;
  });
  // A URL, not a path: on Windows the loader refuses `C:\…` as a specifier.
  const owner = new URL("./search-index-owner.mjs", import.meta.url).href;
  const script = `const { vaultIndexPath } = await import(${JSON.stringify(owner)}); process.stdout.write(JSON.stringify(vaultIndexPath({ dir: process.argv[1], vaultRoot: process.argv[2] })));`;
  const answers = await Promise.all(vaults.map((vault) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, vault], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    // `close`, not `exit`: on Windows the pipe can still hold the answer when the process has exited.
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  })));
  const winners = answers.filter((answer) => answer.path === path.join(dir, DEFAULT_INDEX_FILE));
  assert.equal(winners.length, 1, JSON.stringify(answers));
  assert.equal(new Set(answers.map((answer) => answer.path)).size, vaults.length, "one file per vault");
  assert.equal(new Set(answers.map((answer) => answer.owner)).size, 1, "every one names the same owner");
  assert.deepEqual(fs.readdirSync(dir), [`${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`], "no draft is left behind");
});
