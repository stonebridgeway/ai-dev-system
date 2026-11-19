// Small DOM helpers. Text from the daemon (check summaries, file names, log
// lines) is only ever set as text, never parsed as HTML.

/**
 * An element with attributes and children; strings become text nodes.
 * `on: { click }` adds listeners; `dataset: {}` sets data-*.
 */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "on") {
      for (const [event, listener] of Object.entries(value)) element.addEventListener(event, listener);
    } else if (name === "dataset") {
      Object.assign(element.dataset, value);
    } else if (name === "className") {
      element.className = value;
    } else if (value === true) {
      element.setAttribute(name, "");
    } else {
      element.setAttribute(name, String(value));
    }
  }
  append(element, children);
  return element;
}

function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace what `element` shows. */
export function show(element, ...children) {
  element.replaceChildren();
  append(element, children);
}

/** 1536 → "1.5 KB"; bytes in the units people read. */
export function formatBytes(bytes, language = "en") {
  const value = Number(bytes) || 0;
  const units = language === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : 1);
  return `${language === "ru" ? text.replace(".", ",") : text} ${units[unit]}`;
}

/** A progress bar and its line of text, updated by `update({ progress, total, message })`. */
export function progressBar() {
  const bar = h("progress", { max: 1, value: 0 });
  const line = h("p", { className: "progress-text", "aria-live": "polite" });
  const element = h("div", { className: "progress" }, bar, line);
  return {
    element,
    update({ progress, total, message } = {}) {
      if (Number.isFinite(total) && total > 0) {
        bar.max = total;
        bar.value = Math.min(progress ?? 0, total);
      } else {
        bar.removeAttribute("value");
      }
      line.textContent = message ?? "";
    }
  };
}
