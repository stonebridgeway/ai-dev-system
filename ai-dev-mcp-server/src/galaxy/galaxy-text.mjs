/**
 * The Knowledge Galaxy viewer's words and keys.
 *
 * Browser code, inlined into the page with the rest of `src/galaxy/` by
 * `src/core/galaxy-page.mjs`. The page speaks the browser's language: Russian
 * for `ru`, English otherwise.
 *
 * Keys are named by `event.code`, the physical key, so the controls stay where
 * they are with a Russian layout active; a letter would not.
 */

/** UI text. The page follows the browser's language, English otherwise. */
export const TEXT = {
  en: {
    search: "Find a note…",
    matches: (count) => `${count} match${count === 1 ? "" : "es"}`,
    links: "Links",
    labels: "Labels",
    colors: { cluster: "Colour: constellations", scope: "Colour: note kind", white: "Colour: white" },
    steering: "Steering",
    help: "Help",
    overview: "Overview",
    stats: (m) => `${m.stars} stars · ${m.edges} links · ${m.clusters} constellations · ${m.space}`,
    hint: "WASD fly · drag to look · Shift faster · Space steering · H help",
    speed: (value) => `speed ×${value}`,
    nearest: "Nearest in meaning",
    linked: "Linked in the vault",
    obsidian: "Open in Obsidian",
    flyTo: "Fly here",
    copy: "Copy path",
    copied: "Copied",
    close: "Close",
    noWebgl: "This browser cannot draw the galaxy: WebGL is unavailable.",
    helpTitle: "Flying the galaxy",
    keys: [
      ["W / S", "move forward / back"], ["A / D", "move left / right"],
      ["R / F", "fly up / down"], ["Q / E", "roll"],
      ["↑ ↓ ← →", "turn"], ["Shift", "fly faster"],
      ["Mouse drag", "look around"], ["Wheel", "move forward / back"],
      ["Space", "steering: the ship follows the cursor"], ["Click", "select a star"],
      ["Double click", "fly to a star"], ["L", "links on / off"],
      ["T", "labels on / off"], ["C", "colour mode"],
      ["+ / −", "cruising speed"], ["0 / Home", "overview"],
      ["/ or Ctrl+K", "search"], ["Esc", "clear selection"], ["H or ?", "this help"]
    ],
    helpNote: "Stars close together are close in meaning: each note is tied to its nearest neighbours in embedding space, and wikilinks are drawn as brighter lines. The address bar keeps the camera, so a view can be bookmarked. Touch: drag to look, hold one finger to fly forward, two to fly back.",
    spaces: { dense: "BGE-M3 space", sparse: "keyword space", mixed: "BGE-M3 + keyword space" }
  },
  ru: {
    search: "Найти заметку…",
    matches: (count) => `совпадений: ${count}`,
    links: "Связи",
    labels: "Подписи",
    colors: { cluster: "Цвет: созвездия", scope: "Цвет: тип заметки", white: "Цвет: белый" },
    steering: "Руление",
    help: "Справка",
    overview: "Обзор",
    stats: (m) => `звёзд ${m.stars} · связей ${m.edges} · созвездий ${m.clusters} · ${m.space}`,
    hint: "WASD — полёт · мышь — обзор · Shift — быстрее · Пробел — руление · H — справка",
    speed: (value) => `скорость ×${value}`,
    nearest: "Ближайшие по смыслу",
    linked: "Связаны ссылками",
    obsidian: "Открыть в Obsidian",
    flyTo: "Лететь сюда",
    copy: "Скопировать путь",
    copied: "Скопировано",
    close: "Закрыть",
    noWebgl: "Браузер не может нарисовать галактику: WebGL недоступен.",
    helpTitle: "Как летать по галактике",
    keys: [
      ["W / S", "вперёд / назад"], ["A / D", "влево / вправо"],
      ["R / F", "вверх / вниз"], ["Q / E", "крен"],
      ["↑ ↓ ← →", "поворот"], ["Shift", "быстрее"],
      ["Перетаскивание мышью", "осмотреться"], ["Колесо", "вперёд / назад"],
      ["Пробел", "руление: корабль следует за курсором"], ["Клик", "выбрать звезду"],
      ["Двойной клик", "лететь к звезде"], ["L", "связи вкл / выкл"],
      ["T", "подписи вкл / выкл"], ["C", "режим цвета"],
      ["+ / −", "крейсерская скорость"], ["0 / Home", "обзор"],
      ["/ или Ctrl+K", "поиск"], ["Esc", "снять выделение"], ["H или ?", "эта справка"]
    ],
    helpNote: "Звёзды рядом — заметки, близкие по смыслу: каждая связана с ближайшими соседями в пространстве эмбеддингов, а вики-ссылки нарисованы яркими линиями. Адресная строка хранит положение камеры, так что вид можно сохранить в закладки. На сенсорном экране: проведите пальцем, чтобы осмотреться; удерживайте один палец — полёт вперёд, два — назад.",
    spaces: { dense: "пространство BGE-M3", sparse: "пространство ключевых слов", mixed: "BGE-M3 + ключевые слова" }
  }
};

/** @param {string} [language] */
export function pickText(language) {
  return String(language || "").toLowerCase().startsWith("ru") ? TEXT.ru : TEXT.en;
}

/** Physical key → action. Movement keys are held; the rest fire once. */
export const HELD_KEYS = {
  KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right",
  KeyR: "up", KeyF: "down", KeyQ: "rollLeft", KeyE: "rollRight",
  ArrowUp: "pitchUp", ArrowDown: "pitchDown", ArrowLeft: "yawLeft", ArrowRight: "yawRight",
  PageUp: "up", PageDown: "down"
};
