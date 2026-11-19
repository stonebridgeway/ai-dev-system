// The Costs screen: what the work has cost — today, yesterday, the last seven
// days and everything recorded — by model, by tool and by task, for all
// projects or one (`usage_report`). It only reads.
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { dataTable, emptyState, errorState, formatMoney, formatNumber, loadingLine } from "./ui.js";

const state = { project: "" };

function tile(view, name, label, slice) {
  return h("div", { className: "tile", dataset: { period: name } },
    h("span", { className: "muted" }, label),
    h("strong", { className: "tile-value" }, formatMoney(slice?.cost_usd, view.language)),
    h("span", { className: "muted" }, view.t("costs.tokens", {
      input: formatNumber(slice?.input_tokens, view.language),
      output: formatNumber(slice?.output_tokens, view.language)
    })));
}

function report(view, answer) {
  if (!answer.events) return emptyState(view.t("costs.empty"));
  const money = (row) => formatMoney(row.cost_usd, view.language);
  const tokens = (row) => view.t("costs.tokens", { input: formatNumber(row.input_tokens, view.language), output: formatNumber(row.output_tokens, view.language) });
  const models = [...(answer.models ?? []), ...(answer.historical_models ?? []).map((row) => ({ ...row, historical: true }))];
  return [
    h("div", { className: "tiles" },
      tile(view, "today", view.t("costs.today"), answer.periods?.today),
      tile(view, "yesterday", view.t("costs.yesterday"), answer.periods?.yesterday),
      tile(view, "week", view.t("costs.week"), answer.periods?.last_7_days),
      tile(view, "total", view.t("costs.total"), answer.usage)),
    h("h2", {}, view.t("costs.models")),
    models.length
      ? dataTable([
        { label: view.t("costs.col.model"), value: (row) => [row.model, row.historical ? h("span", { className: "muted" }, ` (${view.t("costs.historical")})`) : null] },
        { label: view.t("costs.col.cost"), value: money, numeric: true },
        { label: view.t("costs.col.tokens"), value: tokens, numeric: true }
      ], models, { name: "models" })
      : emptyState(view.t("costs.models.empty")),
    h("h2", {}, view.t("costs.tools")),
    answer.tools?.length
      ? dataTable([
        { label: view.t("costs.col.tool"), value: (row) => row.tool },
        { label: view.t("costs.col.calls"), value: (row) => formatNumber(row.calls, view.language), numeric: true },
        { label: view.t("costs.col.failures"), value: (row) => formatNumber(row.failures, view.language), numeric: true },
        { label: view.t("costs.col.average"), value: (row) => formatNumber(row.average_ms, view.language), numeric: true }
      ], answer.tools, { name: "tools" })
      : emptyState(view.t("costs.tools.empty")),
    h("h2", {}, view.t("costs.tasks")),
    answer.tasks?.length
      ? dataTable([
        { label: view.t("costs.col.task"), value: (row) => row.task_id || view.t("costs.noTask") },
        { label: view.t("costs.col.cost"), value: money, numeric: true },
        { label: view.t("costs.col.tokens"), value: tokens, numeric: true },
        { label: view.t("costs.col.calls"), value: (row) => formatNumber(row.tool_calls, view.language), numeric: true }
      ], answer.tasks, { name: "tasks" })
      : emptyState(view.t("costs.tasks.empty")),
    answer.rates?.source?.url
      ? h("p", { className: "muted small" }, view.t("costs.rates", { url: answer.rates.source.url, date: answer.rates.source.checked_on ?? "" }))
      : null
  ];
}

/** The Costs screen. */
export function costsScreen(view) {
  const body = h("div", { className: "screen-body" }, loadingLine(view));
  const picker = h("select", { id: "costs-project", dataset: { field: "project" } }, h("option", { value: "" }, view.t("costs.allProjects")));
  const load = () => {
    show(body, loadingLine(view));
    const args = state.project ? { project_path: state.project } : {};
    api.call("usage_report", args).then((answer) => show(body, report(view, answer)), (error) => show(body, errorState(view, error, load)));
  };
  picker.addEventListener("change", () => {
    state.project = picker.value;
    load();
  });
  // The projects to pick from; without them the screen still shows everything.
  api.call("list_projects").then((projects) => {
    for (const project of Array.isArray(projects) ? projects : []) picker.append(h("option", { value: project.project_path }, project.name));
    picker.value = state.project;
    if (picker.value !== state.project) {
      state.project = "";
      load();
    }
  }, () => undefined);
  load();
  return h("section", { dataset: { screen: "costs" } },
    h("h1", { tabindex: "-1" }, view.t("costs.title")),
    h("div", { className: "actions" },
      h("label", { className: "field-inline" }, h("span", {}, view.t("costs.project")), picker),
      h("button", { type: "button", className: "secondary", dataset: { action: "refresh" }, on: { click: load } }, view.t("common.refresh"))),
    body);
}
