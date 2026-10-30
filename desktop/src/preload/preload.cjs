// The page's only way out: a few functions on `window.aiDev`, each one
// channel of the main process (src/main/ipc-policy.mjs). A sandboxed preload
// can require nothing but `electron`'s renderer modules, so the channel names
// are written out here; a test checks they match the policy's.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = {
  state: "ai-dev:state",
  connect: "ai-dev:connect",
  retry: "ai-dev:retry",
  call: "ai-dev:call",
  cancel: "ai-dev:cancel",
  chooseFolder: "ai-dev:choose-folder",
  setLanguage: "ai-dev:set-language",
  tools: "ai-dev:tools",
  consoleCall: "ai-dev:console-call",
  reconnect: "ai-dev:reconnect"
};
const events = {
  state: "ai-dev:state-changed",
  progress: "ai-dev:progress"
};

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("A callback is a function.");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aiDev", Object.freeze({
  /** The connection to the daemon, the platform, the language. */
  state: () => ipcRenderer.invoke(invoke.state),
  /** Reach the daemon, starting it when `start` is true. */
  connect: (start) => ipcRenderer.invoke(invoke.connect, { start: start === true }),
  /** Try again after the app could not get going (no Node, a broken settings file, a missing server). */
  retry: () => ipcRenderer.invoke(invoke.retry),
  /** Call one of the interface's tools; `id` names the call for progress and cancel. */
  call: (tool, args, id) => ipcRenderer.invoke(invoke.call, { tool, args, id }),
  /** Every tool the daemon lists to the app, for the tool console. */
  tools: () => ipcRenderer.invoke(invoke.tools),
  /** Run a tool from the console; one that changes something asks the person first. */
  consoleCall: (tool, args, id) => ipcRenderer.invoke(invoke.consoleCall, { tool, args, id }),
  /** Open a new session with the daemon, for a setting that applies to new sessions. */
  reconnect: () => ipcRenderer.invoke(invoke.reconnect),
  /** Cancel a call by its id. */
  cancel: (id) => ipcRenderer.invoke(invoke.cancel, id),
  /** The folder the person picks in the system's dialog, or null. */
  chooseFolder: (purpose) => ipcRenderer.invoke(invoke.chooseFolder, { purpose: String(purpose ?? "") }),
  /** Show the tray and menus in this language too. */
  setLanguage: (language) => ipcRenderer.invoke(invoke.setLanguage, String(language ?? "")),
  onState: (callback) => subscribe(events.state, callback),
  onProgress: (callback) => subscribe(events.progress, callback)
}));
