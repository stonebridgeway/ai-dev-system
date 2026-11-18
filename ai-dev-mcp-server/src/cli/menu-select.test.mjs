import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { headingLines, runMenu } from "./menu.mjs";
import { canSelect, renderList, resolveTyped, selectFromList, stylesFor } from "./menu-select.mjs";

const ITEMS = [
  { id: "status", label: "Status", hint: "model, index, clients" },
  { id: "settings", label: "Settings", hint: "profiles and folders" },
  { id: "daemon", label: "Daemon" },
  { id: "help", key: "h", label: "Every command" }
];
const PLAIN = stylesFor({ isTTY: false }, {});
const DOWN = "\x1b[B";
const UP = "\x1b[A";

/** A terminal as the menu sees it: a stream on each side that says it is one, and what was written. */
function terminal({ rows = 40, columns = 100 } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: [], setRawMode(on) { this.raw.push(on); } });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows, columns });
  let written = "";
  output.on("data", (chunk) => { written += chunk; });
  // Keys one at a time, as a person types them: each is read before the next is sent.
  const type = async (...keys) => {
    for (const key of keys) {
      input.write(key);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { input, output, type, written: () => written };
}

test("where the list is walked with the arrows, and where it stays a numbered question", () => {
  const tty = { isTTY: true, setRawMode() {} };
  assert.equal(canSelect(tty, { isTTY: true }, {}), true);
  assert.equal(canSelect(tty, { isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(canSelect(tty, { isTTY: true }, { AI_DEV_MENU: "plain" }), false);
  assert.equal(canSelect({ isTTY: true }, { isTTY: true }, {}), false, "a terminal that cannot be put in raw mode");
  assert.equal(canSelect(tty, { isTTY: false }, {}), false, "output that goes to a file");
  // Colour: a terminal's, unless NO_COLOR says otherwise; the text alone anywhere else.
  assert.equal(stylesFor({ isTTY: true }, {}).bold("x"), "\x1b[1mx\x1b[22m");
  assert.equal(stylesFor({ isTTY: true }, { NO_COLOR: "1" }).bold("x"), "x");
  assert.equal(stylesFor({ isTTY: false }, {}).accent("x"), "x");
});

test("the list as lines: one line marked, hints in a column, nothing wider than the terminal", () => {
  const lines = renderList({ title: "Menu", items: ITEMS, back: "Back", selected: 1, styles: PLAIN });
  assert.deepEqual(lines, [
    "",
    "Menu",
    "   1  Status     model, index, clients",
    ">  2  Settings   profiles and folders",
    "   3  Daemon",
    "   h  Every command",
    "   b  Back",
    "   q  Quit",
    "Up and Down, then Enter; or a number and Enter; b or Esc goes back; q leaves.",
    "Choose: "
  ]);
  const main = renderList({ title: "Menu", items: ITEMS, back: null, selected: 0, styles: PLAIN });
  assert.equal(main.some((line) => /^ {3}b {2}/.test(line)), false, "no b line in the main menu");
  const narrow = renderList({ title: "A title that is far longer than a narrow terminal is wide", items: ITEMS, back: "Back", selected: 0, columns: 30, styles: PLAIN });
  assert.ok(narrow.every((line) => line.length <= 29), JSON.stringify(narrow));
});

test("a word typed chooses as it did: a key, an id, a label; b and q where they mean something", () => {
  assert.deepEqual(resolveTyped("2", ITEMS, "Back"), { kind: "choice", id: "settings" });
  assert.deepEqual(resolveTyped(" H ", ITEMS, "Back"), { kind: "choice", id: "help" });
  assert.deepEqual(resolveTyped("daemon", ITEMS, "Back"), { kind: "choice", id: "daemon" });
  assert.deepEqual(resolveTyped("every command", ITEMS, "Back"), { kind: "choice", id: "help" });
  assert.deepEqual(resolveTyped("b", ITEMS, "Back"), { kind: "back" });
  assert.equal(resolveTyped("b", ITEMS, null), null, "the main menu has no back");
  assert.deepEqual(resolveTyped("q", ITEMS, null), { kind: "quit" });
  assert.equal(resolveTyped("zz", ITEMS, "Back"), null);
});

test("at a terminal the arrows move the mark and Enter takes it; raw mode lasts as long as the list", async () => {
  const t = terminal();
  const picking = selectFromList({ input: t.input, output: t.output, title: "Menu", items: ITEMS, back: "Back", styles: PLAIN });
  await t.type(DOWN, DOWN, UP, "\r");
  assert.deepEqual(await picking, { kind: "choice", id: "settings" });
  assert.deepEqual(t.input.raw, [true, false], "the terminal is given back before a command runs");
  assert.match(t.written(), /\x1b\[9A\r\x1b\[0J/, "the list is drawn over itself, not under");
  assert.match(t.written(), /Choose: 2\n$/, "and ends on what was chosen, as a typed answer does");

  // Round the ends, and a number typed moves the mark to its line.
  const round = selectFromList({ input: t.input, output: t.output, title: "Menu", items: ITEMS, back: "Back", styles: PLAIN });
  await t.type(UP, "\r");
  assert.deepEqual(await round, { kind: "choice", id: "help" });
  const typed = selectFromList({ input: t.input, output: t.output, title: "Menu", items: ITEMS, back: "Back", styles: PLAIN });
  await t.type("3");
  assert.match(t.written().split("\x1b[0J").at(-1), /^> {2}3 {2}Daemon$/m);
  await t.type("\r");
  assert.deepEqual(await typed, { kind: "choice", id: "daemon" });
});

test("a word that is not there is said and asked again; Esc goes back, q leaves, Ctrl-C and Ctrl-D are told apart", async () => {
  const t = terminal();
  const wrong = selectFromList({ input: t.input, output: t.output, title: "Menu", items: ITEMS, back: "Back", styles: PLAIN });
  await t.type("z", "z", "\r");
  assert.match(t.written(), /There is no "zz" here: a number from the list, b or q\./);
  await t.type("o", "\x7f", "b", "\r");
  assert.deepEqual(await wrong, { kind: "back" });

  const cases = [
    [["q", "\r"], "Back", { kind: "quit" }],
    [["\x03"], "Back", { kind: "interrupt" }],
    [["\x04"], "Back", { kind: "end" }],
    [["\x1b[D"], "Back", { kind: "back" }]
  ];
  for (const [keys, back, expected] of cases) {
    const picking = selectFromList({ input: t.input, output: t.output, title: "Menu", items: ITEMS, back, styles: PLAIN });
    await t.type(...keys);
    assert.deepEqual(await picking, expected, JSON.stringify(keys));
  }
  // The main menu has no back: the left arrow chooses nothing, Enter still does.
  const main = selectFromList({ input: t.input, output: t.output, title: "Menu", items: ITEMS, back: null, styles: PLAIN });
  await t.type("\x1b[D", "\r");
  assert.deepEqual(await main, { kind: "choice", id: "status" });
});

test("the install's state above the main list: the verdict and why, then the model, the index and the clients", () => {
  const status = { version: "3.0.0", status: "degraded", summary: "the local model is not installed", model: { installed: false }, index: { exists: true, documents: 825, fresh: false }, clients: { connected: 2, found: 3 } };
  assert.deepEqual(headingLines(status, PLAIN), [
    "AI Dev 3.0.0 · degraded: the local model is not installed",
    "  model not installed · index 825 documents, out of date · clients 2 of 3 connected"
  ]);
  const ok = headingLines({ version: "3.0.0", status: "ok", summary: "", model: { installed: true }, index: { exists: false }, clients: { connected: 0, found: 0 } }, PLAIN, 40);
  assert.deepEqual(ok, ["AI Dev 3.0.0 · ok", "  model installed · index not built · …"]);
  const coloured = headingLines({ ...status, status: "failed" }, stylesFor({ isTTY: true }, {}));
  assert.match(coloured[0], /^\x1b\[1mAI Dev 3\.0\.0\x1b\[22m\x1b\[31m · failed/);
});

test("the menu at a terminal: the install's state, then what the marked line names is run", async () => {
  const ran = [];
  const main = async (argv) => { ran.push(argv); return 0; };
  const t = terminal();
  const io = { stdin: t.input, stdout: t.output, env: { AI_DEV_HOME: "/nonexistent-ai-dev-home", NO_COLOR: "1" }, interactive: true, out: (line = "") => t.output.write(`${line}\n`), err: () => undefined };
  const status = async () => ({ version: "3.0.0", status: "ok", summary: "", model: { installed: true }, index: { exists: true, documents: 825, fresh: true }, clients: { connected: 1, found: 1 } });
  const running = runMenu(io, { main, status });
  // The heading is read first; the list is there when it asks.
  for (let waited = 0; !t.written().includes("Choose: ") && waited < 500; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(t.written(), /AI Dev 3\.0\.0 · ok\n {2}model installed · index 825 documents · clients 1 of 1 connected\n\nMenu\n/);
  await t.type(DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, "\r");
  for (let waited = 0; !t.written().includes("The daemon:") && waited < 500; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ran, [], "Daemon opens its own list");
  await t.type("\r");
  for (let waited = 0; !ran.length && waited < 500; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ran, [["daemon", "status"]]);
  // Back in the daemon's list, the mark is where it was left: Down from Status is Start.
  await t.type(DOWN, "\r");
  for (let waited = 0; ran.length < 2 && waited < 500; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ran.at(-1), ["daemon", "start"]);
  // And the main list is marked on Daemon still: Enter opens it again, Esc leaves it.
  await t.type("\x1b[D", "\r", "q", "\r");
  assert.equal(await running, 0);
  assert.equal(t.input.raw.at(-1), false);
});

test("the status lines in colour at a terminal, and as rendered anywhere else", async () => {
  const { colourStatus } = await import("./status.mjs");
  const lines = ["AI Dev 3.0.0 · failed: the search index is not built", "  index     not built: `ai-dev setup` builds it", "    fail search_index_file: missing"];
  assert.deepEqual(colourStatus(lines, "failed", PLAIN), lines);
  const coloured = colourStatus(lines, "failed", stylesFor({ isTTY: true }, {}));
  assert.match(coloured[0], /\x1b\[31m · failed/);
  assert.match(coloured[1], /\x1b\[36mai-dev setup\x1b\[39m/);
  assert.match(coloured[2], /^ {4}\x1b\[31mfail\x1b\[39m search_index_file/);
  assert.deepEqual(coloured.map((line) => line.replace(/\x1b\[\d+m/g, "")), lines.map((line) => line.replaceAll("`", "")));
});
