/**
 * The way back of `npm run upgrade:test`, for a clone, as `docs/MIGRATION.md`
 * ("The way back") gives it: `ai-dev clients remove` takes both names out of
 * every client, 2.x — a checkout of the base commit — connects its own entry
 * again with `install-local-mcp-clients.mjs`, and the 2.x server that entry
 * starts finds the task, the decision and the index 3.0 left. For an
 * `AI_DEV_HOME` that 3.0 moved up, 2.x is given the state and index roots the
 * note names.
 */
import path from "node:path";
import process from "node:process";
import { call, check, npm, readJson, run, withServer } from "./upgrade-harness.mjs";

/** A checkout of the base commit beside the upgraded clone: what `git checkout <the 2.x commit>` gives back. */
export function checkoutBase({ repoRoot, base, folder }) {
  run("git", ["-C", repoRoot, "worktree", "add", "--detach", "--force", folder, base]);
  npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: path.join(folder, "ai-dev-mcp-server") });
  return folder;
}

export async function verifyWayBack({ label, baseRoot, checkout, env, project, expected, aiDevHome, explicitRoots }) {
  const cli = path.join(baseRoot, "ai-dev-mcp-server", "bin", "ai-dev.mjs");
  const cursorFile = path.join(env.HOME, ".cursor", "mcp.json");
  run(process.execPath, [cli, "daemon", "stop"], { cwd: path.dirname(cli), env, allowFailure: true });
  const removed = run(process.execPath, [cli, "clients", "remove", "--json"], { cwd: path.dirname(cli), env, allowFailure: true });
  const results = (() => {
    try {
      return JSON.parse(removed.stdout).clients ?? [];
    } catch {
      return [];
    }
  })();
  const cursor = await readJson(cursorFile);
  check(`${label}: the way back — clients remove takes both names out of every client`,
    removed.status === 0 && !("ai-dev" in (cursor.mcpServers ?? {})) && !("ai-dev-system" in (cursor.mcpServers ?? {})),
    results.map((result) => `${result.client}:${result.status}`).join(" ") || removed.stderr.slice(0, 200));

  const server = path.join(checkout, "ai-dev-mcp-server");
  run(process.execPath, [path.join(server, "scripts", "install-local-mcp-clients.mjs"), "--apply"], { cwd: server, env });
  const local = (await readJson(cursorFile)).mcpServers?.["ai-dev-system"];
  check(`${label}: the way back — 2.x connects its own entry again`, local?.command && path.resolve(String(local.args?.[0] ?? "")).startsWith(path.resolve(server)),
    String(local?.args?.[0] ?? "missing"));
  if (!local) return;
  // MIGRATION.md: for an AI_DEV_HOME that 3.0 moved up, 2.x is told where the state and the index are now.
  const roots = aiDevHome && !explicitRoots
    ? { AI_DEV_STATE_ROOT: path.join(aiDevHome, "state"), AI_DEV_SEARCH_INDEX_DIR: path.join(aiDevHome, "cache", "search-index") }
    : {};
  await withServer({ command: local.command, args: local.args, env: { ...env, ...(local.env || {}), ...roots }, cwd: path.dirname(local.args[0]) }, async (client) => {
    const record = await call(client, "get_task", { task_id: expected.taskId });
    check(`${label}: the way back — 2.x finds the task, with its checkpoint`, record?.id === expected.taskId && (record.checkpoints?.length ?? 0) >= 1,
      `status ${record?.status}, ${record?.checkpoints?.length ?? 0} checkpoint(s)`);
    const decisions = JSON.stringify(await call(client, "list_decisions", { project_path: project }));
    check(`${label}: the way back — 2.x lists the decision`, decisions.includes("Upgrade fixture decision"));
    const found = await call(client, "search_all", { query: "code review" });
    const hits = Array.isArray(found) ? found.length : (found.results?.length ?? 0);
    const hybrid = await call(client, "hybrid_search", { query: "code review checklist", dense_weight: 0 });
    const hybridHits = Array.isArray(hybrid) ? hybrid.length : (hybrid.results?.length ?? 0);
    check(`${label}: the way back — 2.x searches: search_all and hybrid_search answer, from the index or one its freshness check rebuilt`, hits > 0 && hybridHits > 0, `${hits} and ${hybridHits} result(s)`);
  });
}
