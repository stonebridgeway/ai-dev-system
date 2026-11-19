// Markdown from the daemon — a project card, a skill, an epic — shown as
// readable text. A small subset is understood (headings, lists, code blocks,
// tables, rules, paragraphs, `code` and **bold** inside a line); everything is
// set as text, never parsed as HTML, so a note cannot put markup or script on
// the page. Links stay text: the page navigates nowhere.

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * The blocks of a Markdown text: `heading` (level, text), `code` (text),
 * `list` (ordered, items), `table` (rows of cells), `rule` and `paragraph` (text).
 * A YAML front matter at the top is a code block.
 *
 * @param {string} source
 * @returns {Array<{ type: string, level?: number, text?: string, ordered?: boolean, items?: string[], rows?: string[][] }>}
 */
export function markdownBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      blocks.push({ type: "code", text: lines.slice(1, end).join("\n") });
      index = end + 1;
    }
  }
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    if (FENCE.test(line.trim())) {
      flush();
      const fence = line.trim().slice(0, 3);
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) body.push(lines[index++]);
      blocks.push({ type: "code", text: body.join("\n") });
      index += 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, "") });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      flush();
      const rows = [cells(line)];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index])) rows.push(cells(lines[index++]));
      blocks.push({ type: "table", rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const pattern = ordered ? NUMBERED : BULLET;
      const items = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (item) {
          items.push(item[1]);
        } else if (items.length && /^\s{2,}\S/.test(lines[index])) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
}

function cells(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/**
 * The parts of one line: plain text, `code` and **bold**.
 *
 * @param {string} text
 * @returns {Array<{ text: string, code?: true, strong?: true }>}
 */
export function inlineParts(text) {
  const source = String(text ?? "");
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    parts.push(match[1] !== undefined ? { text: match[1], code: true } : { text: match[2], strong: true });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}

/**
 * The elements a Markdown text shows as, built with `h` (dom.js) — text only.
 *
 * @param {string} source
 * @param {(tag: string, attributes?: object, ...children: unknown[]) => unknown} h
 * @param {{ headingOffset?: number }} [options] - How many levels to push headings down (a card under the screen's h1).
 */
export function renderMarkdown(source, h, { headingOffset = 1 } = {}) {
  const inline = (text) => inlineParts(text).map((part) => (part.code ? h("code", {}, part.text) : part.strong ? h("strong", {}, part.text) : part.text));
  return markdownBlocks(source).map((block) => {
    switch (block.type) {
      case "heading":
        return h(`h${Math.min(6, block.level + headingOffset)}`, {}, inline(block.text));
      case "code":
        return h("pre", { className: "code" }, h("code", {}, block.text));
      case "list":
        return h(block.ordered ? "ol" : "ul", {}, block.items.map((item) => h("li", {}, inline(item))));
      case "table": {
        const [head, ...rows] = block.rows;
        return h("div", { className: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, head.map((cell) => h("th", {}, inline(cell))))),
          h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, inline(cell))))))));
      }
      case "rule":
        return h("hr", {});
      default:
        return h("p", {}, inline(block.text));
    }
  });
}
