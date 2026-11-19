import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readAllowlist, verifyDistribution } from "../src/core/distribution-build.mjs";
import { buildDistribution } from "./build-dist.mjs";
import { createDockerContext } from "./prepare-docker-context.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// One build for the file: the tests run in order, and the last one may change it.
const dist = path.join(repositoryRoot, "dist", `.test-${process.pid}`);
const docker = path.join(repositoryRoot, ".docker", `test-context-${process.pid}`);
let built;
test.before(async () => {
  built = await buildDistribution({ output: dist, deps: false });
  await createDockerContext({ output: docker });
});
test.after(() => Promise.all([dist, docker].map((folder) => fs.rm(folder, { recursive: true, force: true }))));

test("the Docker build context holds the distribution itself, byte for byte, and the image's own files beside it", async () => {
  assert.equal(built.name, "ai-dev-system");
  assert.equal((await verifyDistribution(dist)).ok, true);

  // The image is the package: the context's ai-dev/ is a distribution that verifies,
  // with the same files and sha256 as `npm run dist` makes.
  const inContext = path.join(docker, "ai-dev");
  const check = await verifyDistribution(inContext);
  assert.equal(check.ok, true, JSON.stringify(check));
  const listed = async (root) => JSON.parse(await fs.readFile(path.join(root, "distribution.json"), "utf8"));
  const [own, context] = [await listed(dist), await listed(inContext)];
  assert.equal(context.content_fingerprint, own.content_fingerprint);
  assert.deepEqual(context.files, own.files);
  assert.ok(own.files.length > 1500, `${own.files.length} files`);
  for (const file of ["package.json", "npm-shrinkwrap.json"]) {
    assert.equal(await fs.readFile(path.join(inContext, file), "utf8"), await fs.readFile(path.join(dist, file), "utf8"), file);
  }
  // Beside it: what only the image needs, and nothing else.
  assert.deepEqual((await fs.readdir(docker)).sort(), [".dockerignore", "Dockerfile", "ai-dev", "container", "context.json"]);
  assert.deepEqual(await fs.readdir(path.join(docker, "container")), ["entrypoint.sh"]);
  assert.equal(await fs.readFile(path.join(docker, "Dockerfile"), "utf8"), await fs.readFile(path.join(repositoryRoot, "docker", "Dockerfile"), "utf8"));
  const record = JSON.parse(await fs.readFile(path.join(docker, "context.json"), "utf8"));
  assert.equal(record.distribution.content_fingerprint, own.content_fingerprint);
  assert.ok(Number.isFinite(Date.parse(record.generated_at)));
  // The allowlist names the image's own files once, for the docker target only.
  const allowlist = await readAllowlist(repositoryRoot);
  assert.deepEqual(allowlist.groups.filter((group) => group.to?.docker !== undefined).map((group) => group.name), ["image", "entrypoint"]);
  assert.ok(allowlist.groups.filter((group) => group.to?.docker === undefined).every((group) => group.to?.dist !== undefined));

  const manifest = JSON.parse(await fs.readFile(path.join(dist, "package.json"), "utf8"));
  await fs.access(path.join(dist, manifest.bin["ai-dev"]));
  assert.deepEqual(Object.keys(manifest.optionalDependencies).sort(), ["@huggingface/transformers", "onnxruntime-node"],
    "the model runtime is optional: its postinstall failing does not fail an install");
  const shrinkwrap = JSON.parse(await fs.readFile(path.join(dist, "npm-shrinkwrap.json"), "utf8"));
  assert.equal(shrinkwrap.packages[""].name, manifest.name);
  assert.equal(shrinkwrap.packages["node_modules/onnxruntime-node"].optional, true);
});

test("a distribution changed after it was built does not verify, so it is never packed", async () => {
  await fs.appendFile(path.join(dist, "seed", "PUBLIC_SEED.md"), "edited\n");
  await fs.writeFile(path.join(dist, "ai-dev-mcp-server", "stray.mjs"), "");
  await fs.rm(path.join(dist, "search-eval", "search_eval_cases.json"));
  await fs.mkdir(path.join(dist, "frontend-qa", "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(dist, "frontend-qa", "node_modules", "x", "i.js"), "");
  const check = await verifyDistribution(dist);
  assert.equal(check.ok, false);
  assert.deepEqual(check.changed, ["seed/PUBLIC_SEED.md"]);
  assert.deepEqual(check.extra, ["ai-dev-mcp-server/stray.mjs"], "installed dependencies are not part of the build; a stray file is");
  assert.deepEqual(check.missing, ["search-eval/search_eval_cases.json"]);
});

test("the output stays below dist/", async () => {
  await assert.rejects(buildDistribution({ output: path.join(repositoryRoot, "ai-dev-mcp-server"), deps: false }), /must stay below/);
});
