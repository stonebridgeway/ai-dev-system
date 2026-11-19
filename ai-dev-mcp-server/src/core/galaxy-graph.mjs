/**
 * The Knowledge Galaxy's graph: which notes sit next to which in meaning.
 *
 * Obsidian's graph view places a note by its links alone, so a note nobody
 * links to drifts into the outer ring however relevant it is — in a vault of
 * generated catalogs most notes end up there. The galaxy places notes the way
 * a word2vec galaxy places words: every document is joined to its nearest
 * neighbours in embedding space, and a force layout (`galaxy-layout.mjs`) turns
 * those neighbourhoods into clusters of stars. Wikilinks are kept as a second,
 * explicit kind of edge, so nothing Obsidian showed is lost.
 *
 * Two spaces can be present. The BGE-M3 vectors (`dense`) are the better one
 * and are used for every document that has one; the hashed sparse vectors the
 * index keeps for every document (`semantic`) place the rest, weighted by
 * inverse document frequency so a term every note shares does not pull them
 * all together.
 *
 * Exact neighbours in 1024 dimensions cost N² × 1024 multiply-adds, which is a
 * minute for a large vault. Each space is projected onto its principal
 * subspace first (a randomised range finder, one power step), the search there
 * picks a candidate pool, and only the pool is scored exactly. On the public
 * seed (3,291 documents once skill cards fold into their skills) the
 * projection alone kept 53% of the true eight neighbours at 96 dimensions; the
 * pool re-scored exactly keeps 88%, for a tenth of the exact search's time.
 *
 * Everything here is pure and seeded: the same vault gives the same galaxy.
 */

/** Neighbours each document is joined to, unless the caller asks otherwise. */
export const DEFAULT_NEIGHBORS = 8;

/** Width of the principal subspace the candidate search runs in. */
export const REDUCED_DIMENSIONS = 96;

/** Candidates per document the subspace search hands to the exact scoring. */
export const CANDIDATE_POOL = 64;

/** Least weight inverse document frequency gives a feature. */
const IDF_FLOOR = 0.05;

/** Below this cosine a "neighbour" is noise, and no edge is drawn to it. */
export const MIN_SIMILARITY = 0.05;

/** Edge kinds, as stored in `edges.kind`. */
export const EDGE_SEMANTIC = 1;
export const EDGE_LINK = 2;

/**
 * A small, fast, seedable generator (mulberry32).
 *
 * @param {number} seed
 * @returns {() => number} Uniform in [0, 1).
 */
export function seededRandom(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample (Box–Muller). */
function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * Copy the chosen rows, optionally reweighted by inverse document frequency,
 * and scale each to unit length.
 *
 * @param {Float32Array} data - Row-major, `dims` wide.
 * @param {number} dims
 * @param {Int32Array | number[]} rows - Which rows to take, in output order.
 * @param {{ idf?: boolean }} [options]
 * @returns {{ data: Float32Array, present: Uint8Array }} `present[i]` is 0 for an all-zero row.
 */
export function normalizeRows(data, dims, rows, { idf = false } = {}) {
  const count = rows.length;
  const out = new Float32Array(count * dims);
  const present = new Uint8Array(count);
  let weights = null;
  if (idf) {
    const frequency = new Float64Array(dims);
    for (let i = 0; i < count; i += 1) {
      const base = rows[i] * dims;
      for (let d = 0; d < dims; d += 1) if (data[base + d] !== 0) frequency[d] += 1;
    }
    // A feature every document carries is quietened, not zeroed: a plain
    // log(N / df) would erase a document made only of those. The floor is
    // small on purpose — a smoothed log(1 + N / df) keeps shared terms loud
    // enough that near-identical documents all tie, and on the public seed it
    // cut the neighbour recall from 88% to 64%.
    weights = new Float64Array(dims);
    for (let d = 0; d < dims; d += 1) weights[d] = Math.max(Math.log((count + 1) / (frequency[d] + 1)), IDF_FLOOR);
  }
  for (let i = 0; i < count; i += 1) {
    const source = rows[i] * dims;
    const target = i * dims;
    let norm = 0;
    for (let d = 0; d < dims; d += 1) {
      const value = weights ? data[source + d] * weights[d] : data[source + d];
      out[target + d] = value;
      norm += value * value;
    }
    if (norm > 0) {
      present[i] = 1;
      const scale = 1 / Math.sqrt(norm);
      for (let d = 0; d < dims; d += 1) out[target + d] *= scale;
    }
  }
  return { data: out, present };
}

/** Column means of a row-major matrix. */
function columnMeans(data, rows, dims) {
  const mean = new Float64Array(dims);
  for (let i = 0; i < rows; i += 1) {
    const base = i * dims;
    for (let d = 0; d < dims; d += 1) mean[d] += data[base + d];
  }
  for (let d = 0; d < dims; d += 1) mean[d] /= Math.max(rows, 1);
  return mean;
}

/** (X − 1μᵀ) B for X rows × dims and B dims × width. Zero entries of X are skipped. */
function multiplyCentered(data, rows, dims, mean, basis, width) {
  const out = new Float64Array(rows * width);
  const meanTerm = new Float64Array(width);
  for (let d = 0; d < dims; d += 1) {
    const m = mean[d];
    if (m === 0) continue;
    for (let j = 0; j < width; j += 1) meanTerm[j] += m * basis[d * width + j];
  }
  for (let i = 0; i < rows; i += 1) {
    const base = i * dims;
    const target = i * width;
    for (let d = 0; d < dims; d += 1) {
      const value = data[base + d];
      if (value === 0) continue;
      const row = d * width;
      for (let j = 0; j < width; j += 1) out[target + j] += value * basis[row + j];
    }
    for (let j = 0; j < width; j += 1) out[target + j] -= meanTerm[j];
  }
  return out;
}

/** (X − 1μᵀ)ᵀ Y for Y rows × width. */
function multiplyCenteredTransposed(data, rows, dims, mean, matrix, width) {
  const out = new Float64Array(dims * width);
  const columnSums = new Float64Array(width);
  for (let i = 0; i < rows; i += 1) {
    const base = i * dims;
    const source = i * width;
    for (let j = 0; j < width; j += 1) columnSums[j] += matrix[source + j];
    for (let d = 0; d < dims; d += 1) {
      const value = data[base + d];
      if (value === 0) continue;
      const target = d * width;
      for (let j = 0; j < width; j += 1) out[target + j] += value * matrix[source + j];
    }
  }
  for (let d = 0; d < dims; d += 1) {
    const m = mean[d];
    if (m === 0) continue;
    for (let j = 0; j < width; j += 1) out[d * width + j] -= m * columnSums[j];
  }
  return out;
}

/** Orthonormalise the columns of a rows × width matrix in place (modified Gram–Schmidt). */
function orthonormalizeColumns(matrix, rows, width) {
  for (let j = 0; j < width; j += 1) {
    for (let k = 0; k < j; k += 1) {
      let dot = 0;
      for (let i = 0; i < rows; i += 1) dot += matrix[i * width + j] * matrix[i * width + k];
      for (let i = 0; i < rows; i += 1) matrix[i * width + j] -= dot * matrix[i * width + k];
    }
    let norm = 0;
    for (let i = 0; i < rows; i += 1) norm += matrix[i * width + j] ** 2;
    const scale = norm > 1e-20 ? 1 / Math.sqrt(norm) : 0;
    for (let i = 0; i < rows; i += 1) matrix[i * width + j] *= scale;
  }
  return matrix;
}

/**
 * Project unit rows onto their principal subspace and re-normalise, so that a
 * dot product in the result approximates the cosine in the original space.
 *
 * @param {Float32Array} data - Unit rows, `dims` wide.
 * @param {number} rows
 * @param {number} dims
 * @param {{ target?: number, random?: () => number, powerIterations?: number }} [options]
 * @returns {{ data: Float32Array, dims: number }}
 */
export function projectToSubspace(data, rows, dims, { target = REDUCED_DIMENSIONS, random = seededRandom(1), powerIterations = 1 } = {}) {
  const width = Math.max(1, Math.min(target, dims, rows));
  if (width >= dims) return { data: Float32Array.from(data), dims };
  const mean = columnMeans(data, rows, dims);
  let basis = new Float64Array(dims * width);
  for (let index = 0; index < basis.length; index += 1) basis[index] = gaussian(random);
  orthonormalizeColumns(basis, dims, width);
  for (let step = 0; step <= powerIterations; step += 1) {
    const sample = multiplyCentered(data, rows, dims, mean, basis, width);
    basis = orthonormalizeColumns(multiplyCenteredTransposed(data, rows, dims, mean, sample, width), dims, width);
  }
  const projected = multiplyCentered(data, rows, dims, mean, basis, width);
  const out = new Float32Array(rows * width);
  for (let i = 0; i < rows; i += 1) {
    let norm = 0;
    for (let j = 0; j < width; j += 1) norm += projected[i * width + j] ** 2;
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let j = 0; j < width; j += 1) out[i * width + j] = projected[i * width + j] * scale;
  }
  return { data: out, dims: width };
}

/**
 * The k most similar candidates of every query row, by dot product.
 *
 * @param {Float32Array} data - Unit rows, `dims` wide.
 * @param {number} dims
 * @param {{ queries: number[], candidates: number[], k: number, minSimilarity?: number }} options
 *   Row indices into `data`. A row is never its own neighbour.
 * @returns {Array<Array<{ index: number, similarity: number }>>} One list per query, best first.
 */
export function nearestNeighbors(data, dims, { queries, candidates, k, minSimilarity = MIN_SIMILARITY }) {
  const limit = Math.max(1, Math.floor(k));
  const bestIndex = new Int32Array(limit);
  const bestScore = new Float64Array(limit);
  const results = [];
  for (const query of queries) {
    let size = 0;
    const base = query * dims;
    for (const candidate of candidates) {
      if (candidate === query) continue;
      const other = candidate * dims;
      let score = 0;
      for (let d = 0; d < dims; d += 1) score += data[base + d] * data[other + d];
      if (score < minSimilarity) continue;
      if (size === limit && score <= bestScore[size - 1]) continue;
      // Insertion into a short sorted list beats a heap at these sizes.
      let position = size < limit ? size : limit - 1;
      while (position > 0 && bestScore[position - 1] < score) {
        bestScore[position] = bestScore[position - 1];
        bestIndex[position] = bestIndex[position - 1];
        position -= 1;
      }
      bestScore[position] = score;
      bestIndex[position] = candidate;
      if (size < limit) size += 1;
    }
    const row = [];
    for (let slot = 0; slot < size; slot += 1) row.push({ index: bestIndex[slot], similarity: bestScore[slot] });
    results.push(row);
  }
  return results;
}

/**
 * The first three principal axes of unit rows, as coordinates with unit
 * variance: a starting shape for the force layout that already has the
 * vault's large-scale structure, so the layout only has to refine it.
 *
 * @param {Float32Array} data
 * @param {number} rows
 * @param {number} dims
 * @returns {Float32Array} rows × 3
 */
export function principalCoordinates(data, rows, dims) {
  const mean = columnMeans(data, rows, dims);
  const covariance = new Float64Array(dims * dims);
  for (let i = 0; i < rows; i += 1) {
    const base = i * dims;
    for (let a = 0; a < dims; a += 1) {
      const va = data[base + a] - mean[a];
      if (va === 0) continue;
      for (let b = a; b < dims; b += 1) covariance[a * dims + b] += va * (data[base + b] - mean[b]);
    }
  }
  for (let a = 0; a < dims; a += 1) for (let b = 0; b < a; b += 1) covariance[a * dims + b] = covariance[b * dims + a];

  const axes = [];
  const random = seededRandom(7);
  for (let axis = 0; axis < 3; axis += 1) {
    let vector = new Float64Array(dims);
    for (let d = 0; d < dims; d += 1) vector[d] = random() - 0.5;
    for (let step = 0; step < 60; step += 1) {
      const next = new Float64Array(dims);
      for (let a = 0; a < dims; a += 1) {
        let sum = 0;
        for (let b = 0; b < dims; b += 1) sum += covariance[a * dims + b] * vector[b];
        next[a] = sum;
      }
      // Deflate against the axes already found.
      for (const previous of axes) {
        let dot = 0;
        for (let d = 0; d < dims; d += 1) dot += next[d] * previous[d];
        for (let d = 0; d < dims; d += 1) next[d] -= dot * previous[d];
      }
      let norm = 0;
      for (let d = 0; d < dims; d += 1) norm += next[d] ** 2;
      if (norm < 1e-24) break;
      const scale = 1 / Math.sqrt(norm);
      for (let d = 0; d < dims; d += 1) next[d] *= scale;
      vector = next;
    }
    axes.push(vector);
  }

  const coordinates = new Float32Array(rows * 3);
  for (let axis = 0; axis < 3; axis += 1) {
    let sumSquares = 0;
    for (let i = 0; i < rows; i += 1) {
      let value = 0;
      for (let d = 0; d < dims; d += 1) value += (data[i * dims + d] - mean[d]) * axes[axis][d];
      coordinates[i * 3 + axis] = value;
      sumSquares += value * value;
    }
    const deviation = Math.sqrt(sumSquares / Math.max(rows, 1));
    if (deviation > 0) for (let i = 0; i < rows; i += 1) coordinates[i * 3 + axis] /= deviation;
  }
  return coordinates;
}

/** How a wikilink target is looked up: its last path segment, without `.md`, lowercased. */
export function linkKey(value) {
  const segment = String(value || "").trim().replaceAll("\\", "/").split("/").pop() || "";
  return segment.replace(/\.md$/i, "").trim().toLowerCase();
}

/**
 * Resolve every note's wikilinks to node indices, the way Obsidian does for an
 * unambiguous name: by file name first, then by title.
 *
 * @param {Array<{ path: string, title: string, links?: string[] }>} nodes
 * @returns {{ pairs: Array<[number, number]>, unresolved: number }} Distinct
 *   pairs, source first, no self-links; and how many link targets named nothing.
 */
export function resolveWikilinks(nodes) {
  const byFile = new Map();
  const byTitle = new Map();
  nodes.forEach((node, index) => {
    const file = linkKey(node.path);
    if (file && !byFile.has(file)) byFile.set(file, index);
    const title = String(node.title || "").trim().toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, index);
  });
  const pairs = [];
  const seen = new Set();
  let unresolved = 0;
  nodes.forEach((node, source) => {
    for (const link of node.links ?? []) {
      const key = linkKey(link);
      const target = byFile.get(key) ?? byTitle.get(key);
      if (target === undefined) unresolved += 1;
      if (target === undefined || target === source) continue;
      const id = source < target ? `${source}:${target}` : `${target}:${source}`;
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push([source, target]);
    }
  });
  return { pairs, unresolved };
}

/**
 * Collect undirected edges, keeping the strongest similarity for a pair and
 * marking a pair that is both a neighbour and a link as a link.
 */
class EdgeSet {
  constructor() {
    this.index = new Map();
    this.source = [];
    this.target = [];
    this.weight = [];
    this.kind = [];
  }

  add(a, b, weight, kind) {
    if (a === b) return;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const id = low * 4294967296 + high;
    const existing = this.index.get(id);
    if (existing === undefined) {
      this.index.set(id, this.source.length);
      this.source.push(low);
      this.target.push(high);
      this.weight.push(weight);
      this.kind.push(kind);
      return;
    }
    this.weight[existing] = Math.max(this.weight[existing], weight);
    if (kind === EDGE_LINK) this.kind[existing] = EDGE_LINK;
  }

  toArrays() {
    return {
      source: Uint32Array.from(this.source),
      target: Uint32Array.from(this.target),
      weight: Float32Array.from(this.weight),
      kind: Uint8Array.from(this.kind)
    };
  }
}

/** Dot product of two rows of one row-major matrix. */
function dot(data, dims, a, b) {
  let sum = 0;
  const left = a * dims;
  const right = b * dims;
  for (let d = 0; d < dims; d += 1) sum += data[left + d] * data[right + d];
  return sum;
}

/**
 * Neighbours for `rows` of one space, with indices mapped back to nodes: a
 * pool from the principal subspace, scored exactly in the full one.
 *
 * @returns {{ lists: Map<number, Array<{ index: number, similarity: number }>>, reduced: { data: Float32Array, dims: number }, nodes: number[] }}
 */
function spaceNeighbors({ matrix, dims, nodeRows, queryNodes, candidateNodes, idf, k, random }) {
  const rowOf = new Map(nodeRows.map(([node], position) => [node, position]));
  const normalized = normalizeRows(matrix, dims, nodeRows.map(([, row]) => row), { idf });
  const reduced = projectToSubspace(normalized.data, nodeRows.length, dims, { random });
  const usable = (node) => rowOf.has(node) && normalized.present[rowOf.get(node)] === 1;
  const queries = queryNodes.filter(usable).map((node) => rowOf.get(node));
  const candidates = candidateNodes.filter(usable).map((node) => rowOf.get(node));
  const pool = nearestNeighbors(reduced.data, reduced.dims, {
    queries, candidates, k: Math.max(k, CANDIDATE_POOL), minSimilarity: -1
  });
  const lists = new Map();
  queries.forEach((row, position) => {
    const exact = pool[position]
      .map((item) => ({ index: item.index, similarity: dot(normalized.data, dims, row, item.index) }))
      .filter((item) => item.similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity || a.index - b.index)
      .slice(0, k);
    lists.set(nodeRows[row][0], exact.map((item) => ({
      index: nodeRows[item.index][0],
      similarity: item.similarity
    })));
  });
  return { lists, reduced, nodes: nodeRows.map(([node]) => node) };
}

/**
 * Build the galaxy's graph from an index export.
 *
 * @param {object} input
 * @param {Array<{ path: string, title: string, dense?: number, semantic?: number, links?: string[] }>} input.nodes
 * @param {Float32Array} input.semantic - Rows addressed by `node.semantic`, or by
 *   the node's own index when it has none; `semanticDimensions` wide.
 * @param {number} input.semanticDimensions
 * @param {Float32Array} [input.dense] - Rows addressed by `node.dense` (−1 when absent).
 * @param {number} [input.denseDimensions]
 * @param {number} [input.neighbors]
 * @param {number} [input.seed]
 * @returns {{
 *   edges: { source: Uint32Array, target: Uint32Array, weight: Float32Array, kind: Uint8Array },
 *   seedPositions: Float32Array,
 *   space: "dense" | "sparse" | "mixed",
 *   counts: { dense_documents: number, sparse_documents: number, isolated_documents: number, semantic_edges: number, link_edges: number, unresolved_links: number }
 * }}
 */
export function buildGalaxyGraph({
  nodes,
  semantic,
  semanticDimensions,
  dense = new Float32Array(0),
  denseDimensions = 0,
  neighbors = DEFAULT_NEIGHBORS,
  seed = 1
}) {
  const count = nodes.length;
  const random = seededRandom(seed);
  const k = Math.max(1, Math.min(Math.floor(Number(neighbors) || DEFAULT_NEIGHBORS), 32));
  const all = nodes.map((_, index) => index);
  const denseRows = denseDimensions > 0
    ? nodes.flatMap((node, index) => (Number.isInteger(node.dense) && node.dense >= 0 ? [[index, node.dense]] : []))
    : [];
  const denseSet = new Set(denseRows.map(([node]) => node));
  const sparseOnly = all.filter((index) => !denseSet.has(index));

  const edges = new EdgeSet();
  const seedPositions = new Float32Array(count * 3).fill(Number.NaN);

  const place = ({ lists, reduced, nodes: placed }) => {
    for (const [node, list] of lists) {
      for (const item of list) edges.add(node, item.index, item.similarity, EDGE_SEMANTIC);
    }
    const coordinates = principalCoordinates(reduced.data, placed.length, reduced.dims);
    placed.forEach((node, row) => {
      if (!Number.isNaN(seedPositions[node * 3])) return;
      seedPositions.set(coordinates.subarray(row * 3, row * 3 + 3), node * 3);
    });
  };

  if (denseRows.length > 1) {
    place(spaceNeighbors({
      matrix: dense, dims: denseDimensions, nodeRows: denseRows,
      queryNodes: denseRows.map(([node]) => node), candidateNodes: denseRows.map(([node]) => node),
      idf: false, k, random
    }));
  }
  // The sparse space places what the dense one could not. Its neighbours come
  // from every document, so a note without a BGE-M3 vector still lands next to
  // the notes it resembles rather than in a sparse-only island.
  const sparseQueries = denseRows.length > 1 ? sparseOnly : all;
  if (sparseQueries.length && count > 1) {
    const sparse = spaceNeighbors({
      matrix: semantic, dims: semanticDimensions,
      nodeRows: all.map((index) => [index, Number.isInteger(nodes[index].semantic) ? nodes[index].semantic : index]),
      queryNodes: sparseQueries, candidateNodes: all, idf: true, k, random
    });
    // Only the sparse-only nodes take their starting point from this space;
    // the rest keep the dense one.
    if (denseRows.length > 1) {
      for (const [node, list] of sparse.lists) {
        for (const item of list) edges.add(node, item.index, item.similarity, EDGE_SEMANTIC);
      }
    } else {
      place(sparse);
    }
  }

  const links = resolveWikilinks(nodes);
  for (const [a, b] of links.pairs) edges.add(a, b, 0, EDGE_LINK);

  const arrays = edges.toArrays();
  const degree = new Uint32Array(count);
  for (let e = 0; e < arrays.source.length; e += 1) {
    degree[arrays.source[e]] += 1;
    degree[arrays.target[e]] += 1;
  }
  let isolated = 0;
  for (let i = 0; i < count; i += 1) if (degree[i] === 0) isolated += 1;
  let linkEdges = 0;
  for (let e = 0; e < arrays.kind.length; e += 1) if (arrays.kind[e] === EDGE_LINK) linkEdges += 1;

  const space = denseRows.length > 1
    ? (sparseOnly.length ? "mixed" : "dense")
    : "sparse";
  return {
    edges: arrays,
    seedPositions,
    space,
    counts: {
      dense_documents: denseRows.length > 1 ? denseRows.length : 0,
      sparse_documents: denseRows.length > 1 ? sparseOnly.length : count,
      isolated_documents: isolated,
      semantic_edges: arrays.source.length - linkEdges,
      link_edges: linkEdges,
      unresolved_links: links.unresolved
    }
  };
}
