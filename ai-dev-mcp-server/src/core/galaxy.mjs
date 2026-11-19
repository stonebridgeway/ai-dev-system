/**
 * The Knowledge Galaxy from end to end, minus the files: an index export in,
 * the page's data model out.
 *
 *   export ─ parseGalaxyExport ─ selectGalaxyDocuments ─ buildGalaxyGraph
 *          ─ detectCommunities / labelCommunities ─ layoutGalaxy ─ buildGalaxyModel
 *
 * `src/extensions/galaxy.mjs` does the I/O around it: freshening the index,
 * running the export, reading the viewer, writing the page.
 */
import { DEFAULT_NEIGHBORS, EDGE_LINK, buildGalaxyGraph } from "./galaxy-graph.mjs";
import { detectCommunities, labelCommunities } from "./galaxy-clusters.mjs";
import { layoutGalaxy } from "./galaxy-layout.mjs";
import { buildGalaxyModel } from "./galaxy-page.mjs";

/** The export format this module reads (`galaxy-export.mjs`). */
export const GALAXY_EXPORT_SCHEMA = 1;

/** The scopes the search index sorts documents into. */
export const GALAXY_SCOPES = Object.freeze(["knowledge", "skills", "workflows", "quality", "projects"]);

/**
 * Most documents one galaxy is built from. The neighbour search is quadratic:
 * on a 2.1 GHz Xeon 10,000 documents took 30 s and 20,000 took 94 s, and past
 * that a scope filter is the better answer than a longer wait.
 */
export const MAX_GALAXY_DOCUMENTS = 20000;

/** Where the page is written, relative to the vault. */
export const GALAXY_OUTPUT_PATH = "01-system/Knowledge Galaxy.html";

/** A copy of raw little-endian float32 bytes, aligned for a Float32Array. */
function floats(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (view.byteLength % 4 !== 0) throw new Error(`Vector file is ${view.byteLength} bytes, not a whole number of float32 values.`);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Float32Array(copy.buffer);
}

/**
 * Check an export and turn its files into arrays.
 *
 * @param {{ manifest: object, semanticBytes: Uint8Array, denseBytes?: Uint8Array }} input
 * @returns {{ nodes: object[], semantic: Float32Array, semanticDimensions: number, dense: Float32Array, denseDimensions: number, denseModel: string }}
 */
export function parseGalaxyExport({ manifest, semanticBytes, denseBytes }) {
  if (!manifest || manifest.schema !== GALAXY_EXPORT_SCHEMA) {
    throw new Error(`Galaxy export schema ${manifest?.schema ?? "missing"} is not ${GALAXY_EXPORT_SCHEMA}; the export and the renderer disagree.`);
  }
  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
  const semanticDimensions = Number(manifest.semantic_dimensions) || 0;
  const semantic = floats(semanticBytes);
  if (semantic.length !== nodes.length * semanticDimensions) {
    throw new Error(`Galaxy export has ${semantic.length} semantic values for ${nodes.length} documents of ${semanticDimensions}.`);
  }
  const denseDimensions = Number(manifest.dense_dimensions) || 0;
  const dense = denseDimensions ? floats(denseBytes) : new Float32Array(0);
  const denseRows = Number(manifest.dense_documents) || 0;
  if (denseDimensions && dense.length !== denseRows * denseDimensions) {
    throw new Error(`Galaxy export has ${dense.length} dense values for ${denseRows} vectors of ${denseDimensions}.`);
  }
  return { nodes, semantic, semanticDimensions, dense, denseDimensions, denseModel: String(manifest.dense_model || "") };
}

/**
 * The documents a galaxy is drawn from. Each keeps its row in the export's
 * semantic matrix, so filtering never copies the vectors.
 *
 * @param {object[]} nodes
 * @param {{ scopes?: string[] }} [options]
 * @returns {object[]}
 */
export function selectGalaxyDocuments(nodes, { scopes = [] } = {}) {
  const wanted = new Set((scopes ?? []).map((scope) => String(scope).trim().toLowerCase()).filter(Boolean));
  const unknown = [...wanted].filter((scope) => !GALAXY_SCOPES.includes(scope));
  if (unknown.length) throw new Error(`Unknown scope: ${unknown.join(", ")}. Use ${GALAXY_SCOPES.join(", ")}.`);
  const chosen = nodes
    .map((node, index) => ({ ...node, semantic: index }))
    .filter((node) => !wanted.size || wanted.has(String(node.scope || "").toLowerCase()));
  if (chosen.length > MAX_GALAXY_DOCUMENTS) {
    throw new Error(
      `${chosen.length} documents is more than one galaxy draws (${MAX_GALAXY_DOCUMENTS}). `
      + `Narrow it with scopes, e.g. ["knowledge", "workflows"].`
    );
  }
  return chosen;
}

/**
 * Build the galaxy's data model.
 *
 * @param {ReturnType<typeof parseGalaxyExport>} exported
 * @param {{ scopes?: string[], neighbors?: number, seed?: number, iterations?: number, meta?: object, clock?: () => number }} [options]
 * @returns {{ model: object, summary: object }}
 */
export function composeGalaxy(exported, {
  scopes = [],
  neighbors = DEFAULT_NEIGHBORS,
  seed = 1,
  iterations,
  meta = {},
  clock = Date.now
} = {}) {
  const timings = {};
  let mark = clock();
  const lap = (name) => {
    const now = clock();
    timings[name] = now - mark;
    mark = now;
  };
  const nodes = selectGalaxyDocuments(exported.nodes, { scopes });
  if (!nodes.length) throw new Error("No documents to draw: the index is empty or the scopes matched nothing.");

  const graph = buildGalaxyGraph({
    nodes,
    semantic: exported.semantic,
    semanticDimensions: exported.semanticDimensions,
    dense: exported.dense,
    denseDimensions: exported.denseDimensions,
    neighbors,
    seed
  });
  lap("graph_ms");

  // A wikilink is a deliberate tie, so it counts as a fair similarity for
  // clustering even when the two notes read differently.
  const community = detectCommunities(nodes.length, graph.edges, {
    seed,
    weightOf: (e) => (graph.edges.kind[e] === EDGE_LINK ? Math.max(graph.edges.weight[e], 0.3) : graph.edges.weight[e])
  });
  const clusters = labelCommunities(nodes, community);
  lap("clusters_ms");

  const { positions, iterations: steps } = layoutGalaxy({
    count: nodes.length,
    edges: graph.edges,
    seedPositions: graph.seedPositions,
    community,
    seed,
    options: { iterations: iterations ?? (nodes.length > 8000 ? 200 : 300) }
  });
  lap("layout_ms");

  const named = clusters.filter((cluster) => cluster.label && cluster.size >= 5).length;
  const counts = {
    documents: nodes.length,
    ...graph.counts,
    constellations: clusters.filter((cluster) => cluster.size >= 5).length,
    named_constellations: named
  };
  const model = buildGalaxyModel({
    nodes,
    edges: graph.edges,
    positions,
    community,
    clusters,
    meta: { ...meta, space: graph.space, counts }
  });
  return {
    model,
    summary: {
      ...counts,
      space: graph.space,
      dense_model: graph.space === "sparse" ? "" : exported.denseModel,
      layout_iterations: steps,
      largest_constellations: clusters.slice(0, 8).map((cluster) => ({ label: cluster.label, size: cluster.size })),
      timings
    }
  };
}
