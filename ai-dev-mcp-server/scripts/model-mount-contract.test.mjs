import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOCKER_MOUNTED_MODEL_DIR } from "../src/core/dense-backend.mjs";
import { CONTAINER_MODELS, MODEL_FOLDER_MARKERS, dockerRunArgs } from "../src/core/docker-launch.mjs";

// Every copy that mounts AI_DEV_MODEL_PATH into the container — the 2.x
// launchers, the compose example, the 3.0 client entry (`docker-launch.mjs`,
// which bootstrap.sh hands the folder to) — and the image looks for the models
// under one folder. ClaudeMcpProxy.cs mounted it at
// /models/bge-m3 while the other four said /models, so Claude on Windows never
// had dense search — the same decision applied in four
// places out of five, again. This test reads every copy and holds them to one
// answer: the folder the image's model directories sit in.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => fs.readFile(path.join(repositoryRoot, relative), "utf8");

/** Where each copy mounts the model folder, as the copy itself spells it. */
const MOUNT_TARGETS = [
  { file: "docker/run-mcp.sh", pattern: /source=\$\{model_path\},target=([^,"\s]+),readonly/g },
  { file: "docker/run-mcp.ps1", pattern: /source=\$modelPath,target=([^,"\s]+),readonly/g },
  { file: "docker/ClaudeMcpProxy.cs", pattern: /AddBindMount\(arguments, (?:ModelMountSource\(\)|"AI_DEV_MODEL_PATH"), "([^"]+)", true\)/g },
  { file: "docker/compose.local.example.yaml", pattern: /source: \$\{AI_DEV_MODEL_PATH[^\n]*\n\s*#?\s*target: (\S+)/g }
];

/** Where each copy refuses the 2.0.0 value: the files a model folder itself holds. */
const MARKER_LISTS = [
  { file: "docker/run-mcp.sh", pattern: /for marker in ([^;]+); do/g, split: (text) => text.trim().split(/\s+/) },
  { file: "bootstrap.sh", pattern: /for marker in ([^;]+); do/g, split: (text) => text.trim().split(/\s+/) },
  { file: "docker/run-mcp.ps1", pattern: /foreach \(\$marker in @\(([^)]+)\)\)/g, split: quotedList },
  { file: "bootstrap.ps1", pattern: /foreach \(\$marker in @\(([^)]+)\)\)/g, split: quotedList },
  { file: "docker/ClaudeMcpProxy.cs", pattern: /ModelFileMarkers = \{([^}]+)\}/g, split: quotedList }
];

function quotedList(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * The folder the image looks for a mounted model directory in: the server's
 * own (`dense-backend.mjs`). Since 3.0 there is one, the ONNX export's (the
 * Python backend's torch folder went with it), and the image does
 * not name it in its ENV: there it would hide the model `ai-dev model install`
 * puts in the volume.
 */
async function imageModelRoot() {
  const dockerfile = await read("docker/Dockerfile");
  assert.doesNotMatch(dockerfile, /BGE_M3_ONNX_DIR=/, "the image does not pin the model folder to the mount");
  assert.doesNotMatch(dockerfile, /BGE_M3_MODEL_DIR=/, "the Python backend's folder is not set in the image");
  return path.posix.dirname(DOCKER_MOUNTED_MODEL_DIR);
}

test("every copy mounts the model folder where the image looks for the models", async () => {
  const expected = await imageModelRoot();
  assert.equal(expected, "/models");
  // The 3.0 client entry, built by the server's own module.
  assert.equal(CONTAINER_MODELS, expected);
  assert.ok(dockerRunArgs({ image: "x", model: "/host/models" }).includes(`type=bind,source=/host/models,target=${expected},readonly`));
  for (const { file, pattern } of MOUNT_TARGETS) {
    const targets = [...(await read(file)).matchAll(pattern)].map((match) => match[1]);
    assert.ok(targets.length > 0, `${file}: no model mount found — has the copy moved? Update this test with it.`);
    for (const target of targets) assert.equal(target, expected, `${file} mounts the model folder at ${target}`);
  }
});

test("every copy refuses the same old value: a folder holding model files itself", async () => {
  const lists = [];
  for (const { file, pattern, split } of MARKER_LISTS) {
    const found = [...(await read(file)).matchAll(pattern)].map((match) => split(match[1]));
    assert.equal(found.length, 1, `${file}: expected one marker list, found ${found.length}`);
    lists.push({ file, markers: found[0] });
  }
  for (const { file, markers } of lists) {
    assert.deepEqual(markers, ["pytorch_model.bin", "modules.json", "config.json", "onnx"], file);
  }
  assert.deepEqual([...MODEL_FOLDER_MARKERS], ["pytorch_model.bin", "modules.json", "config.json", "onnx"], "src/core/docker-launch.mjs");
});

// The proxy itself, built and run against a docker.exe that writes down what it
// was asked to run. Users build it with csc.exe from .NET Framework 4 on
// Windows; Mono's mcs compiles the same source anywhere else it is installed.
// Without either compiler this half is skipped, and the static half above
// still holds the source to the contract.

const FRAMEWORK_CSC = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

function onPath(command) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

function compilerFor(platform) {
  if (platform === "win32") return existsSync(FRAMEWORK_CSC) ? { compile: FRAMEWORK_CSC, run: null } : null;
  return onPath("mcs") && onPath("mono") ? { compile: "mcs", run: "mono" } : null;
}

const RECORDING_DOCKER_CS = `
using System;
using System.IO;
internal static class RecordingDocker
{
    private static int Main(string[] args)
    {
        File.WriteAllLines(Environment.GetEnvironmentVariable("STUB_LOG"), args);
        Console.Out.Write(Console.In.ReadToEnd());
        return 0;
    }
}
`;

async function buildProxy(t) {
  const compiler = compilerFor(process.platform);
  if (!compiler) {
    t.skip(process.platform === "win32" ? `no ${FRAMEWORK_CSC}` : "neither mcs nor mono is on PATH");
    return null;
  }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-proxy-"));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const bin = path.join(work, "bin");
  await fs.mkdir(bin);
  const proxy = path.join(work, "ClaudeMcpProxy.exe");
  const source = path.join(repositoryRoot, "docker", "ClaudeMcpProxy.cs");
  const outFlag = process.platform === "win32" ? `/out:${proxy}` : `-out:${proxy}`;
  const built = spawnSync(compiler.compile, ["-nologo", outFlag, source], { encoding: "utf8" });
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
  if (process.platform === "win32") {
    // Process.Start("docker.exe") wants a real executable on Windows.
    const stubSource = path.join(work, "RecordingDocker.cs");
    await fs.writeFile(stubSource, RECORDING_DOCKER_CS);
    const stub = spawnSync(compiler.compile, ["-nologo", `/out:${path.join(bin, "docker.exe")}`, stubSource], { encoding: "utf8" });
    assert.equal(stub.status, 0, `${stub.stdout}${stub.stderr}`);
  } else {
    // Mono finds `docker.exe` on PATH like any other file; a script will do.
    // It answers what it reads, as the server would answer a request.
    await fs.writeFile(path.join(bin, "docker.exe"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_LOG"\ncat\n', { mode: 0o755 });
  }
  return { work, bin, proxy, run: compiler.run };
}

async function runProxy(built, modelPath) {
  const log = path.join(built.work, `docker-${path.basename(modelPath)}.log`);
  const command = built.run ?? built.proxy;
  const args = built.run ? [built.proxy] : [];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
    env: {
      ...process.env,
      PATH: `${built.bin}${path.delimiter}${process.env.PATH}`,
      STUB_LOG: log,
      AI_DEV_IMAGE: "ai-dev-system:stub",
      AI_DEV_MODEL_PATH: modelPath,
      AI_DEV_PROJECT_PATH: ""
    },
    timeout: 60_000
  });
  return { ...result, recorded: await fs.readFile(log, "utf8").catch(() => "") };
}

test("the built proxy mounts the folder above the models at /models and refuses the old value", async (t) => {
  const built = await buildProxy(t);
  if (!built) return;
  const models = path.join(built.work, "models");
  await fs.mkdir(path.join(models, "bge-m3-onnx"), { recursive: true });
  const mounted = await runProxy(built, models);
  assert.equal(mounted.status, 0, mounted.stderr);
  assert.ok(mounted.recorded.split(/\r?\n/).includes(`type=bind,source=${models},target=/models,readonly`), mounted.recorded);
  // 3.0: the bytes pass through both ways, and the server answers its own
  // handshake — the proxy no longer makes one up.
  assert.equal(mounted.stdout, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  assert.doesNotMatch(mounted.stdout, /"serverInfo"/);
  assert.match(mounted.stderr, /the 2\.x launcher, which works until 4\.0/);

  const old = path.join(built.work, "bge-m3");
  await fs.mkdir(old);
  await fs.writeFile(path.join(old, "config.json"), "{}");
  const refused = await runProxy(built, old);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /AI_DEV_MODEL_PATH now names the folder above the models/);
  assert.equal(refused.recorded, "", "docker was run despite the refusal");

  const empty = path.join(built.work, "empty");
  await fs.mkdir(empty);
  const warned = await runProxy(built, empty);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /holds no bge-m3-onnx/);
  assert.match(warned.recorded, /target=\/models,readonly/);

  // Only the removed Python backend's weights: said as that.
  const legacy = path.join(built.work, "legacy");
  await fs.mkdir(path.join(legacy, "bge-m3"), { recursive: true });
  const named = await runProxy(built, legacy);
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stderr, /holds bge-m3\\, the weights of the Python backend 3\.0 removed, and no bge-m3-onnx\\; .*npm run model -- install --dir /);
});
