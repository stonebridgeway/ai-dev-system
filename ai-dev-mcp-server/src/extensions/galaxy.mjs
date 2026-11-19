/**
 * `render_knowledge_galaxy`: the vault as a galaxy you can fly through.
 *
 * The I/O around `src/core/galaxy.mjs`: bring the search index up to date, read
 * what the galaxy is drawn from out of it (`src/core/galaxy-export.mjs`), compose
 * the model, inline the viewer (`src/galaxy/`) and write one HTML file into the
 * vault. The file opens from disk in any browser with WebGL and makes no
 * request of any kind.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GALAXY_OUTPUT_PATH,
  GALAXY_SCOPES,
  composeGalaxy,
  parseGalaxyExport
} from "../core/galaxy.mjs";
import { inlineModules, renderGalaxyPage } from "../core/galaxy-page.mjs";

/** The viewer's modules, each after the ones it imports. */
export const GALAXY_VIEWER_FILES = Object.freeze([
  "galaxy-math.mjs",
  "galaxy-text.mjs",
  "galaxy-gl.mjs",
  "galaxy-panels.mjs",
  "galaxy-labels.mjs",
  "galaxy-client.mjs"
]);

/** The viewer as the one module the page runs. */
export async function readGalaxyViewer() {
  const modules = await Promise.all(GALAXY_VIEWER_FILES.map(async (name) => ({
    name,
    source: await fs.readFile(new URL(`../galaxy/${name}`, import.meta.url), "utf8")
  })));
  return inlineModules(modules);
}

/**
 * @param {object} host
 * @param {{ scopes?: string[], neighbors?: number, refresh_index?: boolean, obsidian_vault?: string, seed?: number }} [args]
 */
async function renderKnowledgeGalaxy(host, args = {}) {
  const started = Date.now();
  const refresh = args.refresh_index === false
    ? { action: "skipped" }
    : await host.search.ensureFresh();

  const exported = parseGalaxyExport(await host.search.exportGalaxy());

  const vault = path.basename(path.resolve(host.vaultRoot));
  const obsidianVault = typeof args.obsidian_vault === "string" && args.obsidian_vault.trim()
    ? args.obsidian_vault.trim()
    : vault;
  const { model, summary } = composeGalaxy(exported, {
    scopes: Array.isArray(args.scopes) ? args.scopes : [],
    neighbors: args.neighbors,
    seed: Number.isInteger(args.seed) ? args.seed : 1,
    meta: {
      title: "Knowledge Galaxy",
      vault,
      obsidian_vault: obsidianVault,
      generated_at: new Date().toISOString()
    }
  });
  const { html, bytes } = renderGalaxyPage({ model, clientSource: await readGalaxyViewer() });
  await host.writeText(GALAXY_OUTPUT_PATH, html);
  const target = host.safePath(GALAXY_OUTPUT_PATH);

  return {
    status: "written",
    path: target,
    vault_path: GALAXY_OUTPUT_PATH,
    url: pathToFileURL(target).href,
    bytes,
    index: refresh.action,
    ...summary,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    next_step: "Open the file in a browser. WASD to fly, drag to look, H for the full keymap."
  };
}

export function createGalaxyTools(host) {
  return {
    definitions: [
      {
        name: "render_knowledge_galaxy",
        description: [
          "Render the vault as a 3D galaxy you can fly through, in place of Obsidian's graph view:",
          "every note and skill is a star placed next to its nearest neighbours in meaning (BGE-M3 vectors",
          "where the index has them, keyword vectors otherwise), wikilinks are drawn as brighter lines, and",
          "communities become named, coloured constellations. Writes one self-contained HTML file",
          `(${GALAXY_OUTPUT_PATH}) that opens offline and makes no network request.`
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            scopes: {
              type: "array",
              items: { type: "string", enum: [...GALAXY_SCOPES] },
              description: "Only these kinds of document. Default: all of them."
            },
            neighbors: {
              type: "integer",
              minimum: 3,
              maximum: 24,
              default: 8,
              description: "Nearest neighbours each document is tied to. More gives denser, rounder clusters."
            },
            refresh_index: {
              type: "boolean",
              default: true,
              description: "Rebuild the search index first if the vault changed since it was built."
            },
            obsidian_vault: {
              type: "string",
              description: "Vault name for the page's obsidian:// links. Default: the vault folder's name."
            },
            seed: {
              type: "integer",
              default: 1,
              description: "Layout seed. The same vault and seed give the same galaxy."
            }
          }
        }
      }
    ],
    handlers: {
      render_knowledge_galaxy: (args) => renderKnowledgeGalaxy(host, args)
    }
  };
}
