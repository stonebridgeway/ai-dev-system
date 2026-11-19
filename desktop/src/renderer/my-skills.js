// The Skills screen's part that changes the library: the person's own skills
// (`custom_skills_list`, `custom_skills_add`, `custom_skills_remove`), a
// GitHub repository of skills (`import_skill_repo`) and the registry
// (`rebuild_index`). Each change runs only after the person confirms it in a
// dialog of the main process (ipc-policy.mjs, PAGE_CONFIRMED_TOOLS); removing
// a skill goes through the tool console, which asks too.
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { emptyState, errorState, formatNumber, loadingLine } from "./ui.js";

/** What a call that the person did not confirm, or that failed, says in the result line. */
function failure(view, error) {
  if (error.notConfirmed) return h("p", { className: "notice", role: "status", dataset: { field: "not-confirmed" } }, view.t("console.notConfirmed"));
  return h("p", { className: "error", role: "alert", dataset: { field: "skills-error" } }, view.t("common.error", { message: api.failureText(error, view.t) }));
}

/** The registry's size after a change, in a line. */
const registryText = (view, registry) => view.t("mySkills.registry", { total: formatNumber(registry?.total ?? 0, view.language), custom: formatNumber(registry?.custom ?? 0, view.language) });

/**
 * A form that opens under the buttons: its fields, a submit button, and
 * Cancel. `submit(values)` runs the call; its answer's lines are shown.
 */
function inlineForm(view, { name, fields, submitLabel, submit, done }) {
  const inputs = fields.map((spec) => {
    const id = `${name}-${spec.name}`;
    const input = spec.type === "checkbox"
      ? h("input", { type: "checkbox", id, name: spec.name, checked: spec.checked === true })
      : h(spec.type === "textarea" ? "textarea" : "input", { type: spec.type === "textarea" ? undefined : "text", id, name: spec.name, placeholder: spec.placeholder ?? "", spellcheck: "false", rows: spec.type === "textarea" ? 2 : undefined });
    const label = spec.type === "checkbox"
      ? h("label", { className: "check-label", for: id }, input, " ", spec.label)
      : h("div", { className: "field-row" }, h("label", { for: id }, spec.label), h("div", { className: "field-input" }, input));
    return { spec, input, label };
  });
  const result = h("div", { className: "save-result", "aria-live": "polite" });
  const button = h("button", { type: "submit", className: "primary", dataset: { action: `${name}-submit` } }, submitLabel);
  const form = h("form", { className: "inline-form", dataset: { form: name }, novalidate: true },
    inputs.map((item) => item.label),
    h("div", { className: "actions" }, button, h("button", { type: "button", className: "secondary", dataset: { action: "close-form" }, on: { click: () => done(null) } }, view.t("common.cancel"))),
    result);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(inputs.map(({ spec, input }) => [spec.name, spec.type === "checkbox" ? input.checked : input.value.trim()]));
    const missing = inputs.find(({ spec }) => spec.required && !values[spec.name]);
    if (missing) {
      show(result, h("p", { className: "error", role: "alert" }, view.t("mySkills.required", { field: missing.spec.label })));
      missing.input.focus();
      return;
    }
    button.disabled = true;
    show(result, h("p", { className: "muted", role: "status" }, view.t("common.working")));
    try {
      done(await submit(values));
    } catch (error) {
      button.disabled = false;
      show(result, failure(view, error));
    }
  });
  queueMicrotask(() => inputs[0]?.input.focus());
  return form;
}

/**
 * The person's own skills, and what adds to the library.
 *
 * @param {object} view
 * @param {{ changed: () => void }} hooks - called after the library changed, so the catalog below can be read again.
 */
export function ownSkillsSection(view, { changed }) {
  const list = h("div", { dataset: { field: "own-skills" } }, loadingLine(view));
  const panel = h("div", { className: "form-panel" });
  const result = h("div", { className: "save-result", "aria-live": "polite", dataset: { field: "skills-result" } });

  const say = (...lines) => show(result, h("div", { className: "ok", dataset: { field: "skills-done" } }, lines.map((line) => h("p", {}, line))));
  const after = (answer, lines, registry = answer?.registry) => {
    show(panel);
    if (!answer) return;
    say(...lines, ...(registry ? [registryText(view, registry)] : []));
    load();
    changed();
  };

  const remove = async (skill, button) => {
    button.disabled = true;
    try {
      // Through the console, which asks first: a removed folder does not come back.
      const answer = await api.consoleCall("custom_skills_remove", { name: skill.name, confirm: true });
      after(answer, [view.t("mySkills.removed", { name: skill.name })]);
    } catch (error) {
      button.disabled = false;
      show(result, failure(view, error));
    }
  };

  function load() {
    show(list, loadingLine(view));
    api.call("custom_skills_list").then((answer) => {
      const yours = (answer.skills ?? []).filter((skill) => skill.origin === "yours");
      const seed = (answer.skills ?? []).length - yours.length;
      show(list,
        yours.length
          ? h("ul", { className: "cards skills own" }, yours.map((skill) => {
            const button = h("button", { type: "button", className: "secondary small", dataset: { action: "remove-skill", skill: skill.name } }, view.t("mySkills.remove"));
            button.addEventListener("click", () => remove(skill, button));
            return h("li", { dataset: { own: skill.name } }, h("div", { className: "card static" },
              h("strong", { className: "card-title" }, skill.name),
              skill.description ? h("span", {}, skill.description) : null,
              h("span", { className: "muted small" }, skill.folder),
              h("div", { className: "actions" }, button)));
          }))
          : emptyState(view.t("mySkills.none")),
        h("p", { className: "muted small" }, view.t("mySkills.seed", { count: formatNumber(seed, view.language), folder: answer.root ?? "" })));
    }, (error) => show(list, errorState(view, error, load)));
  }

  const actions = [
    ["add-folder", "mySkills.addFolder", async () => {
      const folder = await api.chooseFolder("skill");
      if (!folder) return;
      show(result, h("p", { className: "muted", role: "status" }, view.t("common.working")));
      try {
        const answer = await api.call("custom_skills_add", { source: folder });
        after(answer, [view.t("mySkills.added", { name: answer.name, files: answer.files }), answer.skipped?.length ? view.t("mySkills.skipped", { files: answer.skipped.join(", ") }) : null].filter(Boolean));
      } catch (error) {
        show(result, failure(view, error));
      }
    }],
    ["new-skill", "mySkills.new", () => show(panel, inlineForm(view, {
      name: "new-skill",
      submitLabel: view.t("mySkills.create"),
      fields: [
        { name: "name", label: view.t("mySkills.field.name"), placeholder: "release-notes", required: true },
        { name: "description", label: view.t("mySkills.field.description"), type: "textarea", placeholder: view.t("mySkills.field.descriptionHint"), required: true }
      ],
      submit: (values) => api.call("custom_skills_add", { name: values.name, description: values.description }),
      done: (answer) => after(answer, answer ? [view.t("mySkills.created", { name: answer.name }), view.t("mySkills.edit", { file: `${answer.folder}/SKILL.md` })] : [])
    }))],
    ["import", "mySkills.import", () => show(panel, inlineForm(view, {
      name: "import",
      submitLabel: view.t("mySkills.importRun"),
      fields: [
        { name: "url", label: view.t("mySkills.field.url"), placeholder: "https://github.com/owner/skills", required: true },
        { name: "select", label: view.t("mySkills.field.select"), type: "checkbox", checked: true }
      ],
      submit: (values) => api.call("import_skill_repo", { repository_url: values.url, select_skills: values.select }),
      done: (answer) => after(answer, answer ? [
        Array.isArray(answer.imported_skills)
          ? view.t("mySkills.importedSome", { path: answer.path ?? "", count: answer.imported_skills.length })
          : view.t("mySkills.imported", { path: answer.path ?? "" }),
        answer.instruction_policy ? view.t("mySkills.importPolicy") : null
      ].filter(Boolean) : [], answer?.rebuild)
    }))],
    ["rebuild", "mySkills.rebuild", async () => {
      show(result, h("p", { className: "muted", role: "status" }, view.t("common.working")));
      try {
        const answer = await api.call("rebuild_index");
        say(registryText(view, answer));
        changed();
      } catch (error) {
        show(result, failure(view, error));
      }
    }]
  ];
  const toolbar = h("div", { className: "actions toolbar" }, actions.map(([action, key, run]) => h("button", { type: "button", className: action === "rebuild" ? "secondary" : "primary", dataset: { action }, on: { click: run } }, view.t(key))));
  load();
  return h("section", { className: "own-skills", dataset: { section: "own-skills" } },
    h("h2", {}, view.t("mySkills.title")),
    h("p", { className: "help" }, view.t("mySkills.help")),
    toolbar, panel, result, list);
}
