// What every end-to-end test needs: an install of its own — a home, a vault,
// a runtime home, the synthetic model on a local host — and the app launched
// in it through Playwright's Electron driver, with the real daemon behind it.
// Nothing touches the person's home: every path an AI client or AI Dev reads
// is inside the test's folder.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const serverRoot = path.resolve(process.env.AI_DEV_SERVER_ROOT || path.join(desktopRoot, "..", "ai-dev-mcp-server"));
export const resultsDir = path.join(desktopRoot, "test-results");

const fromServer = (relative) => import(pathToFileURL(path.join(serverRoot, relative)).href);

/**
 * The apps each test launched: closed before its install is removed, so
 * Electron's last writes do not bring the test's folder back.
 */
const launched = new WeakMap();
const { startModelHost } = await fromServer("test/fixtures/model-host.mjs");
const { writeSyntheticModel } = await fromServer("src/core/synthetic-model.mjs");
const { stopDaemons } = await fromServer("src/core/daemon-client.mjs");

/** The model file a download stalls in, when a test wants one to cancel. */
export const STALLED_FILE = "onnx/model_int8.onnx";

/**
 * A fresh install: home, vault, the model's files on a "USB stick" and on a
 * local host, settings when given.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ stall?: boolean, seed?: boolean, settings?: object, env?: object }} [options]
 *   `seed`: the vault is a copy of the public seed — the skill catalog a real install has.
 */
export async function stage(t, { stall = false, seed = false, settings = null, env: extra = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-desktop-"));
  const home = path.join(root, "home");
  const vault = path.join(root, "vault");
  const projects = path.join(root, "projects");
  await fs.mkdir(path.join(vault, "02-knowledge"), { recursive: true });
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.mkdir(projects, { recursive: true });
  if (seed) await fs.cp(path.join(serverRoot, "..", "docker", "public-seed"), vault, { recursive: true });
  await fs.writeFile(path.join(vault, "02-knowledge", "storage.md"), "# Storage\n\nThe postgres schema keeps every table.\n");
  if (!seed) await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]");
  const usb = path.join(root, "usb", "bge-m3-onnx");
  const { manifest, files } = await writeSyntheticModel(usb);
  const host = await startModelHost({ files, stallAfter: new Map(stall ? [[STALLED_FILE, 1000]] : []) });
  const manifestFile = path.join(root, "synthetic.manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, sources: [host.base] }));
  const aiDevHome = path.join(home, ".ai-dev");
  await fs.mkdir(aiDevHome, { recursive: true });
  if (settings) await fs.writeFile(path.join(aiDevHome, "config.json"), JSON.stringify({ schema_version: 1, ...settings }));
  const env = {
    PATH: process.env.PATH,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude-config"),
    CODEX_HOME: path.join(home, ".codex"),
    AI_DEV_HOME: aiDevHome,
    AI_DEV_VAULT_ROOT: vault,
    AI_DEV_MODEL_MANIFEST: manifestFile,
    AI_DEV_IDLE_TIMEOUT_MS: "60000",
    // The Node the daemon runs on: the one running this test.
    AI_DEV_NODE: process.execPath,
    AI_DEV_SERVER_ROOT: serverRoot,
    AI_DEV_DESKTOP_TEST: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    ...extra
  };
  t.after(async () => {
    for (const app of launched.get(t) ?? []) await quitApp(app).catch(() => undefined);
    await stopDaemons({ timeoutMs: 5000, env }).catch(() => undefined);
    await host.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, home, vault, projects, usb, host, env, manifestFile };
}

/**
 * Whether Chromium runs without its own sandbox: as root it refuses one; on a
 * Linux CI runner that forbids unprivileged user namespaces (Ubuntu 24.04's
 * AppArmor) the workflow says so with AI_DEV_DESKTOP_NO_SANDBOX=1. The page
 * keeps its sandbox flag either way.
 */
export const NO_SANDBOX = process.getuid?.() === 0 || process.env.AI_DEV_DESKTOP_NO_SANDBOX === "1";

/**
 * Launch the app in `env`; closed when the test ends, before its install goes.
 *
 * @returns {Promise<{ app: import("playwright-core").ElectronApplication, page: import("playwright-core").Page }>}
 */
export async function launch(t, env) {
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [...(NO_SANDBOX ? ["--no-sandbox"] : []), desktopRoot],
    env,
    timeout: 60_000
  });
  launched.set(t, [...(launched.get(t) ?? []), app]);
  t.after(() => quitApp(app));
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/**
 * Quit the app as its tray's Quit does. Playwright's own close shuts the
 * window first, which the app keeps in the tray instead — it then waits a
 * minute before quitting the app.
 */
const quit = new WeakSet();

export async function quitApp(app) {
  if (quit.has(app)) return;
  quit.add(app);
  let child;
  try {
    child = app.process();
  } catch {
    // An app that left by itself — the tray's Quit — Playwright has let go of.
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
  const timer = new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000));
  if (await Promise.race([exited, timer]) === "timeout") await app.close().catch(() => undefined);
}

/** The system's folder dialog answers `folder` (null: cancelled). */
export function answerFolderDialog(app, folder) {
  return app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => (chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] });
  }, folder);
}

/** A screenshot, in desktop/test-results. */
export async function shot(page, name) {
  await fs.mkdir(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** A tool's answer through the app's own connection to the daemon (the main process). */
export function mainCall(app, tool, args = {}) {
  return app.evaluate((_electron, request) => globalThis.aiDevTest.link.call(request.tool, request.args, { id: `test-${Date.now()}` }), { tool, args });
}

/** The tray as the main process has it: its state and its menu. */
export function trayNow(app) {
  return app.evaluate(() => ({ state: globalThis.aiDevTest.tray.state(), menu: globalThis.aiDevTest.tray.menu() }));
}

/** The server's own modules, for a test that acts as an AI client would. */
export function serverModule(relative) {
  return fromServer(relative);
}

/** The environment an AI client of this install has: the app's own variables taken out. */
export function clientEnvironment(env) {
  const client = { ...env };
  for (const name of ["AI_DEV_SERVER_ROOT", "AI_DEV_DESKTOP_TEST", "AI_DEV_NODE", "ELECTRON_DISABLE_SECURITY_WARNINGS"]) delete client[name];
  return client;
}

/**
 * Work for the data screens, made through the app's own session the way an AI
 * client makes it: the skill registry and index (setup_run), a git repository
 * registered as a project, a task split into an epic of two, a decision, a
 * session handoff and recorded usage. Returns the project's path and the epic's id.
 */
export async function seedWork(app, s) {
  const repo = path.join(s.root, "projects", "shop");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "shop", version: "1.0.0", scripts: { test: "node -e 0" } }, null, 2)}\n`);
  await fs.writeFile(path.join(repo, "README.md"), "# Shop\n\nA small web shop.\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", windowsHide: true });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init");
  const must = async (tool, args) => {
    const answer = await mainCall(app, tool, args);
    if (!answer.ok) throw new Error(`${tool}: ${answer.error}`);
    return answer.result;
  };
  await must("setup_run", {});
  await must("register_project", { project_path: repo, description: "A small web shop." });
  const task = await must("begin_task", { project_path: repo, task: "Add a checkout page", acceptance_criteria: ["The cart total is shown", "Payment errors are explained"] });
  await must("decompose_task", { task_id: task.id, subtasks: [{ task: "Draw the checkout form", key: "form" }, { task: "Wire the payment call", depends_on: ["form"] }] });
  await must("record_decision", { project_path: repo, title: "Use Stripe for payments", context: "Card payments are needed.", decision: "Payments go through Stripe Checkout.", alternatives: ["PayPal"], tags: ["payments"] });
  await must("save_session", { project_path: repo, task_id: task.id, topic: "Checkout page", building: "A checkout page for the shop.", next_step: "Wire the payment call.", worked: [{ item: "Form layout", evidence: "a screenshot" }] });
  await must("record_usage", { project_path: repo, task_id: task.id, model: "claude-sonnet-4-5", input_tokens: 12000, output_tokens: 3400, cost_usd: 0.42, source: "manual" });
  return { repo, epicId: task.id };
}

/** The system's message box answers with the button at `response` (0 is Run, 1 Cancel), and remembers what it was asked. */
export function answerMessageBox(app, response) {
  return app.evaluate(({ dialog }, answer) => {
    globalThis.aiDevTestDialogs ??= [];
    dialog.showMessageBox = async (...args) => {
      const options = args.find((arg) => arg && typeof arg === "object" && "buttons" in arg);
      globalThis.aiDevTestDialogs.push({ message: options?.message, detail: options?.detail, buttons: options?.buttons, defaultId: options?.defaultId, cancelId: options?.cancelId, type: options?.type });
      return { response: answer, checkboxChecked: false };
    };
  }, response);
}

/** The message boxes shown so far. */
export function messageBoxes(app) {
  return app.evaluate(() => globalThis.aiDevTestDialogs ?? []);
}
