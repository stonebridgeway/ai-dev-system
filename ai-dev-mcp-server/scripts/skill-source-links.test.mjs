/**
 * The README links to the repositories the imported skills came from, and
 * THIRD_PARTY_NOTICES.md is where those repositories are actually recorded.
 * They were written at different times by different hands, and they drifted:
 * the notices credit `Leonxlnx/taste-skill`, while both READMEs linked
 * `tt-a1i/taste-skill`, which does not exist — a broken link shipped to every
 * reader of the front page.
 *
 * So the notices file is the single list of sources, and a GitHub link in a
 * README has to be on it. A link to something that is not a skill source has
 * no place in these files' source paragraphs; if one is ever needed, it goes in
 * the notices too rather than being excused here.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const READMES = ["README.md", "README.ru.md"];
const NOTICES = "THIRD_PARTY_NOTICES.md";
/** The project's own repository: its releases and issues, not an imported source. */
const OWN = "stonebridgeway/ai-dev-system";

/** Every `https://github.com/<owner>/<repo>` in this text, trailing punctuation dropped. */
function githubRepositories(text) {
  return [...text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g)]
    .map((match) => `${match[1]}/${match[2].replace(/\.git$/, "")}`);
}

async function readRepositoryFile(relativePath) {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("every repository the README links is one THIRD_PARTY_NOTICES.md records as a source", async () => {
  const notices = await readRepositoryFile(NOTICES);
  const sources = new Set(
    notices
      .split(/\r?\n/)
      .filter((line) => /^\s*[-*]\s*Source:/.test(line))
      .flatMap(githubRepositories)
  );
  assert.ok(sources.size >= 5, `THIRD_PARTY_NOTICES.md lists ${sources.size} GitHub source(s); the parser is reading the wrong lines.`);

  for (const readme of READMES) {
    const linked = new Set(githubRepositories(await readRepositoryFile(readme)).filter((repository) => repository.toLowerCase() !== OWN));
    assert.ok(linked.size > 0, `${readme} links no repository at all; the parser is reading the wrong file.`);
    for (const repository of linked) {
      assert.ok(
        sources.has(repository),
        `${readme} links https://github.com/${repository}, which no "- Source:" line of ${NOTICES} names. `
          + `Either the link is wrong or the import is unrecorded; the notices file decides.`
      );
    }
  }
});

test("both READMEs credit the same repositories", async () => {
  const [english, russian] = await Promise.all(READMES.map(async (readme) => (
    [...new Set(githubRepositories(await readRepositoryFile(readme)))].sort()
  )));
  assert.deepEqual(english, russian, "the two READMEs link different repositories");
});
