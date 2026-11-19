/**
 * The Knowledge Galaxy's constellations: communities of the neighbour graph,
 * and a two-word name for each.
 *
 * Communities come from Louvain modularity optimisation: nodes move to the
 * neighbouring community that gains the most modularity until none does, the
 * communities become nodes of a smaller graph, and the round repeats. On a
 * nearest-neighbour graph that finds the groups a reader would draw around the
 * clusters of stars, and it does not need to be told how many there are.
 *
 * A community's name is the pair of title and category words most particular
 * to it: frequent inside, rare across the vault. A word found in more than a
 * quarter of the communities names none of them — on the public seed that is
 * "automation" and "external", carried by nine skills in ten — and a community
 * with no word of its own stays unnamed rather than borrowing a vague one. It
 * is a label for a map, not a summary, and it is computed rather than written,
 * so it is only as good as the titles.
 *
 * Pure and seeded, like the rest of the galaxy.
 */
import { seededRandom } from "./galaxy-graph.mjs";

/** Most Louvain rounds; each one coarsens the graph, and few are ever needed. */
const MAX_LEVELS = 12;

/** Most local-moving sweeps inside one round. */
const MAX_SWEEPS = 24;

/** Communities smaller than this are merged into their strongest neighbour. */
export const MIN_COMMUNITY_SIZE = 3;

/** Words too common in note titles to name anything. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "your", "you", "are", "how", "what", "when", "use",
  "using", "this", "that", "via", "not", "all", "new", "one", "two", "its", "our", "out", "any",
  "md", "readme", "index", "notes", "note", "skill", "skills", "agent", "agents", "guide", "tool", "tools",
  "для", "как", "что", "это", "при", "или", "его", "без", "над", "под", "про", "все", "мой"
]);

/**
 * Symmetric compressed adjacency from an undirected edge list.
 *
 * @param {number} count
 * @param {{ source: ArrayLike<number>, target: ArrayLike<number>, weight: ArrayLike<number> }} edges
 * @param {(index: number) => number} [weightOf] - Edge weight used for clustering.
 * @returns {{ offsets: Uint32Array, targets: Uint32Array, weights: Float64Array }}
 */
export function adjacency(count, edges, weightOf = (index) => edges.weight[index]) {
  const offsets = new Uint32Array(count + 1);
  for (let e = 0; e < edges.source.length; e += 1) {
    offsets[edges.source[e] + 1] += 1;
    offsets[edges.target[e] + 1] += 1;
  }
  for (let i = 0; i < count; i += 1) offsets[i + 1] += offsets[i];
  const cursor = offsets.slice(0, count);
  const targets = new Uint32Array(offsets[count]);
  const weights = new Float64Array(offsets[count]);
  for (let e = 0; e < edges.source.length; e += 1) {
    const a = edges.source[e];
    const b = edges.target[e];
    const w = Math.max(weightOf(e), 1e-6);
    targets[cursor[a]] = b;
    weights[cursor[a]] = w;
    cursor[a] += 1;
    targets[cursor[b]] = a;
    weights[cursor[b]] = w;
    cursor[b] += 1;
  }
  return { offsets, targets, weights };
}

/** One round of local moving. Returns the community of every node, renumbered 0..k−1. */
function localMoving({ offsets, targets, weights }, count, random, resolution) {
  const degree = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    for (let e = offsets[i]; e < offsets[i + 1]; e += 1) degree[i] += weights[e];
    total += degree[i];
  }
  const community = new Int32Array(count);
  for (let i = 0; i < count; i += 1) community[i] = i;
  if (total === 0) return { community, communities: count, moved: false };
  const communityTotal = Float64Array.from(degree);
  const order = Array.from({ length: count }, (_, index) => index);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const linkWeight = new Float64Array(count);
  const touched = [];
  let movedAny = false;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    let moved = 0;
    for (const node of order) {
      const current = community[node];
      for (let e = offsets[node]; e < offsets[node + 1]; e += 1) {
        const other = targets[e];
        if (other === node) continue;
        const target = community[other];
        if (linkWeight[target] === 0) touched.push(target);
        linkWeight[target] += weights[e];
      }
      communityTotal[current] -= degree[node];
      let best = current;
      let bestGain = linkWeight[current] - resolution * communityTotal[current] * degree[node] / total;
      for (const candidate of touched) {
        const gain = linkWeight[candidate] - resolution * communityTotal[candidate] * degree[node] / total;
        if (gain > bestGain + 1e-12) {
          best = candidate;
          bestGain = gain;
        }
      }
      communityTotal[best] += degree[node];
      if (best !== current) {
        community[node] = best;
        moved += 1;
      }
      for (const target of touched) linkWeight[target] = 0;
      touched.length = 0;
    }
    if (!moved) break;
    movedAny = true;
  }
  const renumber = new Map();
  for (let i = 0; i < count; i += 1) {
    if (!renumber.has(community[i])) renumber.set(community[i], renumber.size);
    community[i] = renumber.get(community[i]);
  }
  return { community, communities: renumber.size, moved: movedAny };
}

/** Collapse each community into one node; internal weight becomes a self-loop. */
function aggregate({ offsets, targets, weights }, count, community, communities) {
  const merged = new Map();
  for (let i = 0; i < count; i += 1) {
    for (let e = offsets[i]; e < offsets[i + 1]; e += 1) {
      const a = community[i];
      const b = community[targets[e]];
      const key = a * communities + b;
      merged.set(key, (merged.get(key) || 0) + weights[e]);
    }
  }
  const nextOffsets = new Uint32Array(communities + 1);
  for (const key of merged.keys()) nextOffsets[Math.floor(key / communities) + 1] += 1;
  for (let i = 0; i < communities; i += 1) nextOffsets[i + 1] += nextOffsets[i];
  const cursor = nextOffsets.slice(0, communities);
  const nextTargets = new Uint32Array(merged.size);
  const nextWeights = new Float64Array(merged.size);
  for (const [key, weight] of merged) {
    const a = Math.floor(key / communities);
    nextTargets[cursor[a]] = key % communities;
    nextWeights[cursor[a]] = weight;
    cursor[a] += 1;
  }
  return { offsets: nextOffsets, targets: nextTargets, weights: nextWeights };
}

/**
 * Louvain communities, renumbered by size: community 0 is the largest.
 * Communities under `minSize` join the neighbouring community they are most
 * strongly tied to, so the map is not littered with pairs; an isolated node
 * stays alone.
 *
 * @param {number} count
 * @param {{ source: ArrayLike<number>, target: ArrayLike<number>, weight: ArrayLike<number> }} edges
 * @param {{ seed?: number, resolution?: number, minSize?: number, weightOf?: (index: number) => number }} [options]
 * @returns {Int32Array} Community of every node.
 */
export function detectCommunities(count, edges, { seed = 1, resolution = 1, minSize = MIN_COMMUNITY_SIZE, weightOf } = {}) {
  const random = seededRandom(seed);
  const graph = adjacency(count, edges, weightOf);
  const membership = new Int32Array(count);
  for (let i = 0; i < count; i += 1) membership[i] = i;
  let level = graph;
  let levelCount = count;
  for (let round = 0; round < MAX_LEVELS; round += 1) {
    const { community, communities, moved } = localMoving(level, levelCount, random, resolution);
    for (let i = 0; i < count; i += 1) membership[i] = community[membership[i]];
    if (!moved || communities === levelCount) break;
    level = aggregate(level, levelCount, community, communities);
    levelCount = communities;
  }

  // Fold the crumbs into their strongest neighbour.
  const size = new Map();
  for (let i = 0; i < count; i += 1) size.set(membership[i], (size.get(membership[i]) || 0) + 1);
  for (let i = 0; i < count; i += 1) {
    if (size.get(membership[i]) >= minSize) continue;
    const pull = new Map();
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) {
      const target = membership[graph.targets[e]];
      if (target === membership[i] || size.get(target) < minSize) continue;
      pull.set(target, (pull.get(target) || 0) + graph.weights[e]);
    }
    let best = -1;
    let bestWeight = 0;
    for (const [target, weight] of pull) {
      if (weight > bestWeight || (weight === bestWeight && target < best)) {
        best = target;
        bestWeight = weight;
      }
    }
    if (best >= 0) {
      size.set(membership[i], size.get(membership[i]) - 1);
      size.set(best, size.get(best) + 1);
      membership[i] = best;
    }
  }

  // Largest first, ties by first appearance, so ids are stable for a vault.
  const firstSeen = new Map();
  const finalSize = new Map();
  for (let i = 0; i < count; i += 1) {
    if (!firstSeen.has(membership[i])) firstSeen.set(membership[i], i);
    finalSize.set(membership[i], (finalSize.get(membership[i]) || 0) + 1);
  }
  const ranked = [...finalSize.keys()].sort((a, b) => finalSize.get(b) - finalSize.get(a) || firstSeen.get(a) - firstSeen.get(b));
  const rank = new Map(ranked.map((id, position) => [id, position]));
  return membership.map((id) => rank.get(id));
}

/** Words of a title worth naming a community by. */
export function titleWords(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\p{N}+$/u.test(word) && !STOPWORDS.has(word));
}

/**
 * Name every community by its most particular title words.
 *
 * @param {Array<{ title: string, categories?: string }>} nodes
 * @param {ArrayLike<number>} community
 * @param {{ words?: number }} [options]
 * @returns {Array<{ id: number, size: number, label: string, words: string[] }>} Indexed by community id.
 */
export function labelCommunities(nodes, community, { words = 2 } = {}) {
  let communities = 0;
  for (let i = 0; i < community.length; i += 1) communities = Math.max(communities, community[i] + 1);
  const counts = Array.from({ length: communities }, () => new Map());
  const sizes = new Array(communities).fill(0);
  const frequency = new Map();
  nodes.forEach((node, index) => {
    const id = community[index];
    sizes[id] += 1;
    const distinct = new Set([...titleWords(node.title), ...titleWords(node.categories)]);
    for (const word of distinct) {
      counts[id].set(word, (counts[id].get(word) || 0) + 1);
      frequency.set(word, (frequency.get(word) || 0) + 1);
    }
  });
  const total = Math.max(nodes.length, 1);
  const spread = new Map();
  for (const map of counts) for (const word of map.keys()) spread.set(word, (spread.get(word) || 0) + 1);
  const widest = Math.max(2, communities / 4);
  return counts.map((map, id) => {
    const minimum = sizes[id] >= 6 ? 2 : 1;
    const chosen = [...map.entries()]
      .filter(([word, count]) => count >= minimum && spread.get(word) <= widest)
      .map(([word, count]) => ({
        word,
        score: (count / sizes[id]) * Math.log(total / frequency.get(word))
      }))
      .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
      .slice(0, words)
      .map((item) => item.word);
    return { id, size: sizes[id], label: chosen.join(" · "), words: chosen };
  });
}
