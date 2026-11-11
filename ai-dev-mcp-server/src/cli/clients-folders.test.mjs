import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { entryFolders } from "../core/docker-launch.mjs";

// `ai-dev clients folders`: the projects and model folders the entries already there mount, which bootstrap keeps when
// it is named none — a 3.0 entry's binds, a 2.x entry's environment.

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ai-dev.mjs");
const docker30 = (projects, model) => ({ command: "/usr/bin/docker", args: ["run", "-i", "--rm", "--mount", "type=volume,source=ai-dev-system-data,target=/data",
  "--mount", `type=bind,source=${projects},target=${projects}`, ...(model ? ["--mount", `type=bind,source=${model},target=/models,readonly`] : []), "ghcr.io/x:3"] });
const entry2x = (projects, model) => ({ command: "/bin/sh", args: ["/clone/docker/run-mcp.sh"], env: { AI_DEV_IMAGE: "ghcr.io/x:latest", AI_DEV_PROJECT_PATH: projects, AI_DEV_MODEL_PATH: model } });

test("an entry's folders: a 3.0 entry's binds, a 2.x entry's environment, nothing of anything else", () => {
  assert.deepEqual(entryFolders(docker30("/home/u/Dev", "/home/u/models")), { projects: "/home/u/Dev", model: "/home/u/models" });
  assert.deepEqual(entryFolders(docker30("/home/u/Dev")), { projects: "/home/u/Dev", model: "" });
  assert.deepEqual(entryFolders(entry2x("/home/u/Dev", "")), { projects: "/home/u/Dev", model: "" });
  // Windows: the projects at /workspace, by the host's path.
  const windows = { command: "C:\\Program Files\\Docker\\docker.exe", args: ["run", "-i", "--rm", "--mount", "type=bind,source=C:\\Users\\u\\Dev,target=/workspace", "x:3"] };
  assert.deepEqual(entryFolders(windows), { projects: "C:\\Users\\u\\Dev", model: "" });
  // A local 3.0 entry mounts nothing; no entry, nothing.
  assert.deepEqual(entryFolders({ command: "/usr/bin/node", args: ["/home/u/.ai-dev/app/3.0.0/bin/ai-dev.mjs", "mcp"] }), { projects: "", model: "" });
  assert.deepEqual(entryFolders(undefined), { projects: "", model: "" });
});

test("clients folders prints each folder the entries agree on with the clients that mount it, and says when they differ", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-clients-folders-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const write = async (file, servers) => {
    await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await fs.writeFile(path.join(home, file), JSON.stringify({ mcpServers: servers }));
  };
  const run = (...args) => spawnSync(process.execPath, [cli, "clients", "folders", `--home=${home}`, "--platform=linux", ...args], {
    encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex") }
  });
  // No entry anywhere: nothing to keep.
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  assert.equal(run().stdout, "");
  // A 3.0 entry and a 2.x one that agree.
  await write(".cursor/mcp.json", { "ai-dev": docker30("/home/u/Dev", "/home/u/models"), other: { command: "x" } });
  await write(".gemini/settings.json", { "ai-dev-system": entry2x("/home/u/Dev", "/home/u/models") });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "projects\t/home/u/Dev\tCursor, Gemini CLI\nmodel\t/home/u/models\tCursor, Gemini CLI\n");
  // --clients picks whose entries count.
  assert.equal(run("--clients=gemini").stdout, "projects\t/home/u/Dev\tGemini CLI\nmodel\t/home/u/models\tGemini CLI\n");
  // The 3.0 entry is read before the 2.x one in the same file.
  await write(".gemini/settings.json", { "ai-dev": docker30("/home/u/Dev"), "ai-dev-system": entry2x("/home/u/Old", "") });
  assert.equal(run("--clients=gemini").stdout, "projects\t/home/u/Dev\tGemini CLI\n");
  // Two different projects folders: no choice is made.
  await write(".gemini/settings.json", { "ai-dev-system": entry2x("/home/u/Other", "/home/u/models") });
  result = run();
  assert.equal(result.stdout, "differ\tprojects\t/home/u/Dev (Cursor); /home/u/Other (Gemini CLI)\nmodel\t/home/u/models\tCursor, Gemini CLI\n");
  // One folder with a separator at its end and without is one folder.
  await write(".gemini/settings.json", { "ai-dev-system": entry2x("/home/u/Dev/", "/home/u/models//") });
  assert.equal(run().stdout, "projects\t/home/u/Dev\tCursor, Gemini CLI\nmodel\t/home/u/models\tCursor, Gemini CLI\n");
});
