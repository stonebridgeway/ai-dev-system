// The Status screen: where the system stands and why, every health check with
// its details and what to do about it, and the buttons that do it.
import * as api from "./api.js";
import { DETAIL_ROWS, checkTitle, orderedChecks, recommendation, unsaidProblems } from "./checks.js";
import { h, progressBar, show } from "./dom.js";
import { modelUnreadable } from "./setup-words.js";

/**
 * The rebuild Status started, while it runs: its id for Cancel, its last
 * progress, who to tell. It outlives a redraw — a person who goes to Setup
 * and back finds it still there.
 */
let rebuilding = null;

function startRebuild() {
  const running = { id: null, progress: {}, listeners: new Set(), ended: null };
  running.ended = api.call("rebuild_search_index", {}, {
    onStart: (id) => { running.id = id; },
    onProgress: (event) => {
      running.progress = event;
      for (const listener of running.listeners) listener(event);
    }
  }).then(() => null, (error) => error).finally(() => {
    if (rebuilding === running) rebuilding = null;
  });
  rebuilding = running;
  return running;
}

function detailRows(view, details) {
  if (!details || typeof details !== "object") return null;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return null;
  const rest = entries.length - DETAIL_ROWS;
  return h("dl", { className: "details" },
    entries.slice(0, DETAIL_ROWS).map(([key, value]) => [h("dt", {}, key), h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value))]),
    rest > 0 ? [h("dt", {}, "…"), h("dd", {}, view.t("status.moreDetails", { count: rest }))] : null);
}

function checkItem(view, check) {
  const advice = recommendation(view, check);
  const details = detailRows(view, check.details);
  const critical = check.critical === true && check.status === "fail";
  return h("li", { className: `check check-${check.status}`, dataset: { check: check.name, status: check.status, critical: String(check.critical === true) } },
    h("div", { className: "check-head" },
      h("span", { className: "badge" }, view.t(`status.check.${check.status}`)),
      critical ? h("span", { className: "badge badge-critical" }, view.t("status.critical")) : null,
      h("strong", {}, checkTitle(check.name, view.t))),
    h("p", {}, check.summary),
    advice ? h("p", { className: "advice" }, h("span", { className: "label" }, `${view.t("status.recommendation")}: `), advice) : null,
    details ? h("details", {}, h("summary", {}, view.t("status.details")), details) : null);
}

/** The model's line: installed, cannot be read and why, or not installed. */
function modelRow(view, model) {
  if (model.installed) return view.t("status.model.installed");
  return model.unreadable ? modelUnreadable(view, model).status : view.t("status.model.missing");
}

function overview(view, status) {
  const index = status.index.exists
    ? view.t("status.index.documents", { documents: status.index.documents, dense: status.index.dense_documents })
    : view.t("status.index.missing");
  return h("dl", { className: "overview" },
    h("dt", {}, view.t("status.model")), h("dd", { dataset: { field: "model" } }, modelRow(view, status.model)),
    h("dt", {}, view.t("status.index")), h("dd", { dataset: { field: "index" } }, index),
    h("dt", {}, view.t("status.clients")), h("dd", { dataset: { field: "clients" } }, view.t("status.clients.count", status.clients)));
}

/**
 * Why the install is not ok, in the daemon's words, and the settings file's
 * problems — each once: one the summary already says is not listed
 * again.
 */
function why(view, status) {
  if (status.status === "ok") return null;
  const problems = unsaidProblems(status);
  return h("div", { className: "why", dataset: { field: "why" } },
    h("p", {}, h("span", { className: "label" }, `${view.t("status.why")}: `), status.summary),
    problems.length
      ? [h("p", { className: "label" }, view.t("status.settingsProblems")), h("ul", { dataset: { field: "settings-problems" } }, problems.map((problem) => h("li", {}, problem)))]
      : null);
}

/**
 * What the app says of its runtime, when it has something to say
 * (`runtimeNotice`, src/main/bundle.mjs): it runs from its copy, the drive
 * holding no link — after an update the clients must be connected again — or
 * it put back files that went missing.
 */
function runtimeNotes(view) {
  const runtime = view.connection.runtime;
  if (!runtime) return null;
  return h("div", { className: "notice-box", dataset: { field: "runtime" } },
    runtime.linkError ? h("p", { dataset: { field: "no-link" } }, view.t("status.noLink", { folder: runtime.folder, reason: runtime.linkError })) : null,
    runtime.repaired.length
      ? h("p", { dataset: { field: "repaired" } }, view.t("status.repaired", { count: runtime.repaired.length, files: runtime.repaired.slice(0, 3).join(", ") }))
      : null);
}

/** The Status screen; it loads the checks when drawn. */
export function statusScreen(view, navigate) {
  const body = h("div", { className: "status-body" }, h("p", { className: "muted", dataset: { state: "loading" } }, view.t("common.working")));
  const refresh = h("button", { type: "button", className: "secondary", dataset: { action: "refresh" } }, view.t("common.refresh"));
  const rebuild = h("button", { type: "button", className: "secondary", dataset: { action: "rebuild" } }, view.t("status.rebuild"));
  const setup = h("button", { type: "button", className: "secondary", dataset: { action: "setup" }, on: { click: () => navigate("wizard") } }, view.t("status.runSetup"));
  const work = h("div", { className: "work" });

  const load = () => api.call("system_status", { checks: true }).then((status) => {
    show(body,
      h("p", { className: `overall overall-${status.status}`, dataset: { field: "overall", status: status.status } }, view.t(`status.overall.${status.status}`)),
      why(view, status),
      h("p", { className: "muted" }, view.t("status.version", { version: status.version, pid: status.served_by.pid, sessions: status.served_by.sessions ?? 0 })),
      overview(view, status),
      h("h2", {}, view.t("status.checks")),
      h("ul", { className: "checks" }, orderedChecks(status.checks).map((check) => checkItem(view, check))));
  }, (error) => show(body, h("p", { className: "error", role: "alert" }, view.t("common.error", { message: api.failureText(error, view.t) }))));

  // A rebuild running — started now, or before the screen was drawn again:
  // its progress and Cancel. Started now, the focus moves to Cancel; when it
  // ends, a focus left on Cancel goes back to Rebuild.
  const showRebuild = (running, { focus = false } = {}) => {
    const bar = progressBar();
    bar.update(running.progress);
    const cancel = h("button", { type: "button", className: "secondary", dataset: { action: "cancel-rebuild" }, on: { click: () => running.id && api.cancel(running.id) } }, view.t("common.cancel"));
    rebuild.disabled = true;
    show(work, bar.element, cancel);
    if (focus) cancel.focus();
    const listener = (event) => bar.update(event);
    running.listeners.add(listener);
    running.ended.then((error) => {
      running.listeners.delete(listener);
      if (!work.isConnected) return;
      const focused = document.activeElement;
      const lost = !focused || focused === document.body || work.contains(focused);
      rebuild.disabled = false;
      if (lost) rebuild.focus();
      if (!error) show(work);
      else if (error.cancelled) show(work, h("p", { className: "notice" }, view.t("common.cancelled")));
      else show(work, h("p", { className: "error" }, view.t("common.error", { message: api.failureText(error, view.t) })));
      load();
    });
  };
  refresh.addEventListener("click", load);
  rebuild.addEventListener("click", () => showRebuild(startRebuild(), { focus: true }));
  if (rebuilding) showRebuild(rebuilding);
  load();
  return h("section", { dataset: { screen: "status" } },
    h("h1", { tabindex: "-1" }, view.t("status.title")),
    runtimeNotes(view),
    h("div", { className: "actions" }, refresh, rebuild, setup),
    work,
    body);
}
