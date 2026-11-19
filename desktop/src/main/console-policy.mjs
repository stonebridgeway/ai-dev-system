/**
 * The tool console's rule, kept in the main process: the page may call any
 * tool the daemon lists to the app's session, and one that changes something
 * runs only after the person confirms it in a dialog the main process shows.
 * Which tool only reads is the daemon's word — its `readOnlyHint` — never the
 * page's: a page that something managed to run script in can open the dialog,
 * but cannot answer it or skip it.
 */
import { refuseRequest } from "./ipc-policy.mjs";

/**
 * How much of each argument the confirmation shows. Every argument gets a line
 * of its own, cut to this length, so a long one cannot push another out of
 * sight — the page chooses the arguments, and their order.
 */
const VALUE_LIMIT = 240;

/** The longest argument name a confirmation shows; the tools' own are far shorter. */
const NAME_LIMIT = 80;

/**
 * How wide a row of a confirmation is: a value goes on in rows of this many
 * characters, each further row indented, so the dialog stays within the
 * screen — GTK does not break a word, and a value may have no spaces. Rows of
 * the widest letters still fit the dialog's text.
 */
const ROW = 48;

/** The most rows of arguments a confirmation shows; a call that needs more is refused, not shown in part. */
const MAX_ROWS = 36;

/**
 * What would not show as itself in a confirmation — controls, line and
 * paragraph separators, and the invisible format marks (direction overrides,
 * zero-width marks): each is written as its code instead, so an argument stays
 * on its own line and reads as it is.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `text` with every character that would not show as itself written as its code, cut to `limit`; `cut` — its length when cut. */
function visible(text, limit) {
  const plain = String(text).replace(UNSEEN, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
  return plain.length > limit ? { text: `${plain.slice(0, limit)}…`, cut: plain.length } : { text: plain, cut: 0 };
}

/**
 * Each argument on a line of its own: its name, and its value as JSON, every
 * character shown as itself and both cut, a long value going on in
 * indented rows. For the console's confirmation, and for the settings
 * the page may change only after one.
 *
 * @param {Array<[string, unknown]>} entries
 * @param {(key: string, params?: object) => string} t
 */
export function argumentLines(entries, t) {
  return entries.flatMap(([name, value]) => {
    const { rows, cut } = argumentRows(name, value);
    if (cut) rows[rows.length - 1] += ` ${t("console.confirm.longer", { count: cut })}`;
    return rows;
  });
}

/** An argument's rows: its name and the start of its value, then the rest of the value, `ROW` characters a row, indented. */
function argumentRows(name, value) {
  const { text, cut } = visible(JSON.stringify(value) ?? String(value), VALUE_LIMIT);
  const parts = text.match(new RegExp(`.{1,${ROW}}`, "gu")) ?? [""];
  return { rows: [`${visible(name, NAME_LIMIT).text}: ${parts[0]}`, ...parts.slice(1).map((part) => `    ${part}`)], cut };
}

/** The most arguments a console call has — more than any tool takes, few enough to read in the confirmation. */
const MAX_ARGUMENTS = 40;

/**
 * What the console knows of each tool the daemon lists: name, title,
 * description, input schema, and whether it only reads or deletes.
 *
 * @param {Array<{ name: string, title?: string, description?: string, inputSchema?: object, annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean } }>} listed
 */
export function consoleTools(listed) {
  return (Array.isArray(listed) ? listed : [])
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      name: tool.name,
      title: String(tool.title ?? tool.annotations?.title ?? tool.name),
      description: String(tool.description ?? ""),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * What to do with a call from the console: refuse it, run it, or ask first.
 *
 * @param {unknown} request - `{ tool, args, id }` from the page.
 * @param {ReturnType<typeof consoleTools>} tools - What the daemon lists.
 * @returns {{ refused: string } | { tool: object, args: object, id: string, confirm: boolean }}
 */
export function consoleDecision(request, tools) {
  const refused = refuseRequest(request);
  if (refused) return { refused };
  const tool = tools.find((entry) => entry.name === request.tool);
  if (!tool) return { refused: `The daemon lists no tool ${JSON.stringify(String(request.tool)).slice(0, 80)} to this app.` };
  if (Object.keys(request.args ?? {}).length > MAX_ARGUMENTS) return { refused: `A console call has at most ${MAX_ARGUMENTS} arguments.` };
  // Only the arguments the tool's schema names: the form sends no other, and a
  // name the page made up is one more thing the confirmation would have to show.
  const named = tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object" ? tool.inputSchema.properties : {};
  const unknown = Object.keys(request.args ?? {}).find((name) => !Object.hasOwn(named, name));
  if (unknown !== undefined) return { refused: `${tool.name} takes no argument ${JSON.stringify(visible(unknown, NAME_LIMIT).text)}.` };
  const rows = Object.entries(request.args ?? {}).reduce((sum, [name, value]) => sum + argumentRows(name, value).rows.length, 0);
  if (rows > MAX_ROWS) return { refused: `A console call's confirmation shows at most ${MAX_ROWS} rows of arguments; this one needs ${rows}. Shorten its arguments.` };
  return { tool, args: request.args ?? {}, id: request.id, confirm: !tool.readOnly };
}

/**
 * The confirmation the main process shows before a tool that changes
 * something runs: what runs, with what, and Cancel as the default.
 *
 * @param {{ name: string, title: string, destructive: boolean }} tool
 * @param {object} args
 * @param {(key: string, params?: object) => string} t
 */
export function confirmationDialog(tool, args, t) {
  const entries = Object.entries(args ?? {});
  const shown = entries.length ? argumentLines(entries, t) : [t("console.confirm.noArguments")];
  const lines = [t(tool.destructive ? "console.confirm.destructive" : "console.confirm.changes"), "", t("console.confirm.arguments"), ...shown];
  return {
    type: tool.destructive ? "warning" : "question",
    buttons: [t("console.confirm.run"), t("common.cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: t("console.confirm.title"),
    message: t("console.confirm.message", { tool: tool.name }),
    detail: lines.join("\n")
  };
}

/**
 * The confirmation before the page changes a setting that decides where the
 * daemon reaches out to, what it reads and writes, or which tools AI clients
 * get (ipc-policy.mjs; CONFIRMED_SETTINGS): each new
 * value on a line of its own, Cancel as the default.
 *
 * @param {Record<string, unknown>} changes
 * @param {(key: string, params?: object) => string} t
 */
export function settingsDialog(changes, t) {
  return {
    type: "question",
    buttons: [t("settings.confirm.save"), t("common.cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: t("console.confirm.title"),
    message: t("settings.confirm.message"),
    detail: [t("settings.confirm.detail"), "", ...argumentLines(Object.entries(changes), t)].join("\n")
  };
}
