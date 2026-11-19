// What the wizard says of the AI clients and of setup's steps, in the page's
// words: a client's ai-dev entry, the outcome of connecting it, a step's
// title and why it did what it did. No DOM and no IPC here, so a unit test
// runs it under Node.

/**
 * What a client's ai-dev entry runs, in the page's words, and whether it is
 * chosen by default: a client with nothing, or with the 2.x entry, is; one that
 * runs another install, Docker or another program is not — connecting replaces
 * that entry — and one whose config cannot be read cannot be chosen.
 */
export function clientChoice(view, client) {
  if (!client.found) return { note: view.t("wizard.clients.notFound"), checked: false, disabled: true };
  if (client.entry === "unreadable") return { note: view.t("wizard.clients.unreadable", { error: client.error ?? "" }), checked: false, disabled: true };
  if (client.connected) return { note: view.t("wizard.clients.connected"), checked: false, disabled: false };
  const known = { none: "found", "2.x": "legacy", local: "another", docker: "docker", other: "other", invalid: "invalid" };
  const kind = known[client.entry] ?? "other";
  return { note: view.t(`wizard.clients.${kind}`), checked: kind === "found" || kind === "legacy", disabled: false };
}

/** One client's line after Connect: its name, what happened, and why when the daemon says. */
export function clientResult(view, item) {
  const key = `wizard.clients.status.${item.status}`;
  const said = view.t(key);
  return { text: `${item.label ?? item.client}: ${said === key ? item.status : said}`, why: item.error || item.reason || "" };
}

/**
 * Why a setup step did what it did, in the page's words where the reason is
 * one the setup plan gives; the server's own words otherwise. A failed step
 * shows its error.
 */
export function stepReason(view, step) {
  if (step.status === "failed") return step.error || step.reason || "";
  const reason = String(step.reason ?? "");
  const patterns = [
    [/^not installed — pass --[\w-]+ to install it$/, `wizard.step.notAsked.${step.id}`],
    [/^already installed; --[\w-]+ rebuilds it$/, "wizard.step.alreadyInstalled"],
    [/^out of date; --[\w-]+ rebuilds it$/, "wizard.step.outOfDateNotAsked"],
    [/^already built; --force rebuilds it$/, "wizard.step.alreadyBuilt"],
    [/^out of date$/, "wizard.step.outOfDate"],
    [/^missing$/, "wizard.step.built"],
    [/^rebuilding on request$/, "wizard.step.rebuilt"]
  ];
  for (const [pattern, key] of patterns) {
    if (!pattern.test(reason)) continue;
    const text = view.t(key);
    return text === key ? reason : text;
  }
  return reason;
}

export function stepTitle(view, step) {
  const key = `wizard.step.title.${step.id}`;
  const text = view.t(key);
  return text === key ? step.title : text;
}

// The errors that mean the disk or the share the model is on cannot be reached;
// the daemon's own list (dense-backend.mjs) is the same.
const SHARE_UNREACHABLE = new Set(["EIO", "ESTALE", "ENOTCONN", "EHOSTDOWN", "ETIMEDOUT", "ECONNABORTED", "ECONNRESET"]);

/** The error code a "cannot be read" reason starts with — `ENOTDIR` of `ENOTDIR: not a directory, …` — or "". */
export function unreadableCode(reason) {
  return /^[A-Z][A-Z0-9_]+(?=:|$)/.exec(String(reason ?? ""))?.[0] ?? "";
}

/**
 * What the page says of a model this user cannot read: not "not installed",
 * and no download over it — the folder is what needs a look, and what to do
 * depends on why it cannot be read.
 *
 * @param {{ t: (key: string, params?: object) => string }} view
 * @param {{ dir?: string, unreadable: string }} model
 * @returns {{ status: string, wizard: string }}
 */
export function modelUnreadable(view, model) {
  const code = unreadableCode(model.unreadable);
  // EPERM is not the file's mode, often: on macOS a folder under Documents, Desktop or Downloads is kept from an
  // app until it is given access, as the daemon's own advice says (dense-backend.mjs).
  const advice = code === "EACCES" ? "access"
    : code === "EPERM" ? "permission"
    : code === "ENOTDIR" ? "notDirectory"
      : code === "ELOOP" ? "loop"
        : SHARE_UNREACHABLE.has(code) ? "share" : "other";
  return {
    status: view.t("status.model.unreadable", { code: code || model.unreadable }),
    wizard: view.t("wizard.model.unreadable", {
      dir: model.dir ?? "",
      reason: model.unreadable,
      advice: view.t(`wizard.model.unreadable.${advice}`)
    })
  };
}
