#!/usr/bin/env node
/**
 * `npm run docker:upgrade-check -- --old-image <2.x ref> --new-image <ref>` —
 * what a 2.x Docker user meets when the image is updated under them:
 *
 * 1. the 2.x image fills a volume the way 2.x did (`cp -n` of its seed) and
 *    starts a task; the user edits a skill of the seed and adds one of their own;
 * 2. the new image, run by the 2.x launcher the config still names (its cold
 *    path), answers with its instructions, still has the task, and has brought
 *    the volume's skills up to its seed: what 2.x shipped and the new seed
 *    dropped is gone, the user's edit is kept with the update beside it, their
 *    own skill is kept;
 * 3. the 2.x launcher's warm path — a runtime container the 2.x bootstrap
 *    started, now of the new image — still serves a session, and the 3.0
 *    wrapper of the same name answers with the server's own handshake;
 * 4. a 3.0 entry (`ai-dev clients entry … --docker`) on the same volume moves
 *    the volume's state, the task with it, into the host's state folder;
 * 5. the way back as `bootstrap.sh --image …:2` writes it — the 2.x image run
 *    by a 3.0 entry — answers, and sees the task in that state folder;
 * 6. back on the new image, what the 2.x start's `cp -n` put back into the
 *    volume is removed again.
 *
 * The 2.x launcher is read from git (`--old-ref`, the commit the upgrade test
 * starts from). Nothing outside a temporary folder and the volumes it names is
 * touched; both are removed at the end.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dockerRunArgs } from "../src/core/docker-launch.mjs";
import { SEED_HISTORY_BASE } from "./seed-history.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const oldImage = option("--old-image");
const newImage = option("--new-image", "ai-dev-system:local");
// The newest 2.x, the one the seed history counts back from.
const oldRef = option("--old-ref", SEED_HISTORY_BASE);
if (!oldImage) throw new Error("--old-image names the 2.x image to upgrade from.");

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", shell: false, maxBuffer: 1 << 26, ...options });
const tag = crypto.randomBytes(3).toString("hex");
const volume = `ai-dev-upgrade-${tag}`;
const warm = `ai-dev-upgrade-warm-${tag}`;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-docker-upgrade-"));
const projects = path.join(scratch, "projects");
const state = path.join(scratch, "host-state");
const report = { status: "pass", old_image: oldImage, new_image: newImage };

/** One session through a launcher: the handshake, and whatever `work` asks. */
async function session(command, args, env, work = async () => {}) {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: "pipe" });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(chunk));
  const client = new Client({ name: "ai-dev-docker-upgrade", version: "1.0.0" }, { capabilities: {} });
  const started = performance.now();
  try {
    await client.connect(transport, { timeout: 180_000 });
    const handshake = { ms: Math.round(performance.now() - started), instructions: (client.getInstructions() ?? "").length, server: client.getServerVersion() };
    return { handshake, ...(await work(client)), stderr: Buffer.concat(stderr).toString("utf8") };
  } catch (error) {
    process.stderr.write(`${Buffer.concat(stderr).toString("utf8").trim()}\n`);
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

const json = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

/** A shell in the volume, as the image's user. */
function inVolume(image, script) {
  const result = run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sh", "--mount", `type=volume,source=${volume},target=/data`, image, "-c", script]);
  if (result.status !== 0) throw new Error(`in the volume: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * The host's state folder as the image's user sees it. What the container
 * writes there is that user's, in folders only it may read: a host whose uid
 * is not the image's (GitHub's runners are 1001) reads them through it.
 */
function inState(image, script) {
  const result = run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sh", "--mount", `type=bind,source=${state},target=/state`, image, "-c", `cd /state && ${script}`]);
  if (result.status !== 0) throw new Error(`in the state folder: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await fs.mkdir(path.join(projects, "demo"), { recursive: true });
  run("git", ["init", "-q", path.join(projects, "demo")]);
  // 2.x configs ran this launcher, from the user's clone at the 2.x commit.
  const legacy = run("git", ["-C", repositoryRoot, "show", `${oldRef}:docker/run-mcp.sh`]);
  if (legacy.status !== 0) throw new Error(`The 2.x launcher is not in this clone (${oldRef}): ${legacy.stderr.trim()}. Fetch that commit first.`);
  const legacyLauncher = path.join(scratch, "run-mcp-2x.sh");
  await fs.writeFile(legacyLauncher, legacy.stdout, { mode: 0o755 });
  const config = (image, extra = {}) => ({ AI_DEV_IMAGE: image, AI_DEV_DATA_VOLUME: volume, AI_DEV_PROJECT_PATH: projects, AI_DEV_RUNTIME_CONTAINER: "", AI_DEV_MODEL_PATH: "", ...extra });

  // 1. The 2.x image fills the volume and starts a task; the user changes the seed.
  const first = await session("sh", [legacyLauncher], config(oldImage), async (client) => ({
    task: (await json(client, "begin_task", { project_path: "/workspace/demo", task: "Keep this task across the upgrade", acceptance_criteria: ["the new image lists it"] })).id
  }));
  const seeded = inVolume(oldImage, [
    "cd /data/ai-dev-system/03-skills-catalog/sources",
    "printf '\\n## My own note\\nKeep this.\\n' >> custom/feature-builder/SKILL.md",
    "mkdir -p custom/my-own-skill && printf -- '---\\nname: my-own-skill\\ndescription: Mine\\n---\\n# Mine\\n' > custom/my-own-skill/SKILL.md",
    "find . -name SKILL.md | wc -l"
  ].join(" && "));
  report.old = { first_session_ms: first.handshake.ms, skills: Number(seeded), task: first.task };

  // 2. The new image under the 2.x launcher's cold path.
  const second = await session("sh", [legacyLauncher], config(newImage), async (client) => ({
    tasks: (await json(client, "list_tasks", {})).map((task) => task.id)
  }));
  assert(second.handshake.instructions > 500, `the new image answered the 2.x launcher with ${second.handshake.instructions} characters of instructions`);
  assert(second.tasks.includes(first.task), "the task 2.x started is not there after the upgrade");
  const shipped = JSON.parse(run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", newImage, "/opt/ai-dev/seed/public-seed.manifest.json"]).stdout);
  const shippedSkills = shipped.files.filter((file) => file.path.startsWith("03-skills-catalog/sources/") && file.path.endsWith("/SKILL.md")).length;
  const after = inVolume(newImage, [
    "cd /data/ai-dev-system/03-skills-catalog/sources",
    "echo $(find . -name SKILL.md | wc -l)",
    "test -f custom/feature-builder/SKILL.md.seed-new && echo seed-new",
    "grep -q 'Keep this.' custom/feature-builder/SKILL.md && echo kept",
    "test -f custom/my-own-skill/SKILL.md && echo own"
  ].join("; "));
  const [count, ...flags] = after.split("\n");
  assert(Number(count) === shippedSkills + 1, `the volume has ${count} skills; the new seed ships ${shippedSkills}, plus the user's own one`);
  assert(["seed-new", "kept", "own"].every((flag) => flags.includes(flag)), `the user's changes: ${flags.join(", ")}`);
  report.upgraded = { session_ms: second.handshake.ms, instructions: second.handshake.instructions, skills: Number(count), seed_skills: shippedSkills, users_edit: "kept, the update beside it", users_own_skill: "kept", task: "kept" };

  // 3. The 2.x warm path, with a runtime container of the new image as the 2.x bootstrap started it.
  const started = run("docker", ["run", "-d", "--name", warm, "--label", "ai-dev.system.runtime=true", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m",
    "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
    "--mount", `type=volume,source=${volume},target=/data`, "--mount", `type=bind,source=${projects},target=/workspace`, newImage, "tail", "-f", "/dev/null"]);
  assert(started.status === 0, `the runtime container did not start: ${started.stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const warmLegacy = await session("sh", [legacyLauncher], config(newImage, { AI_DEV_RUNTIME_CONTAINER: warm }), async (client) => ({ tools: (await client.listTools()).tools.length }));
  assert(warmLegacy.tools > 100, `the 2.x warm path served ${warmLegacy.tools} tools`);
  const wrapper = await session("sh", [path.join(repositoryRoot, "docker", "run-mcp.sh")], config(newImage, { AI_DEV_RUNTIME_CONTAINER: warm }));
  assert(wrapper.handshake.instructions > 500, "the 3.0 wrapper did not pass the server's own handshake through");
  assert(/the 2\.x launcher, which works until 4\.0/.test(wrapper.stderr), "the 3.0 wrapper did not say what it is");
  report.launchers = {
    legacy_warm: { tools: warmLegacy.tools, instructions: warmLegacy.handshake.instructions, note: "the 2.x launcher answers the handshake itself" },
    wrapper_3x: { ms: wrapper.handshake.ms, instructions: wrapper.handshake.instructions }
  };

  // 4. A 3.0 entry on the same volume, sharing the host's state folder (where
  // the image's user is the host's; here the folder is opened to it whatever
  // this machine's uid): the volume's state, the task with it, moves there.
  await fs.mkdir(state, { recursive: true });
  await fs.chmod(state, 0o777);
  const third = await session("docker", dockerRunArgs({ image: newImage, volume, projects, state, platform: process.platform }), {});
  const moved = inState(newImage, "ls tasks 2>/dev/null; true").split("\n").filter((name) => name.endsWith(".json"));
  assert(moved.includes(`${first.task}.json`), `the task is not in the host's state folder: ${moved.join(", ")}`);
  report.entry_3x = { session_ms: third.handshake.ms, instructions: third.handshake.instructions, tasks_in_host_state: moved.length };

  // 5. The way back as bootstrap --image …:2 writes it: the 2.x image under a
  // 3.0 entry, which hands it the state folder.
  const back = await session("docker", dockerRunArgs({ image: oldImage, volume, projects, state, platform: process.platform }), {}, async (client) => ({
    tasks: (await json(client, "list_tasks", {})).map((task) => task.id)
  }));
  assert(back.tasks.includes(first.task), "the 2.x image under a 3.0 entry does not see the task in the shared state folder");
  const putBack = Number(inVolume(newImage, "find /data/ai-dev-system/03-skills-catalog/sources -name SKILL.md | wc -l"));
  // What step 6 takes away: without it, step 6 would pass having tested nothing.
  assert(putBack > shippedSkills + 1, `the 2.x start under a 3.0 entry put no skills back: ${putBack}`);
  report.way_back_3x_entry = { session_ms: back.handshake.ms, task: "seen in the shared state folder", skills_after_its_cp_n: putBack };

  // 6. Back on the new image: what that start's `cp -n` put back goes again.
  const returned = await session("docker", dockerRunArgs({ image: newImage, volume, projects, state, platform: process.platform }), {});
  const recount = Number(inVolume(newImage, "find /data/ai-dev-system/03-skills-catalog/sources -name SKILL.md | wc -l"));
  assert(recount === shippedSkills + 1, `back on the new image the volume has ${recount} skills; the seed ships ${shippedSkills}, plus the user's own one`);
  report.returned = { session_ms: returned.handshake.ms, skills: recount };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  run("docker", ["rm", "-f", warm], { stdio: "ignore" });
  run("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });
  // The container's files in it are its user's, which this one may not remove.
  if (await fs.stat(state).then(() => true, () => false)) {
    try {
      inState(newImage, "rm -rf ./* ./.[!.]* 2>/dev/null; true");
    } catch {}
  }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
