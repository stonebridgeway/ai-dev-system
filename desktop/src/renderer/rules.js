// The Rules screen: one repository at a time — a project AI Dev knows, or a
// folder the person chooses — and what governs agents in it: the guard rules
// the agent hooks enforce (`list_policy_rules`, `upsert_policy_rule`,
// `remove_policy_rule`), the hooks themselves (`agent_hooks_status`,
// `install_agent_hooks`), the engineering rules each assistant reads
// (`list_rule_packs`, `install_project_rules`) and the MCP servers its
// configs start (`list_mcp_servers`). A change runs only after the person
// confirms it in a dialog of the main process (ipc-policy.mjs).
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { dataTable, emptyState, errorState, loadingLine } from "./ui.js";

const state = { project: null, mine: false };

function failure(view, error) {
  if (error.notConfirmed) return h("p", { className: "notice", role: "status", dataset: { field: "not-confirmed" } }, view.t("console.notConfirmed"));
  return h("p", { className: "error", role: "alert", dataset: { field: "rules-error" } }, view.t("common.error", { message: api.failureText(error, view.t) }));
}

/** A button that runs `work` once at a time and shows what came of it in `result`. */
function actionButton(view, { action, label, className = "secondary", result, work }) {
  const button = h("button", { type: "button", className, dataset: { action } }, label);
  button.addEventListener("click", async () => {
    button.disabled = true;
    show(result, h("p", { className: "muted", role: "status" }, view.t("common.working")));
    try {
      const said = await work();
      show(result, said ? h("p", { className: "ok", dataset: { field: "rules-done" } }, said) : null);
    } catch (error) {
      show(result, failure(view, error));
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function guardRules(view, project, redraw) {
  const body = h("div", {}, loadingLine(view));
  const result = h("div", { className: "save-result", "aria-live": "polite" });
  const load = () => {
    show(body, loadingLine(view));
    api.call("list_policy_rules", { project_path: project }).then((listed) => {
      const rows = listed.rules ?? [];
      const switchButton = (rule) => actionButton(view, {
        action: `toggle-${rule.id}`,
        label: view.t(rule.enabled ? "rules.turnOff" : "rules.turnOn"),
        result,
        work: async () => {
          await api.call("upsert_policy_rule", { project_path: project, rule: { id: rule.id, enabled: !rule.enabled } });
          load();
          return view.t(rule.enabled ? "rules.turnedOff" : "rules.turnedOn", { id: rule.id });
        }
      });
      const removeButton = (rule) => actionButton(view, {
        action: `remove-${rule.id}`,
        label: view.t("rules.remove"),
        result,
        work: async () => {
          await api.consoleCall("remove_policy_rule", { project_path: project, id: rule.id });
          load();
          return view.t("rules.removed", { id: rule.id });
        }
      });
      show(body,
        rows.length
          ? dataTable([
            { label: view.t("rules.column.id"), value: (rule) => rule.id },
            { label: view.t("rules.column.state"), value: (rule) => view.t(rule.enabled ? `rules.action.${rule.effective_action}` : "rules.off") },
            { label: view.t("rules.column.event"), value: (rule) => view.t(`rules.event.${rule.event}`) },
            { label: view.t("rules.column.message"), value: (rule) => [rule.message, ...(rule.problems ?? []).map((problem) => h("span", { className: "error small" }, ` ${problem}`))] },
            { label: "", value: (rule) => h("div", { className: "actions" }, switchButton(rule), removeButton(rule)) }
          ], rows, { name: "guard-rules" })
          : emptyState(view.t("rules.noRules")),
        (listed.problems ?? []).map((problem) => h("p", { className: "muted small" }, problem)));
    }, (error) => show(body, errorState(view, error, load)));
  };

  const id = h("input", { type: "text", id: "rule-id", placeholder: "no-force-push", spellcheck: "false" });
  const pattern = h("input", { type: "text", id: "rule-pattern", placeholder: "git push .*--force", spellcheck: "false" });
  const example = h("input", { type: "text", id: "rule-example", placeholder: "git push origin main --force", spellcheck: "false" });
  const message = h("input", { type: "text", id: "rule-message", placeholder: view.t("rules.field.messageHint") });
  const event = h("select", { id: "rule-event" }, ["bash", "file", "all"].map((value) => h("option", { value }, view.t(`rules.event.${value}`))));
  const action = h("select", { id: "rule-action" }, ["block", "warn"].map((value) => h("option", { value }, view.t(`rules.action.${value}`))));
  const row = (input, key) => h("div", { className: "field-row" }, h("label", { for: input.id }, view.t(key)), h("div", { className: "field-input" }, input));
  const save = h("button", { type: "submit", className: "primary", dataset: { action: "add-rule" } }, view.t("rules.add"));
  const form = h("form", { className: "inline-form", dataset: { form: "add-rule" }, novalidate: true },
    h("h3", {}, view.t("rules.addTitle")),
    row(id, "rules.field.id"), row(pattern, "rules.field.pattern"), row(example, "rules.field.example"), row(message, "rules.field.message"),
    row(event, "rules.field.event"), row(action, "rules.field.action"),
    h("div", { className: "actions" }, save));
  form.addEventListener("submit", async (submitted) => {
    submitted.preventDefault();
    const empty = [[id, "rules.field.id"], [pattern, "rules.field.pattern"], [example, "rules.field.example"], [message, "rules.field.message"]].find(([input]) => !input.value.trim());
    if (empty) {
      show(result, h("p", { className: "error", role: "alert" }, view.t("mySkills.required", { field: view.t(empty[1]) })));
      empty[0].focus();
      return;
    }
    save.disabled = true;
    show(result, h("p", { className: "muted", role: "status" }, view.t("common.working")));
    try {
      const answer = await api.call("upsert_policy_rule", {
        project_path: project,
        rule: { id: id.value.trim(), pattern: pattern.value.trim(), example: example.value.trim(), message: message.value.trim(), event: event.value, action: action.value }
      });
      for (const input of [id, pattern, example, message]) input.value = "";
      show(result, h("p", { className: "ok", dataset: { field: "rules-done" } }, view.t(answer.action === "created" ? "rules.added" : "rules.changed", { id: answer.rule?.id ?? "" })));
      load();
    } catch (error) {
      show(result, failure(view, error));
    } finally {
      save.disabled = false;
    }
  });
  load();
  return h("section", { dataset: { section: "guard-rules" } }, h("h2", {}, view.t("rules.guardTitle")), h("p", { className: "help" }, view.t("rules.guardHelp")), body, form, result);
}

function hooksAndPacks(view, project) {
  const body = h("div", {}, loadingLine(view));
  const result = h("div", { className: "save-result", "aria-live": "polite" });
  const profile = h("select", { id: "hooks-profile" }, ["minimal", "standard", "strict"].map((value) => h("option", { value, selected: value === "standard" }, view.t(`rules.profile.${value}`))));
  const load = () => {
    show(body, loadingLine(view));
    Promise.all([api.call("agent_hooks_status", { project_path: project }), api.call("list_rule_packs", { project_path: project })]).then(([hooks, packs]) => {
      show(body,
        h("p", { dataset: { field: "hooks-state" } }, view.t(hooks.installed ? "rules.hooksOn" : "rules.hooksOff", { profile: hooks.profile ?? "" })),
        h("div", { className: "field-row" }, h("label", { for: profile.id }, view.t("rules.field.profile")), h("div", { className: "field-input" }, profile,
          actionButton(view, {
            action: "install-hooks",
            label: view.t(hooks.installed ? "rules.hooksReinstall" : "rules.hooksInstall"),
            className: "primary",
            result,
            work: async () => {
              const answer = await api.call("install_agent_hooks", { project_path: project, profile: profile.value });
              load();
              return view.t("rules.hooksInstalled", { count: (answer.written?.length ?? 0) + (answer.updated?.length ?? 0) });
            }
          }))),
        h("h3", {}, view.t("rules.packsTitle")),
        h("p", { className: "help" }, view.t("rules.packsHelp", { stack: packs.detected?.stack?.join(", ") || view.t("rules.noStack"), packs: packs.detected?.packs?.join(", ") || view.t("rules.commonOnly") })),
        h("div", { className: "actions" },
          actionButton(view, {
            action: "preview-rules",
            label: view.t("rules.preview"),
            result,
            work: async () => {
              const answer = await api.call("install_project_rules", { project_path: project, dry_run: true });
              return view.t("rules.previewed", { files: (answer.planned ?? []).join(", ") || view.t("rules.nothing") });
            }
          }),
          actionButton(view, {
            action: "install-rules",
            label: view.t("rules.install"),
            className: "primary",
            result,
            work: async () => {
              const answer = await api.call("install_project_rules", { project_path: project });
              const written = [...(answer.written ?? []), ...(answer.updated ?? [])].map((file) => (typeof file === "string" ? file : file.path));
              return view.t("rules.installed", { count: written.length, kept: (answer.skipped ?? []).length });
            }
          })));
    }, (error) => show(body, errorState(view, error, load)));
  };
  load();
  return h("section", { dataset: { section: "hooks-and-packs" } }, h("h2", {}, view.t("rules.hooksTitle")), h("p", { className: "help" }, view.t("rules.hooksHelp")), body, result);
}

function servers(view, project) {
  const body = h("div", {}, loadingLine(view));
  const mine = h("input", { type: "checkbox", id: "servers-mine", checked: state.mine });
  const load = () => {
    state.mine = mine.checked;
    show(body, loadingLine(view));
    api.call("list_mcp_servers", { project_path: project, include_user_scope: state.mine }).then((listed) => {
      const runs = (server) => server.url || [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
      show(body,
        listed.servers?.length
          ? dataTable([
            { label: view.t("servers.column.name"), value: (server) => server.name },
            { label: view.t("servers.column.runs"), value: (server) => h("code", {}, runs(server)) },
            { label: view.t("servers.column.where"), value: (server) => [...new Set(server.origins.map((origin) => `${origin.client} · ${origin.path}`))].join("\n") }
          ], listed.servers, { name: "mcp-servers" })
          : emptyState(view.t(state.mine ? "servers.none" : "servers.noneHere")),
        (listed.findings ?? []).length
          ? h("ul", { className: "findings", dataset: { field: "server-findings" } }, listed.findings.map((finding) => h("li", { className: finding.severity === "warn" ? "notice" : "error" }, `${finding.server}: ${finding.message}`)))
          : null,
        listed.next_step ? h("p", { className: "muted small" }, listed.next_step) : null);
    }, (error) => show(body, errorState(view, error, load)));
  };
  mine.addEventListener("change", load);
  load();
  return h("section", { dataset: { section: "mcp-servers" } },
    h("h2", {}, view.t("servers.title")),
    h("p", { className: "help" }, view.t("servers.help")),
    h("label", { className: "check-label", for: mine.id }, mine, " ", view.t("servers.mine")),
    body);
}

/** The Rules screen. */
export function rulesScreen(view) {
  const body = h("div", { className: "screen-body" });
  const picker = h("div", { className: "field-row", dataset: { field: "project-picker" } }, loadingLine(view));
  const open = (project) => {
    state.project = project;
    show(body, h("p", { className: "muted", dataset: { field: "project" } }, project), guardRules(view, project), hooksAndPacks(view, project), servers(view, project));
  };
  const choose = h("button", {
    type: "button",
    className: "secondary",
    dataset: { action: "choose-project" },
    on: {
      async click() {
        const folder = await api.chooseFolder("project");
        if (folder) open(folder);
      }
    }
  }, view.t("rules.chooseFolder"));
  api.call("list_projects").then((projects) => {
    const list = (Array.isArray(projects) ? projects : []).filter((project) => project.project_path);
    const select = h("select", { id: "rules-project" },
      h("option", { value: "" }, view.t("rules.pickProject")),
      list.map((project) => h("option", { value: project.project_path, selected: project.project_path === state.project }, project.name ?? project.project_path)));
    select.addEventListener("change", () => select.value && open(select.value));
    show(picker, h("label", { for: select.id }, view.t("rules.project")), h("div", { className: "field-input" }, select, choose));
  }, () => show(picker, h("div", { className: "field-input" }, choose)));
  if (state.project) open(state.project);
  else show(body, emptyState(view.t("rules.choose")));
  return h("section", { dataset: { screen: "rules" } }, h("h1", { tabindex: "-1" }, view.t("rules.title")), h("p", { className: "help" }, view.t("rules.help")), picker, body);
}
