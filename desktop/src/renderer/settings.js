// The Settings screen: the settings in ~/.ai-dev/config.json the app changes
// (`settings_get`, `settings_set`) — the projects and model folders, the
// profiles AI clients get, the model mirror, the daemon's idle time and
// whether the app starts it — each with what it does, the value in force and
// where it comes from, and when a change takes effect. A change for new
// sessions reaches this app after it reconnects, which a button does.
// The language is chosen in the header.
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { errorState, loadingLine } from "./ui.js";

const FOLDERS = new Set(["projects_root", "model_dir"]);
const HIDDEN = new Set(["language"]);

/** The value a setting's field starts with: what the file says, else what is in force. */
function startingValue(answer, name) {
  if (Object.hasOwn(answer.pending ?? {}, name)) return answer.pending[name];
  if (Object.hasOwn(answer.stored ?? {}, name)) return answer.stored[name];
  return answer.settings?.[name];
}

/** "environment (AI_DEV_IDLE_TIMEOUT_MS)" and the like, in the page's language. */
export function sourceText(view, source) {
  const text = String(source ?? "");
  const session = /^(.*), as this session started$/.exec(text);
  if (session) return view.t("settings.source.session", { source: sourceText(view, session[1]) });
  const environment = /^environment \((\w+)\)$/.exec(text);
  if (environment) return view.t("settings.source.environment", { name: environment[1] });
  if (text === "file" || text === "default") return view.t(`settings.source.${text}`);
  return text;
}

function shown(view, value) {
  if (value === true) return view.t("common.yes");
  if (value === false) return view.t("common.no");
  if (value === "" || value === null || value === undefined) return view.t("settings.empty");
  return String(value);
}

function field(view, definition, value) {
  const id = `setting-${definition.name}`;
  if (definition.type === "boolean") {
    const box = h("input", { type: "checkbox", id, name: definition.name, checked: value === true });
    return { input: box, read: () => box.checked, control: h("label", { className: "check-label", for: id }, box, " ", view.t(`settings.name.${definition.name}`)) };
  }
  const input = h("input", {
    type: definition.type === "number" ? "number" : "text",
    id,
    name: definition.name,
    value: value ?? "",
    ...(definition.name === "daemon_idle_minutes" ? { min: 0, max: 10080, step: 1 } : {}),
    spellcheck: "false"
  });
  const read = () => (definition.type === "number" ? (input.value.trim() === "" ? null : Number(input.value)) : input.value.trim() || null);
  const choose = FOLDERS.has(definition.name)
    ? h("button", {
      type: "button",
      className: "secondary",
      dataset: { action: `choose-${definition.name}` },
      on: {
        async click() {
          const folder = await api.chooseFolder(definition.name);
          if (folder) input.value = folder;
        }
      }
    }, view.t("settings.choose"))
    : null;
  return { input, read, control: h("div", { className: "field-row" }, h("label", { for: id }, view.t(`settings.name.${definition.name}`)), h("div", { className: "field-input" }, input, choose)) };
}

function settingRow(view, answer, definition) {
  const start = startingValue(answer, definition.name);
  const control = field(view, definition, start);
  const pending = Object.hasOwn(answer.pending ?? {}, definition.name);
  const row = h("div", { className: "setting", dataset: { setting: definition.name } },
    control.control,
    h("p", { className: "help" }, view.t(`settings.help.${definition.name}`)),
    h("p", { className: "muted small" },
      view.t("settings.inForce", { value: shown(view, answer.settings?.[definition.name]), source: sourceText(view, answer.sources?.[definition.name]) }),
      " · ",
      view.t(`settings.applies.${definition.applies}`)),
    pending ? h("p", { className: "notice small", dataset: { pending: definition.name } }, view.t("settings.pending", { value: shown(view, answer.pending[definition.name]) })) : null);
  const initial = control.read();
  return { row, name: definition.name, changed: () => !same(control.read(), initial), value: () => control.read() };
}

function same(left, right) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function reconnectNotice(view) {
  const button = h("button", {
    type: "button",
    className: "primary",
    dataset: { action: "reconnect" },
    on: {
      async click() {
        button.disabled = true;
        await api.reconnect();
      }
    }
  }, view.t("settings.reconnect"));
  return h("div", { className: "notice-box", dataset: { field: "reconnect" } }, h("p", {}, view.t("settings.reconnect.body")), button);
}

function paths(view, status, file) {
  const rows = [
    ["settings.path.config", file],
    ["settings.path.vault", status?.install?.vault_root],
    ["settings.path.runtime", status?.install?.runtime_root],
    ["settings.path.install", status?.install?.root]
  ].filter(([, value]) => value);
  return h("dl", { className: "overview", dataset: { field: "paths" } }, rows.map(([key, value]) => [h("dt", {}, view.t(key)), h("dd", {}, value)]));
}

/** The Settings screen. */
export function settingsScreen(view) {
  const body = h("div", { className: "screen-body" }, loadingLine(view));
  const draw = (message = null) => {
    show(body, loadingLine(view));
    Promise.all([api.call("settings_get"), api.call("system_status", { checks: false }).catch(() => null)]).then(([answer, status]) => {
      const rows = (answer.definitions ?? []).filter((definition) => !HIDDEN.has(definition.name)).map((definition) => settingRow(view, answer, definition));
      const result = h("div", { className: "save-result", "aria-live": "polite" }, message);
      const save = h("button", { type: "submit", className: "primary", dataset: { action: "save" } }, view.t("common.save"));
      const form = h("form", { className: "settings", dataset: { form: "settings" }, novalidate: true }, rows.map((row) => row.row), h("div", { className: "actions" }, save), result);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const changes = Object.fromEntries(rows.filter((row) => row.changed()).map((row) => [row.name, row.value()]));
        if (!Object.keys(changes).length) {
          show(result, h("p", { className: "muted" }, view.t("settings.unchanged")));
          return;
        }
        save.disabled = true;
        try {
          const saved = await api.call("settings_set", { settings: changes });
          const lines = (saved.changed ?? []).map((name) => h("li", {}, `${view.t(`settings.name.${name}`)}: ${view.t(`settings.applies.${saved.applies?.[name] ?? "now"}`)}`));
          draw(h("div", { className: "ok", dataset: { field: "saved" } }, h("p", {}, view.t("settings.saved")), h("ul", {}, lines)));
        } catch (error) {
          save.disabled = false;
          // The model's mirror and folder, the profiles: saved only once the person confirms them.
          show(result, error.notConfirmed
            ? h("p", { className: "notice", role: "status", dataset: { field: "not-confirmed" } }, view.t("settings.notConfirmed"))
            : h("p", { className: "error", role: "alert", dataset: { field: "save-error" } }, view.t("common.error", { message: error.message })));
        }
      });
      show(body,
        answer.problems?.length ? h("div", { className: "error-state", role: "alert" }, h("p", {}, view.t("settings.problems")), h("ul", {}, answer.problems.map((problem) => h("li", {}, problem)))) : null,
        Object.keys(answer.pending ?? {}).length ? reconnectNotice(view) : null,
        form,
        h("h2", {}, view.t("settings.paths")),
        paths(view, status, answer.file));
    }, (error) => show(body, errorState(view, error, () => draw())));
  };
  draw();
  return h("section", { dataset: { screen: "settings" } }, h("h1", { tabindex: "-1" }, view.t("settings.title")), body);
}
