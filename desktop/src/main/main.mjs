/**
 * The desktop app's main process: one window with the app's own page, the
 * tray, and one connection to the daemon every AI client shares
 * (docs/DESKTOP.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { pickLanguage, translate } from "../renderer/i18n.js";
import { prepareRuntime, runtimeNotice, shippedRuntime } from "./bundle.mjs";
import { confirmationDialog, consoleDecision, consoleTools, settingsDialog } from "./console-policy.mjs";
import { DaemonLink } from "./daemon-link.mjs";
import { EVENT_CHANNELS, INVOKE_CHANNELS, callToConfirm, refuseCall, refuseClients, settingsToConfirm, validCallId } from "./ipc-policy.mjs";
import { createLanguageKeeper } from "./language.mjs";
import { findNode } from "./node-runtime.mjs";
import { APP_ORIGIN, APP_SCHEME, PAGE_PARTITION, appFileHandler, isAppUrl, lockContents, lockSession, windowPreferences } from "./security.mjs";
import { startupFailure } from "./startup.mjs";
import { createTray } from "./tray.mjs";
import { UPDATER_PARTITION, lockUpdaterSession, resolverRules, startUpdates, updatesEnabled } from "./updates.mjs";

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session } = electron;

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..", "..");
const rendererRoot = path.join(desktopRoot, "src", "renderer");
const preload = path.join(desktopRoot, "src", "preload", "preload.cjs");

/**
 * The runtime the installed app ships, which the app copies and runs through
 * the stable link AI clients run (bundle.mjs); null in a checkout.
 */
const bundleRoot = shippedRuntime({ env: process.env, packaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath });

/** The server this app drives: beside it in a checkout, or AI_DEV_SERVER_ROOT; an installed app's comes from its runtime. */
function serverRoot() {
  if (process.env.AI_DEV_SERVER_ROOT) return path.resolve(process.env.AI_DEV_SERVER_ROOT);
  return path.resolve(desktopRoot, "..", "ai-dev-mcp-server");
}

/** The app's own package.json, as the build wrote it; empty when it cannot be read. */
function appManifest() {
  try {
    return JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
  } catch {
    return {};
  }
}

/** The installed app looks for updates (updates.mjs); a checkout does not. */
const updates = updatesEnabled({ packaged: app.isPackaged, platform: process.platform, env: process.env, signed: appManifest().aiDevSigned === true });

/**
 * The menu: none on Windows and Linux; on macOS the app and Edit menus, which
 * the system's copy and paste go through. Neither has Reload or the developer
 * tools.
 */
function applicationMenu() {
  return process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]) : null;
}

// Chromium resolves no host name in this app: the page has no network, and a
// name it hands to WebRTC or a dns-prefetch would otherwise still go to the
// system's resolver — a way out for what a script put in it. The daemon is
// reached from Node, over a socket; Node's own lookups
// do not go through this rule. The installed app's updater is the one
// exception: the update hosts, by their exact names (updates.mjs).
app.commandLine.appendSwitch("host-resolver-rules", resolverRules({ updates }));
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  let tray = null;
  let server = null;
  let node = null;
  let language = pickLanguage("", "");
  let quitting = false;
  let starting = null;
  // What the window says when the start failed or no Node was found, drawn
  // again in the language chosen afterwards.
  let explain = null;
  // Windows open only once the page's session is locked and served.
  let ready = false;
  // The main process's own calls are named apart, so two at once do not share an id.
  let ownCalls = 0;
  const env = { ...process.env };
  // The Windows install's server is its runtime's, known once the runtime is prepared.
  let root = bundleRoot ? null : serverRoot();
  // The prepared runtime of the Windows install: its stable link's Node and server.
  let runtime = null;
  // electron-updater's updater, when the installed app looks for updates.
  let updater = null;
  const t = (key, params) => translate(language, key, params);
  const devTools = process.env.AI_DEV_DESKTOP_DEVTOOLS === "1";
  const link = new DaemonLink({ env, t });
  // The language chosen, kept in the settings file — or held until the file
  // can take it (3).
  const languages = createLanguageKeeper({ server: () => server, env, settled: (outcome) => languageSettled(outcome) });

  // The link's own words are said in the language in force.
  const publicState = () => {
    const { errorKey, ...state } = link.state;
    const notice = runtimeNotice(runtime);
    return { ...state, ...(errorKey ? { error: t(errorKey) } : {}), ...(notice ? { runtime: notice } : {}), language, platform: process.platform };
  };
  const fromApp = (event) => isAppUrl(event.senderFrame?.url ?? "");

  const openWindow = () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      title: t("app.title"),
      autoHideMenuBar: true,
      backgroundColor: "#f6f8fa",
      webPreferences: windowPreferences(preload, { devTools })
    });
    window.on("close", (event) => {
      if (!quitting && tray) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      window = null;
    });
    window.loadURL(`${APP_ORIGIN}/index.html`);
    // AI_DEV_DESKTOP_DEVTOOLS=1 is for working on the app: the tools open with the window.
    if (devTools) window.webContents.openDevTools({ mode: "detach" });
  };

  const quit = async () => {
    quitting = true;
    // A language that waits is written once more; the file's lock is waited
    // for a second at most, the write already waiting for it included.
    await languages.quit().catch(() => undefined);
    await link.close();
    app.quit();
  };

  // The tray's "Restart to update": as Quit, then the installer runs silently
  // and starts the app again; the new runtime is prepared at that start.
  const installUpdate = async () => {
    quitting = true;
    await languages.quit().catch(() => undefined);
    await link.close();
    updater.quitAndInstall(true, true);
  };

  /**
   * Copy the Windows install's runtime, or find it copied, and take its
   * server and Node. The page shows how far the copy has come — sent at most
   * five times a second: a runtime is thousands of files.
   */
  const prepare = async () => {
    let sent = 0;
    link.preparing();
    runtime = await prepareRuntime({
      bundleRoot,
      env,
      onProgress: ({ progress, total }) => {
        if (Date.now() - sent < 200 && progress < total) return;
        sent = Date.now();
        link.preparing({ progress, total });
      }
    });
    root = runtime.serverRoot;
  };

  const rebuildFromTray = async () => {
    tray.setRebuilding(0);
    const result = await link.call("rebuild_search_index", {}, {
      id: "tray-rebuild",
      onProgress: ({ progress, total }) => tray.setRebuilding(total ? Math.min(99, Math.floor((progress / total) * 100)) : 0)
    });
    // A failure is said where the rebuild was asked for; the
    // link's own words by their key, said again in another language.
    tray.setRebuilding(null, result.ok || result.cancelled ? null : { key: result.key, text: result.error });
  };

  // The tray's Stop: a daemon that would not stop is said in the menu, as a
  // failed rebuild is — from the answer, which names it, or an error — and
  // Stop is offered again while it runs.
  const stopFromTray = async () => {
    tray.setStopping();
    let failure = null;
    try {
      const answer = await link.stopDaemon();
      const failed = (answer?.daemons ?? []).filter((daemon) => daemon.stopped === false);
      if (failed.length) failure = { daemons: failed.map((daemon) => ({ pid: daemon.pid, reason: daemon.reason ?? "it is still running" })) };
    } catch (error) {
      failure = { error: String(error?.message ?? error) };
    }
    tray.setStopFailed(failure);
  };

  /**
   * A chosen language no longer waits. A write that changed the file changes
   * what the checks see: online, they run again. The file, fixed,
   * named a language of its own, which the choice gave way to: the app speaks
   * it now, as the next start will.
   */
  const languageSettled = ({ changed, language: inFile }) => {
    if (changed && !quitting && link.state.phase === "online") link.refreshStatus({ checks: true, fresh: true }).catch(() => undefined);
    const now = pickLanguage(inFile, app.getLocale());
    if (now === language) return;
    language = now;
    tray?.refresh();
    window?.setTitle(t("app.title"));
    if (["broken", "no-node"].includes(link.state.phase)) explain?.();
    window?.webContents.send(EVENT_CHANNELS.state, publicState());
  };

  /**
   * Get going: the server, the settings, the Node the daemon runs on, the
   * daemon. Whatever stops it is shown in the window with what to do — the
   * app never sits there silent. Run again by Try
   * again, and when the app is launched a second time.
   */
  const startup = () => {
    starting ??= (async () => {
      if (bundleRoot && !runtime) {
        try {
          await prepare();
        } catch (error) {
          // A full disk, a folder that cannot be written, a damaged install:
          // Try again prepares it again; the installer is the way back.
          explain = () => link.fail({ error: t("broken.runtimeFailed"), hint: t("broken.runtimeHint"), detail: String(error?.message ?? error), restart: false });
          explain();
          return;
        }
      }
      try {
        server ??= await import(pathToFileURL(path.join(root, "src", "core", "control-client.mjs")).href);
        const read = server.readSettings({ env });
        const settings = read.settings;
        // The language chosen while the file was broken — unless the file, fixed, names its own.
        language = languages.atStart(read.stored) ?? pickLanguage(settings.language, app.getLocale());
        window?.setTitle(t("app.title"));
        tray?.refresh();
        const clientNodes = await server.clientNodePaths({ env, cliPath: path.join(root, "bin", "ai-dev.mjs") }).catch(() => []);
        // The Windows install's own Node first: the clients it connects run it, through the same link.
        node = findNode({ env, clientNodes, bundled: runtime ? [runtime.node] : [] });
        const linkServer = { ...server, openControlClient: (options) => server.openControlClient({ serverRoot: root, ...options }) };
        explain = node.path ? null : () => link.attach({ server: linkServer, execPath: null, noNode: node.reason ? t(node.reason.key, node.reason.params) : node.problem });
        link.attach({ server: linkServer, execPath: node.path, noNode: node.reason ? t(node.reason.key, node.reason.params) : node.problem });
        if (node.path) await link.connect({ start: settings.daemon_autostart !== false });
      } catch (error) {
        const loaded = Boolean(server);
        explain = () => link.fail(startupFailure(error, { serverRoot: root, loaded, t }));
        explain();
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const handle = (channel, listener) => ipcMain.handle(channel, (event, request) => (fromApp(event) ? listener(event, request) : null));

  // macOS: a click on the Dock icon brings the window back.
  app.on("activate", () => {
    if (ready) openWindow();
  });
  app.on("second-instance", () => {
    if (!ready) return;
    openWindow();
    if (["broken", "no-node"].includes(link.state.phase)) startup();
  });
  app.on("window-all-closed", () => {
    if (!tray) quit();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("web-contents-created", (_event, contents) => lockContents(contents));

  app.whenReady().then(async () => {
    // The system's language until the settings say otherwise — a start that
    // fails before it reads them speaks it too.
    language = pickLanguage("", app.getLocale());
    // The page's session serves the app's files and nothing else; the default
    // one is locked the same way, for any window that is not the app's.
    const pageSession = session.fromPartition(PAGE_PARTITION);
    pageSession.protocol.handle(APP_SCHEME, appFileHandler(rendererRoot));
    await lockSession(pageSession);
    await lockSession(session.defaultSession);
    Menu.setApplicationMenu(applicationMenu());
    link.on("state", () => window?.webContents.send(EVENT_CHANNELS.state, publicState()));

    // The page's channels first: whatever happens next, the window can ask.
    handle(INVOKE_CHANNELS.state, () => publicState());
    handle(INVOKE_CHANNELS.connect, async (_event, request) => {
      await link.connect({ start: request?.start === true });
      return publicState();
    });
    handle(INVOKE_CHANNELS.retry, async () => {
      if (link.state.phase === "broken" && link.state.restart) {
        app.relaunch();
        app.exit(0);
        return publicState();
      }
      if (["broken", "no-node"].includes(link.state.phase)) await startup();
      return publicState();
    });
    const progressTo = (sender, id) => ({ progress, total, message }) => {
      if (!sender.isDestroyed()) sender.send(EVENT_CHANNELS.progress, { id, progress, total, message });
    };
    handle(INVOKE_CHANNELS.call, async (event, request) => {
      let refused = refuseCall(request);
      if (!refused && request.tool === "clients_install") {
        ownCalls += 1;
        const listed = await link.call("clients_list", {}, { id: `clients-offered-${ownCalls}` });
        refused = listed.ok ? refuseClients(request.args.clients, listed.result.clients) : listed.error;
      }
      if (refused) return { ok: false, error: refused, cancelled: false };
      // The model's mirror and folder, the profiles: only after the person says so.
      const changes = settingsToConfirm(request);
      if (changes) {
        const parent = BrowserWindow.fromWebContents(event.sender) ?? window;
        const { response } = await dialog.showMessageBox(parent, settingsDialog(changes, t));
        if (response !== 0) return { ok: false, error: t("settings.notConfirmed"), cancelled: true, confirmed: false };
      }
      // A skill, a rule, the hooks: written into the person's files only after they say so, as the console's calls are.
      if (callToConfirm(request)) {
        const parent = BrowserWindow.fromWebContents(event.sender) ?? window;
        const tool = consoleTools(await link.tools()).find((entry) => entry.name === request.tool) ?? { name: request.tool, destructive: false };
        const { response } = await dialog.showMessageBox(parent, confirmationDialog(tool, request.args ?? {}, t));
        if (response !== 0) return { ok: false, error: t("console.notConfirmed"), cancelled: true, confirmed: false };
      }
      return link.call(request.tool, request.args ?? {}, { id: request.id, onProgress: progressTo(event.sender, request.id) });
    });
    handle(INVOKE_CHANNELS.tools, async () => consoleTools(await link.tools()));
    // The tool console: what the daemon lists, a tool that changes something
    // only after the person says so in a dialog of this process (console-policy.mjs).
    handle(INVOKE_CHANNELS.consoleCall, async (event, request) => {
      const decision = consoleDecision(request, consoleTools(await link.tools()));
      if (decision.refused) return { ok: false, error: decision.refused, cancelled: false };
      if (decision.confirm) {
        const parent = BrowserWindow.fromWebContents(event.sender) ?? window;
        const { response } = await dialog.showMessageBox(parent, confirmationDialog(decision.tool, decision.args, t));
        if (response !== 0) return { ok: false, error: t("console.notConfirmed"), cancelled: true, confirmed: false };
      }
      return link.call(decision.tool.name, decision.args, { id: decision.id, onProgress: progressTo(event.sender, decision.id) });
    });
    handle(INVOKE_CHANNELS.reconnect, async () => {
      await link.reconnect();
      return publicState();
    });
    handle(INVOKE_CHANNELS.cancel, (_event, id) => validCallId(id) && link.cancel(id));
    handle(INVOKE_CHANNELS.chooseFolder, async () => {
      const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    handle(INVOKE_CHANNELS.setLanguage, async (_event, chosen) => {
      language = pickLanguage(chosen, app.getLocale());
      tray?.refresh();
      window?.setTitle(t("app.title"));
      // A failure screen is the main process's words: say them again in this language.
      if (["broken", "no-node"].includes(link.state.phase)) explain?.();
      // Written here, online or not: a file that cannot take it yet gets it later.
      await languages.choose(language);
      return publicState();
    });

    ready = true;
    openWindow();
    tray = createTray({ electron, link, t, actions: { open: openWindow, rebuild: rebuildFromTray, stop: stopFromTray, quit, update: () => installUpdate() } });
    // What the end-to-end tests read from the main process: the tray, its
    // actions, the daemon link (desktop/test/e2e). Nothing of it reaches the page.
    if (process.env.AI_DEV_DESKTOP_TEST === "1") globalThis.aiDevTest = { tray, link, rebuild: rebuildFromTray, stop: stopFromTray, quit, node: () => node, runtime: () => runtime };
    startup();
    if (updates) {
      // The updater's session lets through only the update hosts; locked
      // before electron-updater asks for it (it asks for the same partition).
      lockUpdaterSession(session.fromPartition(UPDATER_PARTITION, { cache: false }));
      const loaded = await import("electron-updater");
      updater = loaded.autoUpdater ?? loaded.default.autoUpdater;
      startUpdates({ updater, tray });
    }
  });
}
