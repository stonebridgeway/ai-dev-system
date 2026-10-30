#!/usr/bin/env node
/**
 * Check the links in the repository's documentation.
 *
 *   node scripts/doc-links.mjs              # relative links and #anchors; exit 1 on a broken one
 *   node scripts/doc-links.mjs --external   # also ask every http(s) link (needs the network)
 *   node scripts/doc-links.mjs --json       # the result as JSON
 *
 * A relative link has to name a file or folder git tracks: a file that is only
 * on this disk is still broken for everyone reading on GitHub. An anchor has to
 * name a heading of its target the way GitHub slugs it (lowercased, punctuation
 * dropped, spaces to hyphens, a repeated heading gets -1, -2 …) or an explicit
 * `<a id>`/`<a name>`. A link inside fenced or inline code is an example, not a
 * link, and is skipped.
 *
 * The documentation is every tracked Markdown file outside `docker/public-seed/`:
 * the seed is the vault the server ships, and its skill catalogue is imported
 * work with its own links. Links from the documentation into the seed are
 * checked like any other.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOT_DOCUMENTATION = ["docker/public-seed/"];
// github.com/stonebridgeway/ai-dev-system/(blob|tree)/<ref>/<path>: a link into this repository written out in full.
const REPOSITORY_URL = /^https:\/\/github\.com\/stonebridgeway\/ai-dev-system\/(?:blob|tree)\/[^/]+\/(.+)$/i;
const LINE_ANCHOR = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/;

/** The anchor GitHub gives a heading: what github-slugger does to the heading's text. */
export function githubSlug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** The text GitHub renders for a heading's Markdown — what its slug is made from. */
export function headingText(markdown) {
  return markdown
    .replace(/<[^>]*>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?!\s)([^*]+?)\*(?=$|[^\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?!\s)([^_]+?)_(?=$|[^\p{L}\p{N}_])/gu, "$1$2")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Blank out fenced code and HTML comments, keeping the line count, so nothing
 * inside them reads as a link or a heading.
 */
function proseLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  let inComment = false;
  return lines.map((line) => {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
      return "";
    }
    if (!inComment && opener) {
      fence = opener[1];
      return "";
    }
    let kept = "";
    let rest = line;
    while (rest) {
      if (inComment) {
        const close = rest.indexOf("-->");
        if (close < 0) return kept;
        rest = rest.slice(close + 3);
        inComment = false;
      } else {
        const open = rest.indexOf("<!--");
        if (open < 0) return kept + rest;
        kept += rest.slice(0, open);
        rest = rest.slice(open + 4);
        inComment = true;
      }
    }
    return kept;
  });
}

/** Inline code spans become spaces of the same length; a run of backticks with no partner stays as text. */
function withoutInlineCode(line) {
  let result = "";
  let at = 0;
  while (at < line.length) {
    const open = line.indexOf("`", at);
    if (open < 0) break;
    let width = 1;
    while (line[open + width] === "`") width += 1;
    let close = -1;
    for (let look = line.indexOf("`", open + width); look >= 0; look = line.indexOf("`", look)) {
      let run = 1;
      while (line[look + run] === "`") run += 1;
      if (run === width) { close = look; break; }
      look += run;
    }
    if (close < 0) {
      result += line.slice(at, open + width);
      at = open + width;
      continue;
    }
    result += line.slice(at, open) + " ".repeat(close + width - open);
    at = close + width;
  }
  return result + line.slice(at);
}

/** Every anchor a Markdown file offers: its headings, GitHub-slugged with repeats numbered, and explicit ids. */
export function anchorsOf(markdown) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const line of proseLines(markdown)) {
    for (const match of line.matchAll(/<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
    const heading = /^ {0,3}#{1,6}(?:\s+(.*?))?\s*$/.exec(line);
    if (!heading) continue;
    const text = (heading[1] || "").replace(/\s+#+\s*$/, "").replace(/^#+$/, "");
    // As github-slugger numbers them: the first "x" is #x, the next #x-1, then #x-2.
    const original = githubSlug(headingText(text));
    let slug = original;
    while (occurrences.has(slug)) {
      occurrences.set(original, occurrences.get(original) + 1);
      slug = `${original}-${occurrences.get(original)}`;
    }
    occurrences.set(slug, 0);
    anchors.add(slug);
  }
  return anchors;
}

/** Read a link destination that starts at `index`: `<…>`, or a run without spaces whose parentheses balance. */
function destinationAt(line, index) {
  let at = index;
  while (line[at] === " ") at += 1;
  if (line[at] === "<") {
    const end = line.indexOf(">", at + 1);
    return end < 0 ? null : { target: line.slice(at + 1, end), end: end + 1 };
  }
  let depth = 0;
  let end = at;
  for (; end < line.length; end += 1) {
    const character = line[end];
    if (character === "\\") { end += 1; continue; }
    if (character === " " || character === "\t") break;
    if (character === "(") depth += 1;
    if (character === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return { target: line.slice(at, end), end };
}

/**
 * Every link a Markdown file makes: inline links and images, reference definitions,
 * full and collapsed reference links, and HTML href/src — with the line it is on.
 */
export function linksOf(markdown) {
  const links = [];
  const references = new Map();
  const usages = [];
  proseLines(markdown).forEach((raw, index) => {
    const line = withoutInlineCode(raw);
    const number = index + 1;
    const definition = /^ {0,3}\[([^\]]+)\]:\s*(.*)$/.exec(line);
    if (definition) {
      const destination = destinationAt(definition[2], 0);
      if (destination?.target) {
        references.set(definition[1].trim().toLowerCase(), destination.target);
        links.push({ target: destination.target, line: number, kind: "reference" });
      }
      return;
    }
    for (let at = line.indexOf("]("); at >= 0; at = line.indexOf("](", at + 2)) {
      const destination = destinationAt(line, at + 2);
      if (!destination || !/^\s*(?:"[^"]*"|'[^']*'|\([^)]*\))?\s*\)/.test(line.slice(destination.end))) continue;
      if (destination.target) links.push({ target: destination.target, line: number, kind: "inline" });
    }
    for (const match of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
      usages.push({ label: (match[2] || match[1]).trim().toLowerCase(), line: number });
    }
    for (const match of line.matchAll(/<(?:a|img|source)\s[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      links.push({ target: match[1], line: number, kind: "html" });
    }
  });
  for (const usage of usages) {
    if (!references.has(usage.label)) links.push({ target: null, label: usage.label, line: usage.line, kind: "undefined-reference" });
  }
  return links;
}

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Files git tracks under the root, as forward-slash paths; the folders they make up come with them. */
export function trackedTree(root = REPOSITORY_ROOT) {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${(listed.stderr || listed.error?.message || "").trim()}`);
  const files = new Set(listed.stdout.split("\0").filter(Boolean));
  const folders = new Set([""]);
  for (const file of files) {
    for (let cut = file.lastIndexOf("/"); cut > 0; cut = file.lastIndexOf("/", cut - 1)) folders.add(file.slice(0, cut));
  }
  return { files, folders };
}

/** The Markdown files this check reads. */
export function documentationFiles(tree) {
  return [...tree.files]
    .filter((file) => /\.md$/i.test(file) && !NOT_DOCUMENTATION.some((prefix) => file.startsWith(prefix)))
    .sort();
}

/**
 * What is wrong with one link, or null when it holds. External links are not
 * judged here; `external: true` marks them for the caller.
 */
export function judgeLink(link, fromFile, { tree, root = REPOSITORY_ROOT, anchorCache = new Map() }) {
  if (link.kind === "undefined-reference") return { reason: `no definition for the reference [${link.label}]` };
  let target = link.target.trim();
  const inRepository = REPOSITORY_URL.exec(target);
  if (inRepository) target = `/${inRepository[1]}`;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return /^https?:/i.test(target) ? { external: true } : null;
  if (target.startsWith("//")) return { external: true };
  const hash = target.indexOf("#");
  const pathPart = decoded(hash < 0 ? target : target.slice(0, hash)).split("?")[0];
  const fragment = hash < 0 ? null : decoded(target.slice(hash + 1));
  let resolved;
  if (pathPart === "") resolved = fromFile;
  else {
    const joined = pathPart.startsWith("/") ? path.posix.normalize(pathPart.slice(1)) : path.posix.join(path.posix.dirname(fromFile), pathPart);
    resolved = path.posix.normalize(joined).replace(/\/$/, "");
    if (resolved === ".") resolved = "";
    if (resolved === ".." || resolved.startsWith("../")) return { reason: "points outside the repository" };
  }
  const isFile = tree.files.has(resolved);
  if (!isFile && !tree.folders.has(resolved)) {
    const onDisk = fs.existsSync(path.join(root, resolved));
    return { reason: onDisk ? `${resolved} exists here but git does not track it` : `${resolved} does not exist` };
  }
  if (fragment === null || fragment === "") return null;
  if (!isFile) return { reason: `#${fragment} on a folder` };
  if (!/\.md$/i.test(resolved)) return LINE_ANCHOR.test(fragment) ? null : { reason: `#${fragment} on a file that is not Markdown` };
  if (!anchorCache.has(resolved)) anchorCache.set(resolved, anchorsOf(fs.readFileSync(path.join(root, resolved), "utf8")));
  if (anchorCache.get(resolved).has(fragment)) return null;
  const lower = fragment.toLowerCase();
  const near = [...anchorCache.get(resolved)].find((anchor) => anchor === lower);
  return { reason: near ? `#${fragment} differs from the heading's anchor #${near} in case` : `${resolved} has no heading #${fragment}` };
}

/** Check every documentation file; returns the broken links and the external ones. */
export function checkDocumentation({ root = REPOSITORY_ROOT, tree = trackedTree(root), files = documentationFiles(tree) } = {}) {
  const anchorCache = new Map();
  const broken = [];
  const external = [];
  let checked = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const link of linksOf(text)) {
      checked += 1;
      const verdict = judgeLink(link, file, { tree, root, anchorCache });
      if (verdict?.external) external.push({ file, line: link.line, target: link.target });
      else if (verdict) broken.push({ file, line: link.line, target: link.target ?? `[${link.label}]`, reason: verdict.reason });
    }
  }
  return { files: files.length, checked, broken, external };
}

/** Ask each external link once; a 4xx/5xx or a failure to connect is reported, not thrown. */
export async function askExternal(links, { timeoutMs = 15_000 } = {}) {
  const answers = new Map();
  for (const target of new Set(links.map((link) => link.target))) {
    let answer;
    try {
      let response = await fetch(target, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 405 || response.status === 403) {
        response = await fetch(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      }
      answer = { status: response.status };
    } catch (error) {
      answer = { error: error?.cause?.code || error?.name || String(error) };
    }
    answers.set(target, answer);
  }
  return links.map((link) => ({ ...link, ...answers.get(link.target) }));
}

async function main(argv) {
  const result = checkDocumentation();
  const externalAnswers = argv.includes("--external") ? await askExternal(result.external) : null;
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...result, external: externalAnswers ?? result.external }, null, 2)}\n`);
  } else {
    for (const link of result.broken) process.stdout.write(`${link.file}:${link.line}: ${link.target} — ${link.reason}\n`);
    if (externalAnswers) {
      for (const link of externalAnswers.filter((answer) => answer.error || answer.status >= 400)) {
        process.stdout.write(`${link.file}:${link.line}: ${link.target} — external: ${link.error || `HTTP ${link.status}`}\n`);
      }
    }
    process.stdout.write(`${result.files} files, ${result.checked} links: ${result.broken.length} broken; `
      + `${result.external.length} external ${externalAnswers ? "asked" : "not asked (--external asks them)"}.\n`);
  }
  return result.broken.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
