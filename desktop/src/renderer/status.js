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

/**
 * One check: its name in the page's words and what to do — the two a person
 * acts on — then the daemon's own sentence, smaller, and the details folded.
 */
function checkItem(view, check) {
  const advice = recommendation(view, check);
  const details = detailRows(view, check.details);
  const critical = check.critical === true && check.status === "fail";
  return h("li", { className: `check check-${check.status}`, dataset: { check: check.name, status: check.status, critical: String(check.critical === true) } },
    h("div", { className: "check-head" },
      h("span", { className: "status-dot", "aria-hidden": "true" }),
      h("strong", {}, checkTitle(check.name, view.t)),
      critical ? h("span", { className: "badge badge-critical" }, view.t("status.critical")) : null,
      h("span", { className: "badge" }, view.t(`status.check.${check.status}`))),
    advice ? h("p", { className: "advice" }, h("span", { className: "label" }, `${view.t("status.recommendation")}: `), advice) : null,
    h("p", { className: "check-summary" }, check.summary),
    details ? h("details", {}, h("summary", {}, view.t("status.details")), details) : null);
}

/** The checks: what needs attention first, open; what works folded under one line. */
function checkLists(view, checks) {
  const ordered = orderedChecks(checks);
  const attention = ordered.filter((check) => check.status !== "ok");
  const working = ordered.filter((check) => check.status === "ok");
  return [
    h("h2", {}, view.t("status.attention"), attention.length ? h("span", { className: "count" }, String(attention.length)) : null),
    attention.length
      ? h("ul", { className: "checks" }, attention.map((check) => checkItem(view, check)))
      : h("p", { className: "all-pass" }, view.t("status.allPass")),
    working.length
      ? h("details", { className: "passing" },
        h("summary", {}, view.t("status.passing", { count: working.length })),
        h("ul", { className: "checks" }, working.map((check) => checkItem(view, check))))
      : null
  ];
}

/** The model's line: installed, cannot be read and why, or not installed. */
function modelRow(view, model) {
  if (model.installed) return view.t("status.model.installed");
  return model.unreadable ? modelUnreadable(view, model).status : view.t("status.model.missing");
}

/** A part of the install as a tile: its name, its state as a colour and a word, and the line about it. */
function tile(label, [state, word], field, value) {
  return h("div", { className: `part part-${state}` },
    h("div", { className: "part-head" }, h("span", { className: "status-dot", "aria-hidden": "true" }), h("span", { className: "part-label" }, label), h("span", { className: "part-state" }, word)),
    h("div", { className: "part-value", dataset: { field } }, value));
}

function overview(view, status) {
  const index = status.index.exists
    ? view.t("status.index.documents", { documents: status.index.documents, dense: status.index.dense_documents })
    : view.t("status.index.missing");
  const ready = ["ok", view.t("status.tile.ok")];
  const model = status.model.installed ? ready : ["warn", view.t(status.model.unreadable ? "status.tile.unreadable" : "status.tile.optional")];
  const indexState = !status.index.exists ? ["fail", view.t("status.tile.needed")] : status.index.fresh === false ? ["warn", view.t("status.tile.stale")] : ready;
  const clients = Number(status.clients.connected) > 0 ? ready
    : ["warn", view.t(Number(status.clients.found) > 0 ? "status.tile.notConnected" : "status.tile.noneFound")];
  return h("div", { className: "parts" },
    tile(view.t("status.model"), model, "model", modelRow(view, status.model)),
    tile(view.t("status.index"), indexState, "index", index),
    tile(view.t("status.clients"), clients, "clients", view.t("status.clients.count", status.clients)));
}

const VERDICT_MARK = Object.freeze({ ok: "✓", degraded: "!", failed: "✕" });

/**
 * Why the install is not ok, in the daemon's words, and the settings file's
 * problems — each once: one the summary already says is not listed
 * again.
 */
function why(view, status) {
  if (status.status === "ok") return null;
  const problems = unsaidProblems(status);
  // The checks that make the verdict, by their names in the page's words; the daemon's sentence under them.
  const worst = (status.checks ?? []).filter((check) => check.status === "fail");
  const named = (worst.length ? worst : (status.checks ?? []).filter((check) => check.status === "warn"))
    .map((check) => `${checkTitle(check.name, view.t)} — ${view.t(`status.check.${check.status}`).toLowerCase()}`);
  return h("div", { className: "why", dataset: { field: "why" } },
    h("p", { className: "why-line" }, h("span", { className: "label" }, `${view.t("status.why")}: `), named.length ? named.join("; ") : status.summary),
    named.length ? h("details", { className: "why-raw" }, h("summary", {}, view.t("status.technical")), h("p", {}, status.summary)) : null,
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
      h("div", { className: `verdict verdict-${status.status}` },
        h("span", { className: "verdict-mark", "aria-hidden": "true" }, VERDICT_MARK[status.status] ?? "?"),
        h("div", { className: "verdict-text" },
          h("p", { className: `overall overall-${status.status}`, dataset: { field: "overall", status: status.status } }, view.t(`status.overall.${status.status}`)),
          why(view, status),
          h("p", { className: "muted small" }, view.t("status.version", { version: status.version, pid: status.served_by.pid, sessions: status.served_by.sessions ?? 0 })))),
      overview(view, status),
      checkLists(view, status.checks));
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
    h("div", { className: "page-head" },
      h("h1", { tabindex: "-1" }, view.t("status.title")),
      h("div", { className: "actions" }, refresh, rebuild, setup)),
    runtimeNotes(view),
    work,
    body);
}
