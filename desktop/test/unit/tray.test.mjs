import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { TRAY_COLOURS, circlePng, trayState } from "../../src/main/tray-icon.mjs";
import { NOTE_LOOK_MS, processRuns, trayMenuTemplate } from "../../src/main/tray.mjs";
import { translate } from "../../src/renderer/i18n.js";

/** The chunks of a PNG, checked: length, type, CRC. */
function chunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const found = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), zlib.crc32(png.subarray(at + 4, at + 8 + length)) >>> 0, `${type} CRC`);
    found.push({ type, data });
    at += 12 + length;
  }
  return found;
}

test("the tray icon is a valid RGBA PNG: the colour in the middle, transparency in the corner", () => {
  const png = circlePng(TRAY_COLOURS.ok, 32);
  const parts = chunks(png);
  assert.deepEqual(parts.map((part) => part.type), ["IHDR", "IDAT", "IEND"]);
  const header = parts[0].data;
  assert.deepEqual([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]], [32, 32, 8, 6]);
  const pixels = zlib.inflateSync(parts[1].data);
  assert.equal(pixels.length, 32 * (1 + 32 * 4));
  const pixel = (x, y) => [...pixels.subarray(y * 129 + 1 + x * 4, y * 129 + 1 + x * 4 + 4)];
  assert.deepEqual(pixel(16, 16), [...TRAY_COLOURS.ok, 255]);
  assert.equal(pixel(0, 0)[3], 0);
  assert.throws(() => circlePng(TRAY_COLOURS.ok, 4), /size must be/);
});

test("the tray's colour follows system_status, and its menu what can be done now", () => {
  assert.deepEqual([{ status: "ok" }, { status: "degraded" }, { status: "failed" }, { status: "odd" }, null].map(trayState), ["ok", "degraded", "failed", "offline", "offline"]);
  const t = (key, params) => translate("en", key, params);
  const noop = () => undefined;
  const actions = { open: noop, rebuild: noop, stop: noop, quit: noop };
  const items = (view) => trayMenuTemplate({ t, ...view }, actions).filter((item) => item.id).map(({ id, label, enabled = true }) => [id, label, enabled]);
  assert.deepEqual(items({ online: true, rebuilding: null }), [
    ["open", "Open AI Dev", true], ["rebuild", "Rebuild search index", true], ["stop", "Stop the daemon", true], ["quit", "Quit", true]
  ]);
  assert.deepEqual(items({ online: true, rebuilding: 40 }).find(([id]) => id === "rebuild"), ["rebuild", "Rebuilding the index… 40%", false]);
  assert.deepEqual(items({ online: false, rebuilding: null }).filter(([, , enabled]) => !enabled).map(([id]) => id), ["rebuild", "stop"]);
});

/** A tray on a stand-in Electron: what it was given, as the person sees it. */
async function standInTray(options = {}) {
  const { EventEmitter } = await import("node:events");
  const { createTray } = await import("../../src/main/tray.mjs");
  const set = [];
  let menu = [];
  const electron = {
    nativeImage: { createFromBuffer: (buffer) => ({ buffer }) },
    Tray: class {
      setImage(image) { set.push(image); }
      setToolTip(text) { this.tip = text; }
      setContextMenu(template) { menu = template; }
      on() {}
    },
    Menu: { buildFromTemplate: (template) => template }
  };
  const link = Object.assign(new EventEmitter(), { state: { phase: "online" }, status: null });
  const view = { language: "en" };
  const t = (key, params) => translate(view.language, key, params);
  const tray = createTray({ electron, link, t, actions: { open() {}, rebuild() {}, stop() {}, quit() {} }, ...options });
  const goes = (phase) => {
    link.state = { phase };
    link.emit("state", link.state);
  };
  const item = (id) => {
    const found = menu.find((entry) => entry.id === id);
    return [found.label, found.enabled ?? true];
  };
  return { tray, link, view, set, goes, item, menu: () => menu };
}

test("each state is drawn in its own colour, and a failed rebuild is said in the menu", async () => {
  const { tray, link, set, goes, item, menu } = await standInTray();
  const colours = Object.keys(TRAY_COLOURS);
  assert.equal(new Set(colours.map((state) => String(TRAY_COLOURS[state]))).size, colours.length, "four different colours");
  for (const state of ["ok", "degraded", "failed"]) {
    link.status = { status: state };
    link.emit("status", link.status);
    assert.equal(tray.state(), state);
    assert.ok(set.at(-1).buffer.equals(circlePng(TRAY_COLOURS[state], 32)), `${state} is drawn in its colour`);
  }
  goes("offline");
  assert.ok(set.at(-1).buffer.equals(circlePng(TRAY_COLOURS.offline, 32)));
  goes("online");
  tray.setRebuilding(null, "The index folder is a file.");
  assert.deepEqual(item("rebuild"), ["Rebuild failed — try again", true]);
  assert.equal(tray.menu().find((entry) => entry.id === "rebuild").label, "Rebuild failed — try again");
  assert.match(tray.tray.tip, /\nThe last rebuild failed: The index folder is a file\.$/, "and why, in the tooltip");
  // Offline, "try again" cannot be pressed: the item says nothing of it, the tooltip still does.
  goes("offline");
  assert.deepEqual(item("rebuild"), ["Rebuild search index", false]);
  assert.match(tray.tray.tip, /The last rebuild failed: The index folder is a file\./);
  goes("online");
  tray.setRebuilding(10);
  assert.deepEqual(item("rebuild"), ["Rebuilding the index… 10%", false]);
  tray.setRebuilding(null);
  assert.deepEqual(item("rebuild"), ["Rebuild search index", true]);
  assert.ok(menu().length > 0);
});

test("a rebuild the link ended is said again in the language chosen after", async () => {
  const { tray, view, goes } = await standInTray();
  tray.setRebuilding(null, { key: "link.wentAway", text: "The daemon went away." });
  goes("offline");
  assert.match(tray.tooltip(), /The last rebuild failed: The daemon went away\.$/);
  view.language = "ru";
  tray.refresh();
  assert.equal(tray.tooltip(), "AI Dev: демон не запущен\nПоследняя перестройка не удалась: Демон пропал.");
  // The daemon's own words are kept as they came.
  tray.setRebuilding(null, { text: "The index folder is a file." });
  assert.match(tray.tooltip(), /Последняя перестройка не удалась: The index folder is a file\.$/);
});

test("a Stop that failed is said while a daemon it names runs — offline too — and Stop is offered again", async () => {
  const running = new Set([4242]);
  const { tray, goes, item } = await standInTray({ runs: (pid) => running.has(pid), lookEveryMs: 5 });
  // While a Stop runs, the item says so and cannot be pressed.
  tray.setStopping();
  assert.deepEqual(item("stop"), ["Stopping the daemon…", false]);
  assert.deepEqual(tray.menu().find((entry) => entry.id === "stop"), { id: "stop", label: "Stopping the daemon…", enabled: false });
  // The app's own daemon stopped, another one would not: the app is offline, the note holds.
  goes("offline");
  tray.setStopFailed({ daemons: [{ pid: 4242, reason: "No handshake within 5000 ms" }] });
  assert.deepEqual(item("stop"), ["Stop failed — try again", true], "offline, and Stop can be pressed again");
  assert.equal(tray.tooltip(), "AI Dev: the daemon is not running\nStill running after Stop: daemon 4242 (No handshake within 5000 ms)");
  assert.equal(tray.tooltip(), tray.tray.tip, "as Electron was given it");
  goes("online");
  goes("offline");
  assert.deepEqual(item("stop"), ["Stop failed — try again", true], "a move or a reconnect does not drop it");
  // The daemon ends — nothing else tells the tray: the note goes within a look.
  running.delete(4242);
  for (const deadline = Date.now() + 2_000; item("stop")[0] !== "Stop the daemon" && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(item("stop"), ["Stop the daemon", false]);
  assert.doesNotMatch(tray.tooltip(), /after Stop/);
  // A Stop whose request failed names no daemon: its note is about the one the app is on, and goes once the app is off it.
  goes("online");
  tray.setStopping();
  tray.setStopFailed({ error: "EPERM" });
  assert.match(tray.tooltip(), /\nStop failed: EPERM$/);
  assert.deepEqual(item("stop"), ["Stop failed — try again", true]);
  goes("offline");
  assert.deepEqual(item("stop"), ["Stop the daemon", false]);
  goes("online");
  assert.deepEqual(item("stop"), ["Stop the daemon", true], "not back on the next daemon");
  // A new Stop drops the last note at once; one that stops everything leaves none.
  running.add(4343);
  tray.setStopFailed({ daemons: [{ pid: 4343, reason: "it is still running" }] });
  tray.setStopping();
  assert.doesNotMatch(tray.tooltip(), /after Stop/);
  tray.setStopFailed(null);
  assert.deepEqual(item("stop"), ["Stop the daemon", true]);
});

test("a note naming two daemons holds while either runs, in the language in force; no pid ≤ 0 runs", async () => {
  const running = new Set([501, 502]);
  const { tray, view, goes, item } = await standInTray({ runs: (pid) => running.has(pid), lookEveryMs: 5 });
  goes("offline");
  tray.setStopFailed({ daemons: [{ pid: 501, reason: "No handshake within 5000 ms" }, { pid: 502, reason: "it is still running" }, { pid: 0, reason: "x" }, { pid: -1, reason: "y" }] });
  assert.equal(tray.tooltip(), "AI Dev: the daemon is not running\nStill running after Stop: daemon 501 (No handshake within 5000 ms); daemon 502 (it is still running)");
  running.delete(501);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(item("stop"), ["Stop failed — try again", true], "the other one still runs");
  view.language = "ru";
  tray.refresh();
  assert.equal(tray.tooltip(), "AI Dev: демон не запущен\nРаботает после «Остановить»: демон 501 (No handshake within 5000 ms); демон 502 (it is still running)");
  running.delete(502);
  for (const deadline = Date.now() + 2_000; item("stop")[1] && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(item("stop"), ["Остановить демон", false]);
  // A note that names no daemon that can run says nothing.
  tray.setStopFailed({ daemons: [{ pid: 0, reason: "x" }] });
  assert.equal(tray.tooltip(), "AI Dev: демон не запущен");
});

test("the tray asks the system whether a daemon runs, once a second at most: this process does, an ended one and pids 0, -1 do not", async () => {
  const { spawn } = await import("node:child_process");
  assert.ok(NOTE_LOOK_MS <= 1_000);
  assert.equal(processRuns(process.pid), true);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(processRuns(child.pid), false);
  assert.deepEqual([0, -1, 1.5, Number.NaN].map(processRuns), [false, false, false, false]);
});

test("the note's words: each daemon whole, its reason cut, three at most and how many more, no empty brackets", async () => {
  const running = new Set([41234, 41235, 41236, 41237, 4242]);
  const { tray, view } = await standInTray({ runs: (pid) => running.has(pid) });
  const long = `Cannot reach the daemon at /home/${"x".repeat(60)}/ai-dev-0123456789abcdef01234567.sock: EAGAIN`;
  tray.setStopFailed({ daemons: [41234, 41235, 41236, 41237].map((pid) => ({ pid, reason: long })) });
  const tip = tray.tooltip().split("\n")[1];
  for (const pid of [41234, 41235, 41236]) assert.match(tip, new RegExp(`daemon ${pid} \\(Cannot reach the daemon at /home/x+…\\)`));
  assert.doesNotMatch(tip, /41237/);
  assert.match(tip, /; 1 more$/);
  view.language = "ru";
  tray.refresh();
  assert.match(tray.tooltip(), /; ещё 1$/);
  view.language = "en";
  tray.setStopFailed({ daemons: [{ pid: 4242, reason: "" }] });
  assert.equal(tray.tooltip().split("\n")[1], "Still running after Stop: daemon 4242");
});
