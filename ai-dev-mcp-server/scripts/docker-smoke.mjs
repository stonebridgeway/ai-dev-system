#!/usr/bin/env node
/**
 * `npm run docker:smoke -- --image <ref> [--browser] [--no-model]` — the image, run the
 * way a client config runs it (`docker run -i --rm --network none …`, the data
 * volume), through the MCP SDK client:
 *
 * 1. a new volume: the server answers its own handshake — instructions and all
 * — the first start builds nothing (the image's data
 *    is copied into the volume), and the health check passes; the time from
 *    `docker run` to the answer is reported;
 * 2. the next session on that volume, timed the same way;
 * 3. two sessions on another new volume, the second a moment after the first,
 *    as two clients start: Docker fills it as the first starts, the second
 *    waits for the copy, and neither builds anything;
 * 4. a volume made with a driver's options, a tmpfs: no name the image can
 *    read at /data, so its advice for the model holds a placeholder for the
 *    mount and says where the sessions keep /data, for a host's model it cannot
 *    read too; and a session that mounts nothing at /data is told of the
 *    default volume by its name;
 * 5. the model through the volume: one run with the network installs a
 *    model — a synthetic one, served from this machine as a Hugging Face mirror
 *    would — and embeds the documents; a session without the network then
 *    searches with it;
 * 6. a model folder of the host's, mounted at /models as `--model` writes it:
 *    the start report gives the command for that volume, which builds the
 *    vectors offline, and the sessions use that folder.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { syntheticManifest, syntheticModelFiles } from "../src/core/synthetic-model.mjs";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const image = option("--image") ?? "ai-dev-system:local";
const withModel = !process.argv.includes("--no-model");
// The `-browser` variant ships Frontend QA's runner with Chromium; the default one does not.
const browser = process.argv.includes("--browser");
const volume = `ai-dev-smoke-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

/** What a client config runs, the 3.0 entry's flags, with this smoke's volume, or with nothing at /data for null. */
function session(extra = [], data = volume) {
  return [
    "run", "--rm", "-i",
    "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--shm-size", "1g",
    "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
    ...(data === null ? [] : ["--mount", `type=volume,source=${data},target=/data`]),
    ...extra,
    image
  ];
}

/** Connect, time the handshake, run `work`, close. */
async function connect(args, work) {
  const transport = new StdioClientTransport({ command: "docker", args, stderr: "pipe" });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(chunk));
  const client = new Client({ name: "ai-dev-docker-smoke", version: "1.0.0" }, { capabilities: {} });
  const started = performance.now();
  try {
    await client.connect(transport, { timeout: 120_000 });
    const ms = Math.round(performance.now() - started);
    return await work({ client, ms, stderr: () => Buffer.concat(stderr).toString("utf8") });
  } catch (error) {
    const serverStderr = Buffer.concat(stderr).toString("utf8").trim();
    if (serverStderr) process.stderr.write(`${serverStderr}\n`);
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

const text = (result) => result.content?.find((item) => item.type === "text")?.text ?? "";

/** Run docker without blocking this process: the model's mirror is served from it. */
function docker(args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** A Hugging Face–shaped mirror of the synthetic model on this machine: `<export>/resolve/<revision>/<file>`. */
async function serveSyntheticModel() {
  const files = syntheticModelFiles();
  const manifest = syntheticManifest(files);
  const prefix = `/${manifest.export}/resolve/${manifest.revision}/`;
  const server = http.createServer((request, response) => {
    const body = request.url.startsWith(prefix) ? files[decodeURIComponent(request.url.slice(prefix.length))] : undefined;
    response.writeHead(body ? 200 : 404, body ? { "content-length": body.length } : {});
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-smoke-model-"));
  await fs.writeFile(path.join(folder, "synthetic.manifest.json"), JSON.stringify(manifest), { mode: 0o644 });
  // mkdtemp makes it this user's alone; the container's user is another.
  await fs.chmod(folder, 0o755);
  return { port: server.address().port, folder, files, close: async () => { server.close(); await fs.rm(folder, { recursive: true, force: true }); } };
}

const report = { status: "pass", image };
try {
  // 1. A new volume.
  await connect(session(), async ({ client, ms, stderr }) => {
    const instructions = client.getInstructions() ?? "";
    if (instructions.length < 500) throw new Error(`initialize carried ${instructions.length} characters of instructions: the server's own answer has them.`);
    const [tools, resources, templates, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listResourceTemplates(), client.listPrompts()]);
    const recommendation = await client.callTool({ name: "recommend_skills", arguments: { task: "Review a containerized Node.js service for secrets and deployment risks", limit: 3 } });
    if (recommendation.isError) throw new Error("recommend_skills failed in the container.");
    // The image's own diagnostic, run inside the image.
    const healthResult = await client.callTool({ name: "system_health_check", arguments: {} });
    if (healthResult.isError) throw new Error("system_health_check failed in the container.");
    const health = JSON.parse(text(healthResult));
    const failed = (health.checks ?? []).filter((check) => check.status === "fail");
    if (health.status === "fail" || failed.length) {
      throw new Error(`Health check in the container reported ${health.status} with ${failed.length} failure(s): `
        + failed.map((check) => `${check.name} — ${String(check.summary).replace(/\s+/g, " ")}`).join("; "));
    }
    // The runner of the `-browser` variant must start. The default variant does
    // not ship its packages, which the check says as `missing-package`; any other
    // failure — an import the image lacks — is a broken image either way.
    const frontendQa = (health.checks ?? []).find((check) => check.name === "frontend_qa_environment");
    const launchFailure = frontendQa?.details?.launch_failure;
    if (launchFailure && (browser || launchFailure !== "missing-package")) {
      throw new Error(`Frontend QA runner did not start in the container (${launchFailure}): ${String(frontendQa.details.launch_error || "").replace(/\s+/g, " ")}`);
    }
    // Docker copies the image's /data into a new volume: nothing is left to build.
    const built = /(\d+) built, \d+ skipped, \d+ failed/.exec(stderr());
    if (!built || built[1] !== "0") throw new Error(`The first start on a new volume built something: ${built?.[0] ?? "no first-run report"}.`);
    // The start report says what this image carries.
    const browserLine = /Frontend QA dependencies: (.*)/.exec(stderr())?.[1] ?? "";
    if (browser ? browserLine !== "comes with the image" : !/its -browser variant carries it/.test(browserLine)) {
      throw new Error(`The start report says of the browser: "${browserLine}".`);
    }
    // The model goes into the volume the session runs on, whatever the host named it, and the start report calls it
    // this one — in the start report and in the health check alike.
    const modelLine = /Local BGE-M3 model: (.*)/.exec(stderr())?.[1] ?? "";
    if (!modelLine.includes(`source=${volume},target=/data`) || !modelLine.endsWith("puts it in this volume")) {
      throw new Error(`The start report's advice for the model does not name this volume, ${volume}: "${modelLine}".`);
    }
    const healthText = JSON.stringify(health);
    if (!healthText.includes(`source=${volume},target=/data`)) {
      const advice = /docker run [^`"]*ai-dev model install/.exec(healthText)?.[0] ?? "no docker run for the model";
      throw new Error(`The health check's advice for the model does not name this volume, ${volume}: "${advice}".`);
    }
    Object.assign(report, {
      first_session_ms: ms,
      instructions: instructions.length,
      server: client.getServerVersion(),
      tools: tools.tools.length,
      resources: resources.resources.length,
      resource_templates: templates.resourceTemplates.length,
      prompts: prompts.prompts.length,
      health: health.status,
      health_checks: (health.checks ?? []).length,
      frontend_qa_environment: frontendQa?.status ?? "absent",
      frontend_qa_runner: launchFailure ? `not shipped (${launchFailure})` : "starts"
    });
  });
  // 2. The next session.
  await connect(session(), async ({ ms }) => { report.next_session_ms = ms; });

  // 3. Two sessions on a new volume, the second 200 ms after the first, as a second client starts: it lands in the
  //    copy Docker makes for the first and waits for it — without the wait one built from part of the catalogue in 8 rounds
  //    of 10, and a start built something in all 10. A race: a run that misses it passes either way.
  const pairVolume = `${volume}-pair`;
  try {
    const pair = await Promise.all([0, 200].map((delay) => sleep(delay).then(() => connect(session([], pairVolume), async ({ ms, stderr }) => ({
      ms,
      built: /(\d+) built, \d+ skipped, \d+ failed/.exec(stderr())?.[1] ?? "no report",
      waited: Number(/this start waited ([\d.]+) s for the copy/.exec(stderr())?.[1] ?? 0)
    })))));
    if (pair.some((start) => start.built !== "0")) {
      throw new Error(`Two sessions on a new volume, the second 200 ms after the first, built: ${pair.map((start) => start.built).join(" and ")}.`);
    }
    report.pair_sessions = pair.map(({ ms, waited }) => ({ ms, waited_for_the_copy_s: waited }));
  } finally {
    spawnSync("docker", ["volume", "rm", "-f", pairVolume], { stdio: "ignore", shell: false });
  }

  // 4. A volume made with a driver's options: the image reads no name at /data, and its advice holds a placeholder for
  //    the mount, in the start report and in the health check alike.
  const unnamedVolume = `${volume}-tmpfs`;
  try {
    const created = await docker(["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", unnamedVolume]);
    if (created.status !== 0) throw new Error(`docker volume create with a driver's options exited ${created.status}: ${created.stderr.trim()}`);
    await connect(session([], unnamedVolume), async ({ client, stderr }) => {
      const modelLine = /Local BGE-M3 model: (.*)/.exec(stderr())?.[1] ?? "";
      if (!modelLine.includes("--mount <what your sessions mount at /data> ") || !modelLine.endsWith("puts it where your sessions keep /data")) {
        throw new Error(`On a volume made with a driver's options the start report's advice for the model is "${modelLine}".`);
      }
      const health = text(await client.callTool({ name: "system_health_check", arguments: {} }));
      if (!health.includes("--mount <what your sessions mount at /data> ") || !health.includes("install it once where your sessions keep /data")) {
        const advice = /[^"]*docker run [^`"]*ai-dev model install[^"]*/.exec(health)?.[0] ?? "no docker run for the model";
        throw new Error(`On a volume made with a driver's options the health check's advice for the model is "${advice}".`);
      }
    });
    // A host's model folder the image cannot read, on that volume: no data volume to install the model into either.
    // A host that lets the image read it all the same, as some file sharing does, says so and checks nothing.
    const unreadable = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-smoke-unreadable-"));
    try {
      await fs.chmod(unreadable, 0o755);
      await fs.mkdir(path.join(unreadable, "bge-m3-onnx"));
      await fs.chmod(path.join(unreadable, "bge-m3-onnx"), 0o000);
      await connect(session(["--mount", `type=bind,source=${unreadable},target=/models,readonly`], unnamedVolume), async ({ client }) => {
        const reason = String(JSON.parse(text(await client.callTool({ name: "embedding_status", arguments: {} }))).reason ?? "");
        if (!reason.includes("cannot be read")) {
          report.unreadable_model = `read all the same here: "${reason}"`;
          return;
        }
        if (!reason.endsWith("or drop the mount and install the model where your sessions keep /data.")) {
          throw new Error(`On a volume made with a driver's options the advice for a host's model the image cannot read is "${reason}".`);
        }
        report.unreadable_model = "where your sessions keep /data";
      });
    } finally {
      await fs.chmod(path.join(unreadable, "bge-m3-onnx"), 0o755).catch(() => {});
      await fs.rm(unreadable, { recursive: true, force: true });
    }
    report.unnamed_volume = "a placeholder for the mount";
  } finally {
    spawnSync("docker", ["volume", "rm", "-f", unnamedVolume], { stdio: "ignore", shell: false });
  }
  // Nothing mounted at /data: an anonymous volume, which --rm removes, and the default's place, by its name.
  await connect(session([], null), async ({ stderr }) => {
    const modelLine = /Local BGE-M3 model: (.*)/.exec(stderr())?.[1] ?? "";
    if (!modelLine.includes("source=ai-dev-system-data,target=/data") || !modelLine.endsWith("puts it in the default volume, ai-dev-system-data")) {
      throw new Error(`With nothing mounted at /data the start report's advice for the model is "${modelLine}".`);
    }
  });
  report.no_data_mount = "the default volume, by its name";

  // 5. The model through the volume.
  if (withModel) {
    const mirror = await serveSyntheticModel();
    try {
      const manifestMount = ["--env", "AI_DEV_MODEL_MANIFEST=/manifest/synthetic.manifest.json", "--mount", `type=bind,source=${mirror.folder},target=/manifest,readonly`];
      const install = await docker([
        "run", "--rm", "--network", "bridge", "--add-host", "host.docker.internal:host-gateway",
        "--env", `AI_DEV_MODEL_MIRROR=http://host.docker.internal:${mirror.port}`, ...manifestMount,
        "--mount", `type=volume,source=${volume},target=/data`, image, "ai-dev", "model", "install", "--json"
      ]);
      if (install.status !== 0) {
        throw new Error(`ai-dev model install in the image exited ${install.status}: ${`${install.stdout}\n${install.stderr}`.trim().split("\n").filter((line) => !/^[·→]|built, \d+ skipped/.test(line)).slice(-6).join(" | ")}`);
      }
      const installed = JSON.parse(install.stdout);
      await connect(session(manifestMount), async ({ client, stderr }) => {
        // The start report checks the model as setup does: this volume has it.
        const modelLine = /Local BGE-M3 model: (.*)/.exec(stderr())?.[1] ?? "";
        const vectorsLine = /Dense vectors: (.*)/.exec(stderr())?.[1] ?? "";
        if (!modelLine.startsWith("installed in ") || vectorsLine !== "every indexed document has one") {
          throw new Error(`The start report after model install says "${modelLine}" and "${vectorsLine}".`);
        }
        const embedding = JSON.parse(text(await client.callTool({ name: "embedding_status", arguments: {} })));
        if (!embedding.available) throw new Error(`The model the volume holds is not available to a session without the network: ${embedding.reason}`);
        const results = JSON.parse(text(await client.callTool({ name: "hybrid_search", arguments: { query: "sql database query", dense_weight: 0.9, limit: 3 } })));
        const top = (Array.isArray(results) ? results : results.results ?? [])[0];
        if (!(top?.dense_score > 0.5)) throw new Error(`Hybrid search did not use the model: ${JSON.stringify(top)}`);
        report.model = {
          start_report: modelLine,
          dir: embedding.model_dir,
          embedded: installed.index?.dense_documents ?? null,
          top: top.path,
          dense_score: top.dense_score
        };
      });

      // 6. A model folder of the host's, mounted read-only at /models as `--model` writes it: the sessions use it,
      //    and the start report's command builds the vectors with it, offline.
      const hostModels = path.join(mirror.folder, "models");
      for (const [name, body] of Object.entries(mirror.files)) {
        const file = path.join(hostModels, "bge-m3-onnx", name);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
        await fs.writeFile(file, body, { mode: 0o644 });
      }
      const hostVolume = `${volume}-host-model`;
      const hostMount = [...manifestMount, "--mount", `type=bind,source=${hostModels},target=/models,readonly`];
      try {
        // Before the vectors: the start report gives the command that builds them, for this volume.
        await connect(session(hostMount, hostVolume), async ({ stderr }) => {
          const vectors = /Dense vectors: (.*)/.exec(stderr())?.[1] ?? "";
          if (!vectors.includes(`docker run --rm -it --mount type=volume,source=${hostVolume},target=/data --mount type=bind,source=<the model folder>,target=/models,readonly <image> ai-dev setup --model`)) {
            throw new Error(`Before the vectors, the start report with the host's model at /models says "${vectors}".`);
          }
        });
        const embed = await docker(["run", "--rm", "--network", "none", ...hostMount, "--mount", `type=volume,source=${hostVolume},target=/data`, image, "ai-dev", "setup", "--model"]);
        if (embed.status !== 0) throw new Error(`ai-dev setup --model with the host's model exited ${embed.status}: ${`${embed.stdout}\n${embed.stderr}`.trim().split("\n").filter((line) => /✗|rror/.test(line)).slice(-3).join(" | ")}`);
        await connect(session(hostMount, hostVolume), async ({ client, stderr }) => {
          const embedding = JSON.parse(text(await client.callTool({ name: "embedding_status", arguments: {} })));
          const vectors = /Dense vectors: (.*)/.exec(stderr())?.[1] ?? "";
          if (!embedding.available || embedding.model_dir !== "/models/bge-m3-onnx" || vectors !== "every indexed document has one") {
            throw new Error(`The host's model at /models: available ${embedding.available}, model_dir ${embedding.model_dir}, start report "${vectors}".`);
          }
          report.host_model = { dir: embedding.model_dir, vectors };
        });
      } finally {
        spawnSync("docker", ["volume", "rm", "-f", hostVolume], { stdio: "ignore", shell: false });
      }
    } finally {
      await mirror.close();
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  spawnSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore", shell: false });
}
