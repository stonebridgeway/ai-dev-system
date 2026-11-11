import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeSyntheticModel } from "../src/core/synthetic-model.mjs";
import { makeZip } from "../test/fixtures/zip-writer.mjs";

// The whole path a person takes, with the five-kilobyte stand-in for BGE-M3:
// `npm run model -- import` copies it in and embeds the vault, then the real
// MCP server — its own process, the real worker thread, transformers.js and
// onnxruntime-node — answers a hybrid search whose winner only the dense half
// can find. Then the model goes, and the server says
// so instead of failing the search.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function write(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  return fs.mkdir(path.dirname(target), { recursive: true }).then(() => fs.writeFile(target, content));
}

/** A home, a vault of four notes on four topics, and the stand-in model with its manifest. */
async function stage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-e2e-"));
  // A server that has just been closed can still be writing its last ledger
  // line; the folder goes once it is quiet.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const vault = path.join(root, "vault");
  await write(vault, "02-knowledge/persistence.md", "# Persistence\n\nThe postgres schema keeps every table in storage.\n");
  await write(vault, "02-knowledge/interface.md", "# Interface\n\nThe react component sets the layout and the button design.\n");
  await write(vault, "02-knowledge/shipping.md", "# Shipping\n\nThe docker image is built, the container rolled out by the pipeline.\n");
  await write(vault, "02-knowledge/access.md", "# Access\n\nA login gives a token; the password sets the permission.\n");
  await write(vault, "03-skills-catalog/registries/skills.index.json", "[]");
  const { manifest } = await writeSyntheticModel(path.join(root, "usb", "bge-m3-onnx"));
  const manifestFile = path.join(root, "synthetic.manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const home = path.join(root, "home", ".ai-dev");
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    AI_DEV_HOME: home,
    AI_DEV_STATE_ROOT: path.join(home, "state"),
    AI_DEV_SEARCH_INDEX_DIR: path.join(home, "cache", "search-index"),
    BGE_M3_ONNX_DIR: path.join(home, "models", "bge-m3-onnx"),
    AI_DEV_VAULT_ROOT: vault,
    AI_DEV_MODEL_MANIFEST: manifestFile,
    AI_DEV_OFFLINE: "1"
  };
  return { root, vault, env, manifest, modelDir: env.BGE_M3_ONNX_DIR };
}

/** Run `scripts/model.mjs` and hand back its exit code and parsed JSON. */
function model(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(serverRoot, "scripts", "model.mjs"), ...args, "--json"], { cwd: serverRoot, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, json: JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`model ${args.join(" ")} printed no JSON (exit ${code}): ${stdout} ${stderr}`));
      }
    });
  });
}

async function connect(env, t) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(serverRoot, "src", "server.mjs")], cwd: serverRoot, env, stderr: "pipe" });
  const client = new Client({ name: "model-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

const toolJson = async (client, name, args) => {
  const answer = await client.callTool({ name, arguments: args });
  const text = answer.content?.[0]?.text ?? "";
  return { isError: Boolean(answer.isError), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

test("import → embed → hybrid search with dense, through the real worker and the real server; then remove", { timeout: 180_000 }, async (t) => {
  const { root, env, modelDir } = await stage(t);

  // Copy the model in from a zip another machine made, and embed the vault.
  const archive = path.join(root, "bge-m3.zip");
  const files = await fs.readdir(path.join(root, "usb", "bge-m3-onnx"), { recursive: true });
  const entries = [];
  for (const relative of files) {
    const full = path.join(root, "usb", "bge-m3-onnx", relative);
    if ((await fs.stat(full)).isFile()) entries.push({ name: `bge-m3-onnx/${relative.split(path.sep).join("/")}`, data: await fs.readFile(full) });
  }
  await fs.writeFile(archive, makeZip(entries));
  const imported = await model(["import", archive], env);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(imported.json.model.copied.length, 5);
  assert.equal(imported.json.index.dense_documents, 4, "every note has a vector");
  assert.equal(imported.json.index.dense_backend, "onnx");

  const status = await model(["status"], env);
  assert.deepEqual([status.code, status.json.installed, status.json.hashed], [0, true, []], "the import's own check is on record");

  const client = await connect(env, t);
  const embedding = await toolJson(client, "embedding_status", {});
  assert.deepEqual([embedding.json.backend, embedding.json.installed, embedding.json.available], ["onnx", true, true]);

  // No note says "sql", "database" or "query": only the dense half can know
  // that persistence.md is the one about databases.
  const hybrid = await toolJson(client, "hybrid_search", { query: "sql database query", dense_weight: 0.9, limit: 4 });
  assert.equal(hybrid.isError, false, hybrid.text);
  const results = Array.isArray(hybrid.json) ? hybrid.json : hybrid.json?.results ?? [];
  const top = results[0];
  assert.equal(top?.path, "02-knowledge/persistence.md", hybrid.text);
  assert.ok(top.dense_score > 0.9, `dense score ${top.dense_score}`);
  const others = results.filter((item) => item.path !== "02-knowledge/persistence.md");
  assert.ok(others.every((item) => item.dense_score < 0.2), "the other topics are far away");

  const embedded = await toolJson(client, "embed_texts", { texts: ["react button", "docker pipeline"] });
  assert.equal(embedded.json.dimensions, 1024);
  assert.equal(embedded.json.count, 2);
  await client.close();

  // Without the model, search still answers, and embedding says what to do.
  const removed = await model(["remove"], env);
  assert.equal(removed.code, 0);
  assert.ok(removed.json.removed.includes("onnx/model_int8.onnx"));
  await assert.rejects(fs.access(modelDir), /ENOENT/);
  const after = await connect(env, t);
  const keyword = await toolJson(after, "hybrid_search", { query: "postgres schema", limit: 4 });
  assert.equal(keyword.isError, false);
  const keywordResults = Array.isArray(keyword.json) ? keyword.json : keyword.json?.results ?? [];
  assert.equal(keywordResults[0]?.path, "02-knowledge/persistence.md");
  assert.ok(keywordResults.every((item) => !item.dense_score), "no model, no dense half");
  const refused = await toolJson(after, "embed_texts", { text: "hello" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Dense search is not installed: the model is not on this machine\. Run `npm run setup -- --model`/);
  const health = await toolJson(after, "embedding_status", {});
  assert.equal(health.json.installed, false);
  await after.close();
});

test("the model command refuses what it cannot do, with the exit codes a script branches on", { timeout: 60_000 }, async (t) => {
  const { root, env } = await stage(t);
  const install = await model(["install"], env);
  assert.equal(install.code, 1);
  assert.match(install.json.error, /AI_DEV_OFFLINE=1 prevents downloads.*npm run model -- import/s);
  const missing = await model(["import", path.join(root, "nowhere")], env);
  assert.deepEqual([missing.code, /does not exist/.test(missing.json.error)], [1, true]);
  const verify = await model(["verify"], env);
  assert.deepEqual([verify.code, verify.json.ready, verify.json.missing.length], [1, false, 5]);
  const status = await model(["status"], env);
  assert.deepEqual([status.code, status.json.installed], [1, false]);
});
