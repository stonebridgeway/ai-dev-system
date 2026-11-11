#!/usr/bin/env node
/**
 * `npm run upgrade:test` — does a 2.x install keep working after an upgrade?
 *
 * The test installs the production 2.x line from a commit (default `86aba56`,
 * production `main` when work on 3.0 started) into a git worktree, uses
 * the 2.x server to create the state a real user has — a task with a
 * checkpoint, a decision, an instinct, a session handoff, the search index,
 * agent hooks in a repository, client configurations in both 2.x formats — and
 * then upgrades that same checkout to the working tree in front of it the way a
 * user does: `git pull` (here: a copy of the tracked and untracked files) and
 * `npm ci`. The current server is then started through the command the 2.x
 * client configuration holds, and has to find all of it.
 *
 * Each user's 2.x index also carries dense vectors, written by the 2.x helper
 * the way its ONNX path writes real ones (`dense-plan`, then `rebuild
 * --dense-vectors-json`), from synthetic numbers since no model is needed to
 * check that they survive: the upgraded server must find the index current
 * without rebuilding it, keep every vector byte for byte through a refresh, and
 * search it.
 *
 * Five users are simulated: one with the defaults; one who set
 * `AI_DEV_HOME`, whose 2.x data sits one level deeper than documented
 * and must be migrated without loss; the layout of
 * the Docker image's /data volume — `AI_DEV_HOME` under the home plus explicit
 * state, index and artifact roots, the environment the Dockerfile sets — run
 * here without a container; and one on the Python dense backend 3.0 removed,
 * whose index holds the Python backend's vectors and whose
 * client config still says `AI_DEV_DENSE_BACKEND=python`: told what replaced
 * it, nothing of the index lost, and moved over by the one command; and one
 * who came from the Codex desktop runtime, whose 2.x server kept its state in
 * `~/.codex/state/ai-dev-system` while the hooks wrote to `~/.ai-dev/state`:
 * moved into `~/.ai-dev` once, with a record of it,
 * and seen by the 2.x hook from then on.
 *
 * Then each goes back the way `docs/MIGRATION.md` gives for a clone
 * (`upgrade-way-back.mjs`): `ai-dev clients remove`, 2.x's own client install
 * from a checkout of the base, and the 2.x server that entry starts finds the
 * task and searches the index 3.0 left.
 *
 * The container half itself — pulling the 2.x image, keeping its volume, the
 * launchers the clients hold — cannot run where the published image is not
 * pullable; `docs/UPGRADE-TEST.md` describes it for CI.
 *
 * Usage: npm run upgrade:test [-- --base <commit>] [--keep]
 *
 * Not named `upgrade-test.mjs`: `node --test` picks up `*-test.mjs` by its own
 * patterns, and every `npm test` ran this whole scenario as a unit test.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolvePythonCommand } from "../src/core/python-command.mjs";
import { openDatabase, sqliteSupport } from "../src/core/search-sqlite.mjs";
import { writeSyntheticModel } from "../src/core/synthetic-model.mjs";
import { startModelHost } from "../test/fixtures/model-host.mjs";
import { call, check, checks, makeRepository, npm, readJson, run, runAsync, withServer } from "./upgrade-harness.mjs";
import { checkoutBase, verifyWayBack } from "./upgrade-way-back.mjs";

export const DEFAULT_BASE_COMMIT = "86aba56";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(serverRoot, "..");

function parseArgs(argv) {
  const options = { base: DEFAULT_BASE_COMMIT, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") options.base = String(argv[++index] || "");
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.base) throw new Error("--base needs a commit.");
  return options;
}

/**
 * Make `target` hold exactly what the working tree at `source` holds — the
 * files git tracks plus the untracked ones it does not ignore — the way
 * `git pull` would leave a clone. Ignored files in `target` (node_modules, the
 * generated seed registries) stay, as they do for a user.
 */
async function syncWorkingTree(source, target) {
  const list = (cwd, extra) => run("git", ["-C", cwd, "ls-files", "-z", "--cached", ...extra])
    .stdout.split("\0").filter(Boolean);
  const wanted = new Set(list(source, ["--others", "--exclude-standard"]).filter((relative) => existsSync(path.join(source, relative))));
  // Like `git pull`: files the old revision tracked and the new one does not
  // are removed; untracked files of the user's own are left alone.
  for (const relative of list(target, [])) {
    if (!wanted.has(relative)) await fs.rm(path.join(target, relative), { force: true });
  }
  let changed = 0;
  for (const relative of wanted) {
    const from = path.join(source, relative);
    const destination = path.join(target, relative);
    // Like git, a file the pull does not change is not written: it keeps its
    // modification time, by which a 2.x index knows its vault.
    const content = await fs.readFile(from);
    const before = await fs.readFile(destination).catch(() => null);
    if (!before || !before.equals(content)) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
      changed += 1;
    }
    await fs.chmod(destination, (await fs.stat(from)).mode & 0o777);
  }
  return { files: wanted.size, changed };
}

function scenarioEnv(base, { home, aiDevHome, explicitRoots }) {
  // Every directory a client installer derives its target from, inside the
  // scenario's home: on Windows the 2.x installers write VS Code's and Claude
  // Desktop's configuration under APPDATA and LOCALAPPDATA, not under HOME.
  const env = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local")
  };
  for (const key of Object.keys(env)) {
    if (/^(AI_DEV_|BGE_M3_)/.test(key)) delete env[key];
  }
  delete env.XDG_CONFIG_HOME;
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  if (aiDevHome) env.AI_DEV_HOME = aiDevHome;
  if (explicitRoots) {
    // What docker/Dockerfile sets next to AI_DEV_HOME, in 2.x and now.
    env.AI_DEV_STATE_ROOT = path.join(aiDevHome, "state");
    env.AI_DEV_SEARCH_INDEX_DIR = path.join(aiDevHome, "cache", "search-index");
    env.AI_DEV_FRONTEND_QA_ARTIFACT_ROOT = path.join(aiDevHome, "artifacts", "frontend-qa");
  }
  return env;
}

/** Every file under `root`, relative to it; empty when it does not exist. */
async function listFiles(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}

/**
 * One hash over the stored dense vectors and their ids, with their count, and
 * the same per vector — id to the hash of its row; empty where this Node
 * cannot read the file.
 */
function denseDigest(indexPath) {
  if (!sqliteSupport().available || !existsSync(indexPath)) return { count: 0, digest: "", byId: new Map() };
  const db = openDatabase(indexPath);
  try {
    const hash = crypto.createHash("sha256");
    const byId = new Map();
    // 2.0.0 recorded no provenance; its vectors are the Python backend's, which is what 3.0 records for them.
    const provenance = db.prepare("PRAGMA table_info(dense_vectors)").all().some((column) => column.name === "backend");
    const rows = db.prepare(provenance
      ? "SELECT id, vector, backend, revision, dtype, content_hash FROM dense_vectors ORDER BY id"
      : "SELECT id, vector, 'python' AS backend, 'unpinned' AS revision, 'fp32' AS dtype, content_hash FROM dense_vectors ORDER BY id").all();
    for (const row of rows) {
      const head = `${row.id}\0${row.backend}\0${row.revision}\0${row.dtype}\0${row.content_hash}\0`;
      hash.update(head);
      hash.update(row.vector);
      byId.set(row.id, crypto.createHash("sha256").update(head).update(row.vector).digest("hex"));
    }
    return { count: rows.length, digest: hash.digest("hex"), byId };
  } finally {
    db.close();
  }
}

/** Documents in an index that get a dense vector: everything but Membrane's connectors. */
function denseEligibleDocuments(indexPath) {
  if (!sqliteSupport().available || !existsSync(indexPath)) return 0;
  const db = openDatabase(indexPath);
  try {
    return db.prepare("SELECT count(*) AS n FROM documents WHERE lower(source) NOT LIKE '%membrane%'").get().n;
  } finally {
    db.close();
  }
}

/**
 * The skills a checkout of the working tree no longer has that `base` had —
 * what `git pull` deletes from a 2.x clone's catalogue — by name.
 */
function removedSkills(base) {
  const listed = run("git", ["-C", repoRoot, "diff", "--name-only", "--diff-filter=D", base, "--", "docker/public-seed/03-skills-catalog/sources"]).stdout;
  return listed.split("\n").filter((line) => line.endsWith("/SKILL.md")).map((line) => ({
    name: path.basename(path.dirname(line)),
    // As the registry records it: relative to 03-skills-catalog.
    path: line.replace(/^docker\/public-seed\/03-skills-catalog\//, "")
  }));
}

/** Whether the pull changed anything under the seed at all. */
function seedChanged(base) {
  return run("git", ["-C", repoRoot, "diff", "--name-only", base, "--", "docker/public-seed"]).stdout.trim() !== "";
}

/**
 * How 2.x labelled the vectors it wrote: its ONNX path with the revision and
 * dtype its manifest pins — the model 3.0 still runs, so they are reused —
 * and its Python backend as "unpinned" fp32, another model's.
 */
function legacyProvenance(backend, baseRoot) {
  if (backend === "python") return ["--dense-backend", "python", "--dense-revision", "unpinned", "--dense-dtype", "fp32"];
  const pinned = JSON.parse(readFileSync(path.join(baseRoot, "ai-dev-mcp-server", "models", "bge-m3.manifest.json"), "utf8"));
  return ["--dense-backend", "onnx", "--dense-revision", pinned.revision, "--dense-dtype", pinned.dtype];
}

/**
 * Dense vectors in the 2.x index, written by the 2.x helper exactly as its
 * ONNX path — or its Python backend — writes them; the numbers are
 * synthetic, which is all a check of their survival needs.
 */
function seedLegacyVectors({ baseRoot, env, indexPath, backend = "onnx" }) {
  const helper = path.join(baseRoot, "search-index", "search_cli.py");
  const python = resolvePythonCommand({ env });
  const common = ["--vault-root", path.join(baseRoot, "docker", "public-seed"), "--index-path", indexPath, "--include-external-project-files"];
  if (!readFileSync(helper, "utf8").includes('"dense-plan"')) return seedSentenceTransformerVectors({ helper, python, common, env, indexPath });
  const provenance = legacyProvenance(backend, baseRoot);
  const plan = JSON.parse(run(python, [helper, "dense-plan", ...common, ...provenance], { env }).stdout);
  const vectors = plan.records.map((record, index) => ({
    id: record.id,
    content_hash: record.content_hash,
    vector: Array.from({ length: 1024 }, (_, position) => ((index * 7 + position) % 101) / 101 - 0.5)
  }));
  const file = path.join(path.dirname(indexPath), "upgrade-fixture-vectors.json");
  writeFileSync(file, JSON.stringify({ vectors }));
  try {
    const rebuilt = JSON.parse(run(python, [helper, "rebuild", ...common, "--dense-embeddings", "--dense-vectors-json", file, ...provenance], { env }).stdout);
    const stored = denseDigest(indexPath);
    return { vectors: rebuilt.dense_documents, digest: stored.digest, byId: stored.byId, backend };
  } finally {
    rmSync(file, { force: true });
  }
}

/** sentence-transformers as 2.0.0's helper calls it, with the synthetic numbers of the vectors above. */
const SENTENCE_TRANSFORMERS_STAND_IN = [
  "class SentenceTransformer:",
  "    def __init__(self, path, device=None):",
  "        self.path = path",
  "",
  "    def encode(self, texts, batch_size=8, normalize_embeddings=True, show_progress_bar=False):",
  "        return [[((index * 7 + position) % 101) / 101 - 0.5 for position in range(1024)] for index, _ in enumerate(texts)]",
  ""
].join("\n");

/**
 * 2.0.0's helper takes no vectors (`dense-plan` came with the ONNX path): it
 * embedded with sentence-transformers from a model folder itself. Here it
 * imports a stand-in, from a folder that holds the one file it looks for, so
 * its own rebuild writes the vectors as it wrote real ones — with no record of
 * the backend, revision or dtype, which later 2.x added.
 */
function seedSentenceTransformerVectors({ helper, python, common, env, indexPath }) {
  const standIn = path.join(path.dirname(indexPath), "upgrade-fixture-sentence-transformers");
  mkdirSync(path.join(standIn, "sentence_transformers"), { recursive: true });
  mkdirSync(path.join(standIn, "model"), { recursive: true });
  writeFileSync(path.join(standIn, "sentence_transformers", "__init__.py"), SENTENCE_TRANSFORMERS_STAND_IN);
  writeFileSync(path.join(standIn, "model", "pytorch_model.bin"), "");
  try {
    const rebuilt = JSON.parse(run(python, [helper, "rebuild", ...common, "--dense-embeddings", "--dense-model-dir", path.join(standIn, "model")], {
      env: { ...env, PYTHONPATH: standIn }
    }).stdout);
    const stored = denseDigest(indexPath);
    return { vectors: rebuilt.dense_documents, digest: stored.digest, byId: stored.byId, backend: "", provenance: false };
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}

/** Everything the 2.x server writes for one user, recorded so it can be found again. */
async function createLegacyState({ baseServer, env, project, denseBackend = "onnx" }) {
  return withServer({ command: process.execPath, args: [path.join(baseServer, "src", "server.mjs")], env, cwd: baseServer }, async (client) => {
    const begun = await call(client, "begin_task", { project_path: project, task: "Upgrade fixture: add CSV export" });
    const taskId = begun.task?.id || begun.task_id || begun.id;
    assert.ok(taskId, `begin_task returned no task id: ${JSON.stringify(begun).slice(0, 500)}`);
    await call(client, "checkpoint_task", { task_id: taskId, summary: "Wrote the exporter and its test.", changed_files: ["README.md"], snapshot: false });
    await call(client, "record_decision", { task_id: taskId, title: "Upgrade fixture decision", decision: "CSV is exported with a header row." });
    await call(client, "record_instinct", { project_path: project, trigger: "when exporting CSV for the upgrade fixture", action: "write a header row first" });
    await call(client, "save_session", { project_path: project, topic: "Upgrade fixture handoff", building: "A CSV export.", next_step: "Run verify_task." });
    await call(client, "install_agent_hooks", { project_path: project, targets: ["claude"] });
    const built = await call(client, "search_index_status", {});
    const dense = seedLegacyVectors({ baseRoot: path.resolve(baseServer, ".."), env, indexPath: built.index_path, backend: denseBackend });
    const status = await call(client, "search_index_status", {});
    assert.equal(Number(status.dense_documents), dense.vectors, "2.x reports the vectors it was given");
    const registry = await readJson(path.join(baseServer, "..", "docker", "public-seed", "03-skills-catalog", "registries", "skills.index.json"));
    return { taskId, documents: indexedDocuments(status), skills: registry.length, dense };
  });
}

function writeLegacyClientConfigs({ baseRoot, env, project }) {
  const baseServer = path.join(baseRoot, "ai-dev-mcp-server");
  run(process.execPath, [path.join(baseServer, "scripts", "install-local-mcp-clients.mjs"), "--apply"], { cwd: baseServer, env });
  run(process.execPath, [
    path.join(baseServer, "scripts", "install-docker-mcp-clients.mjs"), "--apply",
    "--home", env.HOME,
    "--launcher", path.join(baseRoot, "docker", process.platform === "win32" ? "run-mcp.ps1" : "run-mcp.sh"),
    "--image", "ghcr.io/stonebridgeway/ai-dev-system:latest",
    "--project-path", project,
    "--runtime-container", "ai-dev-system-runtime-1000",
    "--platform", process.platform === "win32" ? "win32" : "linux"
  ], { cwd: baseServer, env });
}

/** `search_index_status` names the count of what is in the index `indexed_document_count`. */
function indexedDocuments(status) {
  return Number(status?.indexed_document_count ?? 0);
}

/**
 * Notes of the user's own beside the seed's, as a 2.x user's vault has them:
 * what tells it from a copy of the seed.
 */
function ownNotesFolder(baseRoot) {
  return path.join(baseRoot, "docker", "public-seed", "02-knowledge", "upgrade-fixture");
}

async function writeOwnNotes(baseRoot) {
  const folder = ownNotesFolder(baseRoot);
  await fs.mkdir(folder, { recursive: true });
  for (const name of ["exporter", "csv-header", "handoff"]) {
    await fs.writeFile(path.join(folder, `${name}.md`), `# Upgrade fixture: ${name}\n\nA note of the user's own, written with 2.x.\n`, "utf8");
  }
}

async function verifyUpgradedScenario({ label, base, baseRoot, env, project, expected, aiDevHome, doubledBefore = [], pythonBackend = false, codex = false, temp }) {
  const cursor = await readJson(path.join(env.HOME, ".cursor", "mcp.json"));
  const local = cursor.mcpServers?.["ai-dev-system"];
  check(`${label}: the 2.x local client entry is still there`, local?.command && Array.isArray(local.args), JSON.stringify(local?.args ?? null));
  const docker = cursor.mcpServers?.["ai-dev"];
  check(`${label}: the 2.x Docker client entry still points at an existing launcher`, docker && existsSync(docker.args?.[0] ?? ""), docker?.args?.[0] ?? "missing");

  // Start the server exactly as the 2.x client configuration does.
  const serverEnv = { ...env, ...(local?.env || {}) };
  // But first a command from a shell with another vault — a copy of the same
  // seed, without this user's notes — the first to run after the upgrade: it
  // must leave the index this install's clients built to them.
  // It has to run: a refused option never reached
  // the index.
  const otherVault = path.join(temp, `other-vault-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`);
  const ownNotes = ownNotesFolder(baseRoot);
  await fs.cp(path.join(baseRoot, "docker", "public-seed"), otherVault, { recursive: true, filter: (source) => source !== ownNotes && !source.startsWith(`${ownNotes}${path.sep}`) });
  const doctor = run(process.execPath, [path.join(baseRoot, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "doctor"], {
    cwd: path.join(baseRoot, "ai-dev-mcp-server"),
    env: { ...serverEnv, AI_DEV_VAULT_ROOT: otherVault },
    allowFailure: true
  });
  check(`${label}: a command with another vault — a copy of the seed without this user's notes — runs first`, doctor.status === 0,
    `ai-dev doctor exit ${doctor.status}${doctor.status === 0 ? "" : `: ${String(doctor.stderr || doctor.stdout).trim().split("\n").pop()}`}`);
  await withServer({ command: local.command, args: local.args, env: serverEnv, cwd: path.dirname(local.args[0]) }, async (client) => {
    check(`${label}: the server starts from the 2.x client entry and sends instructions`, (client.getInstructions() || "").length > 0, `${(client.getInstructions() || "").length} characters`);
    // get_task answers with the record itself; its `task` field is the request text.
    const record = await call(client, "get_task", { task_id: expected.taskId });
    check(`${label}: the 2.x task is found, with its checkpoint`, record?.id === expected.taskId && (record.checkpoints?.length ?? 0) >= 1, `status ${record?.status}, ${record?.checkpoints?.length ?? 0} checkpoint(s)`);
    const decisions = await call(client, "list_decisions", { project_path: project });
    const titles = JSON.stringify(decisions);
    check(`${label}: the 2.x decision is listed`, titles.includes("Upgrade fixture decision"));
    const instincts = JSON.stringify(await call(client, "list_instincts", { project_path: project }));
    check(`${label}: the 2.x instinct is listed`, instincts.includes("when exporting CSV for the upgrade fixture"));
    const sessions = JSON.stringify(await call(client, "list_sessions", { project_path: project }));
    check(`${label}: the 2.x session handoff is listed`, sessions.includes("Upgrade fixture handoff"));
    // The pull may have removed skills from the catalogue (the curation of
    // 2026-10-11 removed 2,614): the server has to notice, not go on routing
    // to them. Status reads the index as 2.x left it and says so.
    const status = await call(client, "search_index_status", {});
    const documents = indexedDocuments(status);
    const pulledAway = removedSkills(base);
    check(`${label}: the 2.x search index is read as it is, nothing rewritten by a status call`, documents > 0 && documents === expected.documents, `${documents} document(s), 2.x had ${expected.documents}`);
    const claim = await readJson(`${status.index_path}.vault`).catch(() => null);
    check(`${label}: a command with another vault, run first, left the 2.x index to this install`,
      path.basename(String(status.index_path ?? "")) === "ai-dev-search.sqlite" && Boolean(claim) && !String(claim.vault_root).includes(path.basename(otherVault)),
      `${path.basename(String(status.index_path ?? ""))}, claimed by ${claim?.vault_root ?? "nobody"}`);
    if (sqliteSupport().available) {
      // Skills removed: the index has to be stale. Nothing changed: it has to
      // be current. Other changes may or may not touch what it indexes.
      const expectStale = pulledAway.length > 0 ? true : (seedChanged(base) ? null : false);
      check(`${label}: the Node engine answers, and sees what the pull changed in the catalogue`,
        status.engine === "node" && (expectStale === null || status.stale === expectStale),
        `engine ${status.engine}, stale ${status.stale}${status.reasons?.length ? ` (${status.reasons.join(", ")})` : ""}, ${pulledAway.length} skill(s) removed by the pull`);
    }
    const registry = await readJson(path.join(baseRoot, "docker", "public-seed", "03-skills-catalog", "registries", "skills.index.json"));
    const removedPaths = new Set(pulledAway.map((skill) => skill.path));
    const listedGone = registry.filter((item) => removedPaths.has(String(item.path)));
    check(`${label}: the skill registry follows the pulled catalogue`, listedGone.length === 0 && (pulledAway.length === 0 || registry.length < expected.skills),
      `${registry.length} skill(s), 2.x had ${expected.skills}; ${listedGone.length} removed one(s) still listed`);
    const { vectors, digest, byId } = expected.dense;
    // Counted for the model that answers now: the ONNX path's vectors are its
    // own, the Python backend's another model's, kept and waiting.
    const kept = Number(status.dense_documents) + Number(status.dense_other_model_documents || 0);
    check(`${label}: the 2.x dense vectors are all there`, vectors > 0 && kept === vectors && status.dense_backend === expected.dense.backend,
      `${kept} of ${vectors}, backend ${status.dense_backend}`);
    // 2.0.0's vectors, written before the ONNX path, are all the Python backend's.
    const otherModel = pythonBackend || expected.dense.provenance === false;
    check(`${label}: ${otherModel ? "they are another model's, so every one waits for the new model" : "they are the model 3.0 runs, so none waits"}`,
      otherModel
        ? Number(status.dense_documents) === 0 && Number(status.dense_other_model_documents) === vectors && Number(status.dense_pending_documents) >= vectors
        : Number(status.dense_documents) === vectors && !Number(status.dense_other_model_documents),
      `${status.dense_documents} of the current model, ${status.dense_other_model_documents ?? 0} of another, ${status.dense_pending_documents} waiting`);
    if (digest) {
      check(`${label}: the 2.x vectors are untouched, byte for byte`, denseDigest(status.index_path).digest === digest);
      const refreshed = await call(client, "rebuild_search_index", {});
      const after = denseDigest(status.index_path);
      // Every vector the rebuild keeps is a 2.x vector, unchanged; those of
      // documents gone or rewritten (Membrane's connectors, and the
      // group notes the smaller catalogue rewrote) are dropped and the
      // documents wait for an embedding run.
      const altered = [...after.byId].filter(([id, row]) => byId.get(id) !== row).length;
      const eligible = denseEligibleDocuments(status.index_path);
      check(`${label}: a rebuild keeps byte for byte every 2.x vector whose document it still has unchanged`,
        refreshed.dense_preserved === true && after.count > 0 && altered === 0 && refreshed.dense_documents === after.count
          && refreshed.dense_pending_documents === eligible - after.count,
        `${after.count} of ${vectors} kept, ${altered} altered, ${vectors - after.count} dropped with their documents gone or rewritten, `
          + `${refreshed.dense_pending_documents} pending of ${eligible}, engine ${refreshed.engine}`);
    }
    if (pulledAway.length > 0) {
      const gone = pulledAway[0].name;
      const found = await call(client, "search_skill_registry", { query: gone, limit: 20 });
      const stillThere = (Array.isArray(found) ? found : []).filter((item) => String(item.path || "").includes(`/skills/${gone}/`));
      check(`${label}: a skill the pull removed is not found any more`, stillThere.length === 0, `${gone}: ${stillThere.length} result(s)`);
    }
    const found = await call(client, "search_all", { query: "code review" });
    const hits = Array.isArray(found) ? found.length : (found.results?.length ?? 0);
    check(`${label}: search answers on the upgraded install`, hits > 0, `${hits} result(s)`);
    const hybrid = await call(client, "hybrid_search", { query: "code review checklist", dense_weight: 0 });
    const hybridHits = Array.isArray(hybrid) ? hybrid.length : (hybrid.results?.length ?? 0);
    check(`${label}: hybrid search reads the index the upgraded server keeps`, hybridHits > 0, `${hybridHits} result(s)`);
    if (pythonBackend) {
      // The backend is gone, and saying so is the server's job.
      const embedding = await call(client, "embedding_status", {});
      const notes = embedding.dense_backend?.legacy?.notes ?? [];
      check(`${label}: embedding_status names what is left of the Python backend, with the one command`,
        notes.some((note) => note.startsWith("AI_DEV_DENSE_BACKEND=python")) && notes.some((note) => note.startsWith("BGE_M3_PYTHON is set"))
          && notes.some((note) => note.includes("torch weights")) && embedding.dense_backend?.legacy?.command === "npm run setup -- --model",
        notes.join(" | ").slice(0, 300));
      const health = await call(client, "system_health_check", { include_search_smoke: false, include_dense_smoke: false, include_search_eval: false });
      const verdict = (health.checks ?? []).find((item) => item.name === "embedding_backend");
      check(`${label}: the health check warns, with the command, instead of failing`, verdict?.status === "warn" && /npm run setup -- --model/.test(verdict.summary ?? ""),
        `${verdict?.status}: ${String(verdict?.summary ?? "").slice(0, 160)}`);
      const dense = await call(client, "hybrid_search", { query: "code review checklist", dense_weight: 0.35 });
      const denseHits = Array.isArray(dense) ? dense : (dense.results ?? []);
      check(`${label}: hybrid search answers without the model, and no Python vector is compared`,
        denseHits.length > 0 && denseHits.every((item) => !item.dense_score), `${denseHits.length} result(s)`);
    }
  });

  if (pythonBackend) {
    // The one command the notes give — `npm run setup -- --model` — with the
    // five-kilobyte stand-in served from a local mirror where huggingface.co
    // would be: it downloads the model and embeds the documents again. Not
    // `model import`, which embeds whatever it finds: the advice is what has
    // to work.
    const usb = path.join(temp, "usb-model", "bge-m3-onnx");
    const { manifest } = await writeSyntheticModel(usb);
    const manifestFile = path.join(temp, "synthetic.manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const files = {};
    for (const relative of Object.keys(manifest.files)) files[relative] = readFileSync(path.join(usb, relative));
    const mirror = await startModelHost({ files });
    let moved;
    try {
      moved = await runAsync(process.execPath, [path.join(baseRoot, "ai-dev-mcp-server", "scripts", "first-run.mjs"), "--model", "--no-health"], {
        cwd: path.join(baseRoot, "ai-dev-mcp-server"),
        env: { ...env, AI_DEV_MODEL_MANIFEST: manifestFile, AI_DEV_MODEL_MIRROR: mirror.base.replace(/\/m$/, "") }
      });
    } finally {
      await mirror.close();
    }
    const status = await withServer({ command: local.command, args: local.args, env: { ...serverEnv, AI_DEV_MODEL_MANIFEST: manifestFile }, cwd: path.dirname(local.args[0]) }, (client) => (
      call(client, "search_index_status", {})
    ));
    const rows = denseDigest(status.index_path);
    const eligible = denseEligibleDocuments(status.index_path);
    const embeddedLine = moved.stdout.split("\n").find((line) => /^[✓✗·] Dense vectors/.test(line)) ?? "";
    check(`${label}: the one command moves it over — every vector the new model's, none left of Python, the index whole`,
      moved.status === 0 && status.dense_backend === "onnx" && Number(status.dense_documents) === eligible && Number(status.dense_pending_documents) === 0
        && !Number(status.dense_other_model_documents) && rows.count === eligible && indexedDocuments(status) === Number(status.current_document_count),
      `setup --model exit ${moved.status} (${embeddedLine.trim().slice(0, 90) || moved.stderr.slice(0, 200)}), backend ${status.dense_backend}, `
        + `${status.dense_documents} of ${eligible} embedded, ${status.dense_pending_documents} pending, ${indexedDocuments(status)} document(s) indexed`);
  }

  if (codex) {
    const codexState = path.join(env.HOME, ".codex", "state", "ai-dev-system");
    const left = await listFiles(codexState);
    check(`${label}: nothing of AI Dev's is left in ~/.codex/state/ai-dev-system`, left.length === 0, `${left.length} file(s): ${left.slice(0, 3).join(", ")}`);
    check(`${label}: the task now lives in ~/.ai-dev/state`, existsSync(path.join(env.HOME, ".ai-dev", "state", "tasks", `${expected.taskId}.json`)));
    const log = await readJson(path.join(env.HOME, ".ai-dev", "state", "runtime-home-migration.json")).catch(() => null);
    const record = (log?.history ?? []).find((entry) => entry.kind === "codex");
    check(`${label}: the move is recorded, with where it came from`,
      record?.status === "migrated" && record.from === path.join(env.HOME, ".codex") && Number(record.moved ?? 0) + Number(record.merged ?? 0) > 0,
      `${record?.moved ?? 0} moved, ${record?.merged ?? 0} merged, from ${record?.from ?? "nowhere"}`);
  }

  if (aiDevHome) {
    const left = await listFiles(path.join(aiDevHome, ".ai-dev"));
    check(`${label}: nothing is left one level too deep in AI_DEV_HOME`, left.length === 0, `${doubledBefore.length} file(s) there under 2.x, ${left.length} now`);
    const missing = doubledBefore.filter((relative) => !existsSync(path.join(aiDevHome, relative)));
    check(`${label}: every file 2.x put there is in AI_DEV_HOME itself now`, missing.length === 0, missing.slice(0, 3).join(", "));
    check(`${label}: the task now lives in AI_DEV_HOME itself`, existsSync(path.join(aiDevHome, "state", "tasks", `${expected.taskId}.json`)));
  }

  // The 2.x hook copy in the repository still runs against the upgraded state.
  const settings = await readJson(path.join(project, ".claude", "settings.json"));
  const sessionStart = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command || "";
  const [hookCommand, ...hookArgs] = sessionStart.split(" ");
  const hook = run(hookCommand === "node" ? process.execPath : hookCommand, hookArgs, {
    cwd: project,
    env,
    input: JSON.stringify({ session_id: `upgrade-${label}`, cwd: project, source: "startup" }),
    allowFailure: true
  });
  check(`${label}: the 2.x SessionStart hook runs`, hook.status === 0, `exit ${hook.status}`);
  // A 2.x hook computes the old, doubled path, so it cannot see the migrated
  // task; re-installing the hooks with the upgraded server is the documented fix.
  if (!aiDevHome) check(`${label}: the 2.x hook still sees the open task`, hook.stdout.includes(expected.taskId));

  // Re-installed, the hook runs through the Node launcher, which finds Node
  // without it on PATH: a client opened from the Dock has none.
  await withServer({ command: local.command, args: local.args, env: serverEnv, cwd: path.dirname(local.args[0]) }, (client) => (
    call(client, "install_agent_hooks", { project_path: project, targets: ["claude"] })
  ));
  const reinstalled = (await readJson(path.join(project, ".claude", "settings.json"))).hooks?.SessionStart?.[0]?.hooks?.[0]?.command || "";
  const input = JSON.stringify({ session_id: `upgrade-${label}-refreshed`, cwd: project, source: "startup" });
  let refreshed;
  if (process.platform === "win32") {
    const [command, ...args] = reinstalled.split(" ");
    refreshed = run(command === "node" ? process.execPath : command, args, { cwd: project, env, input, allowFailure: true });
  } else {
    check(`${label}: install_agent_hooks writes the 3.0 hook command`, reinstalled === "/bin/sh .ai-dev/hooks/with-node.sh session-start.mjs", reinstalled);
    // A PATH with git and nothing else: no node, not even coreutils.
    const bin = path.join(temp, `only-git-${label.replace(/[^a-z]+/gi, "-")}`);
    await fs.mkdir(bin, { recursive: true });
    await fs.symlink(run("/bin/sh", ["-c", "command -v git"]).stdout.trim(), path.join(bin, "git")).catch(() => undefined);
    const bare = run("/bin/sh", ["-c", "node -v"], { env: { ...env, PATH: bin }, allowFailure: true });
    check(`${label}: on that PATH there is no node`, bare.status === 127, `exit ${bare.status}`);
    refreshed = run("/bin/sh", ["-c", reinstalled], { cwd: project, env: { ...env, PATH: bin }, input, allowFailure: true });
  }
  check(`${label}: the re-installed hook runs with no Node on PATH and sees the task`, refreshed.status === 0 && refreshed.stdout.includes(expected.taskId), `exit ${refreshed.status} ${refreshed.stderr.slice(0, 160)}`);

  await verifyClientMigration({ label, baseRoot, env, local });
}

/**
 * 3.0 writes one name. `npm run clients:install` (`ai-dev clients install`)
 * takes out the 2.x local entry `ai-dev-system`, replaces the 2.x Docker
 * `ai-dev` with this install, keeps a backup of each file, and the command it
 * writes answers `initialize` with instructions.
 */
async function verifyClientMigration({ label, baseRoot, env, local }) {
  const serverDir = path.join(baseRoot, "ai-dev-mcp-server");
  const cli = path.join(serverDir, "bin", "ai-dev.mjs");
  const cursorFile = path.join(env.HOME, ".cursor", "mcp.json");
  const before = await readJson(cursorFile);
  const foreign = Object.keys(before.mcpServers ?? {}).filter((name) => name !== "ai-dev" && name !== "ai-dev-system");
  const installed = run(process.execPath, [cli, "clients", "install", "--json"], { cwd: serverDir, env, allowFailure: true });
  const results = (() => {
    try {
      return JSON.parse(installed.stdout).clients ?? [];
    } catch {
      return [];
    }
  })();
  const written = results.filter((result) => result.status !== "skipped");
  check(`${label}: clients install writes every client 2.x configured`, installed.status === 0
    && ["claude-code", "claude-desktop", "cursor", "vscode", "codex", "gemini"].every((id) => written.some((result) => result.client === id && result.status === "updated")),
    written.map((result) => `${result.client}:${result.status}`).join(" ") || installed.stderr.slice(0, 200));
  const cursor = written.find((result) => result.client === "cursor");
  check(`${label}: it says what it replaced: the Docker entry, and the 2.x name it removed`, cursor?.previous === "docker" && cursor?.migrated?.includes("ai-dev-system") && existsSync(cursor?.backup ?? ""),
    JSON.stringify({ previous: cursor?.previous, migrated: cursor?.migrated }));
  const after = await readJson(cursorFile);
  check(`${label}: one ai-dev entry is left, running this install; the other servers stay`,
    !("ai-dev-system" in after.mcpServers) && after.mcpServers["ai-dev"]?.command === process.execPath
      && JSON.stringify(after.mcpServers["ai-dev"]?.args) === JSON.stringify([cli, "mcp"])
      && foreign.every((name) => JSON.stringify(after.mcpServers[name]) === JSON.stringify(before.mcpServers[name])),
    Object.keys(after.mcpServers).join(", "));
  check(`${label}: the 2.x entry it replaced pointed at the same clone`, path.resolve(local.args[0]).startsWith(path.resolve(serverDir)), local.args[0]);
  const doctor = run(process.execPath, [cli, "clients", "doctor", "--json"], { cwd: serverDir, env, allowFailure: true });
  const answers = (() => {
    try {
      return JSON.parse(doctor.stdout).clients ?? [];
    } catch {
      return [];
    }
  })();
  check(`${label}: every client's ai-dev command answers initialize with instructions`,
    doctor.status === 0 && answers.length >= 6 && answers.every((answer) => answer.ok === true && answer.instructions > 0),
    answers.map((answer) => `${answer.client}:${answer.ok}`).join(" ") || doctor.stdout.slice(0, 200));
  // `ai-dev mcp` hands each client to the daemon, which the first of them
  // started: one server served all six.
  const daemon = (() => {
    try {
      return JSON.parse(run(process.execPath, [cli, "daemon", "status", "--json"], { cwd: serverDir, env, allowFailure: true }).stdout);
    } catch {
      return {};
    }
  })();
  check(`${label}: one daemon served every client's command`, daemon.running === true && daemon.current === true && daemon.sessions_served >= answers.length,
    `running ${daemon.running}, sessions served ${daemon.sessions_served}`);
  const stopped = run(process.execPath, [cli, "daemon", "stop"], { cwd: serverDir, env, allowFailure: true });
  check(`${label}: ai-dev daemon stop stops it`, stopped.status === 0 && /^Stopped: pid \d+/.test(stopped.stdout), stopped.stdout.trim());
  const again = run(process.execPath, [cli, "clients", "install"], { cwd: serverDir, env, allowFailure: true });
  check(`${label}: a second install changes nothing`, again.status === 0 && /No changes: every client already runs this install\./.test(again.stdout), again.stdout.split("\n").at(-2) ?? "");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run upgrade:test [-- --base <commit>] [--keep]");
    return;
  }
  const started = Date.now();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-upgrade-"));
  const baseRoot = path.join(temp, "clone");
  const baseServer = path.join(baseRoot, "ai-dev-mcp-server");
  console.log(`Base: ${options.base} → working tree at ${repoRoot}`);
  console.log(`Scratch: ${temp}`);
  try {
    run("git", ["-C", repoRoot, "worktree", "add", "--detach", "--force", baseRoot, options.base]);
    npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: baseServer });
    await writeOwnNotes(baseRoot);

    const dockerHome = path.join(temp, "data", "runtime-home");
    const scenarios = [
      { label: "default", home: path.join(temp, "home-default") },
      { label: "AI_DEV_HOME", home: path.join(temp, "home-custom"), aiDevHome: path.join(temp, "home-custom", "ai-dev-data") },
      { label: "Docker volume layout", home: dockerHome, aiDevHome: path.join(dockerHome, ".ai-dev"), explicitRoots: true },
      { label: "Python dense backend", home: path.join(temp, "home-python"), pythonBackend: true },
      { label: "Codex runtime", home: path.join(temp, "home-codex"), codex: true }
    ];
    for (const scenario of scenarios) {
      await fs.mkdir(scenario.home, { recursive: true });
      scenario.env = scenarioEnv(process.env, scenario);
      if (scenario.pythonBackend) {
        // What a 2.x user on the Python backend has: the variables in the
        // client config and the shell, and the torch weights on disk.
        Object.assign(scenario.env, { AI_DEV_DENSE_BACKEND: "python", BGE_M3_PYTHON: path.join(scenario.home, "venv", "bin", "python") });
        const weights = path.join(scenario.home, ".ai-dev", "models", "bge-m3");
        await fs.mkdir(weights, { recursive: true });
        await fs.writeFile(path.join(weights, "pytorch_model.bin"), "2.x torch weights stand-in");
      }
      if (scenario.codex) {
        // Where the Codex desktop runtime kept AI Dev's state and index: 2.x
        // used these folders whenever they existed and ~/.ai-dev's did not.
        await fs.mkdir(path.join(scenario.home, ".codex", "state", "ai-dev-system"), { recursive: true });
        await fs.mkdir(path.join(scenario.home, ".codex", "cache", "ai-dev-system", "search-index"), { recursive: true });
      }
      scenario.project = path.join(temp, `project-${scenario.label.toLowerCase().replace(/[^a-z]+/g, "-")}`);
      await makeRepository(scenario.project);
      npm(["run", "setup", "--", "--no-health"], { cwd: baseServer, env: scenario.env });
      scenario.expected = await createLegacyState({ baseServer, env: scenario.env, project: scenario.project, denseBackend: scenario.pythonBackend ? "python" : "onnx" });
      writeLegacyClientConfigs({ baseRoot, env: scenario.env, project: scenario.project });
      if (scenario.aiDevHome) scenario.doubledBefore = await listFiles(path.join(scenario.aiDevHome, ".ai-dev"));
      if (scenario.codex) {
        check(`${scenario.label}: 2.x kept the task in ~/.codex/state/ai-dev-system (the case to migrate)`,
          existsSync(path.join(scenario.home, ".codex", "state", "ai-dev-system", "tasks", `${scenario.expected.taskId}.json`)));
      }
      if (scenario.aiDevHome && !scenario.explicitRoots) {
        check(`${scenario.label}: 2.x wrote its data one level too deep (the case to migrate)`, existsSync(path.join(scenario.aiDevHome, ".ai-dev", "state", "tasks")), `${scenario.doubledBefore.length} file(s)`);
      }
    }

    const copied = await syncWorkingTree(repoRoot, baseRoot);
    console.log(`Upgraded the clone in place: ${copied.files} file(s) from the working tree, ${copied.changed} of them changed.`);
    const install = npm(["ci", "--no-audit", "--no-fund"], { cwd: baseServer, allowFailure: true });
    check("npm ci without --ignore-scripts succeeds on the upgraded clone", install.status === 0, `exit ${install.status}`);
    if (install.status !== 0) {
      // Keep going, so one failed install does not hide every later check.
      npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: baseServer });
    }

    for (const scenario of scenarios) {
      await verifyUpgradedScenario({ ...scenario, base: options.base, baseRoot, temp });
    }
    // And back, each user as MIGRATION.md tells them; one checkout of the base serves all.
    const checkout = checkoutBase({ repoRoot, base: options.base, folder: path.join(temp, "way-back") });
    for (const scenario of scenarios) {
      await verifyWayBack({ ...scenario, baseRoot, checkout });
    }
  } finally {
    run("git", ["-C", repoRoot, "worktree", "remove", "--force", path.join(temp, "way-back")], { allowFailure: true });
    run("git", ["-C", repoRoot, "worktree", "remove", "--force", baseRoot], { allowFailure: true });
    if (!options.keep) await fs.rm(temp, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
  if (failed.length) process.exitCode = 1;
}

await main();
