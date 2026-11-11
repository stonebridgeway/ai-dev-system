/**
 * The Knowledge Galaxy viewer's chrome: the panels around the sky, and the
 * card a selected star opens.
 *
 * Browser code, inlined into the page with the rest of `src/galaxy/` by
 * `src/core/galaxy-page.mjs`. Vault text only ever reaches the page through
 * `textContent` here — never as markup — so a title cannot become HTML.
 */

/** A DOM element with text, class and attributes. */
export function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "text") node.textContent = value;
    else if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * Replace the page body with the viewer's elements.
 *
 * @param {object} text - The page's `TEXT` entry.
 * @param {string} title - The canvas's accessible name.
 */
export function buildChrome(text, title) {
  document.body.textContent = "";
  const canvas = element("canvas", { id: "scene", tabindex: "0", "aria-label": title });
  const labelLayer = element("div", { id: "labels", "aria-hidden": "true" });
  const steer = element("canvas", { id: "steer", "aria-hidden": "true", hidden: "" });
  const search = element("input", { id: "search", type: "search", placeholder: text.search, autocomplete: "off", spellcheck: "false", "aria-label": text.search });
  const searchCount = element("div", { id: "search-count", hidden: "" });
  const results = element("ul", { id: "results", role: "listbox" });
  const searchPanel = element("div", { id: "search-panel", className: "panel" }, [search, searchCount, results]);
  const buttons = {
    links: element("button", { type: "button", text: `${text.links} (L)` }),
    labels: element("button", { type: "button", text: `${text.labels} (T)` }),
    color: element("button", { type: "button" }),
    steering: element("button", { type: "button", text: `${text.steering} (␣)` }),
    overview: element("button", { type: "button", text: text.overview }),
    help: element("button", { type: "button", text: `${text.help} (H)` })
  };
  const toolbar = element("div", { id: "toolbar", className: "panel" }, Object.values(buttons));
  const stats = element("div", { id: "stats" });
  const hint = element("div", { id: "hint", text: text.hint });
  const speedLabel = element("div", { id: "speed" });
  const details = element("aside", { id: "details", className: "panel", hidden: "", "aria-live": "polite" });
  const tooltip = element("div", { id: "tooltip", hidden: "" });
  const help = element("div", { id: "help", className: "panel", hidden: "", role: "dialog", "aria-label": text.helpTitle });
  help.append(element("h2", { text: text.helpTitle }));
  const table = element("table");
  for (const [keys, action] of text.keys) {
    table.append(element("tr", {}, [element("td", {}, [element("kbd", { text: keys })]), element("td", { text: action })]));
  }
  help.append(table, element("p", { text: text.helpNote }));
  document.body.append(canvas, labelLayer, steer, searchPanel, toolbar, stats, hint, speedLabel, details, tooltip, help);
  return { canvas, labelLayer, steer, search, searchCount, results, buttons, stats, speedLabel, details, tooltip, help };
}

/** A coloured dot. */
export function colorDot(css) {
  const dot = element("span", { className: "dot" });
  dot.style.background = css;
  return dot;
}

/**
 * Fill the card for a selected star, or hide it for none.
 *
 * @param {HTMLElement} details
 * @param {object} card - What to show, and what its buttons do.
 */
export function renderDetails(details, card) {
  details.textContent = "";
  if (!card) { details.hidden = true; return; }
  const { text } = card;
  const list = (items) => {
    const node = element("ul");
    for (const { index, score } of items) {
      const item = element("li", { tabindex: "0", role: "button" }, [colorDot(card.colorOf(index)), element("span", { text: card.titleOf(index) })]);
      if (score !== undefined) item.append(element("span", { className: "score", text: `${Math.round(score * 100)}%` }));
      const go = () => card.onPick(index);
      item.addEventListener("click", go);
      item.addEventListener("keydown", (event) => { if (event.key === "Enter") go(); });
      node.append(item);
    }
    return node;
  };
  const close = element("button", { type: "button", className: "close", text: "×", "aria-label": text.close });
  close.addEventListener("click", card.onClose);
  const chips = element("div", { className: "chips" }, [element("span", { className: "chip", text: card.scope })]);
  if (card.source && card.source !== "vault-note") chips.append(element("span", { className: "chip", text: card.source }));
  if (card.constellation) chips.append(element("span", { className: "chip" }, [colorDot(card.color), card.constellation]));
  details.append(close, element("h2", { text: card.title }), chips, element("div", { className: "path", text: card.path }));
  if (card.preview) details.append(element("p", { text: card.preview }));
  const actions = element("div", { className: "actions" });
  if (card.obsidianHref) actions.append(element("a", { className: "button", href: card.obsidianHref, text: text.obsidian }));
  const fly = element("button", { type: "button", text: text.flyTo });
  fly.addEventListener("click", card.onFly);
  const copy = element("button", { type: "button", text: text.copy });
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(card.path).then(() => { copy.textContent = text.copied; }, () => {});
  });
  actions.append(fly, copy);
  details.append(actions);
  if (card.nearest.length) details.append(element("h3", { text: text.nearest }), list(card.nearest));
  if (card.linked.length) details.append(element("h3", { text: text.linked }), list(card.linked));
  details.hidden = false;
}
