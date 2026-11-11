import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// WCAG 2.2 contrast for the colours the stylesheet uses, light and dark:
// text 4.5:1 (AA), the focus ring and other non-text marks 3:1.
const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer", "styles.css"), "utf8");

function variables(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1], match[2]]));
}

const light = variables(/:root\s*\{([^}]*)\}/.exec(css)[1]);
const darkOwn = variables(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]);
const dark = { ...light, ...darkOwn };

function luminance(hex) {
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

const TEXT = [
  ["text", "bg"], ["text", "surface"],
  ["muted", "bg"], ["muted", "surface"],
  ["accent", "bg"], ["accent", "surface"],
  ["accent-text", "accent"],
  ["ok", "bg"], ["ok", "surface"],
  ["warn", "bg"], ["warn", "surface"],
  ["fail", "bg"], ["fail", "surface"]
];
const MARKS = [["focus", "bg"], ["focus", "surface"]];

test("the stylesheet's colours meet WCAG AA in the light and the dark scheme", () => {
  assert.ok(Object.keys(light).length >= 10, "the light scheme's variables are read");
  assert.ok(Object.keys(darkOwn).length >= 10, "the dark scheme's own variables are read");
  const failing = [];
  for (const [name, scheme] of [["light", light], ["dark", dark]]) {
    for (const [foreground, background] of TEXT) {
      const ratio = contrast(scheme[foreground], scheme[background]);
      if (!(ratio >= 4.5)) failing.push(`${name}: --${foreground} on --${background} is ${ratio.toFixed(2)}:1, text needs 4.5:1`);
    }
    for (const [foreground, background] of MARKS) {
      const ratio = contrast(scheme[foreground], scheme[background]);
      if (!(ratio >= 3)) failing.push(`${name}: --${foreground} on --${background} is ${ratio.toFixed(2)}:1, a mark needs 3:1`);
    }
  }
  assert.deepEqual(failing, []);
});

test("the contrast formula gives the known ratios", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(1), "21.0");
  assert.equal(contrast("#ffffff", "#ffffff").toFixed(1), "1.0");
  assert.equal(contrast("#767676", "#ffffff").toFixed(2), "4.54");
});
