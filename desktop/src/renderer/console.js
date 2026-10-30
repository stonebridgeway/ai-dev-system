// The tool console: every tool the daemon lists to the app, a form built from
// the tool's input schema (schema-form.js), and the answer — readable and as
// JSON. A tool that only reads runs at once; one that changes something runs
// only after the person confirms it in a dialog the main process shows
// (src/main/console-policy.mjs) — the page asks, it cannot answer.
import * as api from "./api.js";
import { h, progressBar, show } from "./dom.js";
import { readableValue } from "./readable.js";
import { argumentsFrom, formFields, initialValue } from "./schema-form.js";
import { emptyState, errorState, loadingLine } from "./ui.js";

const state = { filter: "", selected: null, tab: "readable" };

function badge(view, tool) {
  const kind = tool.readOnly ? "read" : tool.destructive ? "destructive" : "write";
  return h("span", { className: `badge badge-${kind}`, dataset: { kind } }, view.t(`console.kind.${kind}`));
}

function fieldControl(view, field, value) {
  const id = `arg-${field.name}`;
  const label = h("label", { for: id }, field.name, field.required ? h("span", { className: "required", title: view.t("console.required") }, " *") : null);
  let input;
  if (field.kind === "flag") {
    input = h("input", { type: "checkbox", id, name: field.name, checked: value === true });
  } else if (field.kind === "choice") {
    input = h("select", { id, name: field.name },
      field.required ? null : h("option", { value: "" }, view.t("console.unset")),
      field.options.map((option) => h("option", { value: option }, option)));
    input.value = value;
  } else if (field.kind === "lines" || field.kind === "json") {
    input = h("textarea", { id, name: field.name, rows: field.kind === "json" ? 4 : 3, spellcheck: "false" });
    input.value = value;
  } else {
    input = h("input", { type: field.kind === "text" ? "text" : "number", id, name: field.name, spellcheck: "false", ...(field.kind === "integer" ? { step: 1 } : {}) });
    input.value = value;
    if (field.minimum !== undefined) input.min = field.minimum;
    if (field.maximum !== undefined) input.max = field.maximum;
  }
  const hint = field.kind === "lines" ? view.t("console.hint.lines") : field.kind === "json" ? view.t("console.hint.json") : "";
  const error = h("p", { className: "field-error error", id: `${id}-error`, "aria-live": "polite" });
  input.setAttribute("aria-describedby", `${id}-error`);
  const help = [field.description, hint].filter(Boolean).join(" ");
  return {
    element: h("div", { className: "arg", dataset: { arg: field.name } }, label, input, help ? h("p", { className: "help" }, help) : null, error),
    read: () => (field.kind === "flag" ? input.checked : input.value),
    error: (problem) => {
      error.textContent = problem ? view.t(`console.error.${problem.code}`, problem) : "";
      if (problem) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  };
}

function resultView(view, outcome) {
  const readable = h("button", { type: "button", className: "tab", dataset: { tab: "readable" }, "aria-pressed": String(state.tab === "readable") }, view.t("console.readable"));
  const json = h("button", { type: "button", className: "tab", dataset: { tab: "json" }, "aria-pressed": String(state.tab === "json") }, view.t("console.json"));
  const panel = h("div", { className: "result-panel", dataset: { panel: state.tab } });
  const draw = () => {
    readable.setAttribute("aria-pressed", String(state.tab === "readable"));
    json.setAttribute("aria-pressed", String(state.tab === "json"));
    panel.dataset.panel = state.tab;
    show(panel, state.tab === "json"
      ? h("pre", { className: "code", tabindex: "0" }, JSON.stringify(outcome.result, null, 2))
      : h("div", { className: "readable-root" }, readableValue(outcome.result, h, view.t)));
  };
  for (const button of [readable, json]) {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      draw();
    });
  }
  draw();
  return h("div", { className: "result", dataset: { field: "result" } },
    h("div", { className: "result-head" }, h("h3", {}, view.t("console.result")), h("span", { className: "muted" }, view.t("console.duration", { ms: outcome.ms })),
      h("div", { className: "tabs", role: "group", "aria-label": view.t("console.result") }, readable, json)),
    panel);
}

function toolPanel(view, tool) {
  const fields = formFields(tool.inputSchema);
  const controls = fields.map((field) => fieldControl(view, field, initialValue(field)));
  const out = h("div", { className: "console-out", "aria-live": "polite" });
  const run = h("button", { type: "submit", className: "primary", dataset: { action: "run" } }, view.t("console.run"));
  const form = h("form", { className: "console-form", dataset: { tool: tool.name }, novalidate: true },
    controls.length ? controls.map((control) => control.element) : h("p", { className: "muted" }, view.t("console.noArguments")),
    tool.readOnly ? null : h("p", { className: "notice small", dataset: { field: "confirm-note" } }, view.t(tool.destructive ? "console.note.destructive" : "console.note.write")),
    h("div", { className: "actions" }, run));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(fields.map((field, index) => [field.name, controls[index].read()]));
    const { args, errors } = argumentsFrom(fields, values);
    fields.forEach((field, index) => controls[index].error(errors[field.name]));
    if (Object.keys(errors).length) {
      form.querySelector("[aria-invalid]")?.focus();
      return;
    }
    run.disabled = true;
    const bar = progressBar();
    bar.update({ message: view.t("common.working") });
    let id = null;
    const cancel = h("button", { type: "button", className: "secondary", dataset: { action: "cancel" }, on: { click: () => id && api.cancel(id) } }, view.t("common.cancel"));
    show(out, bar.element, cancel);
    const started = performance.now();
    try {
      const result = await api.consoleCall(tool.name, args, { onStart: (callId) => { id = callId; }, onProgress: (progress) => bar.update(progress) });
      show(out, resultView(view, { result, ms: Math.round(performance.now() - started) }));
    } catch (error) {
      show(out, error.notConfirmed
        ? h("p", { className: "notice", role: "status", dataset: { field: "not-confirmed" } }, view.t("console.notConfirmed"))
        : h("p", { className: error.cancelled ? "notice" : "error", role: "alert", dataset: { field: "call-error" } }, error.cancelled ? view.t("common.cancelled") : view.t("common.error", { message: error.message })));
    } finally {
      run.disabled = false;
    }
  });
  return h("div", { className: "tool-panel", dataset: { selected: tool.name } },
    h("div", { className: "tool-head" }, h("h2", { tabindex: "-1" }, tool.name), badge(view, tool)),
    tool.title && tool.title !== tool.name ? h("p", { className: "muted" }, tool.title) : null,
    h("p", { className: "tool-description" }, tool.description),
    form,
    out);
}

/** The Tool console screen. */
export function consoleScreen(view) {
  const list = h("div", { className: "tool-list" }, loadingLine(view));
  const panel = h("div", { className: "tool-detail" }, h("p", { className: "muted" }, view.t("console.pick")));
  const filter = h("input", { type: "search", id: "console-filter", placeholder: view.t("console.filter"), "aria-label": view.t("console.filter"), value: state.filter });
  let tools = [];

  const select = (tool) => {
    state.selected = tool.name;
    for (const button of list.querySelectorAll("[data-tool]")) button.setAttribute("aria-current", String(button.dataset.tool === tool.name));
    show(panel, toolPanel(view, tool));
    panel.querySelector("h2")?.focus();
  };

  const drawList = () => {
    const query = state.filter.toLowerCase();
    const matching = tools.filter((tool) => !query || tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query));
    if (!matching.length) return show(list, emptyState(view.t("console.none", { query: state.filter })));
    return show(list,
      h("p", { className: "muted small", dataset: { field: "tool-count" } }, view.t("console.count", { count: matching.length })),
      h("ul", { className: "tools" }, matching.map((tool) => h("li", {},
        h("button", { type: "button", className: "tool-button", dataset: { tool: tool.name }, "aria-current": String(tool.name === state.selected), on: { click: () => select(tool) } },
          h("span", { className: "tool-name" }, tool.name), badge(view, tool))))));
  };

  const load = () => {
    show(list, loadingLine(view));
    api.tools().then((listed) => {
      tools = listed;
      if (!tools.length) return show(list, emptyState(view.t("console.noTools")));
      drawList();
      const selected = tools.find((tool) => tool.name === state.selected);
      if (selected) show(panel, toolPanel(view, selected));
      return undefined;
    }, (error) => show(list, errorState(view, error, load)));
  };

  filter.addEventListener("input", () => {
    state.filter = filter.value.trim();
    drawList();
  });
  load();
  return h("section", { className: "console", dataset: { screen: "console" } },
    h("h1", { tabindex: "-1" }, view.t("console.title")),
    h("div", { className: "console-grid" }, h("div", { className: "console-left" }, filter, list), panel));
}
