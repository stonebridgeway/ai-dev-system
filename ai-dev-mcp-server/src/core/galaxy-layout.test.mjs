import assert from "node:assert/strict";
import test from "node:test";
import { LAYOUT_DEFAULTS, layoutGalaxy } from "./galaxy-layout.mjs";

/** Two cliques of `size`, joined by one edge; community of node i is ⌊i / size⌋. */
function twoCliques(size = 12) {
  const source = [];
  const target = [];
  for (let g = 0; g < 2; g += 1) {
    for (let a = 0; a < size; a += 1) {
      for (let b = a + 1; b < size; b += 1) { source.push(g * size + a); target.push(g * size + b); }
    }
  }
  source.push(0);
  target.push(size);
  return {
    count: size * 2,
    edges: { source: Uint32Array.from(source), target: Uint32Array.from(target) },
    community: Array.from({ length: size * 2 }, (_, i) => Math.floor(i / size))
  };
}

function distance(positions, a, b) {
  return Math.hypot(
    positions[a * 3] - positions[b * 3],
    positions[a * 3 + 1] - positions[b * 3 + 1],
    positions[a * 3 + 2] - positions[b * 3 + 2]
  );
}

/** Mean distance within the cliques over the mean distance between them. */
function separation(positions, size) {
  let within = 0; let withinCount = 0; let between = 0; let betweenCount = 0;
  for (let a = 0; a < size * 2; a += 1) {
    for (let b = a + 1; b < size * 2; b += 1) {
      const d = distance(positions, a, b);
      if (Math.floor(a / size) === Math.floor(b / size)) { within += d; withinCount += 1; } else { between += d; betweenCount += 1; }
    }
  }
  return (within / withinCount) / (between / betweenCount);
}

test("the layout is seeded, finite and centred on the origin", () => {
  const { count, edges } = twoCliques();
  const first = layoutGalaxy({ count, edges, options: { iterations: 60 } });
  const again = layoutGalaxy({ count, edges, options: { iterations: 60 } });
  assert.deepEqual(Array.from(first.positions), Array.from(again.positions));
  assert.equal(first.iterations, 60);
  assert.ok(Array.from(first.positions).every(Number.isFinite));
  for (let axis = 0; axis < 3; axis += 1) {
    let sum = 0;
    for (let i = 0; i < count; i += 1) sum += first.positions[i * 3 + axis];
    assert.ok(Math.abs(sum / count) < 1e-3);
  }
  const other = layoutGalaxy({ count, edges, seed: 2, options: { iterations: 60 } });
  assert.notDeepEqual(Array.from(other.positions), Array.from(first.positions));
});

test("connected stars settle closer than unconnected ones", () => {
  const { count, edges } = twoCliques();
  const { positions } = layoutGalaxy({ count, edges, options: { iterations: 200 } });
  assert.ok(separation(positions, 12) < 0.6, `separation ${separation(positions, 12)}`);
  // Springs settle near their rest length rather than collapsing or flying apart.
  let total = 0;
  for (let e = 0; e < edges.source.length; e += 1) total += distance(positions, edges.source[e], edges.target[e]);
  const mean = total / edges.source.length;
  assert.ok(mean > LAYOUT_DEFAULTS.springLength * 0.3 && mean < LAYOUT_DEFAULTS.springLength * 6, `mean edge ${mean}`);
});

test("weaker springs between communities pull the constellations apart", () => {
  const { count, edges, community } = twoCliques();
  // Tie the cliques together properly, so only the spring weakening separates them.
  const source = [...edges.source];
  const target = [...edges.target];
  for (let i = 0; i < 12; i += 1) { source.push(i); target.push(12 + i); }
  const joined = { source: Uint32Array.from(source), target: Uint32Array.from(target) };
  const uniform = layoutGalaxy({ count, edges: joined, options: { iterations: 200 } }).positions;
  const aware = layoutGalaxy({ count, edges: joined, community, options: { iterations: 200 } }).positions;
  assert.ok(separation(aware, 12) < separation(uniform, 12), "community-aware springs separate more");
});

test("seed positions shape the start; a node without one starts beside its neighbours", () => {
  const count = 3;
  const edges = { source: Uint32Array.from([0, 1]), target: Uint32Array.from([2, 2]) };
  const seedPositions = Float32Array.from([-1, 0, 0, 1, 0, 0, Number.NaN, Number.NaN, Number.NaN]);
  const { positions } = layoutGalaxy({ count, edges, seedPositions, options: { iterations: 0 } });
  // Before any step: 0 and 1 mirror each other on x, and 2 sits between them.
  assert.ok(positions[0] < 0 && positions[3] > 0);
  assert.ok(Math.abs(positions[6]) < Math.abs(positions[0]));
});

test("stars that start on the same spot are pulled apart, and a loner does not drift away", () => {
  const count = 40;
  const seedPositions = new Float32Array(count * 3);
  const edges = { source: new Uint32Array(0), target: new Uint32Array(0) };
  const { positions } = layoutGalaxy({ count, edges, seedPositions, options: { iterations: 150 } });
  assert.ok(Array.from(positions).every(Number.isFinite));
  const spots = new Set();
  for (let i = 0; i < count; i += 1) spots.add(`${positions[i * 3].toFixed(3)},${positions[i * 3 + 1].toFixed(3)},${positions[i * 3 + 2].toFixed(3)}`);
  assert.equal(spots.size, count);
  for (let i = 0; i < count; i += 1) assert.ok(Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]) < 5000);
  // One star alone is simply at the centre.
  const single = layoutGalaxy({ count: 1, edges, options: { iterations: 5 } }).positions;
  assert.deepEqual(Array.from(single), [0, 0, 0]);
});
