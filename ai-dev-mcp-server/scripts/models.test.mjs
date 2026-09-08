import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelStatus, pullModel } from "./models.mjs";

test("model pull verifies every downloaded artifact before marking the model ready", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-model-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = Buffer.from("verified-model-fixture");
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  const server = http.createServer((request, response) => { response.end(request.url === "/model.bin" ? content : "missing"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const manifest = { model: "fixture", revision: "abc", dtype: "q8", sources: [`http://127.0.0.1:${server.address().port}`], files: { "model.bin": digest } };
  const status = await pullModel({ targetDir: root, expected: manifest, log: () => undefined });
  assert.equal(status.ready, true);
  await fs.writeFile(path.join(root, "model.bin"), "corrupt");
  assert.deepEqual((await modelStatus(root, manifest)).missing, ["model.bin"]);
});
