import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { answerMessageBox, desktopRoot, launch, messageBoxes, stage } from "./harness.mjs";

test("the page has no Node, no file system, no network, and reaches only the interface's tools", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // Every dialog the page's calls bring up is answered Cancel, and remembered.
  await answerMessageBox(app, 1);
  const seen = await page.evaluate(async () => {
    const tried = async (attempt) => {
      try {
        await attempt();
        return "allowed";
      } catch (error) {
        return `refused: ${error?.name ?? "Error"}`;
      }
    };
    // Playwright evaluates through the DevTools protocol, which lets the
    // evaluation itself use eval whatever the page's policy says; a task of
    // the page's own — a timer — runs as the page's scripts do.
    const inTask = (attempt) => new Promise((resolve) => setTimeout(() => {
      try {
        attempt();
        resolve("allowed");
      } catch (error) {
        resolve(`refused: ${error?.name ?? "Error"}`);
      }
    }, 0));
    const inline = await new Promise((resolve) => {
      window.inlineRan = false;
      const script = document.createElement("script");
      script.textContent = "window.inlineRan = true;";
      document.head.append(script);
      setTimeout(() => resolve(window.inlineRan ? "ran" : "blocked"), 200);
    });
    return {
      globals: { require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer, global: typeof global, ipcRenderer: typeof window.ipcRenderer, electron: typeof window.electron },
      api: Object.keys(window.aiDev).sort(),
      apiFrozen: Object.isFrozen(window.aiDev),
      file: await tried(() => fetch("file:///etc/passwd").then((response) => response.text())),
      network: await tried(() => fetch("https://example.com/").then((response) => response.text())),
      inline,
      evalCall: await inTask(() => eval("1 + 1")),
      newFunction: await inTask(() => new Function("return 1")()),
      // A worker the policy refuses is made, then fails; one that ran would say so.
      worker: await new Promise((resolve) => setTimeout(() => {
        let settled = false;
        const done = (value) => {
          if (!settled) resolve((settled = true) && value);
        };
        try {
          const worker = new Worker("data:text/javascript,postMessage('ran')");
          worker.onmessage = () => done("ran");
          worker.onerror = () => done("refused: error event");
          setTimeout(() => done("refused: never started"), 1500);
        } catch (error) {
          done(`refused: ${error?.name ?? "Error"}`);
        }
      }, 0)),
      opened: window.open("https://example.com/") === null ? "denied" : "opened",
      removeModel: await window.aiDev.call("model_remove", { confirm: true }, "call-remove"),
      agentTool: await window.aiDev.call("record_decision", { title: "x", decision: "y" }, "call-agent"),
      badId: await window.aiDev.call("system_status", {}, "../../etc"),
      trayId: await window.aiDev.call("system_status", {}, "tray-rebuild"),
      // The language goes through setLanguage, never settings_set (which takes the Settings screen's own).
      otherSetting: await window.aiDev.call("settings_set", { settings: { language: "ru" } }, "call-language"),
      // Where the daemon downloads the model from: only after the person confirms it.
      mirror: await window.aiDev.call("settings_set", { settings: { model_mirror: "http://127.0.0.1:9/x" } }, "call-mirror"),
      // A client the wizard does not offer — not on this computer.
      clientNotOffered: await window.aiDev.call("clients_install", { clients: ["codex"] }, "call-codex"),
      // No client named is not all of them: refused in words.
      noClients: await window.aiDev.call("clients_install", {}, "call-none"),
      // Permissions: none is granted, none is even asked for.
      notification: await new Promise((resolve) => setTimeout(() => Notification.requestPermission().then(resolve, (error) => resolve(`refused: ${error.name}`)), 0)),
      geolocation: await new Promise((resolve) => setTimeout(() => navigator.permissions.query({ name: "geolocation" }).then((answer) => resolve(answer.state), (error) => resolve(`refused: ${error.name}`)), 0))
    };
  });
  assert.deepEqual(seen.globals, { require: "undefined", process: "undefined", module: "undefined", Buffer: "undefined", global: "undefined", ipcRenderer: "undefined", electron: "undefined" });
  assert.deepEqual(seen.api, ["call", "cancel", "chooseFolder", "connect", "consoleCall", "onProgress", "onState", "reconnect", "retry", "setLanguage", "state", "tools"]);
  assert.equal(seen.apiFrozen, true);
  for (const key of ["file", "network", "evalCall", "newFunction", "worker"]) assert.match(seen[key], /^refused/, `${key}: ${seen[key]}`);
  assert.equal(seen.inline, "blocked", "no inline script runs");
  assert.equal(seen.opened, "denied");
  assert.deepEqual(seen.removeModel, { ok: false, error: 'The interface does not call "model_remove".', cancelled: false });
  assert.match(seen.agentTool.error, /The interface does not call "record_decision"/);
  assert.match(seen.badId.error, /id is call- and/);
  assert.match(seen.trayId.error, /id is call- and/, "the page cannot stand in for the tray's calls");
  assert.match(seen.otherSetting.error, /does not change "language"/);
  assert.deepEqual([seen.mirror.ok, seen.mirror.cancelled, seen.mirror.confirmed], [false, true, false]);
  const boxes = await messageBoxes(app);
  assert.equal(boxes.length, 1, "the mirror's change, and nothing else, asked");
  assert.match(boxes[0].detail, /^model_mirror: "http:\/\/127\.0\.0\.1:9\/x"$/m);
  await assert.rejects(fs.readFile(path.join(s.home, ".ai-dev", "config.json")), "no setting was written");
  assert.match(seen.clientNotOffered.error, /only the clients it found on this computer/);
  assert.deepEqual(seen.noClients, { ok: false, error: "clients_install needs clients.", cancelled: false });
  assert.equal(seen.notification, "denied");
  assert.equal(seen.geolocation, "denied");

  // Navigation away from the app's page does not happen.
  await page.evaluate(() => { window.location.href = "https://example.com/"; });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.match(page.url(), /^app:\/\/ai-dev\//);
  // The window's settings, read in the main process.
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const prefs = contents.getLastWebPreferences();
    return { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webviewTag: prefs.webviewTag };
  });
  assert.deepEqual(preferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
});

test("nothing leaves the window: WebRTC, a request made for it, another page with its functions, the developer tools", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  // Listeners a page could reach: a UDP port for STUN, a TCP port for TURN, an HTTP server.
  const stun = [];
  const udp = dgram.createSocket("udp4");
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  udp.on("message", (message) => stun.push(message.length));
  const turn = [];
  const tcp = net.createServer((socket) => { turn.push(socket.remoteAddress); socket.destroy(); });
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const requests = [];
  const web = http.createServer((request, response) => { requests.push(request.url); response.end("hi"); });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  t.after(() => { udp.close(); tcp.close(); web.close(); });

  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });

  // WebRTC from a task of the page: STUN over UDP and TURN over TCP.
  const rtc = await page.evaluate(({ udpPort, tcpPort }) => new Promise((resolve) => setTimeout(async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }, { urls: `turn:127.0.0.1:${tcpPort}?transport=tcp`, username: "u", credential: "p" }] });
      const candidates = [];
      pc.onicecandidate = (event) => event.candidate && candidates.push(event.candidate.type);
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((done) => setTimeout(done, 3000));
      pc.close();
      resolve(candidates);
    } catch (error) {
      resolve([`threw ${error.name}`]);
    }
  }, 0)), { udpPort: udp.address().port, tcpPort: tcp.address().port });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual({ candidates: rtc.filter((type) => type !== "host"), stun: stun.length, turn: turn.length }, { candidates: [], stun: 0, turn: 0 });
  // What WebRTC's TCP would go to: the page's session sends everything — loopback too — to a
  // proxy that is not there.
  const proxies = await app.evaluate(({ session }) => Promise.all(["https://example.com/", "http://127.0.0.1:8080/"].map((url) => session.fromPartition("ai-dev-page").resolveProxy(url))));
  assert.deepEqual(proxies, ["PROXY 127.0.0.1:9", "PROXY 127.0.0.1:9"]);

  // Names carry data too: the host of a TURN server and a dns-prefetch the page makes reach no
  // resolver — Electron's own net log names neither.
  const mark = `m${Date.now().toString(36)}`;
  const netlog = path.join(s.root, "netlog.json");
  await app.evaluate(async ({ netLog }, file) => { await netLog.startLogging(file, { captureMode: "everything" }); }, netlog);
  await page.evaluate((name) => new Promise((resolve) => setTimeout(async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: `turn:turn-${name}.example.com:3478?transport=tcp`, username: "u", credential: "p" }] });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
    const link = document.createElement("link");
    link.rel = "dns-prefetch";
    link.href = `//prefetch-${name}.example.com`;
    document.head.append(link);
    setTimeout(() => {
      pc.close();
      resolve();
    }, 3000);
  }, 0)), mark);
  await app.evaluate(async ({ netLog }) => { await netLog.stopLogging(); });
  const logged = await fs.readFile(netlog, "utf8");
  assert.ok(logged.length > 1000, "the net log has events");
  assert.equal(logged.includes(mark), false, "no name the page chose was looked up");

  // The session cancels what is not the app's page, whoever asks for it.
  const loads = await app.evaluate(async ({ BrowserWindow }, urls) => {
    // A window on the page's own session, where app://ai-dev is served.
    const window = new BrowserWindow({ show: false, webPreferences: { partition: "ai-dev-page" } });
    const outcome = {};
    for (const url of urls) {
      try {
        await window.loadURL(url);
        outcome[url] = "loaded";
      } catch (error) {
        outcome[url] = String(error.code ?? error.message);
      }
    }
    window.destroy();
    return outcome;
  }, [`http://127.0.0.1:${web.address().port}/leak`, "file:///etc/hostname", "app://other-host/index.html"]);
  for (const [url, outcome] of Object.entries(loads)) assert.match(outcome, /ERR_BLOCKED_BY_CLIENT/, url);
  assert.deepEqual(requests, [], "no request reached the server");

  // Another page with the same preload gets nothing from the main process: it has
  // window.aiDev, and every channel answers it null.
  const stranger = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } });
    await window.loadURL("about:blank").catch(() => undefined);
    const answer = await window.webContents.executeJavaScript("window.aiDev ? Promise.all([window.aiDev.state(), window.aiDev.call('system_status', {}, 'call-x')]) : 'no aiDev'").catch((error) => `threw ${error.message}`);
    window.destroy();
    return answer;
  }, path.join(desktopRoot, "src", "preload", "preload.cjs"));
  assert.deepEqual(stranger, [null, null], "a page that is not the app's gets no answer");

  // No developer tools and no default menu.
  const shipped = await app.evaluate(async ({ BrowserWindow, Menu }) => {
    const contents = BrowserWindow.getAllWindows().find((window) => window.isVisible())?.webContents ?? BrowserWindow.getAllWindows()[0].webContents;
    contents.openDevTools();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { opened: contents.isDevToolsOpened(), menu: Menu.getApplicationMenu() === null ? null : Menu.getApplicationMenu().items.map((item) => item.label) };
  });
  assert.deepEqual(shipped, { opened: false, menu: process.platform === "darwin" ? shipped.menu : null });
});
