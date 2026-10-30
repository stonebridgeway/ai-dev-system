// The first-run wizard: projects folder, AI clients, local model, search
// index, and what next. Each step calls the control API and shows what came
// back; a long step shows its progress and can be cancelled — from this
// screen, and from it again when the person comes back to it.
import * as api from "./api.js";
import { formatBytes, h, progressBar, show } from "./dom.js";
import { clientChoice, clientResult, modelUnreadable, stepReason, stepTitle } from "./setup-words.js";

const STEPS = ["projects", "clients", "model", "index", "done"];

/**
 * Where the wizard is, the long call running in it, if one is — which step
 * it belongs to, its id for Cancel, its last progress, and who to tell when
 * it ends — and the outcome of the last one. Both outlive a redraw: a person
 * who goes to Status and back finds the download still there, with its
 * Cancel, and the build's outcome still shown.
 */
const wizard = { step: 0, modelInstalled: false, active: null, finished: null };

function start(view, step, { label, tool, args }) {
  const active = { step, label, id: null, progress: { message: label }, listeners: new Set(), outcome: null, ended: null };
  wizard.active = active;
  active.ended = api.call(tool, args, {
    onStart: (id) => { active.id = id; },
    onProgress: (event) => {
      active.progress = { ...event, message: event.message || label };
      for (const listener of active.listeners) listener(active.progress);
    }
  }).then((answer) => ({ answer }), (error) => ({ error })).then((outcome) => {
    wizard.active = null;
    // Kept for the step drawn again — until the next call replaces it.
    wizard.finished = { step, outcome };
    active.outcome = outcome;
    return outcome;
  });
  return active;
}

/**
 * Show a running call in `body`: its progress and Cancel, with the focus on
 * Cancel; when it ends, `onDone` or `onFail` draws what came of it, and the
 * focus goes to the way on — the step's own main button, or Next — never to
 * "Build again", which Enter would press.
 */
function attach(view, body, footer, active, { onDone, onFail }) {
  const bar = progressBar();
  bar.update(active.progress);
  const cancelButton = h("button", {
    type: "button",
    className: "secondary",
    dataset: { action: "cancel" },
    on: { click: () => active.id && api.cancel(active.id) }
  }, view.t("common.cancel"));
  show(body, bar.element, cancelButton);
  cancelButton.focus();
  footer.back.disabled = true;
  footer.next.disabled = true;
  const listener = (progress) => bar.update(progress);
  active.listeners.add(listener);
  active.ended.then(({ answer, error }) => {
    active.listeners.delete(listener);
    if (!body.isConnected) return;
    footer.back.disabled = wizard.step === 0;
    footer.next.disabled = false;
    if (error) onFail(error);
    else onDone(answer);
    (body.querySelector("button.primary") ?? footer.next).focus();
  });
}

function running(view, body, footer, step, call, handlers) {
  attach(view, body, footer, start(view, step, call), handlers);
}

function errorLine(view, error) {
  return h("p", { className: error.cancelled ? "notice" : "error", role: "alert" },
    error.cancelled ? view.t("common.cancelled") : view.t("common.error", { message: api.failureText(error, view.t) }));
}

function projectsStep(view, body, footer) {
  const line = h("p", { className: "muted", dataset: { field: "projects-root" } }, view.t("wizard.projects.none"));
  const choose = h("button", {
    type: "button",
    className: "primary",
    dataset: { action: "choose-projects" },
    on: {
      async click() {
        const folder = await api.chooseFolder("projects");
        if (!folder) return;
        try {
          await api.call("settings_set", { settings: { projects_root: folder } });
          line.textContent = view.t("wizard.projects.chosen", { path: folder });
          line.className = "";
        } catch (error) {
          line.replaceWith(errorLine(view, error));
        }
      }
    }
  }, view.t("wizard.projects.choose"));
  show(body, h("p", {}, view.t("wizard.projects.body")), choose, line);
  api.call("settings_get").then((answer) => {
    if (answer.settings?.projects_root) {
      line.textContent = view.t("wizard.projects.chosen", { path: answer.settings.projects_root });
      line.className = "";
    }
  }, () => undefined);
  footer.next.disabled = false;
}

function clientsStep(view, body, footer) {
  show(body, h("p", {}, view.t("wizard.clients.body")), h("p", { className: "muted" }, view.t("common.working")));
  footer.next.disabled = false;
  api.call("clients_list").then((answer) => {
    const boxes = [];
    const rows = answer.clients.map((client) => {
      const choice = clientChoice(view, client);
      const box = h("input", { type: "checkbox", name: "client", value: client.client, checked: choice.checked, disabled: choice.disabled });
      boxes.push(box);
      return h("li", { dataset: { client: client.client, entry: client.entry } }, h("label", {}, box, " ", client.label, " ", h("span", { className: "muted" }, `— ${choice.note}`)));
    });
    const result = h("div", { dataset: { field: "clients-result" }, "aria-live": "polite" });
    const chosen = () => boxes.filter((box) => box.checked && !box.disabled).map((box) => box.value);
    // With nothing chosen the button cannot be pressed, rather than do nothing.
    const connect = h("button", {
      type: "button",
      className: "primary",
      dataset: { action: "connect-clients" },
      disabled: chosen().length === 0,
      on: {
        async click() {
          const clients = chosen();
          if (!clients.length) return;
          connect.disabled = true;
          try {
            const outcome = await api.call("clients_install", { clients });
            show(result,
              h("p", { className: outcome.failed ? "error" : "ok" }, view.t("wizard.clients.result", { changed: outcome.changed, failed: outcome.failed })),
              h("ul", {}, outcome.results.map((item) => {
                const line = clientResult(view, item);
                return h("li", { dataset: { result: item.client, status: item.status } }, line.text, line.why ? h("span", { className: "muted" }, ` — ${line.why}`) : null);
              })));
          } catch (error) {
            show(result, errorLine(view, error));
          } finally {
            connect.disabled = chosen().length === 0;
          }
        }
      }
    }, view.t("wizard.clients.connect"));
    for (const box of boxes) box.addEventListener("change", () => { connect.disabled = chosen().length === 0; });
    const found = answer.clients.some((client) => client.found);
    show(body, h("p", {}, view.t("wizard.clients.body")),
      found ? [h("ul", { className: "choices" }, rows), connect, result] : h("p", {}, view.t("wizard.clients.none")));
  }, (error) => show(body, errorLine(view, error)));
}

function modelStep(view, body, footer) {
  // What a download or an import came to, under the step: nothing when the model is ready.
  const outcomeNote = ({ answer, error }) => {
    if (error) return errorLine(view, error);
    return answer?.ready ? null : h("p", { className: "error" }, view.t("common.error", { message: (answer?.mismatched ?? []).join(", ") || view.t("wizard.model.notReady") }));
  };
  const draw = (note) => {
    show(body, h("p", {}, view.t("wizard.model.body")), h("p", { className: "muted" }, view.t("common.working")));
    api.call("system_status", { checks: false }).then((status) => {
      const model = status.model;
      wizard.modelInstalled = Boolean(model.installed);
      // Without the model the way on is to skip it: search works by words.
      footer.next.textContent = view.t(model.installed ? "common.next" : "wizard.model.skip");
      // Installed is the last word: an earlier download's failure or Cancel no longer holds.
      if (model.installed) {
        show(body, h("p", {}, view.t("wizard.model.body")), h("p", { className: "ok", dataset: { field: "model-state" } }, view.t("wizard.model.installed")));
        return;
      }
      if (model.supported === false) {
        show(body, h("p", {}, view.t("wizard.model.body")),
          h("p", { className: "notice", dataset: { field: "model-unsupported" } }, view.t("wizard.model.unsupported", { reason: model.support_reason ?? "" })));
        return;
      }
      // A model this user cannot read is not missing: a download or an import would meet the same folder.
      if (model.unreadable) {
        const again = h("button", { type: "button", className: "secondary", dataset: { action: "check-model" }, on: { click: () => draw(null) } }, view.t("wizard.model.checkAgain"));
        show(body, h("p", {}, view.t("wizard.model.body")),
          h("p", { className: "notice", dataset: { field: "model-unreadable" } }, modelUnreadable(view, model).wizard),
          h("div", { className: "actions" }, again));
        return;
      }
      const partial = (model.partial ?? []).reduce((sum, file) => sum + (file.bytes ?? 0), 0);
      const handlers = { onDone: (answer) => draw(outcomeNote({ answer })), onFail: (error) => draw(outcomeNote({ error })) };
      const download = h("button", {
        type: "button",
        className: "primary",
        dataset: { action: "download-model" },
        on: { click: () => running(view, body, footer, "model", { label: view.t("wizard.model.downloading"), tool: "model_install", args: {} }, handlers) }
      }, view.t("wizard.model.download"));
      const importButton = h("button", {
        type: "button",
        className: "secondary",
        dataset: { action: "import-model" },
        on: {
          async click() {
            const source = await api.chooseFolder("model");
            if (!source) return;
            running(view, body, footer, "model", { label: view.t("wizard.model.importing"), tool: "model_import", args: { source } }, handlers);
          }
        }
      }, view.t("wizard.model.import"));
      show(body,
        h("p", {}, view.t("wizard.model.body")),
        h("div", { className: "actions" }, download, importButton),
        partial ? h("p", { className: "muted", dataset: { field: "model-partial" } }, view.t("wizard.model.partial", { bytes: formatBytes(partial, view.language) })) : null,
        note);
    }, (error) => show(body, errorLine(view, error)));
  };
  footer.next.disabled = false;
  footer.next.textContent = view.t("common.next");
  if (wizard.active?.step === "model") {
    attach(view, body, footer, wizard.active, { onDone: (answer) => draw(outcomeNote({ answer })), onFail: (error) => draw(outcomeNote({ error })) });
    return;
  }
  // A download that ended while the person was elsewhere says what came of it.
  draw(wizard.finished?.step === "model" ? outcomeNote(wizard.finished.outcome) : null);
}

function indexStep(view, body, footer) {
  const result = (answer) => {
    const count = (status) => answer.steps.filter((step) => step.status === status).length;
    const list = h("ul", { className: "steps" }, answer.steps.map((step) => {
      const reason = stepReason(view, step);
      return h("li", { dataset: { step: step.id, status: step.status } },
        h("strong", {}, stepTitle(view, step)), ` — ${view.t(`wizard.step.status.${step.status}`)}`,
        reason ? h("span", { className: step.status === "failed" ? "error" : "muted" }, ` (${reason})`) : null);
    }));
    // The outcome stays with the step, and so does the way to build again.
    show(body, h("p", { dataset: { field: "index-result" } }, view.t("wizard.index.result", { done: count("done"), skipped: count("skipped"), failed: count("failed") })), list, startButton(true));
    footer.next.disabled = false;
  };
  const handlers = {
    onDone: result,
    onFail(error) {
      show(body, errorLine(view, error), startButton());
      footer.next.disabled = false;
    }
  };
  const startButton = (again = false) => h("button", {
    type: "button",
    className: again ? "secondary" : "primary",
    dataset: { action: "build-index" },
    on: { click: () => running(view, body, footer, "index", { label: view.t("wizard.index.running"), tool: "setup_run", args: wizard.modelInstalled ? { model: true } : {} }, handlers) }
  }, view.t(again ? "wizard.index.again" : "wizard.index.start"));
  footer.next.disabled = true;
  if (wizard.active?.step === "index") {
    attach(view, body, footer, wizard.active, handlers);
    return;
  }
  if (wizard.finished?.step === "index") {
    const { outcome } = wizard.finished;
    if (outcome.error) handlers.onFail(outcome.error);
    else result(outcome.answer);
    return;
  }
  show(body, h("p", {}, view.t("wizard.index.body")), startButton());
}

function doneStep(view, body, footer, navigate) {
  footer.next.hidden = true;
  show(body,
    h("p", {}, view.t("wizard.done.body")),
    h("ol", {}, h("li", {}, view.t("wizard.done.next1")), h("li", {}, view.t("wizard.done.next2")), h("li", {}, view.t("wizard.done.next3"))),
    h("button", { type: "button", className: "primary", dataset: { action: "open-status" }, on: { click: () => { wizard.step = 0; navigate("status"); } } }, view.t("wizard.done.status")));
}

const DRAW = { projects: projectsStep, clients: clientsStep, model: modelStep, index: indexStep, done: doneStep };

/** The wizard at its current step; a long call still running is shown where it runs. */
export function wizardScreen(view, navigate) {
  if (wizard.active) wizard.step = STEPS.indexOf(wizard.active.step);
  const name = STEPS[wizard.step];
  const body = h("div", { className: "step-body" });
  const back = h("button", { type: "button", className: "secondary", dataset: { action: "back" }, disabled: wizard.step === 0 }, view.t("common.back"));
  const next = h("button", { type: "button", className: "primary", dataset: { action: "next" } }, view.t("common.next"));
  const section = h("section", { className: "wizard", dataset: { screen: "wizard", step: name } },
    h("p", { className: "muted" }, view.t("wizard.step", { step: wizard.step + 1, total: STEPS.length })),
    h("h1", { tabindex: "-1" }, view.t(`wizard.${name}.title`)),
    body,
    h("footer", { className: "wizard-footer" }, back, next));
  back.addEventListener("click", () => {
    if (wizard.active) return;
    wizard.step = Math.max(0, wizard.step - 1);
    navigate("wizard");
  });
  next.addEventListener("click", () => {
    if (wizard.active) return;
    wizard.step = Math.min(STEPS.length - 1, wizard.step + 1);
    navigate("wizard");
  });
  DRAW[name](view, body, { back, next }, navigate);
  return section;
}
