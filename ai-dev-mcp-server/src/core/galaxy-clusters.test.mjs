import assert from "node:assert/strict";
import test from "node:test";
import { adjacency, detectCommunities, labelCommunities, titleWords } from "./galaxy-clusters.mjs";

/** Undirected edge list from [a, b, weight] triples. */
function edges(list) {
  return {
    source: Uint32Array.from(list.map(([a]) => a)),
    target: Uint32Array.from(list.map(([, b]) => b)),
    weight: Float32Array.from(list.map(([, , w = 1]) => w))
  };
}

/** `groups` cliques of `size`, each joined to the next by one weak edge. */
function cliques(groups, size) {
  const list = [];
  for (let g = 0; g < groups; g += 1) {
    for (let a = 0; a < size; a += 1) {
      for (let b = a + 1; b < size; b += 1) list.push([g * size + a, g * size + b, 0.9]);
    }
    if (g + 1 < groups) list.push([g * size, (g + 1) * size, 0.1]);
  }
  return edges(list);
}

test("adjacency is symmetric and keeps every weight", () => {
  const graph = adjacency(3, edges([[0, 1, 0.5], [1, 2, 0.25]]));
  assert.deepEqual(Array.from(graph.offsets), [0, 1, 3, 4]);
  assert.deepEqual(Array.from(graph.targets), [1, 0, 2, 1]);
  assert.deepEqual(Array.from(graph.weights), [0.5, 0.5, 0.25, 0.25]);
  // A zero weight is kept positive so the node still has a degree.
  const floored = adjacency(2, edges([[0, 1, 0]]));
  assert.ok(floored.weights[0] > 0);
});

test("Louvain finds planted cliques and numbers them largest first", () => {
  const graph = cliques(4, 6);
  // Make the third clique the largest by hanging two more nodes on it.
  graph.source = Uint32Array.from([...graph.source, 12, 12, 24]);
  graph.target = Uint32Array.from([...graph.target, 24, 25, 25]);
  graph.weight = Float32Array.from([...graph.weight, 0.9, 0.9, 0.9]);
  const community = detectCommunities(26, graph);
  const groups = new Map();
  community.forEach((id, node) => groups.set(id, [...(groups.get(id) ?? []), node]));
  assert.equal(groups.size, 4);
  for (const members of groups.values()) {
    const cliqueOf = (node) => (node >= 24 ? 2 : Math.floor(node / 6));
    assert.equal(new Set(members.map(cliqueOf)).size, 1, `mixed community ${members}`);
  }
  assert.equal(community[12], 0, "the largest community is number 0");
  assert.deepEqual(detectCommunities(26, graph), community, "seeded: the same graph gives the same answer");
});

test("crumbs join their strongest neighbour; an isolated node stays alone", () => {
  // A clique of five, a pair hanging off it, and one node with no edges.
  const list = [];
  for (let a = 0; a < 5; a += 1) for (let b = a + 1; b < 5; b += 1) list.push([a, b, 1]);
  list.push([5, 6, 1], [5, 0, 0.4], [6, 1, 0.3]);
  // Left alone, Louvain keeps the pair apart; the size floor folds it in.
  const unfolded = detectCommunities(8, edges(list), { minSize: 1 });
  assert.equal(unfolded[5], unfolded[6]);
  assert.notEqual(unfolded[5], unfolded[0]);
  const community = detectCommunities(8, edges(list), { minSize: 3 });
  assert.equal(community[5], community[0]);
  assert.equal(community[6], community[0]);
  assert.notEqual(community[7], community[0]);
  const lonely = detectCommunities(2, edges([]));
  assert.deepEqual(Array.from(lonely).sort(), [0, 1]);
});

test("titleWords splits Latin and Cyrillic alike and drops the noise", () => {
  assert.deepEqual(titleWords("React Hooks — the skill for UI"), ["react", "hooks"]);
  assert.deepEqual(titleWords("Заметки по безопасности API v2 2024"), ["заметки", "безопасности", "api"]);
  assert.deepEqual(titleWords(""), []);
});

test("a constellation is named by the words particular to it", () => {
  const nodes = [
    ...Array.from({ length: 6 }, (_, i) => ({ title: `react hooks ${i}`, categories: "frontend" })),
    ...Array.from({ length: 6 }, (_, i) => ({ title: `postgres index ${i}`, categories: "database" })),
    ...Array.from({ length: 6 }, (_, i) => ({ title: `vendor${i}`, categories: "" })),
    ...Array.from({ length: 6 }, (_, i) => ({ title: `filler${i}`, categories: "" })),
    ...Array.from({ length: 6 }, (_, i) => ({ title: `other${i}`, categories: "" }))
  ];
  const community = nodes.map((_, i) => Math.floor(i / 6));
  const labels = labelCommunities(nodes, community);
  assert.equal(labels.length, 5);
  assert.equal(labels[0].size, 6);
  // Three words tie here; two are kept, alphabetically, so the name is stable.
  assert.deepEqual(labels[0].words, ["frontend", "hooks"]);
  assert.equal(labels[0].label, "frontend · hooks");
  assert.ok(labels[1].label.includes("postgres"));
  // Every title unique: nothing is particular to the group, so no name.
  assert.equal(labels[2].label, "");
  // A word spread over most constellations names none of them.
  const common = nodes.map((node) => ({ ...node, title: `${node.title} shared` }));
  assert.ok(!labelCommunities(common, community).some((item) => item.words.includes("shared")));
});
