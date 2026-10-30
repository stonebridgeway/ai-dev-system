import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// What docker/Dockerfile promises, read from the file: the image is built and
// run in CI (docker-publish.yml) and here only where Docker is, so the promises
// that a 2.x config, a 2.x volume or a reader of the file depends on are held
// by a test that runs everywhere.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = await fs.readFile(path.join(repositoryRoot, "docker", "Dockerfile"), "utf8");
const instructions = dockerfile.split("\n").filter((line) => /^[A-Z]+ /.test(line));
// What the build runs, without what its comments say.
const code = dockerfile.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

test("the image keeps what 2.x configs and volumes name: the server's path, the command, the volume, the user, the variables", () => {
  assert.match(dockerfile, /ln -s ai-dev-mcp-server \/opt\/ai-dev\/app/, "docker exec … node /opt/ai-dev/app/src/server.mjs, and 2.x volumes' 09-mcp links");
  assert.match(dockerfile, /ln -s seed \/opt\/ai-dev\/public-seed/);
  assert.equal(instructions.filter((line) => line.startsWith("CMD ")).at(-1), 'CMD ["node", "/opt/ai-dev/app/src/server.mjs"]');
  assert.ok(instructions.includes('VOLUME ["/data"]'));
  assert.ok(instructions.includes("USER node"));
  assert.match(dockerfile, /useradd --uid 1000 --gid node/);
  for (const variable of ["AI_DEV_RUNTIME=docker", "AI_DEV_VAULT_ROOT=/data/ai-dev-system", "AI_DEV_HOME=/data/runtime-home/.ai-dev",
    "AI_DEV_STATE_ROOT=/data/runtime-home/.ai-dev/state", "AI_DEV_SEARCH_INDEX_DIR=/data/runtime-home/.ai-dev/cache/search-index",
    "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT=/data/runtime-home/.ai-dev/artifacts/frontend-qa", "HOME=/data/runtime-home"]) {
    assert.ok(dockerfile.includes(variable), variable);
  }
});

test("the image is the distribution, checked file by file, with no Python and the model left to the volume or a mount", () => {
  assert.match(dockerfile, /COPY ai-dev\/ \.\//);
  assert.match(dockerfile, /verify-distribution\.mjs --root \/opt\/ai-dev/);
  const apt = /apt-get install -y --no-install-recommends ([^\n]+)/.exec(dockerfile)?.[1] ?? "";
  assert.deepEqual(apt.replace(/\\$/, "").trim().split(/\s+/).sort(), ["ca-certificates", "git", "tini"]);
  assert.doesNotMatch(code, /python/i);
  // A model folder in the ENV would hide the one `ai-dev model install` puts in the volume.
  assert.doesNotMatch(code, /BGE_M3_ONNX_DIR=/);
  // The default target is the server; the browser is a variant of its own.
  const stages = instructions.filter((line) => line.startsWith("FROM "));
  assert.equal(stages.at(-1), "FROM server-build AS server");
  assert.ok(stages.includes("FROM browser-deps AS browser"));
  assert.match(dockerfile, /git config --system --add safe\.directory '\*'/, "projects of another owner are repositories");
});

test("a build passing INSTALL_BGE_M3=1 is told what replaced it, until 4.0", () => {
  // Removing a public name goes through a notice until 4.0: the argument stays declared.
  assert.ok(instructions.includes("ARG INSTALL_BGE_M3=0"));
  const notice = /RUN if \[ "\$\{INSTALL_BGE_M3\}" = "1" \]; then \\\n\s+echo "([^"]+)" >&2/.exec(dockerfile)?.[1] ?? "";
  assert.match(notice, /^INSTALL_BGE_M3=1 is no longer used: 3\.0 removed the dense backend it installed/);
  assert.match(notice, /--mount type=volume,source=ai-dev-system-data,target=\/data <image> ai-dev model install/, "the way the model gets into the volume");
  assert.match(notice, /bge-m3-onnx\/ at \/models/, "and the way a host's model is mounted");
  // In the stage both variants build on.
  const stage = dockerfile.slice(dockerfile.indexOf("AS server-build"), dockerfile.indexOf("AS browser-deps"));
  assert.ok(stage.includes("ARG INSTALL_BGE_M3=0") && stage.includes('[ "${INSTALL_BGE_M3}" = "1" ]'));
});

test("pnpm is the version Frontend QA names in packageManager, not one written in the Dockerfile", async () => {
  const frontendQa = JSON.parse(await fs.readFile(path.join(repositoryRoot, "frontend-qa", "package.json"), "utf8"));
  assert.match(frontendQa.packageManager, /^pnpm@\d+\.\d+\.\d+/);
  assert.doesNotMatch(code, /pnpm@\d/, "a pnpm version in the Dockerfile drifts from packageManager");
  assert.match(dockerfile, /require\('\/opt\/ai-dev\/frontend-qa\/package\.json'\)\.packageManager/);
});
