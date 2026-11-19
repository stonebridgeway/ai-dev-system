import assert from "node:assert/strict";
import test from "node:test";
import {
  EDGE_LINK,
  EDGE_SEMANTIC,
  buildGalaxyGraph,
  linkKey,
  nearestNeighbors,
  normalizeRows,
  principalCoordinates,
  projectToSubspace,
  resolveWikilinks,
  seededRandom
} from "./galaxy-graph.mjs";

/**
 * `groups` clusters of `size` points in `dims` dimensions: a random centre
 * each, and small noise around it. Row i belongs to group ⌊i / size⌋.
 */
function clustered({ groups = 3, size = 20, dims = 48, noise = 0.15, seed = 3 } = {}) {
  const random = seededRandom(seed);
  const centres = Array.from({ length: groups }, () => Array.from({ length: dims }, () => random() - 0.5));
  const data = new Float32Array(groups * size * dims);
  for (let g = 0; g < groups; g += 1) {
    for (let k = 0; k < size; k += 1) {
      const row = (g * size + k) * dims;
      for (let d = 0; d < dims; d += 1) data[row + d] = centres[g][d] + (random() - 0.5) * noise;
    }
  }
  return { data, dims, count: groups * size, groupOf: (i) => Math.floor(i / size) };
}

test("seededRandom is deterministic, uniform in [0, 1), and seed-sensitive", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom(43);
  const first = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(first, Array.from({ length: 1000 }, () => b()));
  assert.notDeepEqual(first.slice(0, 5), Array.from({ length: 5 }, () => c()));
  assert.ok(first.every((value) => value >= 0 && value < 1));
  const mean = first.reduce((sum, value) => sum + value, 0) / first.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
  // A zero seed must not stick at zero.
  const zero = seededRandom(0);
  assert.notEqual(zero(), zero());
});

test("normalizeRows gives unit rows, flags empty ones, and lets IDF quiet a shared term", () => {
  // Dimension 0 is in every row; dimension 1 only in row 0.
  const data = Float32Array.from([1, 1, 0, 1, 0, 1, 0, 0, 0]);
  const plain = normalizeRows(data, 3, [0, 1, 2]);
  assert.deepEqual(Array.from(plain.present), [1, 1, 0]);
  assert.ok(Math.abs(Math.hypot(plain.data[0], plain.data[1], plain.data[2]) - 1) < 1e-6);
  assert.deepEqual(Array.from(plain.data.subarray(6, 9)), [0, 0, 0]);
  const weighted = normalizeRows(data, 3, [0, 1, 2], { idf: true });
  // The rare dimension now outweighs the common one in row 0.
  assert.ok(weighted.data[1] > weighted.data[0]);
  // Rows are taken in the order asked for.
  const reordered = normalizeRows(data, 3, [1, 0]);
  assert.deepEqual(Array.from(reordered.data.subarray(0, 3)), Array.from(plain.data.subarray(3, 6)));
});

test("nearestNeighbors ranks by similarity, skips the query itself, and honours the floor", () => {
  const data = Float32Array.from([
    1, 0,
    0.8, 0.6,
    0, 1,
    -1, 0
  ]);
  const [row] = nearestNeighbors(data, 2, { queries: [0], candidates: [0, 1, 2, 3], k: 3 });
  assert.deepEqual(row.map((item) => item.index), [1]);
  assert.ok(Math.abs(row[0].similarity - 0.8) < 1e-6);
  const [open] = nearestNeighbors(data, 2, { queries: [0], candidates: [0, 1, 2, 3], k: 3, minSimilarity: -2 });
  assert.deepEqual(open.map((item) => item.index), [1, 2, 3]);
  const [one] = nearestNeighbors(data, 2, { queries: [0], candidates: [3, 2, 1], k: 1, minSimilarity: -2 });
  assert.deepEqual(one.map((item) => item.index), [1]);
});

test("projectToSubspace keeps neighbourhoods and returns unit rows", () => {
  const { data, dims, count, groupOf } = clustered({ dims: 200 });
  const rows = Array.from({ length: count }, (_, i) => i);
  const unit = normalizeRows(data, dims, rows);
  const reduced = projectToSubspace(unit.data, count, dims, { target: 16, random: seededRandom(5) });
  assert.equal(reduced.dims, 16);
  for (let i = 0; i < count; i += 1) {
    let norm = 0;
    for (let d = 0; d < reduced.dims; d += 1) norm += reduced.data[i * reduced.dims + d] ** 2;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-4);
  }
  const found = nearestNeighbors(reduced.data, reduced.dims, { queries: rows, candidates: rows, k: 5 });
  let same = 0;
  let total = 0;
  found.forEach((list, i) => list.forEach((item) => { total += 1; if (groupOf(item.index) === groupOf(i)) same += 1; }));
  assert.ok(same / total > 0.95, `purity ${same / total}`);
  // Never wider than the rows can span.
  assert.equal(projectToSubspace(unit.data, count, dims, { target: 500 }).dims, count);
  // Asking for every dimension leaves the rows as they were.
  const narrow = clustered({ dims: 8 });
  const narrowUnit = normalizeRows(narrow.data, 8, rows);
  const whole = projectToSubspace(narrowUnit.data, count, 8, { target: 500 });
  assert.equal(whole.dims, 8);
  assert.deepEqual(Array.from(whole.data), Array.from(narrowUnit.data));
});

test("principalCoordinates spreads the rows with unit variance and keeps groups apart", () => {
  const { data, dims, count, groupOf } = clustered({ groups: 2, dims: 30 });
  const unit = normalizeRows(data, dims, Array.from({ length: count }, (_, i) => i));
  const coordinates = principalCoordinates(unit.data, count, dims);
  assert.equal(coordinates.length, count * 3);
  let variance = 0;
  for (let i = 0; i < count; i += 1) variance += coordinates[i * 3] ** 2;
  assert.ok(Math.abs(variance / count - 1) < 1e-3);
  // Two groups split along the first axis.
  const sides = new Set();
  for (let i = 0; i < count; i += 1) sides.add(`${groupOf(i)}:${Math.sign(coordinates[i * 3])}`);
  assert.equal(sides.size, 2);
});

test("wikilinks resolve by file name, then title, the way Obsidian reads them", () => {
  assert.equal(linkKey("03-skills-catalog/groups/Security.md"), "security");
  assert.equal(linkKey("folder\\Note"), "note");
  const nodes = [
    { path: "02-knowledge/Alpha.md", title: "Alpha", links: ["Beta", "beta", "folder/Beta", "Gamma Title", "Alpha", "Missing"] },
    { path: "02-knowledge/Beta.md", title: "Beta note", links: ["Alpha"] },
    { path: "03-skills-catalog/sources/x/SKILL.md", title: "Gamma Title" }
  ];
  const { pairs, unresolved } = resolveWikilinks(nodes);
  // Alpha→Beta three ways and Beta→Alpha are one edge; the self-link is none.
  assert.deepEqual(pairs, [[0, 1], [0, 2]]);
  assert.equal(unresolved, 1);
});

test("a vault without BGE-M3 vectors is laid out from its keyword vectors", () => {
  const { data, dims, count, groupOf } = clustered({ dims: 64 });
  const nodes = Array.from({ length: count }, (_, i) => ({ path: `n${i}.md`, title: `n${i}`, dense: -1 }));
  nodes[0].links = ["n59"];
  const graph = buildGalaxyGraph({ nodes, semantic: data, semanticDimensions: dims, neighbors: 4 });
  assert.equal(graph.space, "sparse");
  assert.equal(graph.counts.sparse_documents, count);
  assert.equal(graph.counts.dense_documents, 0);
  assert.equal(graph.counts.link_edges, 1);
  let same = 0;
  let semantic = 0;
  for (let e = 0; e < graph.edges.source.length; e += 1) {
    assert.ok(graph.edges.source[e] < graph.edges.target[e], "edges are stored low → high");
    if (graph.edges.kind[e] !== EDGE_SEMANTIC) continue;
    semantic += 1;
    if (groupOf(graph.edges.source[e]) === groupOf(graph.edges.target[e])) same += 1;
    assert.ok(graph.edges.weight[e] > 0 && graph.edges.weight[e] <= 1.0001);
  }
  assert.ok(same / semantic > 0.95);
  assert.equal(graph.counts.isolated_documents, 0);
  assert.ok(Array.from(graph.seedPositions).every(Number.isFinite));
  // Same input, same graph.
  const again = buildGalaxyGraph({ nodes, semantic: data, semanticDimensions: dims, neighbors: 4 });
  assert.deepEqual(Array.from(again.edges.target), Array.from(graph.edges.target));
});

test("BGE-M3 vectors place the documents that have them; keyword vectors place the rest", () => {
  const sparse = clustered({ dims: 32, seed: 11 });
  const dense = clustered({ dims: 40, seed: 12 });
  const count = sparse.count;
  // Every document but the last five has a dense row, stored in reverse order.
  const nodes = Array.from({ length: count }, (_, i) => ({
    path: `n${i}.md`,
    title: `n${i}`,
    dense: i < count - 5 ? count - 6 - i : -1
  }));
  const denseRows = new Float32Array((count - 5) * dense.dims);
  for (let i = 0; i < count - 5; i += 1) {
    denseRows.set(dense.data.subarray(i * dense.dims, (i + 1) * dense.dims), nodes[i].dense * dense.dims);
  }
  const graph = buildGalaxyGraph({
    nodes,
    semantic: sparse.data,
    semanticDimensions: sparse.dims,
    dense: denseRows,
    denseDimensions: dense.dims,
    neighbors: 4
  });
  assert.equal(graph.space, "mixed");
  assert.equal(graph.counts.dense_documents, count - 5);
  assert.equal(graph.counts.sparse_documents, 5);
  const degree = new Array(count).fill(0);
  for (let e = 0; e < graph.edges.source.length; e += 1) {
    degree[graph.edges.source[e]] += 1;
    degree[graph.edges.target[e]] += 1;
  }
  assert.ok(degree.every((value) => value > 0), "every document found neighbours");
  for (let i = count - 5; i < count; i += 1) assert.ok(Number.isNaN(graph.seedPositions[i * 3]));
  for (let i = 0; i < count - 5; i += 1) assert.ok(Number.isFinite(graph.seedPositions[i * 3]));
});

test("a document with no features is isolated, and a link can still reach it", () => {
  const dims = 8;
  const semantic = new Float32Array(3 * dims);
  semantic[0] = 1;
  semantic[dims] = 1;
  const nodes = [
    { path: "a.md", title: "a", links: ["c"] },
    { path: "b.md", title: "b" },
    { path: "c.md", title: "c" }
  ];
  const graph = buildGalaxyGraph({ nodes, semantic, semanticDimensions: dims, neighbors: 2 });
  assert.equal(graph.counts.isolated_documents, 0);
  const kinds = Array.from(graph.edges.kind);
  assert.ok(kinds.includes(EDGE_LINK));
  const alone = buildGalaxyGraph({ nodes: nodes.map(({ links, ...node }) => node), semantic, semanticDimensions: dims, neighbors: 2 });
  assert.equal(alone.counts.isolated_documents, 1);
});
