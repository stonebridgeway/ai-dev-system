// The Skills screen: search the skill catalog, browse it by group, and read a
// skill (`search_skills`, `list_skill_groups`, `browse_skill_group`,
// `read_skill`) — and, above it, the person's own skills and what adds to the
// library (my-skills.js).
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { ownSkillsSection } from "./my-skills.js";
import { emptyState, errorState, formatNumber, loadingLine } from "./ui.js";

const RESULTS = 20;
const state = { query: "", group: null };

/** `text` cut to `length`, with "…" when it was cut. */
const cut = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

function resultList(view, skills, open) {
  return h("ul", { className: "cards skills" }, skills.map((skill) => h("li", { dataset: { skill: skill.name, source: skill.source ?? "" } },
    h("button", { type: "button", className: "card", on: { click: () => open(skill) } },
      h("strong", { className: "card-title" }, skill.name),
      skill.description ? h("span", {}, cut(String(skill.description), 240)) : null,
      h("span", { className: "muted" }, [
        skill.primary_group_label || skill.primary_group,
        skill.source ? view.t("skills.source", { source: skill.source }) : null,
        Number.isFinite(skill.quality_score) ? view.t("skills.quality", { score: skill.quality_score }) : null
      ].filter(Boolean).join(" · "))))));
}

function groupList(view, groups, browse) {
  return h("ul", { className: "groups" }, groups.map((group) => h("li", { dataset: { group: group.id } },
    h("button", { type: "button", className: "chip", on: { click: () => browse(group) } },
      group.label, h("span", { className: "muted" }, ` ${formatNumber(group.count, view.language)}`)))));
}

/** The Skills screen. */
export function skillsScreen(view) {
  const body = h("div", { className: "screen-body", dataset: { field: "catalog" } });
  const input = h("input", {
    type: "search",
    id: "skills-query",
    placeholder: view.t("skills.placeholder"),
    value: state.query,
    "aria-label": view.t("skills.search")
  });
  const submit = h("button", { type: "submit", className: "primary", dataset: { action: "search" } }, view.t("common.search"));
  const form = h("form", { className: "search", role: "search" }, input, submit);

  const failed = (retry) => (error) => show(body, errorState(view, error, retry),
    /skills\.index\.json|registry/i.test(error.message) ? h("p", { className: "advice" }, view.t("recommend.skill_registry")) : null);

  const read = (skill, back) => {
    show(body, loadingLine(view));
    api.call("read_skill", { name: skill.name, ...(skill.source ? { source: skill.source } : {}) }).then((text) => {
      show(body,
        h("button", { type: "button", className: "link", dataset: { action: "back" }, on: { click: back } }, `← ${view.t("skills.back")}`),
        h("article", { className: "markdown skill", dataset: { reading: skill.name } }, renderMarkdown(text, h)));
      body.querySelector("[data-action=back]")?.focus();
    }, failed(() => read(skill, back)));
  };

  const results = (title, skills, again) => {
    const back = () => results(title, skills, again);
    show(body,
      h("p", { className: "muted", dataset: { field: "results" } }, title),
      skills.length ? resultList(view, skills, (skill) => read(skill, back)) : emptyState(view.t("skills.empty", { query: state.query || state.group?.label || "" })));
  };

  const search = () => {
    state.query = input.value.trim();
    state.group = null;
    if (!state.query) return groups();
    show(body, loadingLine(view));
    // One more than shown, to know when there are more and say so.
    return api.call("search_skills", { query: state.query, limit: RESULTS + 1 }).then(
      (skills) => (skills.length > RESULTS
        ? results(view.t("skills.resultsFirst", { count: RESULTS }), skills.slice(0, RESULTS), search)
        : results(view.t("skills.results", { count: skills.length }), skills, search)),
      failed(search));
  };

  const browse = (group) => {
    state.group = group;
    show(body, loadingLine(view));
    api.call("browse_skill_group", { group: group.id, limit: RESULTS }).then((answer) => {
      const skills = Array.isArray(answer?.results) ? answer.results : [];
      results(view.t("skills.inGroup", { group: group.label, shown: skills.length, count: answer?.total_matches ?? skills.length }), skills, () => browse(group));
    }, failed(() => browse(group)));
  };

  function groups() {
    show(body, loadingLine(view));
    return api.call("list_skill_groups").then((answer) => {
      const list = (answer.groups ?? []).filter((group) => group.count > 0);
      if (!list.length) return show(body, emptyState(view.t("skills.noGroups")));
      return show(body, h("p", { className: "muted" }, view.t("skills.total", { count: formatNumber(answer.total_skills, view.language) })),
        h("h2", {}, view.t("skills.groups")), groupList(view, list, browse));
    }, failed(groups));
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    search();
  });
  if (state.group) browse(state.group);
  else if (state.query) search();
  else groups();
  // A change of the library is read again below: a new skill is found at once.
  const own = ownSkillsSection(view, { changed: () => (state.group ? browse(state.group) : state.query ? search() : groups()) });
  return h("section", { dataset: { screen: "skills" } }, h("h1", { tabindex: "-1" }, view.t("skills.title")), own, h("h2", {}, view.t("skills.catalog")), form, body);
}
