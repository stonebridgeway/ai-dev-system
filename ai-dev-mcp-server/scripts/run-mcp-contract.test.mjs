import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The cold launch path of the Docker launcher, driven against a `docker` that
// only writes down what it was asked to run. What is under test is the model
// mount since AI_DEV_MODEL_PATH moved one level up.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.resolve(scriptDir, "..", "..", "docker", "run-mcp.sh");
const powerShellLauncher = path.resolve(scriptDir, "..", "..", "docker", "run-mcp.ps1");

const recordingDocker = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$@" > "$STUB_LOG"',
  "exit 0",
  ""
].join("\n");

async function launchWithModelPath(modelDir, context, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-launcher-"));
  const binDir = path.join(home, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "docker"), recordingDocker, { mode: 0o755 });
  const log = path.join(home, "docker.log");
  try {
    const result = spawnSync("sh", [launcher], {
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        HOME: home,
        STUB_LOG: log,
        AI_DEV_IMAGE: "ai-dev-system:stub",
        AI_DEV_MODEL_PATH: modelDir,
        AI_DEV_RUNTIME_CONTAINER: "",
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ...extraEnv
      }
    });
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return null;
    }
    return { ...result, recorded: await fs.readFile(log, "utf8").catch(() => "") };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("the folder above the models is mounted read-only as /models", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  await fs.mkdir(path.join(models, "bge-m3-onnx"));
  try {
    const result = await launchWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    const realModels = await fs.realpath(models);
    assert.ok(result.recorded.includes(`type=bind,source=${realModels},target=/models,readonly`), `mount missing from: ${result.recorded}`);
    assert.doesNotMatch(result.stderr, /holds (?:no bge-m3-onnx|bge-m3[\\/],)/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

test("3.0 keeps the 2.x launcher working, says so, and runs the configured image even for a 2.x runtime-container config", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  await fs.mkdir(path.join(models, "bge-m3-onnx"));
  try {
    const result = await launchWithModelPath(models, context, { AI_DEV_RUNTIME_CONTAINER: "ai-dev-system-runtime-1000" });
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    const args = result.recorded.trim().split("\n");
    assert.deepEqual([args[0], args.at(-1)], ["run", "ai-dev-system:stub"], "a session of the image, not `docker exec` into a container that keeps an old one");
    assert.ok(!args.includes("exec"));
    assert.match(result.stderr, /the 2\.x launcher, which works until 4\.0\. Run \.\/bootstrap\.sh/);
    assert.match(result.stderr, /ai-dev-system-runtime-1000 is not used any more/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

test("a model folder with no model in it launches, and says why dense will be missing", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  try {
    const result = await launchWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /holds no bge-m3-onnx\/; dense search will report that it is not set up/);
    assert.match(result.recorded, /target=\/models,readonly/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

test("a 2.x launcher mounts a linked bge-m3-onnx itself, and says when the link leads nowhere", async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-")));
  try {
    const real = path.join(root, "disk2", "bge-m3-onnx-real");
    await fs.mkdir(real, { recursive: true });
    const models = path.join(root, "models");
    await fs.mkdir(models);
    await fs.symlink(real, path.join(models, "bge-m3-onnx"));
    const linked = await launchWithModelPath(models, context);
    if (linked === null) return;
    assert.equal(linked.status, 0, linked.stderr);
    assert.ok(linked.recorded.includes(`type=bind,source=${models}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly`), linked.recorded);
    assert.doesNotMatch(linked.recorded, /target=\/models,readonly/);
    assert.equal(linked.stderr.includes("leads nowhere"), false);

    await fs.rm(real, { recursive: true });
    const dangling = await launchWithModelPath(models, context);
    assert.equal(dangling.status, 0, "the session starts, without the model");
    assert.match(dangling.stderr, /its bge-m3-onnx is a link to .*bge-m3-onnx-real that leads nowhere here; dense search will report that it is not set up until the disk it leads to is connected/);
    assert.match(dangling.recorded, /target=\/models,readonly/, "the folder, as before: Docker refuses a mount of a link that leads nowhere");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a model folder with only the removed Python backend's weights is named as that", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  await fs.mkdir(path.join(models, "bge-m3"));
  try {
    const result = await launchWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /holds bge-m3\/, the weights of the Python backend 3\.0 removed, and no bge-m3-onnx\/; .*npm run model -- install --dir .*bge-m3-onnx/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

for (const marker of ["pytorch_model.bin", "modules.json", "config.json", "onnx"]) {
  test(`the old value — a directory holding ${marker} — is refused before docker runs`, async (context) => {
    const oldStyle = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bge-m3-"));
    if (marker === "onnx") await fs.mkdir(path.join(oldStyle, marker));
    else await fs.writeFile(path.join(oldStyle, marker), "");
    try {
      const result = await launchWithModelPath(oldStyle, context);
      if (result === null) return;
      assert.equal(result.status, 64, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /AI_DEV_MODEL_PATH now names the folder above the models/);
      assert.match(result.stderr, /bge-m3-onnx\//);
      assert.equal(result.recorded, "", "docker was run despite the refusal");
    } finally {
      await fs.rm(oldStyle, { recursive: true, force: true });
    }
  });
}

// The PowerShell launcher makes the same promises, and was written on a machine
// that could not run it. pwsh is on the ubuntu and macOS
// runners as well as on Windows; the recording docker is a shell script, so
// this half runs where sh is the shell.
// pwsh renders a thrown message through its ConciseView: coloured even with no
// terminal, a gutter on every line, and wrapped at whatever width the host
// reports — 80 on the runner, wider here. The message is
// what is under test, so the view is taken back off before matching.
function powerShellMessage(rendered) {
  return rendered
    .replace(/\u001B\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:Line|\d+)?\s*\|\s?/, "").trim())
    .filter((line) => line && !/^~+$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ");
}

async function launchPowerShellWithModelPath(modelDir, context) {
  if (process.platform === "win32") {
    context.skip("the recording docker is a shell script");
    return null;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-launcher-ps-"));
  const binDir = path.join(home, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "docker"), recordingDocker, { mode: 0o755 });
  const log = path.join(home, "docker.log");
  try {
    const result = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-File", powerShellLauncher], {
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        HOME: home,
        STUB_LOG: log,
        AI_DEV_IMAGE: "ai-dev-system:stub",
        AI_DEV_MODEL_PATH: modelDir,
        AI_DEV_DEBUG_LOG: "",
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`
      }
    });
    if (result.error?.code === "ENOENT") {
      context.skip("pwsh is unavailable on this host");
      return null;
    }
    return { ...result, recorded: await fs.readFile(log, "utf8").catch(() => "") };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("the PowerShell launcher mounts the folder above the models read-only as /models", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  await fs.mkdir(path.join(models, "bge-m3-onnx"));
  try {
    const result = await launchPowerShellWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    const mount = result.recorded.match(/^type=bind,source=(.+),target=\/models,readonly$/m);
    assert.ok(mount, `mount missing from: ${result.recorded}`);
    // Resolve-Path keeps a symlinked temp directory as written; sh's realpath does not.
    assert.ok([models, await fs.realpath(models)].includes(mount[1]), `unexpected mount source ${mount[1]}`);
    assert.doesNotMatch(result.stderr, /holds (?:no bge-m3-onnx|bge-m3[\\/],)/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

test("the PowerShell launcher warns about a model folder with no model in it, and still launches", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  try {
    const result = await launchPowerShellWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /holds no bge-m3-onnx\\; dense search will report that it is not set up/);
    assert.match(result.recorded, /target=\/models,readonly/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

for (const marker of ["pytorch_model.bin", "modules.json", "config.json", "onnx"]) {
  test(`the PowerShell launcher refuses the old value — a directory holding ${marker} — before docker runs`, async (context) => {
    const oldStyle = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bge-m3-"));
    if (marker === "onnx") await fs.mkdir(path.join(oldStyle, marker));
    else await fs.writeFile(path.join(oldStyle, marker), "");
    try {
      const result = await launchPowerShellWithModelPath(oldStyle, context);
      if (result === null) return;
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const message = powerShellMessage(result.stderr);
      assert.match(message, /AI_DEV_MODEL_PATH now names the folder above the models/);
      assert.match(message, new RegExp(`holds model files itself \\(${marker.replace(".", "\\.")}\\)`));
      assert.match(message, /bge-m3-onnx/);
      assert.equal(result.recorded, "", "docker was run despite the refusal");
    } finally {
      await fs.rm(oldStyle, { recursive: true, force: true });
    }
  });
}

test("no launcher answers the handshake itself any more: no serverInfo, no version of its own", async () => {
  // Issue #65: both launchers answered `initialize` themselves so a
  // client would not time out while the container started, with a version
  // written in them — "1.0.0" for the whole of 2.0. In 3.0 the server answers:
  // its instructions reach the client, and there is no version here to keep.
  for (const relative of ["run-mcp.sh", "run-mcp.ps1", "ClaudeMcpProxy.cs"]) {
    const source = await fs.readFile(path.resolve(scriptDir, "..", "..", "docker", relative), "utf8");
    assert.doesNotMatch(source, /serverInfo|protocolVersion|"initialize"/, `${relative} still speaks MCP itself`);
  }
});
