/**
 * A person's own skills: the `custom` source of the skill catalog,
 * `<vault>/03-skills-catalog/sources/custom/<name>/SKILL.md`, the folder the
 * registry reads first. What comes with AI Dev — the seed's skills — lies
 * there too; what a person adds sits beside them, and a seed sync of the next
 * version leaves it alone.
 *
 * Three things a person does with them, from the terminal (`ai-dev skills`) or
 * the desktop app (the control tools `custom_skills_*`): add a folder that
 * holds a SKILL.md, start a new skill from a template, and remove one they
 * added. A skill that came with AI Dev is not removed: the next update would
 * put it back.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatBytes } from "./disk-space.mjs";
import { parseSkillFrontmatter } from "./skill-import-policy.mjs";

/** A skill's name: what its folder is called and what `read_skill` takes. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What an added folder may hold: enough for a skill with its references and scripts, not a repository. */
export const ADD_LIMITS = Object.freeze({ files: 500, bytes: 20 * 1024 * 1024 });

/** Folders an added skill never brings along. */
const LEFT_OUT = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".venv"]);

const DESCRIPTION_MAX = 1024;

/** The custom source's folder under the skill sources root. */
export function customSkillsRoot(sourcesRoot) {
  return path.join(sourcesRoot, "custom");
}

/**
 * The names of the skills the seed ships in the custom source, read from the
 * seed's manifest: those come with AI Dev and are not the person's to remove.
 *
 * @param {{ seedRoot?: string, manifestFile?: string }} where - `manifestFile` wins over `seedRoot`.
 * @returns {Promise<Set<string>>}
 */
export async function seedSkillNames({ seedRoot = "", manifestFile = seedRoot ? path.join(seedRoot, "public-seed.manifest.json") : "" } = {}) {
  const names = new Set();
  if (!manifestFile) return names;
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch {
    return names;
  }
  for (const file of manifest?.files ?? []) {
    const match = /^03-skills-catalog\/sources\/custom\/([^/]+)\/SKILL\.md$/.exec(String(file?.path ?? ""));
    if (match) names.add(match[1]);
  }
  return names;
}

/** A name as the registry takes it, or an error that says what a name may hold. */
function checkedName(name, what = "A skill's name") {
  const text = String(name ?? "").trim();
  if (!SKILL_NAME.test(text)) {
    throw new Error(`${what} must be 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit, not ${JSON.stringify(text)}.`);
  }
  return text;
}

/** One line of description: what the registry routes by. */
function checkedDescription(description) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("A skill needs a description: one sentence of what it does and when to use it. The registry routes by it.");
  if (text.length > DESCRIPTION_MAX) throw new Error(`A skill's description must be at most ${DESCRIPTION_MAX} characters, not ${text.length}.`);
  return text;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The skills in the custom source, each with where it came from.
 *
 * @param {{ root: string, seedNames?: Set<string> }} options
 * @returns {Promise<Array<{ name: string, description: string, folder: string, origin: "seed" | "yours" }>>}
 */
export async function listCustomSkills({ root, seedNames = new Set() }) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const skills = [];
  for (const entry of entries) {
    // A hidden folder is a skill being added or removed, never one to list.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = path.join(root, entry.name);
    let text;
    try {
      text = await fs.readFile(path.join(folder, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(text.replace(/^﻿/, ""), entry.name);
    skills.push({ name: entry.name, description: meta.description, folder, origin: seedNames.has(entry.name) ? "seed" : "yours" });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Everything under `source` an added skill takes: regular files and folders,
 * the left-out folders and every link skipped, within {@link ADD_LIMITS}.
 */
async function collectFiles(source, limits) {
  const files = [];
  const skipped = [];
  let bytes = 0;
  const walk = async (folder, relative) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const inside = relative ? `${relative}/${entry.name}` : entry.name;
      if (LEFT_OUT.has(entry.name)) {
        skipped.push(inside);
        continue;
      }
      const full = path.join(folder, entry.name);
      // A link could lead out of the folder: an added skill is the files that are in it.
      if (entry.isSymbolicLink()) {
        skipped.push(inside);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, inside);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(inside);
        continue;
      }
      const stat = await fs.stat(full);
      bytes += stat.size;
      files.push({ relative: inside, full, bytes: stat.size });
      if (files.length > limits.files) throw new Error(`${source} holds more than ${limits.files} files: a skill is a SKILL.md with its references, not a repository. Add the skill's own folder.`);
      if (bytes > limits.bytes) throw new Error(`${source} holds more than ${formatBytes(limits.bytes)}: a skill is a SKILL.md with its references, not a repository. Add the skill's own folder.`);
    }
  };
  await walk(source, "");
  return { files, skipped, bytes };
}

/**
 * Put a finished folder in place of `target`, which must not be there unless
 * `replace`: the copy is made beside it first, so a reader never sees half a skill.
 */
async function placeFolder(staged, target, replace) {
  if (!replace) {
    await fs.rename(staged, target);
    return;
  }
  // Hidden, as a removal's is: a folder left by a crash is never read as a second skill.
  const aside = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.old`);
  await fs.rename(target, aside);
  try {
    await fs.rename(staged, target);
  } catch (error) {
    await fs.rename(aside, target).catch(() => {});
    throw error;
  }
  // The skill is replaced by now: an old copy that will not go (EBUSY on Windows) is no failure of it.
  await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
}

/**
 * The SKILL.md text with its frontmatter's `name:` set to `name`, added when
 * it has none: the registry knows a skill by that line, not by its folder.
 */
function withName(text, name) {
  return text.replace(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---)/, (whole, open, inside, close) => /^name:/m.test(inside)
    ? `${open}${inside.replace(/^name:.*$/m, `name: ${name}`)}${close}`
    : `${open}name: ${name}\n${inside}${close}`);
}

/**
 * Add a skill from a folder that holds a SKILL.md — or from the SKILL.md
 * itself — copied into the custom source under the name its frontmatter gives
 * (the folder's when it gives none, or `name` when the caller names it).
 *
 * @param {{ root: string, source: string, name?: string, replace?: boolean, seedNames?: Set<string>, limits?: { files: number, bytes: number } }} options
 *   `replace`: a skill of that name the person added before is replaced; one that came with AI Dev never is.
 * @returns {Promise<{ name: string, description: string, folder: string, files: number, bytes: number, skipped: string[], replaced: boolean }>}
 */
export async function addCustomSkill({ root, source, name, replace = false, seedNames = new Set(), limits = ADD_LIMITS }) {
  const given = path.resolve(String(source ?? ""));
  const stat = await lstatOrNull(given);
  if (!stat) throw new Error(`${given} is not there.`);
  const folder = stat.isFile() && path.basename(given) === "SKILL.md" ? path.dirname(given) : given;
  if (!(stat.isDirectory() || folder !== given)) throw new Error(`${given} is neither a folder nor a SKILL.md: a skill is a folder that holds one.`);
  let text;
  try {
    text = await fs.readFile(path.join(folder, "SKILL.md"), "utf8");
  } catch {
    throw new Error(`${folder} holds no SKILL.md: a skill is a folder with a SKILL.md that starts with its name and description.`);
  }
  text = text.replace(/^﻿/, "");
  const meta = parseSkillFrontmatter(text, path.basename(folder));
  const skillName = checkedName(name || meta.name, name ? "The name given" : "The skill's name (its SKILL.md's, or its folder's)");
  checkedDescription(meta.description);
  // A name given is the one the registry must know it by: its SKILL.md says so too.
  if (skillName !== meta.name) text = withName(text, skillName);
  if (parseSkillFrontmatter(text, skillName).name !== skillName) throw new Error(`${folder}/SKILL.md has a frontmatter the name ${skillName} cannot be written into: give it a \`name:\` line.`);
  const resolvedRoot = path.resolve(root);
  if (folder === path.join(resolvedRoot, skillName)) throw new Error(`${folder} is already the skill ${skillName}.`);
  const target = path.join(resolvedRoot, skillName);
  const existing = await lstatOrNull(target);
  if (seedNames.has(skillName)) throw new Error(`${skillName} comes with AI Dev, and the next update would put it back. Give yours another name.`);
  if (existing && !replace) throw new Error(`There is a skill ${skillName} already. Replace it, or give yours another name.`);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error(`${target} is not a skill's folder: move it away first.`);
  const collected = await collectFiles(folder, limits);
  // The SKILL.md is written from the text read above, a link's (as dotfile managers keep it) too.
  const files = collected.files.filter((file) => file.relative !== "SKILL.md");
  const skipped = collected.skipped.filter((relative) => relative !== "SKILL.md");
  const bytes = files.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(text));
  await fs.mkdir(resolvedRoot, { recursive: true });
  const staged = path.join(resolvedRoot, `.${skillName}.${randomUUID()}.adding`);
  try {
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "SKILL.md"), text, { encoding: "utf8", flag: "wx" });
    for (const file of files) {
      const destination = path.join(staged, ...file.relative.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(file.full, destination);
    }
    await placeFolder(staged, target, Boolean(existing));
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true });
    throw error;
  }
  return { name: skillName, description: checkedDescription(meta.description), folder: target, files: files.length + 1, bytes, skipped, replaced: Boolean(existing) };
}

/**
 * A new skill's SKILL.md: the frontmatter the registry reads and the sections a
 * good skill has — a workflow of steps, its constraints, how it is verified —
 * so that a skill just started passes the structure check the health check
 * holds every skill of yours to. Each line says what
 * to write there.
 */
export function skillTemplate(name, description) {
  const title = name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## When to use",
    "",
    "- The situation this skill is for, in the words a request would use.",
    "- What it is not for, when a neighbouring skill fits better.",
    "",
    "## Workflow",
    "",
    "1. Read the request and the files it names; confirm what done means before changing anything.",
    "2. Implement the smallest change that meets the request, one step at a time.",
    "3. Run the project's checks — its tests, its linter — and read what they print.",
    "4. Report what changed and the evidence that it works.",
    "",
    "## Constraints",
    "",
    "- Do not change what the request does not ask for.",
    "- Never report a check that did not run, or a result nobody saw.",
    "",
    "## Verification",
    "",
    "- The evidence that shows the work is finished: the command that was run and what it printed.",
    ""
  ].join("\n");
}

/**
 * Start a new skill from {@link skillTemplate}.
 *
 * @param {{ root: string, name: string, description: string }} options
 * @returns {Promise<{ name: string, description: string, folder: string, file: string }>}
 */
export async function createCustomSkill({ root, name, description }) {
  const skillName = checkedName(name);
  const text = checkedDescription(description);
  const target = path.join(path.resolve(root), skillName);
  if (await lstatOrNull(target)) throw new Error(`There is a skill ${skillName} already. Give the new one another name.`);
  await fs.mkdir(path.resolve(root), { recursive: true });
  const staged = path.join(path.resolve(root), `.${skillName}.${randomUUID()}.adding`);
  try {
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "SKILL.md"), skillTemplate(skillName, text), { encoding: "utf8", flag: "wx" });
    await fs.rename(staged, target);
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true });
    throw error;
  }
  return { name: skillName, description: text, folder: target, file: path.join(target, "SKILL.md") };
}

/**
 * Remove a skill the person added. One that came with AI Dev is refused, and
 * so is anything that is not a skill's own folder in the custom source.
 *
 * @param {{ root: string, name: string, seedNames?: Set<string> }} options
 * @returns {Promise<{ name: string, folder: string }>}
 */
export async function removeCustomSkill({ root, name, seedNames = new Set() }) {
  const skillName = checkedName(name);
  if (seedNames.has(skillName)) throw new Error(`${skillName} comes with AI Dev, and the next update would put it back: it is not removed.`);
  const target = path.join(path.resolve(root), skillName);
  const stat = await lstatOrNull(target);
  if (!stat) throw new Error(`There is no skill ${skillName} of yours. \`ai-dev skills mine\` lists them.`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${target} is not a skill's folder: it is left as it is.`);
  if (!await lstatOrNull(path.join(target, "SKILL.md"))) throw new Error(`${target} holds no SKILL.md: it is not a skill, and it is left as it is.`);
  // Moved aside first: the registry never reads half a folder.
  const aside = path.join(path.resolve(root), `.${skillName}.${randomUUID()}.removing`);
  await fs.rename(target, aside);
  await fs.rm(aside, { recursive: true, force: true });
  return { name: skillName, folder: target };
}
