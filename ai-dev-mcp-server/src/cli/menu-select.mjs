/**
 * The menu's list at a terminal: the arrows move a mark, Enter takes the
 * marked line, and a number or a letter typed is what it was before — the
 * choice, after Enter. Colour where the terminal has it.
 *
 * The keys are read in raw mode for as long as one list is on the screen and
 * no longer: a command the menu runs has the terminal as it was, so Ctrl-C
 * reaches the command. Piped input (a test, a script) never comes here.
 */
import readline from "node:readline";

/**
 * Whether a list is drawn this way: a terminal on both sides that can be put
 * in raw mode and moves its cursor. `TERM=dumb` and `AI_DEV_MENU=plain` keep
 * the numbered questions.
 *
 * @param {{ isTTY?: boolean, setRawMode?: Function }} input
 * @param {{ isTTY?: boolean }} output
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function canSelect(input, output, env = process.env) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") return false;
  if (String(env.TERM ?? "").toLowerCase() === "dumb") return false;
  return String(env.AI_DEV_MENU ?? "").trim().toLowerCase() !== "plain";
}

/**
 * The styles of a terminal: escape codes, or the text as it is where colour
 * is not wanted (`NO_COLOR`, by https://no-color.org) or not there.
 *
 * @param {{ isTTY?: boolean }} output
 * @param {NodeJS.ProcessEnv} [env]
 */
export function stylesFor(output, env = process.env) {
  const plain = !output?.isTTY || (env.NO_COLOR !== undefined && env.NO_COLOR !== "") || String(env.TERM ?? "").toLowerCase() === "dumb";
  const wrap = (open, close) => (text) => (plain || text === "" ? text : `\x1b[${open}m${text}\x1b[${close}m`);
  return {
    plain,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    accent: wrap(36, 39),
    ok: wrap(32, 39),
    warn: wrap(33, 39),
    fail: wrap(31, 39)
  };
}

/** A line cut to the terminal's width: a wrapped line would be counted as one when the list is drawn again. */
function fit(text, width) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

const keyOf = (item, index) => String(item.key ?? index + 1);

/**
 * The list as lines, one item marked.
 *
 * @param {{ title: string, items: Array<{ id: string, label: string, hint?: string, key?: string }>, back: string | null, selected: number, typed?: string, note?: string, columns?: number, styles: ReturnType<typeof stylesFor> }} state
 * @returns {string[]}
 */
export function renderList({ title, items, back, selected, typed = "", note = "", columns = 100, styles }) {
  const width = Math.max(20, columns - 1);
  const labelWidth = Math.max(0, ...items.filter((item) => item.hint).map((item) => item.label.length)) + 3;
  const lines = ["", styles.bold(fit(title, width))];
  items.forEach((item, index) => {
    const marked = index === selected;
    const key = keyOf(item, index).padStart(2);
    const label = item.hint ? item.label.padEnd(labelWidth) : item.label;
    const hint = fit(item.hint ?? "", Math.max(0, width - 6 - label.length));
    lines.push(marked
      ? `${styles.accent(">")} ${styles.accent(styles.bold(key))}  ${styles.bold(label)}${hint}`
      : `  ${styles.accent(key)}  ${label}${styles.dim(hint)}`);
  });
  if (back) lines.push(`  ${styles.accent(" b")}  ${back}`);
  lines.push(`  ${styles.accent(" q")}  Quit`);
  if (note) lines.push(styles.warn(fit(note, width)));
  // In words: a console that has no arrows in its font shows them as question marks.
  lines.push(styles.dim(fit(`Up and Down, then Enter; or a number and Enter${back ? "; b or Esc goes back" : ""}; q leaves.`, width)));
  lines.push(`Choose: ${typed}`);
  return lines;
}

/**
 * What a typed word chooses: an item by its key, id or label, back, quit, or
 * nothing here.
 *
 * @returns {{ kind: "choice", id: string } | { kind: "back" } | { kind: "quit" } | null}
 */
export function resolveTyped(word, items, back) {
  const text = word.trim().toLowerCase();
  if (text === "q") return { kind: "quit" };
  if (back && text === "b") return { kind: "back" };
  const found = items.find((item, index) => keyOf(item, index) === text)
    ?? items.find((item) => item.id.toLowerCase() === text || item.label.toLowerCase() === text);
  return found ? { kind: "choice", id: found.id } : null;
}

/**
 * One list at a terminal, until a choice is made.
 *
 * @param {{ input: NodeJS.ReadStream, output: NodeJS.WriteStream, title: string, items: Array<{ id: string, label: string, hint?: string, key?: string }>, back: string | null, styles: ReturnType<typeof stylesFor>, start?: number }} options
 *   `start`: the line marked first — where this list was left the last time.
 * @returns {Promise<{ kind: "choice", id: string } | { kind: "back" } | { kind: "quit" } | { kind: "end" } | { kind: "interrupt" }>}
 *   `end`: Ctrl-D, the input ended; `interrupt`: Ctrl-C.
 */
export function selectFromList({ input, output, title, items, back, styles, start = 0 }) {
  return new Promise((resolve) => {
    let selected = start >= 0 && start < items.length ? start : 0;
    let typed = "";
    let note = "";
    let drawn = 0;
    const draw = () => {
      const lines = renderList({ title, items, back, selected, typed, note, columns: Number(output.columns) || 100, styles });
      // Back to the first line of the list as it was drawn, and everything below it gone.
      const rewind = drawn > 1 ? `\x1b[${drawn - 1}A` : "";
      output.write(`${drawn ? `${rewind}\r\x1b[0J` : ""}${lines.join("\n")}`);
      drawn = lines.length;
    };
    const finish = (result, shown) => {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      typed = shown;
      note = "";
      draw();
      output.write("\n");
      resolve(result);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") return finish({ kind: "interrupt" }, typed);
      if (key.ctrl && key.name === "d") return typed ? undefined : finish({ kind: "end" }, "");
      if (key.name === "up" || key.name === "down") {
        selected = (selected + (key.name === "up" ? items.length - 1 : 1)) % items.length;
        typed = "";
        note = "";
        return draw();
      }
      if (key.name === "home" || key.name === "end") {
        selected = key.name === "home" ? 0 : items.length - 1;
        return draw();
      }
      if (key.name === "return" || key.name === "enter") {
        if (!typed.trim()) return finish({ kind: "choice", id: items[selected].id }, keyOf(items[selected], selected));
        const result = resolveTyped(typed, items, back);
        if (result) return finish(result, typed.trim());
        note = `There is no ${JSON.stringify(typed.trim())} here: a number from the list${back ? ", b" : ""} or q.`;
        typed = "";
        return draw();
      }
      if (key.name === "escape" || key.name === "left") return back ? finish({ kind: "back" }, "b") : undefined;
      if (key.name === "backspace") {
        typed = typed.slice(0, -1);
        return draw();
      }
      if (typeof text !== "string" || text.length !== 1 || text < " " || key.ctrl || key.meta) return undefined;
      typed += text;
      note = "";
      // A key typed moves the mark to its line: Enter then takes what is seen.
      const at = items.findIndex((item, index) => keyOf(item, index) === typed.trim().toLowerCase());
      if (at >= 0) selected = at;
      return draw();
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    draw();
  });
}
