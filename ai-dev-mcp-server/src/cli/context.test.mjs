import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_MARKER } from "../core/app-home.mjs";
import { EXIT } from "../core/cli-args.mjs";
import { localLaunch } from "./context.mjs";

const clone = { kind: "clone", ephemeral: false, appHome: false, root: "/src/ai-dev-system" };
const home = path.resolve("/home/me");

test("a runtime folder named by AI_DEV_HOME goes into the client's entry; the home itself does not", () => {
  const named = localLaunch({ env: { HOME: home, AI_DEV_HOME: "/data/ai" }, execPath: "/usr/bin/node", cliPath: "/src/cli.mjs", serverRoot: "/src/x", layout: clone });
  assert.deepEqual(named, { command: "/usr/bin/node", args: ["/src/cli.mjs", "mcp"], env: { AI_DEV_HOME: path.resolve("/data/ai") } });
  const homeItself = localLaunch({ env: { HOME: home, AI_DEV_HOME: home }, execPath: "/usr/bin/node", cliPath: "/src/cli.mjs", serverRoot: "/src/x", layout: clone });
  assert.deepEqual(homeItself.env, {}, "AI_DEV_HOME naming the home keeps its 2.x meaning, <home>/.ai-dev");
  const vault = localLaunch({ env: { HOME: home, AI_DEV_VAULT_ROOT: "/vault", AI_DEV_HOME: "/data/ai" }, execPath: "/usr/bin/node", cliPath: "/c", serverRoot: "/s", layout: clone });
  assert.deepEqual(vault.env, { AI_DEV_VAULT_ROOT: path.resolve("/vault"), AI_DEV_HOME: path.resolve("/data/ai") });
});

test("the Windows install is launched through its stable link, so an update changes no client config", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-launch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, ".ai-dev");
  const copy = path.join(runtime, "app", "3.0.0-abcdef12");
  await fs.mkdir(copy, { recursive: true });
  await fs.writeFile(path.join(copy, APP_MARKER), "{}\n");
  const windows = { kind: "package", ephemeral: false, appHome: true, bundle: true, root: copy, runtimeRoot: runtime };
  const link = { command: path.join(runtime, "app", "current", "node", "node.exe"), cli: path.join(runtime, "app", "current", "ai-dev-mcp-server", "bin", "ai-dev.mjs") };
  const launch = localLaunch({ env: { HOME: home }, execPath: "/real/copy/node.exe", cliPath: "/real/copy/cli.mjs", serverRoot: windows.root, layout: windows, stable: () => link });
  assert.deepEqual(launch, { command: link.command, args: [link.cli, "mcp"], env: {} });
  const noLink = localLaunch({ env: { HOME: home }, execPath: "/real/copy/node.exe", cliPath: "/real/copy/cli.mjs", serverRoot: windows.root, layout: windows, stable: () => null });
  assert.deepEqual(noLink.args, ["/real/copy/cli.mjs", "mcp"], "without its link the copy is named as any install is");
  assert.equal(noLink.command, "/real/copy/node.exe");
  // The installer's own runtime, in the program's folder, is never named: an update replaces it.
  const shipped = { ...windows, appHome: false, root: path.join(root, "Programs", "AI Dev", "resources", "runtime") };
  assert.throws(() => localLaunch({ env: { HOME: home }, execPath: "/p/node.exe", cliPath: "/p/cli.mjs", serverRoot: shipped.root, layout: shipped, stable: () => null }),
    (error) => error.exitCode === EXIT.failed && /program folder .* Start AI Dev once/.test(error.message));
  assert.deepEqual(localLaunch({ env: { HOME: home }, execPath: "/p/node.exe", cliPath: "/p/cli.mjs", serverRoot: shipped.root, layout: shipped, stable: () => link }).args,
    [link.cli, "mcp"], "with the link made, it names the link, wherever it runs from");
  const seen = [];
  localLaunch({ env: { HOME: home }, execPath: "/n", cliPath: "/c", serverRoot: "/s", layout: clone, stable: (layout) => seen.push(layout) && null });
  assert.deepEqual(seen, [], "a clone never looks for the link");
});

test("a package npx runs from its cache is launched from the app home, or not at all", () => {
  const npx = { kind: "package", ephemeral: true, appHome: false, root: "/home/me/.npm/_npx/1/node_modules/ai-dev-system" };
  const installed = localLaunch({ env: { HOME: home }, execPath: "/usr/bin/node", layout: npx, appCliPath: () => "/home/me/.ai-dev/app/3.0.0-abc/ai-dev-mcp-server/bin/ai-dev.mjs" });
  assert.deepEqual(installed.args, ["/home/me/.ai-dev/app/3.0.0-abc/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"]);
  assert.throws(() => localLaunch({ env: { HOME: home }, layout: npx, appCliPath: () => "" }), (error) => (
    error.exitCode === EXIT.failed
    && /runs from npx's cache .* which npm may clear/.test(error.message)
    && /Run `npx ai-dev-system setup` first/.test(error.message)
  ));
});
