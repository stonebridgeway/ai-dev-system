// The page: which screen shows, the language, the header. The main process
// tells the page where the daemon stands (connecting, online, offline, no
// Node); the page asks it to connect, and calls tools once online.
import * as api from "./api.js";
import { consoleScreen } from "./console.js";
import { costsScreen } from "./costs.js";
import { h, show } from "./dom.js";
import { pickLanguage, translate } from "./i18n.js";
import { logScreen } from "./log.js";
import { projectsScreen } from "./projects.js";
import { rulesScreen } from "./rules.js";
import { settingsScreen } from "./settings.js";
import { skillsScreen } from "./skills.js";
import { statusScreen } from "./status.js";
import { wizardScreen } from "./wizard.js";

/** Every screen the header leads to, by its route. */
const SCREENS = {
  status: statusScreen,
  projects: projectsScreen,
  costs: costsScreen,
  skills: skillsScreen,
  rules: rulesScreen,
  console: consoleScreen,
  log: logScreen,
  settings: settingsScreen,
  wizard: wizardScreen
};

const screen = document.getElementById("screen");
const languageSelect = document.getElementById("language");
const nav = document.querySelector("nav");
let leaving = [];

const view = {
  language: "en",
  connection: { phase: "connecting" },
  route: null,
  t: (key, params) => translate(view.language, key, params),
  /** What a screen stops when another one opens (a timer, a poll). */
  onLeave: (callback) => leaving.push(callback)
};

function leave() {
  for (const callback of leaving.splice(0)) {
    try {
      callback();
    } catch {
      // a screen's own cleanup does not stop the next screen
    }
  }
}

function translateStatic() {
  document.documentElement.lang = view.language;
  document.title = view.t("app.title");
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = view.t(element.dataset.i18n);
  nav.setAttribute("aria-label", view.t("nav.main"));
  languageSelect.setAttribute("aria-label", view.t("nav.language"));
  languageSelect.value = view.language;
  for (const button of document.querySelectorAll("[data-nav]")) {
    if (button.dataset.nav === view.route && view.connection.phase === "online") button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function focusHeading() {
  screen.querySelector("h1")?.focus();
}

function connectingScreen() {
  const { preparing, progress = 0, total = 0 } = view.connection;
  if (!preparing) {
    return h("section", { className: "centre", dataset: { screen: "connecting" } },
      h("h1", { tabindex: "-1" }, view.t("connect.title")),
      h("div", { className: "spinner", role: "presentation" }));
  }
  // The Windows install copies its runtime first (desktop/src/main/bundle.mjs).
  const megabytes = (bytes) => `${Math.round(bytes / 1_048_576)} MB`;
  return h("section", { className: "centre", dataset: { screen: "preparing" } },
    h("h1", { tabindex: "-1" }, view.t("connect.preparing")),
    h("p", {}, view.t("connect.preparingDetail")),
    total > 0
      ? h("div", { className: "progress" }, h("progress", { max: String(total), value: String(progress), "aria-label": view.t("connect.preparing") }))
      : h("div", { className: "spinner", role: "presentation" }),
    total > 0 ? h("p", { className: "muted" }, view.t("connect.preparingProgress", { done: megabytes(progress), total: megabytes(total) })) : null);
}

/** A Try again button, for a screen whose cause the person can fix while the app runs. */
function retryButton(label) {
  const button = h("button", {
    type: "button",
    className: "primary",
    id: "retry",
    on: {
      async click() {
        button.disabled = true;
        await api.retry();
        button.disabled = false;
      }
    }
  }, label);
  return button;
}

function noNodeScreen() {
  return h("section", { className: "centre", dataset: { screen: "no-node" } },
    h("h1", { tabindex: "-1" }, view.t("node.title")),
    h("p", {}, view.t("node.body")),
    view.connection.error ? h("p", { className: "muted" }, view.connection.error) : null,
    retryButton(view.t("common.retry")));
}

/** The app could not get going: what stopped it, what to do, and Try again or Restart. */
function brokenScreen() {
  const { connection } = view;
  return h("section", { className: "centre", dataset: { screen: "broken" } },
    h("h1", { tabindex: "-1" }, view.t("broken.title")),
    h("p", { className: "error", role: "alert", dataset: { field: "broken-error" } }, connection.error ?? ""),
    connection.hint ? h("p", { dataset: { field: "broken-hint" } }, connection.hint) : null,
    retryButton(view.t(connection.restart ? "broken.restart" : "common.retry")),
    connection.detail ? h("details", { className: "log" }, h("summary", {}, view.t("broken.detail")), h("pre", {}, connection.detail)) : null);
}

function offlineScreen() {
  const { connection } = view;
  const starting = connection.phase === "starting";
  const start = h("button", {
    type: "button",
    className: "primary",
    id: "start-daemon",
    disabled: starting,
    on: { click: () => api.connect(true) }
  }, view.t(starting ? "offline.starting" : "offline.start"));
  return h("section", { className: "centre", dataset: { screen: "offline" } },
    h("h1", { tabindex: "-1" }, view.t("offline.title")),
    h("p", {}, view.t("offline.body")),
    start,
    connection.error ? h("p", { className: "error", role: "alert", dataset: { field: "offline-error" } }, h("span", { className: "label" }, `${view.t("offline.reason")}: `), connection.error) : null,
    connection.log?.length
      ? h("details", { className: "log" }, h("summary", {}, view.t("offline.log")), h("pre", {}, connection.log.join("\n")))
      : null);
}

async function render() {
  leave();
  const { phase } = view.connection;
  document.body.dataset.phase = phase;
  if (phase === "online" && !view.route) view.route = view.connection.needsSetup ? "wizard" : "status";
  translateStatic();
  if (phase === "connecting" || phase === "reconnecting") return show(screen, connectingScreen());
  if (phase === "no-node") return show(screen, noNodeScreen());
  if (phase === "broken") return show(screen, brokenScreen());
  if (phase !== "online") return show(screen, offlineScreen());
  const navigate = (route) => {
    view.route = route;
    render();
  };
  show(screen, (SCREENS[view.route] ?? statusScreen)(view, navigate));
  focusHeading();
  return undefined;
}

for (const button of document.querySelectorAll("[data-nav]")) {
  button.addEventListener("click", () => {
    if (view.connection.phase !== "online") return;
    view.route = button.dataset.nav;
    render();
  });
}

languageSelect.addEventListener("change", async () => {
  view.language = pickLanguage(languageSelect.value, "");
  // The state comes back in the new language: the link's own words too.
  const connection = await api.setLanguage(view.language);
  if (connection) {
    view.connection = connection;
    // The main process's language after the choice: a state sent meanwhile does not undo it.
    if (connection.language) view.language = connection.language;
  }
  render();
});

api.onState((connection) => {
  const was = view.connection.phase;
  const spoken = view.language;
  view.connection = connection ?? { phase: "offline" };
  if (connection?.language) view.language = connection.language;
  // A screen in the middle of a step keeps its place while the daemon is
  // reachable, and across a reconnect (the daemon of new code); any
  // other change of phase draws the page again from the start.
  if (was !== view.connection.phase) {
    if (!["online", "reconnecting"].includes(view.connection.phase)) view.route = null;
    render();
  } else if (["offline", "broken", "no-node"].includes(view.connection.phase) || view.language !== spoken) {
    // The same screen with news: a log that arrived, a reason that changed —
    // or the language, which the main process changed: the settings file,
    // fixed, named its own.
    render();
  }
});

const initial = await api.state();
view.connection = initial;
view.language = initial.language ?? pickLanguage("", navigator.language);
render();
