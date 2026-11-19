import assert from "node:assert/strict";
import test from "node:test";
import { confirmationDialog, consoleDecision, consoleTools, settingsDialog } from "../../src/main/console-policy.mjs";
import { translate } from "../../src/renderer/i18n.js";

// What the daemon lists, as tools/list answers it (annotations from server.mjs).
const LISTED = [
  { name: "record_decision", description: "Record an ADR.", inputSchema: { type: "object", properties: { title: { type: "string" } } }, annotations: { title: "Record Decision", readOnlyHint: false, destructiveHint: false } },
  { name: "list_projects", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "model_remove", inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "odd_tool" },
  null,
  { title: "no name" }
];

test("the console's tools: the daemon's list, sorted, each read-only only on the daemon's word", () => {
  const tools = consoleTools(LISTED);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.readOnly, tool.destructive]), [
    ["list_projects", true, false],
    ["model_remove", false, true],
    ["odd_tool", false, false],
    ["record_decision", false, false]
  ]);
  assert.equal(tools[3].title, "Record Decision");
  assert.deepEqual(tools[2].inputSchema, { type: "object", properties: {} }, "a tool without a schema gets an empty form");
  assert.deepEqual(consoleTools(undefined), []);
});

test("a read-only tool runs at once, one that changes something asks first, one not listed is refused", () => {
  const tools = consoleTools(LISTED);
  const read = consoleDecision({ tool: "list_projects", args: {}, id: "call-1" }, tools);
  assert.equal(read.confirm, false);
  assert.equal(read.tool.name, "list_projects");
  const write = consoleDecision({ tool: "record_decision", args: { title: "x" }, id: "call-2" }, tools);
  assert.equal(write.confirm, true);
  assert.deepEqual(write.args, { title: "x" });
  // The page says nothing that makes a writing tool read-only.
  assert.equal(consoleDecision({ tool: "record_decision", args: {}, id: "call-c", readOnly: true, confirm: false }, tools).confirm, true);
  assert.equal(consoleDecision({ tool: "model_remove", args: { confirm: true }, id: "call-c" }, tools).confirm, true);
  assert.match(consoleDecision({ tool: "run_shell", args: {}, id: "call-c" }, tools).refused, /lists no tool "run_shell"/);
  assert.match(consoleDecision({ tool: "list_projects", args: {}, id: "../x" }, tools).refused, /id is call- and/);
  assert.match(consoleDecision({ tool: "list_projects", args: {}, id: "tray-rebuild" }, tools).refused, /id is call- and/, "the main process's own ids are not the console's");
  assert.match(consoleDecision({ tool: "list_projects", args: "x", id: "call-c" }, tools).refused, /arguments are an object/);
  assert.match(consoleDecision({ tool: "list_projects", args: { big: "x".repeat(70 * 1024) }, id: "call-c" }, tools).refused, /at most 65536 bytes/);
  assert.match(consoleDecision(null, tools).refused, /A call is an object/);
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`a${index}`, 1]));
  assert.match(consoleDecision({ tool: "record_decision", args: many, id: "call-c" }, tools).refused, /at most 40 arguments/, "more than a confirmation can show is refused");
  assert.match(consoleDecision({ args: {}, id: "call-c" }, tools).refused, /names a tool/);
});

test("the confirmation says what runs and with what, Cancel is the default, in the person's language", () => {
  const [, remove, , record] = consoleTools(LISTED);
  const en = (key, params) => translate("en", key, params);
  const dialog = confirmationDialog(record, { title: "Use Stripe" }, en);
  assert.equal(dialog.type, "question");
  assert.equal(dialog.defaultId, 1);
  assert.equal(dialog.cancelId, 1);
  assert.equal(dialog.buttons[dialog.cancelId], "Cancel");
  assert.match(dialog.message, /record_decision/);
  assert.match(dialog.detail, /^title: "Use Stripe"$/m);
  const ru = confirmationDialog(remove, { confirm: true }, (key, params) => translate("ru", key, params));
  assert.equal(ru.type, "warning", "a destructive tool warns");
  assert.equal(ru.buttons[1], "Отмена");
  assert.match(ru.message, /model_remove/);
  // A long argument cannot push another out of sight: each has its own line, cut on its own.
  const long = confirmationDialog(record, { text: "x".repeat(5000), project_path: "/home/me/secret-repo" }, en);
  assert.ok(long.detail.length < 800, `${long.detail.length} characters`);
  assert.match(joined(long.detail), /^text: "x{239}… \(5002 characters in all\)$/m);
  assert.match(long.detail, /^project_path: "\/home\/me\/secret-repo"$/m);
  assert.match(confirmationDialog(record, {}, en).detail, /\(no arguments\)/);
});

// Every way a line of the dialog could end, as GTK draws it.
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;
// The dialog's text with each value's further rows put back on its first.
const joined = (detail) => detail.replace(/\n {4}/g, "");

test("the confirmation shows every argument that runs, each on its own line, as it is", () => {
  const tools = consoleTools([{ name: "record_decision", inputSchema: { type: "object", properties: { project_path: {}, title: {}, decision: {}, ["a\nb"]: {} } }, annotations: {} }]);
  const [record] = tools;
  const en = (key, params) => translate("en", key, params);
  // A value full of line separators, and direction marks: one line, the next argument right after it.
  const separators = String.fromCharCode(0x2028).repeat(300);
  const dialog = confirmationDialog(record, { project_path: "/p", title: `${separators}x`, decision: `${String.fromCharCode(0x202e)}DROP TABLE users` }, en);
  const lines = joined(dialog.detail).split(LINE_BREAK);
  assert.equal(lines.length, 3 + 3, JSON.stringify(lines.slice(0, 8)));
  assert.match(lines[4], /^title: "(\\u\{2028\}){29}\\u\{2028… \(2403 characters in all\)$/);
  assert.match(lines[5], /^decision: "\\u\{202e\}DROP TABLE users"$/);
  assert.doesNotMatch(dialog.detail, /[\u2028\u2029\u202e]/u);
  // A name's line breaks are shown, not drawn; a long name is cut.
  const named = confirmationDialog(record, { ["a\nb"]: 1, [`x${" ".repeat(500)}`]: 2 }, en);
  assert.equal(joined(named.detail).split(LINE_BREAK).length, 3 + 2);
  assert.match(named.detail, /^a\\u\{a\}b: 1$/m);
  assert.ok(named.detail.length < 300, `${named.detail.length} characters`);
  // The console lets through only what the tool's schema names.
  assert.match(consoleDecision({ tool: "record_decision", args: { title: "t", [`(no arguments)${"\n".repeat(60)}`]: "-" }, id: "call-1" }, tools).refused, /record_decision takes no argument "\(no arguments\)(\\\\u\{a\}){13}/);
  assert.equal(consoleDecision({ tool: "record_decision", args: { title: "t", ["a\nb"]: 1 }, id: "call-2" }, tools).confirm, true);
  const [none] = consoleTools([{ name: "odd_tool" }]);
  assert.match(consoleDecision({ tool: "odd_tool", args: { anything: 1 }, id: "call-3" }, [none]).refused, /odd_tool takes no argument "anything"/);
});

test("the settings the page changes only after a confirmation: each new value on its own line, Cancel the default", () => {
  const ru = settingsDialog({ model_mirror: `https://mirror.example/x${"\n".repeat(30)}`, model_dir: "/data/models" }, (key, params) => translate("ru", key, params));
  assert.deepEqual([ru.defaultId, ru.cancelId, ru.buttons], [1, 1, ["Сохранить", "Отмена"]]);
  assert.equal(ru.message, "Сохранить эти настройки?");
  const lines = joined(ru.detail).split(LINE_BREAK);
  assert.equal(lines.length, 2 + 2);
  assert.match(lines[2], /^model_mirror: "https:\/\/mirror\.example\/x(\\n){30}"$/);
  assert.equal(lines[3], 'model_dir: "/data/models"');
});

test("a long value goes on in indented rows, so the dialog stays within the screen; a call that needs too many rows is refused", () => {
  const properties = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`field_${index}`, {}]));
  const tools = consoleTools([{ name: "write_many", inputSchema: { type: "object", properties }, annotations: {} }]);
  const en = (key, params) => translate("en", key, params);
  // 240 characters with no space: six rows, none wider than its name and 48 characters.
  const dialog = confirmationDialog(tools[0], { field_0: "A".repeat(240), field_1: "/a/very/long/path/with/no/spaces/at/all/to/a/project/folder/somewhere/deep" }, en);
  const rows = dialog.detail.split("\n").slice(3);
  // The note on a cut value has spaces of its own: GTK breaks it where it must.
  const widths = rows.map((row) => row.replace(/ \(\d+ characters in all\)$/, "").length);
  assert.deepEqual(widths.map((width) => width <= "field_0: ".length + 48), rows.map(() => true), JSON.stringify(rows));
  assert.ok(rows.filter((row) => row.startsWith("    ")).length >= 3, "the rest of each value is indented");
  assert.match(joined(dialog.detail), /^field_0: "A{239}… \(242 characters in all\)$/m);
  assert.match(joined(dialog.detail), /^field_1: "\/a\/very\/long\/path\/with\/no\/spaces\/at\/all\/to\/a\/project\/folder\/somewhere\/deep"$/m);
  // Six values cut at 240 characters take 36 rows: shown. Seven would take 42: refused, not shown in part.
  const values = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${index}`, "B".repeat(300)]));
  assert.equal(consoleDecision({ tool: "write_many", args: values(6), id: "call-6" }, tools).confirm, true);
  assert.match(consoleDecision({ tool: "write_many", args: values(7), id: "call-7" }, tools).refused, /at most 36 rows of arguments; this one needs 42/);
});
