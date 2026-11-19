import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectDocuments,
  collectDocumentsYielding,
  createDocumentCache,
  denseDocRecords,
  densePassageText,
  firstHeading,
  inferScope,
  parseProjectPath,
  pythonPath,
  sourceFingerprint
} from "./search-documents.mjs";

const symlinks = process.platform !== "win32";

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** A small vault that exercises every rule of the collector. */
function buildVault(root) {
  write(root, "00-inbox/Welcome.md", "\ufeff# Welcome\r\n\r\nFirst  line\twith   spaces.\rSecond line.\r\n");
  write(root, "02-knowledge/Projects/Projects Index.md", "Index of projects\n");
  write(root, "04-agent-workflows/flow.md", "No heading here\n## Not a title\n#\u00a0\tTabbed heading  \n# Second\n");
  write(root, "07-quality-gates/gate.md", "#   \n# Gate\nbody");
  write(root, "notes/my qa list.md", "qa things");
  write(root, "notes/aqa.md", "#NoSpace\nnot a heading");
  write(root, "notes/UPPER.MD", "# Upper\n\x1cfile separator\x1dline\u2028para\u2029end\x85next");
  write(root, "notes/emoji.md", `# Emoji\n${"\u{1F600} smile ".repeat(60)}`);
  write(root, "notes/invalid.md", Buffer.from([0x23, 0x20, 0x41, 0xc0, 0x80, 0x0a, 0x62, 0xed, 0xa0, 0x80]));
  write(root, "03-skills-catalog/cards/card.md", "# Card\ncontent");
  write(root, "03-skills-catalog/sources/x/SKILL.md", "# Skipped source");
  write(root, "03-skills-catalog/Registries/upper.md", "# Skipped, case-insensitively");
  write(root, "03-skills-catalog/groups/all-skills/a.md", "# Skipped group");
  write(root, "09-mcp/search-index/x.md", "# Skipped index file");
  write(root, "node_modules/pkg/readme.md", "# Skipped dir");
  write(root, ".obsidian/x.md", "# Skipped dir");
  write(root, "notes/not-markdown.txt", "# ignored");
  write(root, "03-skills-catalog/registries/skills.index.json", JSON.stringify([
    { name: "alpha", source: "custom", type: "workflow", categories: ["a", "b"], description: "Alpha skill.", use_when: "When alpha.",
      quality_score: 87, skill_schema_version: 2, requires: ["git"], path: "sources/custom/alpha/SKILL.md", subgroups: ["x", 1], maturity: "reviewed" },
    { name: "", source: "external/membrane", categories: "abc", description: "", path: "", conflicts: [], quality_score: null },
    { name: "beta", source: "design", quality_score: 0, related_skills: ["alpha"], frameworks: { react: true }, compatibility: "Node 22", path: "sources/design/beta/" }
  ]).replace('"quality_score":87', '"quality_score":87.0'));
  if (symlinks) {
    fs.symlinkSync(path.join(root, "notes"), path.join(root, "linked"), "dir");
    fs.symlinkSync(path.join(root, "00-inbox", "Welcome.md"), path.join(root, "notes", "alias.md"));
  }
}

// What `search-index/search_cli.py` collected from the same vault:
// [path, scope, title, source, categories, id, content_hash].
const PYTHON_DOCS = [
  ["02-knowledge/Projects/Projects Index.md", "projects", "Projects Index", "vault-note", "", "54ac17c6313c6a3bae347a6ebf0f6667ecaf64b7", "26dd0b6b2a7d7e45f1754ec52f9044bb80d1397b9afe121b7bfa0ecd8e0a7805"],
  ["04-agent-workflows/flow.md", "workflows", "Tabbed heading", "vault-note", "", "bcdea77b350ce309904fa099ee3db63a56f414de", "68f7f6694be5daf05efef5d6dbdd867e98a364f968c171663b9188742392e6fa"],
  ["notes/aqa.md", "knowledge", "aqa", "vault-note", "", "ac6652b246ff150982d4fc4927197e7fdb41db35", "d12d94e85edd1233f94273d66c93940c09646dfc7899c1f07bc574ec8eee6792"],
  ["notes/alias.md", "knowledge", "Welcome", "vault-note", "", "8158a94bc62589da8c2d4c7dceaf8a5b4c79d3f5", "085a1ee8fd4c1953d08dcdfd3d0ff471fdb2dcaaab4eb405d2357bcef01f6f49"],
  ["notes/my qa list.md", "quality", "my qa list", "vault-note", "", "93b85b187cc4acaf42960b3fd7c231e3fe7e9f42", "e7417333a2d6f77af412b313c2847931e650226d6c2a1e93664b1e1c9ce331c8"],
  ["notes/UPPER.MD", "knowledge", "Upper", "vault-note", "", "38bbe4cde2c5d1d9c5c02eb927b9658f273d7b15", "a50c1cade3a32b6d4ddbf92faff464e2973240175b4091feec676d0eced5a2b7"],
  ["notes/emoji.md", "knowledge", "Emoji", "vault-note", "", "02bd93fd361a3b4fb188555599031f139ca04d7e", "b676ebea99669a838d4000afb9965db6df51f3861facf7ab1ec3b602007190c1"],
  ["notes/invalid.md", "knowledge", "A\ufffd\ufffd", "vault-note", "", "4db1693e2a633877ddfc3d9c4e4275511aa676cb", "0f9e244b24e446833cfcc54211937e95dcec159db4124d51e66f45df397c1fec"],
  ["00-inbox/Welcome.md", "knowledge", "Welcome", "vault-note", "", "cd340d0b03a3bf4b21b9cc5500b539e8f2c11cef", "929fb99d929c53f0cf802cd1c72d203ec0909613263cc537c05c5fe0b4c61960"],
  ["03-skills-catalog/cards/card.md", "skills", "Card", "vault-note", "", "33848d89e429fd4e6bddd008a621348acc1dc820", "778270c2708445863b2bc1d4adcf2b2b7c307cc6901b1ccbf7826bea6c52af35"],
  ["07-quality-gates/gate.md", "quality", "Gate", "vault-note", "", "1757f4ffffa91631d705de16d753456b682547a2", "75b8b66e12ee5f83de96bac41d774e4916bc7b3d76a2a402b9f094c0be55f11e"],
  ["03-skills-catalog/sources/custom/alpha/SKILL.md", "skills", "alpha", "custom", "a, b", "a10e9c9907299dbfb55b44b14018d969a28839cb", "16fbfd2a4af5e0593384ca12d2d19c268dc20f0aadecb2a64ade08acdf0b61b5"],
  ["03-skills-catalog", "skills", "unnamed-skill", "external/membrane", "a, b, c", "2b5d277737f8a2e4ee09d8eba935eff94c0ba570", "a56734ae23d1f3fdc096d67c00577d3c19a44b2e775f6332b0663a8c57b33663"],
  ["03-skills-catalog/sources/design/beta", "skills", "beta", "design", "", "b401eb49a73d883bae482c1d16624ed3ce26af92", "c653fb37b1fa4fb574e658f92dd90539c243095fd6503c7ba177778b360e81cf"]
];
const PYTHON_FINGERPRINT = "1f14c879fdb9429993cd07360c8c2525a4d9284faf7c4f03fdac2b738c063f0a";

test("documents, ids and hashes are the ones the Python helper collected", { skip: !symlinks && "the fixture has symlinks" }, (t) => {
  const root = tempRoot(t, "search-docs-");
  buildVault(root);
  const { docs, duplicates } = collectDocuments({ vaultRoot: root, includeExternalProjectFiles: false });
  assert.equal(duplicates, 0);
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  assert.equal(docs.length, PYTHON_DOCS.length, [...byPath.keys()].join("\n"));
  for (const [docPath, scope, title, source, categories, id, contentHash] of PYTHON_DOCS) {
    const doc = byPath.get(docPath);
    assert.ok(doc, `missing ${docPath}`);
    assert.deepEqual([doc.scope, doc.title, doc.source, doc.categories, doc.id, doc.content_hash], [scope, title, source, categories, id, contentHash], docPath);
  }
  assert.equal(sourceFingerprint(docs), PYTHON_FINGERPRINT);
});

test("text is read as Python reads it, and previews are cut by characters", { skip: !symlinks && "the fixture has symlinks" }, (t) => {
  const root = tempRoot(t, "search-docs-");
  buildVault(root);
  const byPath = new Map(collectDocuments({ vaultRoot: root, includeExternalProjectFiles: false }).docs.map((doc) => [doc.path, doc]));
  const welcome = byPath.get("00-inbox/Welcome.md");
  assert.equal(welcome.body, "# Welcome\n\nFirst  line\twith   spaces.\nSecond line.\n", "BOM dropped, CRLF and CR read as LF");
  assert.equal(welcome.preview, "# Welcome First line with spaces. Second line.");
  assert.equal(byPath.get("notes/invalid.md").body, "# A\ufffd\ufffd\nb\ufffd\ufffd\ufffd");
  assert.equal(byPath.get("notes/UPPER.MD").preview, "# Upper file separator line para end next");
  const emoji = byPath.get("notes/emoji.md").preview;
  assert.equal([...emoji].length, 360);
  assert.ok(emoji.endsWith("ile \u{1F600} smile \u{1F600} smile "), JSON.stringify(emoji.slice(-20)));
  const alpha = byPath.get("03-skills-catalog/sources/custom/alpha/SKILL.md");
  assert.equal(alpha.preview, "alpha custom workflow x 1 reviewed quality score 87.0 skill schema 2 a, b Alpha skill. When alpha. git sources/custom/alpha/SKILL.md");
  assert.equal(byPath.get("03-skills-catalog/sources/design/beta").preview, "beta design alpha react quality score 0 Node 22 sources/design/beta/");
});

test("skipped folders, other files and symlinked folders stay out", { skip: !symlinks && "the fixture has symlinks" }, (t) => {
  const root = tempRoot(t, "search-docs-");
  buildVault(root);
  const paths = collectDocuments({ vaultRoot: root, includeExternalProjectFiles: false }).docs.map((doc) => doc.path);
  for (const unwanted of ["sources/x", "Registries", "all-skills", "09-mcp", "node_modules", ".obsidian", "not-markdown", "linked/"]) {
    assert.ok(!paths.some((docPath) => docPath.includes(unwanted)), unwanted);
  }
});

test("a file that cannot be read is skipped, not fatal (\u0414-115)", { skip: !symlinks && "needs symlinks" }, (t) => {
  const root = tempRoot(t, "search-docs-");
  write(root, "notes/kept.md", "# Kept");
  fs.symlinkSync(path.join(root, "missing.md"), path.join(root, "notes", "broken.md"));
  fs.mkdirSync(path.join(root, "02-knowledge", "Projects", "archive.md"), { recursive: true });
  const { docs } = collectDocuments({ vaultRoot: root });
  assert.deepEqual(docs.map((doc) => doc.path), ["notes/kept.md"]);
});

test("project files come from the repository a card points at", (t) => {
  const vault = tempRoot(t, "search-vault-");
  const project = fs.realpathSync(tempRoot(t, "search-project-"));
  write(project, ".ai-dev/project-brief.md", "# Brief\nWhat it is.");
  write(project, ".ai-dev/quality-gate.md", "# Gate");
  write(project, "AGENTS.md", "# Agents");
  write(vault, "02-knowledge/Projects/one.md", `---\nproject_path: "${project}"\n---\n# One\n`);
  write(vault, "02-knowledge/Projects/Projects Index.md", `- Root: \`${project}\``);
  write(vault, "02-knowledge/Projects/relative.md", "project_path: some/where\n");
  write(vault, "02-knowledge/Projects/missing.md", `project_path: ${path.join(project, "gone")}\n`);
  const { docs } = collectDocuments({ vaultRoot: vault });
  const files = docs.filter((doc) => doc.source !== "vault-note");
  assert.deepEqual(files.map((doc) => doc.source), ["project-brief", "project-quality-gate", "project-agents"]);
  const brief = files[0];
  assert.equal(brief.scope, "projects");
  assert.equal(brief.title, `${path.basename(project)} / .ai-dev/project-brief.md`);
  assert.equal(brief.path, `${project}${path.sep}${path.join(".ai-dev", "project-brief.md")}`);
  assert.equal(brief.categories, "project, handoff");
  assert.equal(brief.preview, "# Brief What it is.");
});

test("two cards for one project give each file once (\u0414-114)", (t) => {
  const vault = tempRoot(t, "search-vault-");
  const project = fs.realpathSync(tempRoot(t, "search-project-"));
  write(project, "AGENTS.md", "# Agents");
  write(vault, "02-knowledge/Projects/one.md", `project_path: "${project}"\n`);
  write(vault, "02-knowledge/Projects/two.md", `- Repository path: \`${project}\`\n`);
  const { docs, duplicates } = collectDocuments({ vaultRoot: vault });
  assert.equal(docs.filter((doc) => doc.source === "project-agents").length, 1);
  assert.equal(duplicates, 1);
  assert.equal(new Set(docs.map((doc) => doc.id)).size, docs.length);
});

test("a project file that resolves outside its project is left out", { skip: !symlinks && "needs symlinks" }, (t) => {
  const vault = tempRoot(t, "search-vault-");
  const project = fs.realpathSync(tempRoot(t, "search-project-"));
  const outside = write(tempRoot(t, "search-outside-"), "secret.md", "# Not the project's");
  fs.symlinkSync(outside, path.join(project, "AGENTS.md"));
  write(vault, "02-knowledge/Projects/one.md", `project_path: ${project}\n`);
  assert.equal(collectDocuments({ vaultRoot: vault }).docs.filter((doc) => doc.source !== "vault-note").length, 0);
});

test("paths print as pathlib prints them", () => {
  const posix = (value) => {
    const { text, name, absolute } = pythonPath(value, "linux");
    return [text, absolute, name];
  };
  assert.deepEqual(posix("/a//b/./c/"), ["/a/b/c", true, "c"]);
  assert.deepEqual(posix("//a/b"), ["//a/b", true, "b"]);
  assert.deepEqual(posix("///a"), ["/a", true, "a"]);
  assert.deepEqual(posix("a/../b"), ["a/../b", false, "b"]);
  assert.deepEqual(posix("/"), ["/", true, ""]);
  assert.deepEqual(posix(""), [".", false, ""]);
  const windows = (value) => {
    const { text, name, absolute } = pythonPath(value, "win32");
    return [text, absolute, name];
  };
  assert.deepEqual(windows("C:/Users/x/proj/"), ["C:\\Users\\x\\proj", true, "proj"]);
  assert.deepEqual(windows("C:\\Users\\x\\.\\proj"), ["C:\\Users\\x\\proj", true, "proj"]);
  assert.deepEqual(windows("C:proj"), ["C:proj", false, "proj"]);
  assert.deepEqual(windows("\\\\server\\share\\p"), ["\\\\server\\share\\p", true, "p"]);
  assert.deepEqual(windows("/abs/unix"), ["\\abs\\unix", false, "unix"]);
  assert.deepEqual(windows("c:\\"), ["c:\\", true, ""]);
});

test("headings, scopes and project paths follow the helper's rules", () => {
  assert.equal(firstHeading("intro\n#\u00a0Title  \n# Later", "fallback"), "Title");
  assert.equal(firstHeading("#Title\n##  Sub", "fallback"), "fallback");
  assert.equal(firstHeading("#   \n", "fallback"), "fallback");
  assert.equal(inferScope("02-knowledge/projects/x.md"), "projects");
  assert.equal(inferScope("06-prompts/x.md"), "workflows");
  assert.equal(inferScope("notes/release-gate.md"), "quality");
  assert.equal(inferScope("notes/QA.md"), "quality");
  assert.equal(inferScope("notes/aqa.md"), "knowledge");
  assert.equal(inferScope("03-skills-catalog/cards/x.md"), "skills");
  assert.equal(parseProjectPath("x\nproject_path:\n  \"/a/b\" \n"), "/a/b");
  assert.equal(parseProjectPath("- Real git root: `/r`\n- Root: `/s`"), "/r");
  assert.equal(parseProjectPath("project_path: \"\"\n- ROOT:   `/s`"), "/s");
  assert.equal(parseProjectPath("nothing here"), "");
});

test("a status cache answers from stats, without bodies, and sees every change", (t) => {
  const root = tempRoot(t, "search-docs-");
  const old = new Date(Date.now() - 3_600_000);
  const note = write(root, "notes/a.md", "# A\none");
  write(root, "notes/b.md", "# B");
  for (const file of ["notes/a.md", "notes/b.md"]) fs.utimesSync(path.join(root, file), old, old);
  // utimes sets ctime to now; a clock an hour on puts both times out of the window.
  const cache = createDocumentCache({ now: () => Date.now() + 3_600_000 });
  const first = collectDocuments({ vaultRoot: root, cache }).docs;
  assert.equal(first[0].body, undefined, "a status check needs no bodies");
  assert.equal(cache.entries.size, 2);
  const again = collectDocuments({ vaultRoot: root, cache }).docs;
  assert.deepEqual(again.map((doc) => doc.content_hash), first.map((doc) => doc.content_hash));
  assert.equal(again[0], first[0], "served from the cache");
  fs.writeFileSync(note, "# A\ntwo");
  fs.utimesSync(note, old, old);
  fs.rmSync(path.join(root, "notes", "b.md"));
  const changed = collectDocuments({ vaultRoot: root, cache }).docs;
  assert.equal(changed.length, 1);
  assert.notEqual(changed[0].content_hash, first.find((doc) => doc.path === "notes/a.md").content_hash);
  assert.equal(cache.entries.size, 1, "a deleted file leaves the cache");
  const uncached = collectDocuments({ vaultRoot: root }).docs;
  assert.equal(uncached[0].content_hash, changed[0].content_hash);
  assert.equal(uncached[0].body, "# A\ntwo");
});

test("a cached status reads a project card as a card, though it is a note as well", (t) => {
  const vault = tempRoot(t, "search-vault-");
  const project = fs.realpathSync(tempRoot(t, "search-project-"));
  write(project, "AGENTS.md", "# Agents");
  const card = write(vault, "02-knowledge/Projects/one.md", `project_path: "${project}"\n# One\n`);
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(card, old, old);
  fs.utimesSync(path.join(project, "AGENTS.md"), old, old);
  const cache = createDocumentCache();
  const uncached = collectDocuments({ vaultRoot: vault }).docs.map((doc) => [doc.path, doc.content_hash]);
  for (let round = 0; round < 3; round += 1) {
    const cached = collectDocuments({ vaultRoot: vault, cache }).docs.map((doc) => [doc.path, doc.content_hash]);
    assert.deepEqual(cached, uncached, `round ${round}`);
  }
  assert.equal(uncached.length, 2, "the card as a note, and the project's AGENTS.md");
});

test("a file written just now is not trusted by its stat", (t) => {
  const root = tempRoot(t, "search-docs-");
  write(root, "notes/fresh.md", "# Fresh");
  const cache = createDocumentCache();
  collectDocuments({ vaultRoot: root, cache });
  assert.equal(cache.entries.size, 0);
});

test("an old mtime put back on a file changed just now does not make it trusted: ctime counts too", (t) => {
  // Same size, old mtime restored: only ctime tells this file from the one
  // cached a moment ago, and where ctime moves in coarse ticks a cached entry
  // keyed on it could match the new content. So a fresh ctime is not trusted.
  const root = tempRoot(t, "search-docs-");
  const note = write(root, "notes/a.md", "# A\none");
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(note, old, old);
  const cache = createDocumentCache();
  collectDocuments({ vaultRoot: root, cache });
  assert.equal(cache.entries.size, 0, "mtime an hour old, ctime now: not remembered");
  const later = createDocumentCache({ now: () => Date.now() + 3_600_000 });
  collectDocuments({ vaultRoot: root, cache: later });
  assert.equal(later.entries.size, 1, "once both are out of the window it is");
});

test("on Windows a linked folder is entered, as os.walk enters a junction, but not one into its own ancestry", { skip: !symlinks && "needs symlinks" }, (t) => {
  // Node reports an NTFS junction as a symlink; Python does not count it as
  // one and walks into it. Symlinks stand in for junctions here.
  const vault = tempRoot(t, "search-vault-");
  const elsewhere = tempRoot(t, "search-linked-");
  write(elsewhere, "linked.md", "# Linked\n\nA note in a folder linked into the vault.");
  write(vault, "02-knowledge/own.md", "# Own");
  fs.symlinkSync(elsewhere, path.join(vault, "02-knowledge", "linked"), "junction");
  fs.symlinkSync(path.join(vault, "02-knowledge"), path.join(vault, "02-knowledge", "loop"), "junction");
  write(vault, "03-skills-catalog/registries/skills.index.json", "[]");
  const paths = (platform) => collectDocuments({ vaultRoot: vault, platform }).docs.map((doc) => doc.path).sort();
  assert.deepEqual(paths("win32"), ["02-knowledge/linked/linked.md", "02-knowledge/own.md"], "the linked note once, and no loop");
  assert.deepEqual(paths("linux"), ["02-knowledge/own.md"], "elsewhere a symlinked folder stays out, as os.walk leaves it");
});

test("on Windows a junction to a folder of the vault never takes that folder's notes away", { skip: !symlinks && "needs symlinks" }, (t) => {
  for (const [real, link] of [
    ["02-knowledge/deep/target", "02-knowledge/link"],
    ["02-knowledge/aaa-real", "02-knowledge/zzz-link"],
    ["02-knowledge/zzz-real", "02-knowledge/aaa-link"]
  ]) {
    const vault = tempRoot(t, "search-vault-");
    write(vault, `${real}/note.md`, "# Note\n\nLives in the real folder.");
    write(vault, "03-skills-catalog/registries/skills.index.json", "[]");
    fs.symlinkSync(path.join(vault, real), path.join(vault, link), "junction");
    const paths = (platform) => collectDocuments({ vaultRoot: vault, platform }).docs.map((doc) => doc.path).sort();
    assert.deepEqual(paths("win32"), [`${link}/note.md`, `${real}/note.md`].sort(), `${link} -> ${real}: both paths, as os.walk indexes them`);
    assert.deepEqual(paths("linux"), [`${real}/note.md`]);
  }
});

test("dense passages and their hashes are the helper's", { skip: !symlinks && "the fixture has symlinks" }, (t) => {
  const root = tempRoot(t, "search-docs-");
  buildVault(root);
  const { docs } = collectDocuments({ vaultRoot: root, includeExternalProjectFiles: false });
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const expected = [
    ["00-inbox/Welcome.md", 1200, "46a0d6b01da978a1e524897584aa8424cd166b1c7a37366136848402ec0f2c37"],
    ["00-inbox/Welcome.md", 40, "3811cb468f8a3b43363266c56849ca708cd6b1c8f1ffea07151c56a8a001fcf4"],
    ["03-skills-catalog/sources/custom/alpha/SKILL.md", 1200, "f22cbc4c8f4cdb38b8b5cf2db01012cb3f0bfb0f6b5d929c04f764369d9725ca"],
    ["03-skills-catalog/sources/custom/alpha/SKILL.md", 40, "75e46321457c171633f7f5ea3525595f5509d99a3f29bf25d81454f4ae008deb"],
    ["notes/emoji.md", 1200, "b4a06615302641c1ee824af3419553d7fa5d078e03ede88f800355afcda6db92"],
    ["notes/emoji.md", 40, "c2acf70f2cb6070bfc969e15786eb0e2fb45633dc726586ed4acbf50aaba2dc4"]
  ];
  for (const [docPath, limit, hash] of expected) {
    const [record] = denseDocRecords([byPath.get(docPath)], { textLimit: limit });
    assert.equal(record.content_hash, hash, `${docPath} @ ${limit}`);
  }
  assert.equal(densePassageText(byPath.get("00-inbox/Welcome.md"), 40), "passage: Title: Welcome Scope: knowledge Source: ");
  assert.equal(denseDocRecords(docs).length, 13, "Membrane is left out");
  assert.equal(denseDocRecords(docs, { includeMembrane: true }).length, 14);
});

test("a rebuild's collection gives other work a turn and finds exactly what the plain one does", async (t) => {
  const root = tempRoot(t, "yield");
  buildVault(root);
  for (let index = 0; index < 300; index += 1) write(root, `02-knowledge/many/note-${index}.md`, `# Note ${index}\n\nbody ${index}\n`);
  const plain = collectDocuments({ vaultRoot: root });
  // Other work that waits for its turn as the collection gives it: a timer
  // counted milliseconds instead, of which a fast runner took only ten.
  let turns = 0;
  let reading = true;
  const other = () => {
    if (!reading) return;
    turns += 1;
    setImmediate(other);
  };
  setImmediate(other);
  const yielding = await collectDocumentsYielding({ vaultRoot: root }, { sliceMs: 0 });
  reading = false;
  assert.deepEqual(yielding.docs.map((doc) => [doc.id, doc.content_hash]), plain.docs.map((doc) => [doc.id, doc.content_hash]));
  assert.equal(yielding.duplicates, plain.duplicates);
  assert.ok(plain.docs.length > 300);
  assert.ok(turns > 10, `another task ran ${turns} times while the vault was read`);
});
