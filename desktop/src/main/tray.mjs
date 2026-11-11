/**
 * The tray: a dot in the colour of the daemon's state, and a menu — open the
 * window, rebuild the search index, stop the daemon, quit.
 */
import process from "node:process";
import { circlePng, TRAY_COLOURS, trayState } from "./tray-icon.mjs";

/** How often a Stop's note looks whether the daemons it names still run. */
export const NOTE_LOOK_MS = 1_000;

/** Whether process `pid` runs; one the app may not signal runs too. No pid ≤ 0 does: 0 and -1 name groups. */
export function processRuns(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The tray's menu as a template, so a test can read it without a tray.
 *
 * @param {{ t: (key: string, params?: object) => string, online: boolean, rebuilding: number | null, failed?: unknown, stopping?: boolean, stopFailed?: unknown, update?: { version: string } | null }} view
 *   `failed` — the last rebuild from the tray failed, until the next one;
 *   `stopping` — a Stop runs; `stopFailed` — the last Stop failed, while a
 *   daemon it names still runs; `update` — an update is downloaded and waits.
 * @param {{ open: () => void, rebuild: () => void, stop: () => void, quit: () => void, update?: () => void }} actions
 */
export function trayMenuTemplate({ t, online, rebuilding, failed = null, stopping = false, stopFailed = null, update = null }, actions) {
  // "Try again" only where it can be pressed; offline the tooltip says why.
  const rebuildLabel = rebuilding !== null ? t("tray.rebuilding", { percent: rebuilding }) : failed && online ? t("tray.rebuildFailed") : t("tray.rebuild");
  const stopLabel = stopping ? t("tray.stopping") : stopFailed ? t("tray.stopFailed") : t("tray.stop");
  return [
    { id: "open", label: t("tray.open"), click: actions.open },
    {
      id: "rebuild",
      label: rebuildLabel,
      enabled: online && rebuilding === null,
      click: actions.rebuild
    },
    // A daemon that would not stop may be one the app is not on: Stop is
    // offered again while it runs, and not while a Stop runs.
    { id: "stop", label: stopLabel, enabled: !stopping && (online || Boolean(stopFailed)), click: actions.stop },
    { type: "separator" },
    // A downloaded update: offered here, and installed at Quit if not sooner.
    ...(update && actions.update ? [{ id: "update", label: t("tray.update", { version: update.version }), click: actions.update }] : []),
    { id: "quit", label: t("tray.quit"), click: actions.quit }
  ];
}

/**
 * Create the tray and keep it in step with the daemon.
 *
 * @param {{ electron: typeof import("electron"), link: import("./daemon-link.mjs").DaemonLink, t: (key: string, params?: object) => string, actions: object, runs?: (pid: number) => boolean, lookEveryMs?: number }} options
 *   `t` translates into the language in force when it is called; `runs`
 *   tells whether a daemon still runs.
 * @returns {{ tray: import("electron").Tray, refresh: () => void, setRebuilding: (percent: number | null, failure?: { key?: string, text?: string } | string | null) => void, setStopping: () => void, setStopFailed: (failure: { daemons?: Array<{ pid: number, reason?: string }>, error?: string } | string | null) => void, setUpdate: (update: { version: string } | null) => void, state: () => string, menu: () => Array<object>, tooltip: () => string }}
 */
export function createTray({ electron, link, t, actions, runs = processRuns, lookEveryMs = NOTE_LOOK_MS }) {
  const { Menu, Tray, nativeImage } = electron;
  const images = Object.fromEntries(Object.entries(TRAY_COLOURS).map(([state, rgb]) => {
    const image = nativeImage.createFromBuffer(circlePng(rgb, 32), { scaleFactor: 2 });
    return [state, image];
  }));
  let current = "offline";
  let rebuilding = null;
  // Why the last rebuild failed: the link's own words by their key, said in
  // the language in force, or the daemon's text.
  let failed = null;
  let stopping = false;
  // Why the last Stop failed: the daemons that would not stop, each with its
  // pid and why, or the error the request ended with.
  let stopFailed = null;
  // A downloaded update waiting for a restart: `{ version }`, or null.
  let update = null;
  let noteTimer = null;
  // What Electron was last given, which is what the person sees.
  let template = [];
  let tip = "";
  const tray = new Tray(images.offline);
  // A Stop's note holds while a daemon it names runs — the app may be off it,
  // its own having stopped. One that names none (the request itself failed)
  // was about the daemon the app is on: it holds while the app is online.
  const noteHolds = (online) => (stopFailed.daemons.length ? stopFailed.daemons.some(({ pid }) => runs(pid)) : online);
  // Each daemon whole, with its reason cut; three at most, and how many more.
  const cut = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
  const daemonWords = ({ pid, reason }) => (reason ? t("tray.stopFailedDaemon", { pid, reason: cut(reason, 60) }) : t("tray.stopFailedDaemonBare", { pid }));
  const stopWords = () => {
    if (!stopFailed.daemons.length) return t("tray.stopErrorTip", { message: cut(stopFailed.error, 120) });
    const named = stopFailed.daemons.slice(0, 3).map(daemonWords);
    const more = stopFailed.daemons.length - named.length;
    return t("tray.stopFailedTip", { message: [...named, ...(more ? [t("tray.stopFailedMore", { count: more })] : [])].join("; ") });
  };
  const stopLooking = () => {
    clearInterval(noteTimer);
    noteTimer = null;
  };
  const refresh = () => {
    const online = link.state.phase === "online";
    if (stopFailed && !noteHolds(online)) stopFailed = null;
    if (!stopFailed) stopLooking();
    current = online ? trayState(link.status) : "offline";
    tray.setImage(images[current]);
    const why = failed?.key ? t(failed.key) : String(failed?.text ?? "");
    const tips = [
      t(`tray.tooltip.${current}`),
      failed ? t("tray.rebuildFailedTip", { message: why.slice(0, 120) }) : null,
      stopFailed ? stopWords() : null
    ];
    tip = tips.filter(Boolean).join("\n");
    tray.setToolTip(tip);
    template = trayMenuTemplate({ t, online, rebuilding, failed, stopping, stopFailed, update }, actions);
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  tray.on("click", actions.open);
  link.on("state", refresh);
  link.on("status", refresh);
  refresh();
  return {
    tray,
    refresh,
    /** The rebuild's progress (null: not running); when it ends, why it failed, if it did. */
    setRebuilding(percent, failure = null) {
      rebuilding = percent;
      if (percent !== null || !failure) failed = null;
      else failed = typeof failure === "string" ? { text: failure } : failure;
      refresh();
    },
    /** A Stop runs: the item says so and cannot be pressed; the last note goes. */
    setStopping() {
      stopping = true;
      stopFailed = null;
      refresh();
    },
    /** The Stop ended: the daemons that would not stop (`{ daemons: [{ pid, reason }] }`), the error it ended with (`{ error }`), or null. */
    setStopFailed(failure) {
      stopping = false;
      const daemons = (failure?.daemons ?? []).filter(({ pid }) => Number.isInteger(pid) && pid > 0).map(({ pid, reason }) => ({ pid, reason: String(reason ?? "") }));
      const error = typeof failure === "string" ? failure : String(failure?.error ?? "");
      stopFailed = daemons.length || error ? { daemons, error } : null;
      stopLooking();
      // Nothing else tells the tray when such a daemon ends: it looks.
      if (stopFailed?.daemons.length) {
        noteTimer = setInterval(() => {
          if (stopFailed && !noteHolds(link.state.phase === "online")) refresh();
        }, lookEveryMs);
        noteTimer.unref?.();
      }
      refresh();
    },
    /** An update was downloaded (`{ version }`): the menu offers a restart for it. */
    setUpdate(next) {
      update = next?.version ? { version: next.version } : null;
      refresh();
    },
    state: () => current,
    /** The menu as Electron was last given it: each item's id, label and whether it is enabled. */
    menu: () => template.filter((item) => item.id).map(({ id, label, enabled = true }) => ({ id, label, enabled })),
    /** The tooltip as Electron was last given it. */
    tooltip: () => tip
  };
}
