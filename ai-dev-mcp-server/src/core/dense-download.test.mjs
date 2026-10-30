import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BLOCKED_DOWNLOAD_ADVICE,
  describeOutOfSpace,
  describeWriteFailure,
  downloadDenseModel,
  modelSources,
  PART_META_SUFFIX,
  PART_SUFFIX,
  readPartMeta,
  sweepOrphanParts,
  writeAll
} from "./dense-download.mjs";
import { parseDenseManifest } from "./dense-manifest.mjs";
import { openUrl } from "./http-download.mjs";
import { startModelHost, startProxy, TEST_HOST, TEST_TLS } from "../../test/fixtures/model-host.mjs";

const digestOf = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Random bytes, so a resumed file that skipped or repeated a byte cannot hash
// right by accident.
const WEIGHTS = crypto.randomBytes(256 * 1024);
const FILES = { "config.json": Buffer.from("{\"model_type\":\"xlm-roberta\"}"), "onnx/model_int8.onnx": WEIGHTS };
const REVISION = "a".repeat(40);

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * A disk with a fixed amount of room on it, so the suite's verdict does not
 * depend on how full the machine running it is.
 */
const disk = (free) => async () => ({ bsize: 4096, bavail: free / 4096 });
const roomy = disk(80 * GB);

function manifestFor(sources, overrides = {}) {
  return parseDenseManifest({
    model: "BAAI/bge-m3",
    export: "Xenova/bge-m3",
    revision: REVISION,
    dtype: "int8",
    dimensions: 1024,
    sources,
    files: Object.fromEntries(Object.entries(FILES).map(([name, body]) => [name, digestOf(body)])),
    ...overrides
  });
}

async function stageDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-download-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const quiet = () => {};
const weightsAt = (dir) => path.join(dir, "onnx", "model_int8.onnx");
const gets = (host, file = "model_int8.onnx") => host.requests.filter((entry) => entry.method === "GET" && entry.path.endsWith(file));

/** Run a download and hand back its error, or null. */
const attempt = (options) => downloadDenseModel({ log: quiet, statfs: roomy, env: {}, ...options }).then(() => null, (error) => error);

test("a good host lands every file, reports progress to the last byte, and leaves no .part behind", async (t) => {
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const events = [];

  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: quiet, statfs: roomy, env: {}, onProgress: (event) => events.push(event) });

  assert.equal(result.ready, true);
  assert.equal(result.downloaded, 2);
  assert.equal(result.bytes, FILES["config.json"].length + WEIGHTS.length);
  assert.deepEqual(await fs.readFile(weightsAt(dir)), WEIGHTS);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")).revision, REVISION);
  assert.deepEqual((await fs.readdir(path.join(dir, "onnx"))).sort(), ["model_int8.onnx"]);
  const last = events.at(-1);
  assert.equal(last.phase, "done");
  assert.equal(last.bytes, last.total);
  assert.equal(last.total, FILES["config.json"].length + WEIGHTS.length, "sizes came from HEAD before the first byte");
  assert.equal(last.filesDone, 2);
  assert.ok(events.some((event) => event.file === "onnx/model_int8.onnx" && event.source === `127.0.0.1:${host.port}`));
  for (const event of events) assert.ok(event.bytes <= event.total, "never past the total");
});

test("a second run fetches nothing", async (t) => {
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const manifest = manifestFor([host.base]);
  await downloadDenseModel({ manifest, targetDir: dir, log: quiet, statfs: roomy, env: {} });
  const before = host.requests.length;
  const again = await downloadDenseModel({ manifest, targetDir: dir, log: quiet, statfs: roomy, env: {} });
  assert.equal(again.ready, true);
  assert.equal(again.downloaded, 0);
  assert.equal(host.requests.length, before, "files whose digest already matches are not asked for");
});

test("a transfer cut at 50 % is continued from that byte, and the file hashes right", async (t) => {
  const half = WEIGHTS.length / 2;
  const host = await startModelHost({ files: FILES, cutAfter: new Map([["onnx/model_int8.onnx", half]]) });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const manifest = manifestFor([host.base]);

  const failure = await attempt({ manifest, targetDir: dir });
  assert.ok(failure, "the cut is a failure of this run");
  assert.match(failure.message, /^Could not fetch onnx\/model_int8\.onnx: the connection to 127\.0\.0\.1:\d+ closed after \d+(?:\.\d)? KB of 256 KB\. \d+(?:\.\d)? KB of it are kept; running the install again continues from there\.$/);
  const part = `${weightsAt(dir)}${PART_SUFFIX}`;
  // What arrived, less what Node still held in the stream's buffer when the
  // connection broke — a few bytes, never more than were sent.
  const kept = (await fs.stat(part)).size;
  assert.ok(kept > half * 0.75 && kept <= half, `kept ${kept} of ${half}`);
  const meta = await readPartMeta(weightsAt(dir));
  assert.deepEqual([meta.revision, meta.sha256, meta.size], [REVISION, digestOf(WEIGHTS), WEIGHTS.length], "and so is what they are the start of");

  const result = await downloadDenseModel({ manifest, targetDir: dir, log: quiet, statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  assert.equal(result.resumed, 1);
  assert.deepEqual(await fs.readFile(weightsAt(dir)), WEIGHTS);
  assert.deepEqual(gets(host).map((entry) => [entry.range, entry.status, entry.sent]), [
    ["", 200, half],
    [`bytes=${kept}-`, 206, WEIGHTS.length - kept]
  ], "the second request starts where the disk ends");
  await assert.rejects(fs.access(part), /ENOENT/);
  await assert.rejects(fs.access(`${weightsAt(dir)}${PART_META_SUFFIX}`), /ENOENT/);
});

test("bytes that do not match the manifest never take the name, and nothing of them is kept", async (t) => {
  const host = await startModelHost({ files: FILES, corrupt: new Set(["onnx/model_int8.onnx"]) });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const failure = await attempt({ manifest: manifestFor([host.base]), targetDir: dir });
  assert.match(failure.message, /checksum mismatch for model_int8\.onnx: got [0-9a-f]{64}, manifest says [0-9a-f]{64}/);
  assert.deepEqual(await fs.readdir(path.join(dir, "onnx")), [], "no file, no .part, no .part.json");
});

test("a .part of another revision, or with nothing to say what it is, is not continued", async (t) => {
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  for (const meta of [{ format: 1, revision: "b".repeat(40), sha256: digestOf(WEIGHTS), size: WEIGHTS.length }, null]) {
    const dir = await stageDir(t);
    await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
    await fs.writeFile(`${weightsAt(dir)}${PART_SUFFIX}`, WEIGHTS.subarray(0, 1000));
    if (meta) await fs.writeFile(`${weightsAt(dir)}${PART_META_SUFFIX}`, JSON.stringify(meta));
    const lines = [];
    host.requests.length = 0;
    const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: (line) => lines.push(line), statfs: roomy, env: {} });
    assert.equal(result.ready, true);
    assert.deepEqual(gets(host).map((entry) => entry.range), [""], "fetched from the first byte");
    if (meta) assert.ok(lines.some((line) => /another revision/.test(line)), lines.join("\n"));
  }
});

test("continued bytes that turn out wrong are fetched once more from the start before the source is blamed", async (t) => {
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  const dir = await stageDir(t);
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  // The right length and the right label, the wrong bytes: a disk that lost
  // a page, or a writer killed mid-chunk.
  await fs.writeFile(`${weightsAt(dir)}${PART_SUFFIX}`, Buffer.alloc(4096, 7));
  await fs.writeFile(`${weightsAt(dir)}${PART_META_SUFFIX}`, JSON.stringify({ format: 1, revision: REVISION, sha256: digestOf(WEIGHTS), size: WEIGHTS.length }));
  const lines = [];
  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: (line) => lines.push(line), statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  assert.deepEqual(gets(host).map((entry) => entry.range), ["bytes=4096-", ""]);
  assert.ok(lines.some((line) => /did not match; fetching it again from the start/.test(line)), lines.join("\n"));
});

test("a host that ignores Range starts the file over instead of appending the whole file to half of it", async (t) => {
  const host = await startModelHost({ files: FILES, noRange: true });
  t.after(() => host.close());
  const dir = await stageDir(t);
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  await fs.writeFile(`${weightsAt(dir)}${PART_SUFFIX}`, WEIGHTS.subarray(0, 1000));
  await fs.writeFile(`${weightsAt(dir)}${PART_META_SUFFIX}`, JSON.stringify({ format: 1, revision: REVISION, sha256: digestOf(WEIGHTS), size: WEIGHTS.length }));
  const lines = [];
  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: (line) => lines.push(line), statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  assert.deepEqual(await fs.readFile(weightsAt(dir)), WEIGHTS, "1,000 bytes and then the whole file would not hash right");
  assert.deepEqual(gets(host).map((entry) => [entry.range, entry.status]), [["bytes=1000-", 200]]);
  assert.ok(lines.some((line) => /does not resume downloads; starting this file over/.test(line)), lines.join("\n"));
});

test("a .part that is already whole is finished without asking the host for anything", async (t) => {
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  const dir = await stageDir(t);
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  await fs.writeFile(`${weightsAt(dir)}${PART_SUFFIX}`, WEIGHTS);
  await fs.writeFile(`${weightsAt(dir)}${PART_META_SUFFIX}`, JSON.stringify({ format: 1, revision: REVISION, sha256: digestOf(WEIGHTS), size: WEIGHTS.length }));
  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: quiet, statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  assert.deepEqual(gets(host), [], "killed between the last byte and the rename: nothing left to fetch");

  // Without a size on record the host is asked, and its 416 says the same.
  const second = await stageDir(t);
  await fs.mkdir(path.join(second, "onnx"), { recursive: true });
  await fs.writeFile(`${weightsAt(second)}${PART_SUFFIX}`, WEIGHTS);
  await fs.writeFile(`${weightsAt(second)}${PART_META_SUFFIX}`, JSON.stringify({ format: 1, revision: REVISION, sha256: digestOf(WEIGHTS), size: null }));
  const noHead = await startModelHost({ files: FILES, noHead: true });
  t.after(() => noHead.close());
  const again = await downloadDenseModel({ manifest: manifestFor([noHead.base]), targetDir: second, log: quiet, statfs: roomy, env: {} });
  assert.equal(again.ready, true);
  assert.deepEqual(gets(noHead).map((entry) => [entry.range, entry.status]), [[`bytes=${WEIGHTS.length}-`, 416]]);
});

test("a source answering 503 hands over to the next one, which finishes the job", async (t) => {
  const dead = await startModelHost({ files: FILES, fail: new Map([["config.json", 503], ["onnx/model_int8.onnx", 503]]) });
  const alive = await startModelHost({ files: FILES });
  t.after(() => Promise.all([dead.close(), alive.close()]));
  const dir = await stageDir(t);
  const lines = [];
  const result = await downloadDenseModel({ manifest: manifestFor([dead.base, alive.base]), targetDir: dir, log: (line) => lines.push(line), statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  assert.ok(lines.some((line) => /source failed for config\.json: .*returned HTTP 503: not here/.test(line)), lines.join("\n"));
  assert.equal(gets(alive).length, 1);
});

test("a source that breaks mid-file hands its .part to the next source, which continues it", async (t) => {
  const half = WEIGHTS.length / 2;
  const breaking = await startModelHost({ files: FILES, cutAfter: new Map([["onnx/model_int8.onnx", half]]) });
  const alive = await startModelHost({ files: FILES });
  t.after(() => Promise.all([breaking.close(), alive.close()]));
  const dir = await stageDir(t);
  const result = await downloadDenseModel({ manifest: manifestFor([breaking.base, alive.base]), targetDir: dir, log: quiet, statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  const [range] = gets(alive).map((entry) => entry.range);
  const from = Number(range?.match(/^bytes=(\d+)-$/)?.[1]);
  assert.ok(from > half * 0.75 && from <= half, `continued from ${range}`);
});

test("every source failing reports the last reason and the ways round it; no sources and offline both say so first", async (t) => {
  const dead = await startModelHost({ files: FILES, fail: new Map([["config.json", 500]]) });
  t.after(() => dead.close());
  const failed = await attempt({ manifest: manifestFor([dead.base]), targetDir: await stageDir(t) });
  assert.match(failed.message, /Could not fetch config\.json: .*HTTP 500/s);
  assert.ok(failed.message.endsWith(` ${BLOCKED_DOWNLOAD_ADVICE}`), "nothing came through, so the mirror, the proxy and the import are named");
  assert.match(BLOCKED_DOWNLOAD_ADVICE, /AI_DEV_MODEL_MIRROR.*HTTPS_PROXY.*`npm run model -- import <folder or \.zip>`/s);
  const corrupt = await startModelHost({ files: FILES, corrupt: new Set(["config.json"]) });
  t.after(() => corrupt.close());
  const mismatch = await attempt({ manifest: manifestFor([corrupt.base]), targetDir: await stageDir(t) });
  assert.doesNotMatch(mismatch.message, /AI_DEV_MODEL_MIRROR/, "a source that answered with other bytes is not a blocked network");
  assert.match((await attempt({ manifest: manifestFor([]), targetDir: await stageDir(t) })).message, /lists no sources/);
  // A mirror that serves other bytes, then the manifest's own source unreachable: the mirror is named, not the network.
  const served = await attempt({ manifest: manifestFor([dead.base]), env: { AI_DEV_MODEL_MIRROR: `${corrupt.base}/mirror` }, targetDir: await stageDir(t) });
  assert.match(served.message, /Could not fetch config\.json: 127\.0\.0\.1:\d+: .*; 127\.0\.0\.1:\d+: .*HTTP 500/s, "each source's answer, by its host");
  assert.match(served.message, /127\.0\.0\.1:\d+ is not a mirror of .* at revision \w{12}: point AI_DEV_MODEL_MIRROR at one that is/);
  assert.ok(!served.message.endsWith(BLOCKED_DOWNLOAD_ADVICE), "the network is not what failed");
  const offline = await attempt({ manifest: manifestFor(["http://127.0.0.1:1/m"]), targetDir: await stageDir(t), env: { AI_DEV_OFFLINE: "1" } });
  assert.match(offline.message, /AI_DEV_OFFLINE=1 prevents downloads.*npm run model -- import/s);
});

test("AI_DEV_MODEL_MIRROR, then HF_ENDPOINT, come before the manifest's sources, read as Hugging Face endpoints", async (t) => {
  const manifest = manifestFor(["https://huggingface.co/Xenova/bge-m3/resolve/r"]);
  assert.deepEqual(modelSources(manifest, { AI_DEV_MODEL_MIRROR: "https://mirror.example/", HF_ENDPOINT: "https://hf-mirror.com" }), [
    `https://mirror.example/Xenova/bge-m3/resolve/${REVISION}`,
    `https://hf-mirror.com/Xenova/bge-m3/resolve/${REVISION}`,
    "https://huggingface.co/Xenova/bge-m3/resolve/r"
  ]);
  assert.deepEqual(modelSources(manifest, { HF_ENDPOINT: "https://huggingface.co/Xenova/bge-m3/resolve/r/../../../../" }).length, 2);
  assert.throws(() => modelSources(manifest, { AI_DEV_MODEL_MIRROR: "hf-mirror.com" }), /AI_DEV_MODEL_MIRROR=hf-mirror\.com is not an http\(s\) address/);

  const dead = await startModelHost({ files: FILES, fail: new Map([["config.json", 503], ["onnx/model_int8.onnx", 503]]) });
  const mirror = await startModelHost({ files: FILES });
  t.after(() => Promise.all([dead.close(), mirror.close()]));
  const dir = await stageDir(t);
  const result = await downloadDenseModel({
    manifest: manifestFor([dead.base]),
    targetDir: dir,
    log: quiet,
    statfs: roomy,
    env: { AI_DEV_MODEL_MIRROR: `http://127.0.0.1:${mirror.port}` }
  });
  assert.equal(result.ready, true);
  assert.deepEqual(gets(mirror, "").map((entry) => entry.path).sort(), [
    `/Xenova/bge-m3/resolve/${REVISION}/config.json`,
    `/Xenova/bge-m3/resolve/${REVISION}/onnx/model_int8.onnx`
  ]);
  assert.deepEqual(gets(dead, ""), [], "the mirror answered, so the manifest's source was never asked");
});

test("behind an HTTP proxy the download goes through it, for a host only the proxy can reach", async (t) => {
  const host = await startModelHost({ files: FILES });
  const proxy = await startProxy({ hosts: { [TEST_HOST]: host.port } });
  t.after(() => Promise.all([host.close(), proxy.close()]));
  const source = `http://${TEST_HOST}:${host.port}/m`;
  const result = await downloadDenseModel({ manifest: manifestFor([source]), targetDir: await stageDir(t), log: quiet, statfs: roomy, env: { HTTP_PROXY: proxy.url } });
  assert.equal(result.ready, true);
  assert.ok(proxy.seen.includes(`GET ${source}/onnx/model_int8.onnx`), proxy.seen.join("\n"));

  // The same host on NO_PROXY is asked directly — and does not resolve.
  const direct = await attempt({ manifest: manifestFor([source]), targetDir: await stageDir(t), env: { HTTP_PROXY: proxy.url, NO_PROXY: TEST_HOST } });
  assert.match(direct.message, /models\.example\.test could not be resolved/);
});

test("behind an HTTPS proxy the download tunnels with CONNECT, and a cut is continued through the tunnel", async (t) => {
  const half = WEIGHTS.length / 2;
  const host = await startModelHost({ files: FILES, tls: true, redirect: true, cutAfter: new Map([["onnx/model_int8.onnx", half]]) });
  const proxy = await startProxy({ hosts: { [TEST_HOST]: host.port } });
  t.after(() => Promise.all([host.close(), proxy.close()]));
  const manifest = manifestFor([`https://${TEST_HOST}:${host.port}/m`]);
  const dir = await stageDir(t);
  const request = (url, options) => openUrl(url, { ...options, ca: TEST_TLS.cert });
  const env = { HTTPS_PROXY: proxy.url };
  assert.ok(await attempt({ manifest, targetDir: dir, env, request }));
  const result = await downloadDenseModel({ manifest, targetDir: dir, log: quiet, statfs: roomy, env, request });
  assert.equal(result.ready, true);
  assert.deepEqual(await fs.readFile(weightsAt(dir)), WEIGHTS);
  assert.ok(proxy.seen.every((line) => line === `CONNECT ${TEST_HOST}:${host.port}`), proxy.seen.join("\n"));
  const ranges = host.requests.filter((entry) => entry.method === "GET" && entry.path === "/cdn/onnx/model_int8.onnx").map((entry) => entry.range);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0], "");
  assert.match(ranges[1], /^bytes=\d+-$/, "the CDN behind the redirect was asked for the rest");
  assert.ok(Number(ranges[1].slice(6, -1)) > 0);
});

test("cancelling keeps what arrived, and the next run continues from it", async (t) => {
  const host = await startModelHost({ files: FILES, chunkDelayMs: 5 });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const manifest = manifestFor([host.base]);
  const controller = new AbortController();
  const failure = await attempt({
    manifest,
    targetDir: dir,
    signal: controller.signal,
    onProgress: (event) => {
      if (event.file === "onnx/model_int8.onnx" && event.bytes - FILES["config.json"].length >= 40_000) controller.abort();
    }
  });
  assert.equal(failure?.name, "AbortError");
  assert.equal(failure.cancelled, true);
  assert.match(failure.message, /^Download cancelled\. .* of onnx\/model_int8\.onnx are kept; running the install again continues from there\.$/);
  const kept = (await fs.stat(`${weightsAt(dir)}${PART_SUFFIX}`)).size;
  assert.ok(kept >= 40_000 && kept < WEIGHTS.length, `kept ${kept}`);

  host.requests.length = 0;
  const result = await downloadDenseModel({ manifest, targetDir: dir, log: quiet, statfs: roomy, env: {} });
  assert.equal(result.ready, true);
  assert.deepEqual(gets(host).map((entry) => entry.range), [`bytes=${kept}-`]);
  assert.deepEqual(await fs.readFile(weightsAt(dir)), WEIGHTS);

  const before = new AbortController();
  before.abort();
  const early = await attempt({ manifest, targetDir: await stageDir(t), signal: before.signal });
  assert.equal(early.cancelled, true);
});

test("a source that goes silent is given up on within the stall window, and its bytes are kept", async (t) => {
  // A CDN that sent 510 MB of 542 and then nothing held a Windows run
  // past ten minutes. Now it costs the stall window and none of the bytes.
  const host = await startModelHost({ files: FILES, stallAfter: new Map([["onnx/model_int8.onnx", 10_000]]) });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const started = Date.now();
  const failure = await attempt({ manifest: manifestFor([host.base]), targetDir: dir, stallMs: 300 });
  assert.match(failure.message, /no data for 0s from 127\.0\.0\.1:\d+\. The source accepted the connection and then stopped sending\./);
  assert.ok(Date.now() - started < 5000);
  assert.equal((await fs.stat(`${weightsAt(dir)}${PART_SUFFIX}`)).size, 10_000);
});

test("a source that takes the connection and never answers the size probe costs one stall window, then the next serves", async (t) => {
  // Reads and never answers; reading is what lets it see the client hang up.
  const silent = net.createServer((socket) => socket.resume());
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => silent.close(resolve)));
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  const started = Date.now();
  const result = await downloadDenseModel({
    manifest: manifestFor([`http://127.0.0.1:${silent.address().port}/m`, host.base]), targetDir: await stageDir(t), log: quiet, statfs: roomy, env: {}, stallMs: 300
  });
  assert.equal(result.ready, true);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms: once for the probe, not once per file and request`);
  // A proxy that never answers CONNECT is the same wait, then a sentence.
  const proxy = net.createServer((socket) => socket.resume());
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const tunnelled = Date.now();
  const failure = await attempt({ manifest: manifestFor(["https://models.example.test/m"]), targetDir: await stageDir(t), stallMs: 300, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } });
  assert.match(failure.message, /no data for 0s from models\.example\.test/);
  assert.ok(Date.now() - tunnelled < 3000);
});

test("a disk that will not take the file is said as the disk's, once, not blamed on the network", async (t) => {
  const host = await startModelHost({ files: FILES });
  t.after(() => host.close());
  const dir = await stageDir(t);
  // The partial file's name taken by a folder: the open fails with EISDIR.
  await fs.mkdir(`${weightsAt(dir)}${PART_SUFFIX}`, { recursive: true });
  const second = await startModelHost({ files: FILES });
  t.after(() => second.close());
  const failure = await attempt({ manifest: manifestFor([host.base, second.base]), targetDir: dir });
  assert.match(failure.message, /^Could not write onnx\/model_int8\.onnx into .*onnx: .*\(EISDIR\)\. Once that is fixed, run the install again\.$/);
  assert.equal(failure.final, true);
  assert.equal(gets(second).length, 0, "another source would fail the same way, so none is asked");
  assert.doesNotMatch(failure.message, /connection/);
  const quota = describeWriteFailure(Object.assign(new Error("quota"), { code: "EDQUOT" }), { relative: "onnx/model_int8.onnx", target: "/m/onnx/model_int8.onnx", kept: 300 * MB });
  assert.equal(quota.message, "Could not write onnx/model_int8.onnx into /m/onnx: this account's disk quota is used up (EDQUOT). "
    + "300 MB of it are kept; once that is fixed, running the install again continues from there.");
});

test("a short write is finished before the next chunk, so the bytes on disk are the bytes hashed", async () => {
  const written = [];
  const trickle = { write: async (buffer, offset, length) => { written.push(buffer.subarray(offset, offset + Math.min(3, length))); return { bytesWritten: Math.min(3, length) }; } };
  await writeAll(trickle, Buffer.from("0123456789"));
  assert.equal(Buffer.concat(written).toString(), "0123456789");
  const stuck = { write: async () => ({ bytesWritten: 0 }) };
  await assert.rejects(writeAll(stuck, Buffer.from("x")), (error) => error.code === "EIO");
});

test("a mirror's password stays out of messages and the partial file's record", async (t) => {
  const dead = await startModelHost({ files: FILES, fail: new Map([["config.json", 503]]) });
  t.after(() => dead.close());
  const secret = ["mirror", "PW", "42"].join("");
  const withPassword = dead.base.replace("http://", `http://bob:${secret}@`);
  const logged = [];
  const failure = await downloadDenseModel({ manifest: manifestFor([withPassword]), targetDir: await stageDir(t), log: (line) => logged.push(line), statfs: roomy, env: {} })
    .then(() => null, (error) => error);
  assert.match(failure.message, /http:\/\/\*\*\*@127\.0\.0\.1:\d+\/m\/config\.json returned HTTP 503/);
  assert.equal([failure.message, ...logged].some((line) => line.includes(secret)), false);
  const cut = await startModelHost({ files: FILES, cutAfter: new Map([["onnx/model_int8.onnx", 1000]]) });
  t.after(() => cut.close());
  const dir = await stageDir(t);
  await attempt({ manifest: manifestFor([cut.base.replace("http://", `http://bob:${secret}@`)]), targetDir: dir });
  const meta = await readPartMeta(weightsAt(dir));
  assert.match(meta.source, /^http:\/\/\*\*\*@127\.0\.0\.1:/);
  assert.throws(() => modelSources(manifestFor([]), { AI_DEV_MODEL_MIRROR: `ftp://bob:${secret}@mirror` }), (error) => !error.message.includes(secret));
});

test("a slow source that keeps sending is not cut off", async (t) => {
  const host = await startModelHost({ files: FILES, chunkDelayMs: 20 });
  t.after(() => host.close());
  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: await stageDir(t), log: quiet, statfs: roomy, env: {}, stallMs: 400 });
  assert.equal(result.ready, true, "64 pieces 20 ms apart outlast a 400 ms window many times over");
});

test("2.x .part files of killed runs are swept; this version's .part is never swept for its age", async (t) => {
  const dir = await stageDir(t);
  const target = path.join(dir, "model_int8.onnx");
  const orphan = `${target}.10584.part`;
  const live = `${target}.17124.part`;
  const current = `${target}${PART_SUFFIX}`;
  await fs.writeFile(orphan, "abandoned");
  await fs.writeFile(live, "in progress");
  await fs.writeFile(current, "resumable");
  await fs.writeFile(path.join(dir, "notes.txt"), "keep me");
  const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
  await fs.utimes(orphan, longAgo, longAgo);
  await fs.utimes(current, longAgo, longAgo);
  assert.deepEqual(await sweepOrphanParts(target), ["model_int8.onnx.10584.part"]);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["model_int8.onnx.17124.part", "model_int8.onnx.part", "notes.txt"]);
});

test("a download that does not fit is refused before a byte is fetched, and a partial one needs only the rest", async (t) => {
  // 601 MB of model against 280 MB of disk.
  const host = await startModelHost({ files: FILES, headSizes: { "onnx/model_int8.onnx": 601 * MB } });
  t.after(() => host.close());
  const dir = await stageDir(t);
  const failure = await attempt({ manifest: manifestFor([host.base]), targetDir: dir, statfs: disk(280 * MB) });
  assert.match(failure.message, /Not enough free space/);
  assert.match(failure.message, /601 MB/);
  assert.match(failure.message, /280 MB is available/);
  assert.deepEqual(host.requests.filter((entry) => entry.method !== "HEAD"), []);
  assert.deepEqual(await fs.readdir(dir), []);

  // 400 bytes still to come, 512 MB + 1 KB free: room for the rest, not for the whole.
  const partial = await stageDir(t);
  await fs.mkdir(path.join(partial, "onnx"), { recursive: true });
  await fs.writeFile(`${weightsAt(partial)}${PART_SUFFIX}`, WEIGHTS.subarray(0, WEIGHTS.length - 400));
  await fs.writeFile(`${weightsAt(partial)}${PART_META_SUFFIX}`, JSON.stringify({ format: 1, revision: REVISION, sha256: digestOf(WEIGHTS), size: WEIGHTS.length }));
  await fs.writeFile(path.join(partial, "config.json"), FILES["config.json"]);
  const plain = await startModelHost({ files: FILES });
  t.after(() => plain.close());
  const result = await downloadDenseModel({ manifest: manifestFor([plain.base]), targetDir: partial, log: quiet, env: {}, statfs: disk(512 * MB + 1024) });
  assert.equal(result.ready, true);
});

test("a tight disk is said once, a host with no HEAD is checked on the GET, and an unmeasurable disk is no verdict", async (t) => {
  const big = await startModelHost({ files: FILES, headSizes: { "onnx/model_int8.onnx": 601 * MB } });
  t.after(() => big.close());
  const lines = [];
  const tight = await downloadDenseModel({ manifest: manifestFor([big.base]), targetDir: await stageDir(t), env: {}, statfs: disk(3 * GB), log: (line) => lines.push(line) });
  assert.equal(tight.ready, true);
  assert.equal(lines.filter((line) => /3\.0 GB free.*not the network/s.test(line)).length, 1);

  const noHead = await startModelHost({ files: FILES, noHead: true });
  t.after(() => noHead.close());
  const dir = await stageDir(t);
  const refused = await attempt({ manifest: manifestFor([noHead.base]), targetDir: dir, statfs: disk(100 * MB) });
  assert.match(refused.message, /Not enough free space.*100 MB is available/s);
  assert.doesNotMatch(refused.message, /Could not fetch/, "the disk is the reason, not the source");

  const unmeasurable = async () => {
    throw Object.assign(new Error("no statfs here"), { code: "ENOTSUP" });
  };
  const plain = await startModelHost({ files: FILES });
  t.after(() => plain.close());
  assert.equal((await downloadDenseModel({ manifest: manifestFor([plain.base]), targetDir: await stageDir(t), log: quiet, env: {}, statfs: unmeasurable })).ready, true);
});

test("sizes nobody states leave the total unknown, not wrong", async (t) => {
  const host = await startModelHost({ files: FILES, noHead: true });
  t.after(() => host.close());
  const events = [];
  await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: await stageDir(t), log: quiet, statfs: roomy, env: {}, onProgress: (event) => events.push(event) });
  assert.ok(events.every((event) => event.total === null && event.etaSeconds === null));
  assert.equal(events.at(-1).bytes, FILES["config.json"].length + WEIGHTS.length);
});

test("a disk that fills up mid-transfer is said as that, and as resumable", () => {
  const said = describeOutOfSpace(path.join("/home/u/.ai-dev/models/bge-m3-onnx/onnx", "model_int8.onnx"));
  assert.match(said, /^model_int8\.onnx: the disk filled up/);
  assert.match(said, /bge-m3-onnx.onnx/);
  assert.match(said, /what was written is kept, and it continues from there/);
});
