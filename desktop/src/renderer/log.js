// The Log screen: the last lines of the daemon's log (`logs_tail`), the part
// set aside at 1 MB, and Follow, which reads it again every two seconds while
// the screen is open. It only reads.
import * as api from "./api.js";
import { formatBytes, h, show } from "./dom.js";
import { emptyState, errorState, loadingLine } from "./ui.js";

const FOLLOW_EVERY_MS = 2000;
const state = { log: "daemon", lines: 200, follow: false };

/** The Log screen; `view.onLeave` stops Follow when another screen opens. */
export function logScreen(view) {
  const body = h("div", { className: "screen-body" }, loadingLine(view));
  const which = h("select", { id: "log-name", dataset: { field: "log" } },
    h("option", { value: "daemon" }, view.t("log.daemon")),
    h("option", { value: "daemon.1" }, view.t("log.daemonOld")));
  which.value = state.log;
  const lines = h("select", { id: "log-lines", dataset: { field: "lines" } }, [50, 200, 1000].map((count) => h("option", { value: count }, String(count))));
  lines.value = String(state.lines);
  const follow = h("input", { type: "checkbox", id: "log-follow", checked: state.follow });
  let timer = null;
  let busy = false;

  const load = (quiet = false) => {
    if (busy) return;
    busy = true;
    if (!quiet) show(body, loadingLine(view));
    api.call("logs_tail", { log: state.log, lines: state.lines }).then((answer) => {
      if (!answer.exists) return show(body, emptyState(view.t("log.missing", { file: answer.file })));
      if (!answer.lines.length) return show(body, emptyState(view.t("log.empty")));
      const pre = h("pre", { className: "log-lines", tabindex: "0", "aria-label": view.t("log.title") }, answer.lines.join("\n"));
      show(body,
        h("p", { className: "muted small", dataset: { field: "log-file" } }, view.t("log.file", { file: answer.file, size: formatBytes(answer.size, view.language) })),
        pre);
      pre.scrollTop = pre.scrollHeight;
      return undefined;
    }, (error) => show(body, errorState(view, error, () => load()))).finally(() => {
      busy = false;
    });
  };

  const setFollow = (on) => {
    state.follow = on;
    clearInterval(timer);
    timer = on ? setInterval(() => load(true), FOLLOW_EVERY_MS) : null;
  };

  which.addEventListener("change", () => {
    state.log = which.value;
    load();
  });
  lines.addEventListener("change", () => {
    state.lines = Number(lines.value);
    load();
  });
  follow.addEventListener("change", () => setFollow(follow.checked));
  view.onLeave?.(() => clearInterval(timer));
  setFollow(state.follow);
  load();
  return h("section", { dataset: { screen: "log" } },
    h("h1", { tabindex: "-1" }, view.t("log.title")),
    h("div", { className: "actions" },
      h("label", { className: "field-inline", for: "log-name" }, view.t("log.which")), which,
      h("label", { className: "field-inline", for: "log-lines" }, view.t("log.lines")), lines,
      h("label", { className: "check-label", for: "log-follow" }, follow, " ", view.t("log.follow")),
      h("button", { type: "button", className: "secondary", dataset: { action: "refresh" }, on: { click: () => load() } }, view.t("common.refresh"))),
    body);
}
