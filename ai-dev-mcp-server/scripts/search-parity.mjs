#!/usr/bin/env node
/**
 * Does Node search answer as the Python helper did?
 *
 *   npm run search:parity -- [--vault <dir>] [--json <report.json>]
 *                            [--helper <search_cli.py> | --helper-rev <git revision>]
 *
 * A development check, not a test. The helper left the repository when search
 * moved to Node; this takes it from git history — the
 * last revision that had `search-index/search_cli.py`, or the one named — and
 * needs Python 3 to run it. The vault it reads should have its skill registry
 * built (`npm run setup`). It
 *
 * 1. builds the index with each into a scratch directory and compares the two
 *    files table by table, row by row (the build time aside): a 2.x server
 *    rolled back onto an index Node wrote must read what it would have written;
 * 2. runs every golden case in `search-eval/*.json` — the search cases with
 *    their preset's filters, the routing cases' tasks as plain questions —
 *    through Node's keyword search and the helper's `search`, and compares the
 *    top 3 and the top k;
 * 3. because keyword search requires every word and most golden questions are
 *    sentences, also asks both for a few hundred document titles — questions
 *    that find at least their own document, and usually its neighbours
 *    (`--titles N`, 300 by default);
 * 4. runs the golden cases and the titles through Node's hybrid search and the
 *    helper's `hybrid` on the Node-built index, answer for answer;
 * 5. gives every document a synthetic dense vector, then compares hybrid
 *    search with a synthetic question vector, and the galaxy export byte for
 *    byte.
 *
 * Every ranking discrepancy is printed with a reason: a question with
 * AND/OR/NOT/NEAR, where the helper had a bug; a tie in score, where
 * order is the database's to choose; or "unexplained", which fails the run.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { exportGalaxy } from "../src/core/galaxy-export.mjs";
import { resolvePythonCommand } from "../src/core/python-command.mjs";
import { createHybridCache, hybridSearch } from "../src/core/search-hybrid.mjs";
import { resolveSearchPresetArgs } from "../src/core/search-runtime.mjs";
import { keywordSearch } from "../src/core/search-query.mjs";
import { openDatabase, sqliteSupport } from "../src/core/search-sqlite.mjs";
import { DENSE_DIMENSIONS, densePlan, rebuildIndex } from "../src/core/search-store.mjs";

const run = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..");
const HELPER_PATH = "search-index/search_cli.py";
const evalDir = path.join(repoRoot, "search-eval");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const vaultRoot = path.resolve(option("--vault", path.join(repoRoot, "docker", "public-seed")));
const jsonOut = option("--json", "");
const titleCount = Math.max(0, Number(option("--titles", "300")) || 0);
const python = resolvePythonCommand();
const MODEL_DIR = "/parity/models/bge-m3";
const OPERATOR = /(^|[^\p{L}\p{N}_])(AND|OR|NOT|NEAR)([^\p{L}\p{N}_]|$)/u;

/**
 * The helper, copied into `directory`: the file `--helper` names, or the one
 * git holds at `--helper-rev`, by default the parent of the commit that
 * deleted it (HEAD while the deletion is not committed yet).
 */
function placeHelper(directory) {
  const target = path.join(directory, "search_cli.py");
  const explicit = option("--helper", "");
  if (explicit) {
    fs.copyFileSync(path.resolve(explicit), target);
    return path.resolve(explicit);
  }
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true });
  let revision = option("--helper-rev", "");
  if (!revision) {
    const deletedIn = git(["log", "-1", "--diff-filter=D", "--format=%H", "--", HELPER_PATH]).trim();
    revision = deletedIn ? `${deletedIn}^` : "HEAD";
  }
  fs.writeFileSync(target, git(["show", `${revision}:${HELPER_PATH}`]));
  return `${HELPER_PATH} @ ${git(["rev-parse", "--short", revision]).trim()}`;
}

// One Python process for every search, instead of one per question.
const DRIVER = `
import contextlib, io, json, sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import search_cli
answers = []
for job in json.load(sys.stdin):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        getattr(search_cli, job["fn"])(SimpleNamespace(**job["args"]))
    answers.append(json.loads(buffer.getvalue()))
json.dump(answers, sys.stdout)
`;

/** Run `search` or `hybrid_search` in the helper for each case, in one process. */
function helperSearches(helperDir, fn, indexPath, cases, { queryVectorPath = "" } = {}) {
  const jobs = cases.map((testCase) => ({
    fn,
    args: {
      index_path: indexPath,
      query: testCase.query,
      scope: testCase.scope,
      limit: testCase.limit,
      project: testCase.project,
      source: testCase.source,
      categories: testCase.categories,
      folders: testCase.folders,
      ...(fn === "hybrid_search"
        ? { semantic_weight: 0.2, keyword_weight: 0.45, dense_weight: 0.35, dense_model_dir: "/nonexistent", dense_device: "cpu", dense_query_vector_path: queryVectorPath }
        : {})
    }
  }));
  const result = spawnSync(python, ["-c", DRIVER, helperDir], { input: JSON.stringify(jobs), maxBuffer: 1 << 30, windowsHide: true });
  if (result.status !== 0) throw new Error(`The helper's searches failed: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

/** Every row of every table as text, rowids and the build time aside. */
function dumpIndex(indexPath) {
  const db = openDatabase(indexPath);
  const rows = (sql) => db.prepare(sql).all().map((row) => JSON.stringify(Object.values(row).map((value) => (
    value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value
  ))));
  try {
    return {
      documents: rows("SELECT id, scope, title, CAST(path AS BLOB), source, categories, CAST(preview AS BLOB), mtime, content_hash FROM documents ORDER BY id"),
      docs_fts: rows("SELECT id, CAST(title AS BLOB), CAST(body AS BLOB), CAST(path AS BLOB), source, categories FROM docs_fts ORDER BY id"),
      semantic_vectors: rows("SELECT id, vector, norm FROM semantic_vectors ORDER BY id"),
      dense_vectors: rows("SELECT id, vector, dimensions, model, backend, revision, dtype, content_hash, mtime FROM dense_vectors ORDER BY id"),
      meta: rows("SELECT key, value FROM meta WHERE key != 'built_at' ORDER BY key")
    };
  } finally {
    db.close();
  }
}

function compareIndexes(left, right) {
  const a = dumpIndex(left);
  const b = dumpIndex(right);
  return Object.fromEntries(Object.keys(a).map((table) => {
    const inB = new Set(b[table]);
    const inA = new Set(a[table]);
    return [table, { rows: [a[table].length, b[table].length], differing: a[table].filter((row) => !inB.has(row)).length + b[table].filter((row) => !inA.has(row)).length }];
  }));
}

/** The golden questions, with the filters a search case's preset applies. */
function loadCases() {
  const cases = [];
  for (const file of fs.readdirSync(evalDir).filter((name) => name.endsWith(".json")).sort()) {
    const { cases: list = [] } = JSON.parse(fs.readFileSync(path.join(evalDir, file), "utf8"));
    for (const testCase of list) {
      const question = testCase.query ?? testCase.task;
      if (typeof question !== "string" || !question.trim()) continue;
      const resolved = testCase.query ? resolveSearchPresetArgs({ ...testCase }, { defaultLimit: 10 }).search : { query: question, scope: "all", limit: 10 };
      cases.push({
        file,
        id: String(testCase.id ?? question),
        query: question,
        scope: resolved.scope || "all",
        limit: resolved.limit || 10,
        project: resolved.project || "",
        source: [resolved.source ?? ""].flat().join(","),
        categories: [resolved.categories ?? ""].flat().join(","),
        folders: [resolved.folders ?? ""].flat().join(",")
      });
    }
  }
  return cases;
}

/** Why two rankings differ, or "unexplained". */
function explain(testCase, left, right) {
  if (OPERATOR.test(testCase.query)) return "operator word in the question";
  const scores = new Map();
  for (const item of [...left, ...right]) {
    const known = scores.get(item.path);
    if (known !== undefined && Math.abs(known - item.score) > 1e-9) return "unexplained";
    scores.set(item.path, item.score);
  }
  const differing = left.map((item, index) => [item, right[index]]).filter(([a, b]) => a?.path !== b?.path);
  const tied = differing.every(([a, b]) => a && b && Math.abs(a.score - b.score) <= 1e-9);
  return tied ? "tie in score: the order is the database's" : "unexplained";
}

/**
 * Top 3 and top k by path; with `whole`, every answer must also be the same
 * answer field for field, scores included, or be explained.
 */
function compareRankings(cases, label, leftResults, rightResults, { whole = false } = {}) {
  const rows = [];
  for (let index = 0; index < cases.length; index += 1) {
    const left = leftResults[index];
    const right = rightResults[index];
    const top = (list, k) => list.slice(0, k).map((item) => item.path);
    const sameTop3 = JSON.stringify(top(left, 3)) === JSON.stringify(top(right, 3));
    const sameTopK = JSON.stringify(top(left, cases[index].limit)) === JSON.stringify(top(right, cases[index].limit));
    const identical = isDeepStrictEqual(left, right);
    const widest = Math.max(top(left, 3).length, top(right, 3).length);
    const overlap3 = widest ? top(left, 3).filter((item) => top(right, 3).includes(item)).length / widest : 1;
    const agrees = sameTop3 && sameTopK && (!whole || identical);
    rows.push({ id: cases[index].id, answered: widest > 0, sameTop3, sameTopK, identical, overlap3, reason: agrees ? "" : explain(cases[index], left, right), left: top(left, 3), right: top(right, 3) });
  }
  const sameTop3 = rows.filter((row) => row.sameTop3).length;
  return {
    label,
    cases: rows.length,
    answered: rows.filter((row) => row.answered).length,
    answered_top3_identical: rows.filter((row) => row.answered && row.sameTop3).length,
    top3_identical: sameTop3,
    top3_identical_share: Number((sameTop3 / Math.max(1, rows.length)).toFixed(4)),
    top3_mean_overlap: Number((rows.reduce((sum, row) => sum + row.overlap3, 0) / Math.max(1, rows.length)).toFixed(4)),
    topk_identical: rows.filter((row) => row.sameTopK).length,
    ...(whole ? { answers_identical: rows.filter((row) => row.identical).length } : {}),
    discrepancies: rows.filter((row) => row.reason)
  };
}

/** A deterministic unit vector per seed: the same numbers on every run and machine. */
function syntheticVector(seed) {
  let state = seed >>> 0;
  const values = Array.from({ length: DENSE_DIMENSIONS }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32 - 0.5;
  });
  const norm = Math.hypot(...values);
  return values.map((value) => Number((value / norm).toFixed(8)));
}

/** The galaxy files from the helper and from Node, compared part by part. */
async function compareGalaxy(helperFile, indexPath, scratch) {
  const out = path.join(scratch, "galaxy");
  await run(python, [helperFile, "galaxy-export", "--index-path", indexPath, "--out-dir", out], { maxBuffer: 1 << 28, windowsHide: true });
  const db = openDatabase(indexPath);
  let node;
  try {
    node = exportGalaxy(db);
  } finally {
    db.close();
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "nodes.json"), "utf8"));
  return {
    nodes: [node.manifest.nodes.length, manifest.nodes.length],
    manifest_equal: isDeepStrictEqual(node.manifest, manifest),
    semantic_bytes_equal: Buffer.from(node.semanticBytes).equals(fs.readFileSync(path.join(out, "semantic.f32"))),
    dense_bytes_equal: Buffer.from(node.denseBytes).equals(fs.readFileSync(path.join(out, "dense.f32"))),
    dense_bytes: node.denseBytes.length
  };
}

async function main() {
  if (!sqliteSupport().available) throw new Error(sqliteSupport().reason);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "search-parity-"));
  const helperDir = path.join(scratch, "helper");
  fs.mkdirSync(helperDir);
  const helperFile = path.join(helperDir, "search_cli.py");
  const pythonIndex = path.join(scratch, "python.sqlite");
  const nodeIndex = path.join(scratch, "node.sqlite");
  try {
    const helperFrom = placeHelper(helperDir);
    let started = performance.now();
    await run(python, [helperFile, "rebuild", "--vault-root", vaultRoot, "--index-path", pythonIndex, "--include-external-project-files", "--preserve-dense", "--dense-model-dir", MODEL_DIR], { maxBuffer: 1 << 28, windowsHide: true });
    const pythonMs = Math.round(performance.now() - started);
    started = performance.now();
    const built = await rebuildIndex({ vaultRoot, indexPath: nodeIndex, preserveDense: true, denseModelDir: MODEL_DIR });
    const nodeMs = Math.round(performance.now() - started);
    const tables = compareIndexes(pythonIndex, nodeIndex);

    const cases = loadCases();
    const cache = createHybridCache();
    const nodeRuns = (questions, search) => {
      const db = openDatabase(nodeIndex);
      try {
        return questions.map((testCase) => search(db, testCase));
      } finally {
        db.close();
      }
    };
    const hybridOptions = (testCase, denseQueryVector = null) => ({ ...testCase, semanticWeight: 0.2, keywordWeight: 0.45, denseWeight: 0.35, denseQueryVector, cache });
    const titleDb = openDatabase(nodeIndex);
    let titleCases;
    try {
      const titles = titleDb.prepare("SELECT DISTINCT title FROM documents WHERE title != '' ORDER BY id").all().map((row) => row.title);
      const step = Math.max(1, Math.floor(titles.length / Math.max(1, titleCount)));
      titleCases = titleCount ? titles.filter((_, index) => index % step === 0).slice(0, titleCount)
        .map((title) => ({ file: "titles", id: `title: ${title}`, query: title, scope: "all", limit: 10, project: "", source: "", categories: "", folders: "" })) : [];
    } finally {
      titleDb.close();
    }
    const everything = [...cases, ...titleCases];
    const nodeKeyword = nodeRuns(cases, keywordSearch);
    const nodeTitles = nodeRuns(titleCases, keywordSearch);
    const nodeHybrid = nodeRuns(everything, (db, testCase) => hybridSearch(db, hybridOptions(testCase)));
    const pythonKeyword = helperSearches(helperDir, "search", pythonIndex, cases);
    const pythonTitles = helperSearches(helperDir, "search", pythonIndex, titleCases);
    const pythonHybrid = helperSearches(helperDir, "hybrid_search", nodeIndex, everything);

    // Synthetic vectors for every document the plan would embed, then a
    // synthetic question: what the arithmetic does with them is what counts.
    const plan = await densePlan({ vaultRoot, indexPath: nodeIndex, incremental: false });
    await rebuildIndex({
      vaultRoot,
      indexPath: nodeIndex,
      inPlace: true,
      preserveDense: true,
      denseEmbeddings: true,
      denseModelDir: MODEL_DIR,
      suppliedVectors: plan.records.map((record, index) => ({ id: record.id, content_hash: record.content_hash, vector: syntheticVector(index + 1) }))
    });
    const queryVector = syntheticVector(0xC0FFEE);
    const queryVectorPath = path.join(scratch, "query-vector.json");
    fs.writeFileSync(queryVectorPath, JSON.stringify(queryVector));
    const nodeDense = nodeRuns(cases, (db, testCase) => hybridSearch(db, hybridOptions(testCase, queryVector)));
    const pythonDense = helperSearches(helperDir, "hybrid_search", nodeIndex, cases, { queryVectorPath });
    const galaxy = await compareGalaxy(helperFile, nodeIndex, scratch);

    const report = {
      vault: vaultRoot,
      helper: helperFrom,
      documents: built.document_count,
      dense_vectors: plan.records.length,
      rebuild_ms: { python: pythonMs, node: nodeMs },
      index_tables: tables,
      keyword: compareRankings(cases, "keyword search, golden questions: Node vs the helper", nodeKeyword, pythonKeyword),
      titles: compareRankings(titleCases, "keyword search, document titles: Node vs the helper", nodeTitles, pythonTitles),
      hybrid: compareRankings(everything, "hybrid search, golden questions and titles, no dense: Node vs the helper", nodeHybrid, pythonHybrid, { whole: true }),
      hybrid_dense: compareRankings(cases, "hybrid search, golden questions, synthetic dense vectors: Node vs the helper", nodeDense, pythonDense, { whole: true }),
      galaxy
    };
    if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

    console.log(`vault ${vaultRoot}: ${report.documents} documents; helper ${helperFrom}; rebuild Python ${pythonMs} ms, Node ${nodeMs} ms`);
    for (const [table, { rows, differing }] of Object.entries(tables)) console.log(`  ${table}: ${rows[0]} / ${rows[1]} rows, ${differing} differing`);
    const sections = [report.keyword, report.titles, report.hybrid, report.hybrid_dense];
    for (const section of sections) {
      console.log(`${section.label}: top-3 identical in ${section.top3_identical} of ${section.cases} (${(section.top3_identical_share * 100).toFixed(1)} %), `
        + `${section.answered_top3_identical} of the ${section.answered} that found anything; mean top-3 overlap ${(section.top3_mean_overlap * 100).toFixed(1)} %, top-k identical in ${section.topk_identical}`
        + (section.answers_identical === undefined ? "" : `; answers identical field for field in ${section.answers_identical}`));
      for (const row of section.discrepancies) console.log(`  ${row.id}: ${row.reason}\n    Node:   ${row.left.join(" | ")}\n    Python: ${row.right.join(" | ")}`);
    }
    console.log(`galaxy export, ${report.dense_vectors} synthetic vectors: ${galaxy.nodes[0]} / ${galaxy.nodes[1]} nodes; nodes.json ${galaxy.manifest_equal ? "equal" : "DIFFERS"}, `
      + `semantic.f32 ${galaxy.semantic_bytes_equal ? "equal" : "DIFFERS"}, dense.f32 (${galaxy.dense_bytes} bytes) ${galaxy.dense_bytes_equal ? "equal" : "DIFFERS"}`);
    const unexplained = sections.flatMap((section) => section.discrepancies).filter((row) => row.reason === "unexplained");
    const tablesDiffer = Object.values(tables).some((table) => table.differing > 0);
    const galaxyDiffers = !galaxy.manifest_equal || !galaxy.semantic_bytes_equal || !galaxy.dense_bytes_equal;
    if (unexplained.length || tablesDiffer || galaxyDiffers) {
      console.log(`FAIL: ${unexplained.length} unexplained discrepanc${unexplained.length === 1 ? "y" : "ies"}${tablesDiffer ? "; the index files differ" : ""}${galaxyDiffers ? "; the galaxy export differs" : ""}.`);
      process.exitCode = 1;
    } else {
      console.log("OK: the index files and the galaxy export are equal, and every discrepancy is explained.");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
