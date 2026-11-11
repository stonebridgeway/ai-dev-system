// The Projects screen: the projects AI Dev knows, and one project's card —
// its tasks, its epics and how far each has come, its decisions, and the
// handoffs sessions left for the next one. Everything here only reads.
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { dataTable, emptyState, errorState, formatDate, loadingLine } from "./ui.js";

const state = { selected: null };

// How many of each the card shows. Each list asks for one more, to know when
// there are more than it shows, and says so.
const TASKS = 50;
const EPICS = 10;
const DECISIONS = 50;
const HANDOFFS = 20;

/** The first `limit` of `list`, and a line saying there are more when there are. */
function capped(view, list, limit) {
  return { shown: list.slice(0, limit), more: list.length > limit ? h("p", { className: "muted small", dataset: { field: "more" } }, view.t("projects.more", { shown: limit })) : null };
}

/** A translated word for a status, or the status itself when there is none. */
function word(view, prefix, value) {
  const key = `${prefix}.${value}`;
  const text = view.t(key);
  return text === key ? String(value ?? "") : text;
}

function projectList(view, projects, open) {
  return h("ul", { className: "cards" }, projects.map((project) => h("li", { dataset: { project: project.slug || project.name } },
    h("button", { type: "button", className: "card", on: { click: () => open(project) } },
      h("strong", { className: "card-title" }, project.name),
      project.description ? h("span", {}, project.description) : null,
      h("span", { className: "muted" }, [
        project.stack?.length ? view.t("projects.stack", { stack: project.stack.join(", ") }) : null,
        project.updated ? view.t("projects.updated", { date: formatDate(project.updated, view.language) }) : null
      ].filter(Boolean).join(" · "))))));
}

/**
 * One section of the card: its heading, then what `load` draws into it, with
 * loading and error states. `load(again)` is told when it runs for Try again.
 */
function section(view, { name, title, load }) {
  const body = h("div", { className: "section-body" }, loadingLine(view));
  const draw = (again = false) => {
    show(body, loadingLine(view));
    load(again).then((content) => show(body, content), (error) => show(body, errorState(view, error, () => draw(true))));
  };
  draw();
  return h("section", { className: "card-section", dataset: { section: name } }, h("h2", {}, title), body);
}

function criteria(task) {
  const list = Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [];
  return { met: list.filter((item) => item.status === "met").length, total: list.length };
}

function tasksSection(view, tasksOf) {
  return section(view, {
    name: "tasks",
    title: view.t("projects.tasks"),
    load: async (again) => {
      const { shown: tasks, more } = capped(view, await tasksOf(again), TASKS);
      if (!tasks.length) return emptyState(view.t("projects.tasks.empty"));
      return [dataTable([
        { label: view.t("projects.col.task"), value: (task) => [task.task, task.parent_id ? h("span", { className: "muted" }, ` ${view.t("projects.task.child")}`) : null] },
        { label: view.t("projects.col.status"), value: (task) => word(view, "task.status", task.status) },
        { label: view.t("projects.col.criteria"), value: (task) => view.t("projects.criteria", criteria(task)), numeric: true },
        { label: view.t("projects.col.updated"), value: (task) => formatDate(task.updated_at, view.language) }
      ], tasks, { name: "tasks" }), more];
    }
  });
}

function epicsSection(view, tasksOf) {
  return section(view, {
    name: "epics",
    title: view.t("projects.epics"),
    load: async (again) => {
      const all = await tasksOf(again);
      const { shown: parents, more } = capped(view, all.slice(0, TASKS).filter((task) => task.epic?.children?.length), EPICS);
      // The epics come from the tasks the card has: past its first ones, there may be more.
      const beyond = !more && all.length > TASKS ? h("p", { className: "muted small", dataset: { field: "more" } }, view.t("projects.moreEpics", { tasks: TASKS })) : null;
      if (!parents.length) return [emptyState(view.t("projects.epics.empty")), beyond];
      const answers = await Promise.all(parents.map((task) => api.call("epic_status", { task_id: task.id })));
      return [h("ul", { className: "epics" }, answers.map((answer) => {
        const { epic } = answer;
        return h("li", { dataset: { epic: answer.task_id } },
          h("strong", {}, answer.task),
          h("progress", { max: 100, value: epic.percent, "aria-label": view.t("projects.epic.progress", epic) }),
          h("p", { className: "muted" }, view.t("projects.epic.progress", epic)),
          epic.next ? h("p", {}, view.t("projects.epic.next", { task: epic.next.task })) : null,
          h("ul", { className: "children" }, epic.children.map((child) => h("li", { dataset: { state: child.state } },
            `${child.task} — ${word(view, "epic.state", child.state)}`,
            h("span", { className: "muted" }, ` (${view.t("projects.criteria", { met: child.criteria_met, total: child.criteria_total })})`)))));
      })), more, beyond];
    }
  });
}

function decisionsSection(view, project) {
  return section(view, {
    name: "decisions",
    title: view.t("projects.decisions"),
    load: async () => {
      const answer = await api.call("list_decisions", { project_path: project.project_path, limit: DECISIONS + 1 });
      const { shown: decisions, more } = capped(view, answer.decisions ?? [], DECISIONS);
      if (!decisions.length) return emptyState(view.t("projects.decisions.empty"));
      return [h("ul", { className: "decisions" }, decisions.map((decision) => h("li", { dataset: { decision: decision.id } },
        h("details", {},
          h("summary", {}, h("strong", {}, `${decision.id} `), decision.title, h("span", { className: "muted" }, ` — ${word(view, "decision.status", decision.status)}, ${decision.date}`)),
          decision.context ? h("p", {}, h("span", { className: "label" }, `${view.t("projects.decision.context")}: `), decision.context) : null,
          h("p", {}, h("span", { className: "label" }, `${view.t("projects.decision.decision")}: `), decision.decision),
          decision.alternatives?.length ? h("p", {}, h("span", { className: "label" }, `${view.t("projects.decision.alternatives")}: `), decision.alternatives.join("; ")) : null)))), more];
    }
  });
}

function handoffsSection(view, project) {
  return section(view, {
    name: "handoffs",
    title: view.t("projects.handoffs"),
    load: async () => {
      const answer = await api.call("list_sessions", { project_path: project.project_path, limit: HANDOFFS + 1 });
      const { shown: sessions, more } = capped(view, answer.sessions ?? [], HANDOFFS);
      if (!sessions.length) return emptyState(view.t("projects.handoffs.empty"));
      return [h("ul", { className: "handoffs" }, sessions.map((session) => h("li", { dataset: { session: session.id } },
        h("strong", {}, session.topic || session.id),
        h("span", { className: "muted" }, ` — ${formatDate(session.saved_at, view.language)}${session.unconfirmed ? `, ${view.t("projects.handoff.draft")}` : ""}`),
        session.next_step ? h("p", {}, view.t("projects.handoff.next", { step: session.next_step })) : null))), more];
    }
  });
}

function cardSection(view, project) {
  return section(view, {
    name: "card",
    title: view.t("projects.card"),
    load: async () => {
      const text = await api.call("read_project", { name: project.slug || project.name });
      return h("details", { className: "markdown" }, h("summary", {}, view.t("projects.card.show")), renderMarkdown(text, h, { headingOffset: 2 }));
    }
  });
}

function projectCard(view, project, back) {
  // The tasks and the epics sections read the same list: one call, again only for Try again.
  let tasks = null;
  const tasksOf = (again) => {
    if (again || !tasks) tasks = api.call("list_tasks", { project_path: project.project_path, limit: TASKS + 1 });
    return tasks;
  };
  return h("div", { className: "project", dataset: { open: project.slug || project.name } },
    h("button", { type: "button", className: "link", dataset: { action: "all-projects" }, on: { click: back } }, `← ${view.t("projects.back")}`),
    h("h2", { className: "project-name", tabindex: "-1" }, project.name),
    h("p", { className: "muted" }, project.project_path),
    tasksSection(view, tasksOf),
    epicsSection(view, tasksOf),
    decisionsSection(view, project),
    handoffsSection(view, project),
    cardSection(view, project));
}

/** The Projects screen. */
export function projectsScreen(view) {
  const body = h("div", { className: "screen-body" }, loadingLine(view));
  const load = () => {
    show(body, loadingLine(view));
    api.call("list_projects").then((projects) => {
      const list = Array.isArray(projects) ? projects : [];
      if (!list.length) {
        state.selected = null;
        show(body, emptyState(view.t("projects.empty")));
        return;
      }
      const open = (project) => {
        state.selected = project.slug || project.name;
        show(body, projectCard(view, project, () => {
          state.selected = null;
          load();
        }));
        body.querySelector(".project-name")?.focus();
      };
      const selected = list.find((project) => (project.slug || project.name) === state.selected);
      if (selected) open(selected);
      else show(body, h("p", { className: "muted" }, view.t("projects.count", { count: list.length })), projectList(view, list, open));
    }, (error) => show(body, errorState(view, error, load)));
  };
  load();
  return h("section", { dataset: { screen: "projects" } }, h("h1", { tabindex: "-1" }, view.t("projects.title")), body);
}
