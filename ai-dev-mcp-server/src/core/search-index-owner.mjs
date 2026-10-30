/**
 * Which search index file a vault reads and writes.
 *
 * A runtime home keeps one index directory. Until 3.0 every vault served from
 * it wrote the same `ai-dev-search.sqlite`, and nothing in the file said which
 * vault it was built from: two clients with different `AI_DEV_VAULT_ROOT` took
 * turns rebuilding it, and a search in one vault answered with the notes of
 * the other.
 *
 * The file now belongs to one vault, named by a claim beside it,
 * `ai-dev-search.sqlite.vault`, made in one step that only one process can
 * win; every other vault keeps an index of its own beside it,
 * `ai-dev-search-<12 hex of its root>.sqlite`. An index written before claims
 * existed goes only to the vault it was built from — the one its `meta` names,
 * or, for a 2.x index that names none, the one whose notes are the ones it
 * indexed, untouched or all there with the same content — so after an upgrade
 * the vault that has been using it keeps it, with its vectors, whichever
 * process starts first: a command run from a shell with a vault holding only
 * some of those notes does not take it. A copy of the whole vault cannot be
 * told from it, and takes it only by starting first.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isGeneratedVaultFile } from "./generated-vault-files.mjs";
import { noteIdentity } from "./search-documents.mjs";
import { loadSqlite, sqliteSupport } from "./search-sqlite.mjs";
import { canonicalFolder } from "./session-env.mjs";

/** The index file a runtime home has always had. */
export const DEFAULT_INDEX_FILE = "ai-dev-search.sqlite";

/** What names the vault an index file belongs to: `<index file><suffix>`. */
export const CLAIM_SUFFIX = ".vault";

/**
 * The vault a claim names, or null when there is no claim or it is unreadable.
 *
 * @param {string} claimFile
 * @returns {string | null} the vault root as it was claimed
 */
function readClaim(claimFile) {
  try {
    const vault = JSON.parse(fs.readFileSync(claimFile, "utf8"))?.vault_root;
    return typeof vault === "string" && vault ? vault : null;
  } catch {
    return null;
  }
}

/**
 * Claim `claimFile` for `vaultRoot`, unless another process has: the claim is
 * written whole under another name and then linked into place, which fails
 * when the name exists — so a claim is never seen half written.
 *
 * @returns {"claimed" | "taken" | "unwritable"}
 */
function claim(claimFile, vaultRoot) {
  const body = `${JSON.stringify({ vault_root: vaultRoot, claimed_at: new Date().toISOString() })}\n`;
  const draft = `${claimFile}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });
    fs.writeFileSync(draft, body, { flag: "wx", mode: 0o600 });
  } catch {
    return "unwritable";
  }
  try {
    fs.linkSync(draft, claimFile);
    return "claimed";
  } catch (error) {
    if (error?.code === "EEXIST") return "taken";
    // A file system without hard links: create it exclusively instead.
    try {
      fs.writeFileSync(claimFile, body, { flag: "wx", mode: 0o600 });
      return "claimed";
    } catch (fallback) {
      return fallback?.code === "EEXIST" ? "taken" : "unwritable";
    }
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

/** How many of an index's notes are looked at in a vault to tell whether it was built from it. */
const SAMPLE_NOTES = 200;

/**
 * Which vault an index file not yet claimed was built from, as far as it
 * says: `this`, `another`, or `unknown` — no documents to tell by, or not an
 * index at all, which the search runtime sets aside and builds again.
 *
 * @param {string} file
 * @param {string} vaultRoot
 * @param {(left: string, right: string) => boolean} same
 * @returns {"this" | "another" | "unknown"}
 */
export function indexOrigin(file, vaultRoot, same) {
  if (!sqliteSupport().available) return "unknown";
  let db;
  try {
    db = new (loadSqlite().DatabaseSync)(file, { readOnly: true });
    const recorded = db.prepare("SELECT value FROM meta WHERE key = 'vault_root'").get()?.value;
    if (recorded) return same(String(recorded), vaultRoot) ? "this" : "another";
    // A 2.x index names no vault, only the notes it was built from: their
    // paths, content and modification times. That a path exists says nothing
    // — a vault sharing the skill catalog took the index that way
    // — so only notes count, the sample spread over
    // the table by id, and every note of the sample counts: one missing here
    // counts against, as one changed does. Not the notes the server
    // writes itself — skill and project cards, group notes, dashboards: a
    // clone does not carry them and each generation writes them anew, so
    // they say nothing of whose vault it is.
    const notes = db.prepare("SELECT path, mtime, content_hash FROM documents WHERE source = 'vault-note' ORDER BY id").all()
      .filter((row) => {
        const relative = String(row.path ?? "");
        return relative && !path.isAbsolute(relative) && !path.win32.isAbsolute(relative) && !isGeneratedVaultFile(relative, { ignoreCase: true });
      })
      .slice(0, SAMPLE_NOTES);
    if (!notes.length) return "unknown";
    let identical = 0;
    let unchanged = 0;
    for (const row of notes) {
      const note = noteIdentity(vaultRoot, String(row.path));
      if (!note || note.contentHash !== row.content_hash) continue;
      identical += 1;
      if (Math.abs(note.mtime - Number(row.mtime)) < 1e-6) unchanged += 1;
    }
    // The vault it was built from: at least half of the sample is the very
    // files it indexed, untouched since — a pull rewrites only what it
    // changes — or every note of it is here with the same content, as after
    // a clone into the same folder or files written again with the same
    // bytes. A vault holding only part of them — a copy of the seed beside
    // notes of the owner's own, a note or two copied over with their times —
    // is another, whichever way they came. A copy of the whole vault cannot be
    // told from it: whichever starts first takes the index, which is right
    // for its notes, and the other builds its own.
    return unchanged * 2 >= notes.length || identical === notes.length ? "this" : "another";
  } catch {
    return "unknown";
  } finally {
    db?.close();
  }
}

/**
 * The index file of `vaultRoot` in `dir`.
 *
 * @param {object} options
 * @param {string} options.dir - The index directory (`AI_DEV_SEARCH_INDEX_DIR`, or the runtime home's).
 * @param {string} options.vaultRoot
 * @param {string} [options.platform]
 * @returns {{ path: string, owner: string, reason: "own" | "claimed" | "another-vault" | "unclaimed" }}
 *   `owner`: the vault the default file belongs to, as claimed; `unclaimed`:
 *   no claim could be written here — a read-only directory — so the default
 *   file is used as before.
 */
export function vaultIndexPath({ dir, vaultRoot, platform = process.platform, origin = indexOrigin }) {
  const defaultFile = path.join(dir, DEFAULT_INDEX_FILE);
  const claimFile = `${defaultFile}${CLAIM_SUFFIX}`;
  const mine = canonicalFolder(vaultRoot, platform);
  const same = (left, right) => canonicalFolder(left, platform) === canonicalFolder(right, platform);
  const ownFile = () => path.join(dir, `ai-dev-search-${crypto.createHash("sha256").update(mine).digest("hex").slice(0, 12)}.sqlite`);
  let owner = readClaim(claimFile);
  let reason = "own";
  if (owner === null) {
    // A claim that cannot be read is nobody's to share: the default file stays
    // with whoever wrote it, and this vault keeps its own.
    if (fs.existsSync(claimFile)) return { path: ownFile(), owner: "", reason: "another-vault" };
    // An index from before claims, built from another vault, is left to it.
    if (fs.existsSync(defaultFile) && origin(defaultFile, vaultRoot, same) === "another") {
      return { path: ownFile(), owner: "", reason: "another-vault" };
    }
    const outcome = claim(claimFile, path.resolve(vaultRoot));
    if (outcome === "unwritable") return { path: defaultFile, owner: "", reason: "unclaimed" };
    owner = outcome === "claimed" ? path.resolve(vaultRoot) : readClaim(claimFile);
    if (outcome === "claimed") reason = "claimed";
  }
  if (owner !== null && same(owner, vaultRoot)) return { path: defaultFile, owner, reason };
  return { path: ownFile(), owner: owner ?? "", reason: "another-vault" };
}
