/**
 * The Knowledge Galaxy's layout: where each star sits in three dimensions.
 *
 * A force-directed layout over the neighbour graph, with the physics of
 * ngraph.forcelayout — the engine behind anvaka's Software Galaxies, which the
 * viewer's navigation also follows. Every star repels every other (inverse
 * square, approximated with a Barnes–Hut octree), every edge is a spring of a
 * set rest length, velocity is dragged and capped per step. What differs is the
 * start: stars begin at their principal coordinates in embedding space rather
 * than at random, so the large-scale arrangement already means something and
 * a few hundred steps are enough to settle the local one. A faint pull toward
 * the centre keeps a document with no neighbours from drifting off for ever —
 * the outer ring Obsidian's graph builds out of exactly those.
 *
 * Given the communities, a spring between two of them is weaker than one
 * inside a community. A nearest-neighbour graph of a real vault is one
 * connected hairball otherwise: every cluster has a few members that resemble
 * another cluster, and uniform springs pull the clusters into each other.
 *
 * Pure and seeded: the same graph gives the same positions.
 */
import { seededRandom } from "./galaxy-graph.mjs";

/** ngraph.forcelayout's defaults, which the Software Galaxies were laid out with. */
export const LAYOUT_DEFAULTS = Object.freeze({
  springLength: 30,
  springCoefficient: 0.0008,
  repulsion: 1.2,
  theta: 0.8,
  drag: 0.02,
  timeStep: 20,
  centerPull: 0.00005,
  interCommunitySpring: 0.08,
  iterations: 300
});

/** Barnes–Hut octree over the current positions, rebuilt every step. */
class Octree {
  constructor(bodies) {
    this.capacity = Math.max(64, bodies * 4);
    this.allocate(this.capacity);
    this.count = 0;
  }

  allocate(capacity) {
    const grow = (Type, previous, width = 1) => {
      const next = new Type(capacity * width);
      if (previous) next.set(previous);
      return next;
    };
    this.children = grow(Int32Array, this.children, 8);
    this.body = grow(Int32Array, this.body);
    this.mass = grow(Float64Array, this.mass);
    this.mx = grow(Float64Array, this.mx);
    this.my = grow(Float64Array, this.my);
    this.mz = grow(Float64Array, this.mz);
    this.cx = grow(Float64Array, this.cx);
    this.cy = grow(Float64Array, this.cy);
    this.cz = grow(Float64Array, this.cz);
    this.half = grow(Float64Array, this.half);
    this.capacity = capacity;
  }

  cell(x, y, z, half) {
    if (this.count === this.capacity) this.allocate(this.capacity * 2);
    const index = this.count;
    this.count += 1;
    this.children.fill(-1, index * 8, index * 8 + 8);
    this.body[index] = -1;
    this.mass[index] = 0;
    this.mx[index] = 0;
    this.my[index] = 0;
    this.mz[index] = 0;
    this.cx[index] = x;
    this.cy[index] = y;
    this.cz[index] = z;
    this.half[index] = half;
    return index;
  }

  octant(cell, x, y, z) {
    return (x > this.cx[cell] ? 1 : 0) | (y > this.cy[cell] ? 2 : 0) | (z > this.cz[cell] ? 4 : 0);
  }

  child(cell, octant) {
    const half = this.half[cell] / 2;
    return this.cell(
      this.cx[cell] + (octant & 1 ? half : -half),
      this.cy[cell] + (octant & 2 ? half : -half),
      this.cz[cell] + (octant & 4 ? half : -half),
      half
    );
  }

  addMass(cell, mass, x, y, z) {
    this.mass[cell] += mass;
    this.mx[cell] += mass * x;
    this.my[cell] += mass * y;
    this.mz[cell] += mass * z;
  }

  build(positions, masses, count, random) {
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const x = positions[i * 3]; const y = positions[i * 3 + 1]; const z = positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) / 2 + 1;
    this.count = 0;
    this.cell((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, half);
    for (let i = 0; i < count; i += 1) this.insert(i, positions, masses, random);
    for (let cell = 0; cell < this.count; cell += 1) {
      const mass = this.mass[cell];
      if (mass > 0) {
        this.mx[cell] /= mass;
        this.my[cell] /= mass;
        this.mz[cell] /= mass;
      }
    }
  }

  insert(i, positions, masses, random) {
    const mass = masses[i];
    let cell = 0;
    for (let depth = 0; ; depth += 1) {
      const x = positions[i * 3]; const y = positions[i * 3 + 1]; const z = positions[i * 3 + 2];
      const occupant = this.body[cell];
      const hasChildren = occupant === -2;
      if (!hasChildren && occupant === -1 && this.mass[cell] === 0) {
        this.body[cell] = i;
        this.addMass(cell, mass, x, y, z);
        return;
      }
      if (!hasChildren) {
        // A leaf holding one body: split it, unless the two coincide so
        // closely that splitting would recurse for ever. Then nudge the
        // newcomer, and past a depth limit let the leaf hold both.
        const j = occupant;
        const dx = positions[j * 3] - x; const dy = positions[j * 3 + 1] - y; const dz = positions[j * 3 + 2] - z;
        if (depth > 48) {
          this.addMass(cell, mass, x, y, z);
          return;
        }
        if (dx * dx + dy * dy + dz * dz < 1e-6) {
          positions[i * 3] += (random() - 0.5);
          positions[i * 3 + 1] += (random() - 0.5);
          positions[i * 3 + 2] += (random() - 0.5);
          continue;
        }
        this.body[cell] = -2;
        const octant = this.octant(cell, positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]);
        const moved = this.child(cell, octant);
        this.children[cell * 8 + octant] = moved;
        this.body[moved] = j;
        this.addMass(moved, masses[j], positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]);
      }
      this.addMass(cell, mass, x, y, z);
      const octant = this.octant(cell, x, y, z);
      const next = this.children[cell * 8 + octant];
      if (next === -1) {
        const leaf = this.child(cell, octant);
        this.children[cell * 8 + octant] = leaf;
        this.body[leaf] = i;
        this.addMass(leaf, mass, x, y, z);
        return;
      }
      cell = next;
    }
  }

  /** Add body i's repulsion from everything else into `force`. */
  repel(i, positions, masses, strength, theta, force, stack) {
    const x = positions[i * 3]; const y = positions[i * 3 + 1]; const z = positions[i * 3 + 2];
    const mass = masses[i];
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const cell = stack[--top];
      const cellMass = this.mass[cell];
      if (cellMass === 0 || this.body[cell] === i) continue;
      const dx = this.mx[cell] - x; const dy = this.my[cell] - y; const dz = this.mz[cell] - z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const isLeaf = this.body[cell] >= 0;
      if (!isLeaf && (4 * this.half[cell] * this.half[cell]) > theta * theta * distanceSquared) {
        for (let octant = 0; octant < 8; octant += 1) {
          const child = this.children[cell * 8 + octant];
          if (child !== -1) stack[top++] = child;
        }
        continue;
      }
      const distance = Math.sqrt(Math.max(distanceSquared, 0.01));
      const magnitude = strength * mass * cellMass / (distance * distance * distance);
      force[i * 3] -= magnitude * dx;
      force[i * 3 + 1] -= magnitude * dy;
      force[i * 3 + 2] -= magnitude * dz;
    }
  }
}

/**
 * Lay the graph out in 3D.
 *
 * @param {object} input
 * @param {number} input.count
 * @param {{ source: ArrayLike<number>, target: ArrayLike<number> }} input.edges
 * @param {Float32Array} [input.seedPositions] - count × 3, NaN where a node has none.
 * @param {ArrayLike<number>} [input.community] - Community of every node.
 * @param {number} [input.seed]
 * @param {Partial<typeof LAYOUT_DEFAULTS>} [input.options]
 * @returns {{ positions: Float32Array, iterations: number }} Centred on the origin.
 */
export function layoutGalaxy({ count, edges, seedPositions, community, seed = 1, options = {} }) {
  const settings = { ...LAYOUT_DEFAULTS, ...options };
  const random = seededRandom(seed);
  const positions = new Float64Array(count * 3);
  const velocity = new Float64Array(count * 3);
  const force = new Float64Array(count * 3);
  const degree = new Uint32Array(count);
  for (let e = 0; e < edges.source.length; e += 1) {
    degree[edges.source[e]] += 1;
    degree[edges.target[e]] += 1;
  }
  const masses = new Float64Array(count);
  for (let i = 0; i < count; i += 1) masses[i] = 1 + degree[i] / 3;
  const stiffness = new Float64Array(edges.source.length).fill(settings.springCoefficient);
  if (community) {
    for (let e = 0; e < edges.source.length; e += 1) {
      if (community[edges.source[e]] !== community[edges.target[e]]) stiffness[e] *= settings.interCommunitySpring;
    }
  }

  // Start from the principal coordinates, scaled to roughly the size the
  // springs will settle at; a node without them starts beside its neighbours.
  const scale = settings.springLength * Math.cbrt(Math.max(count, 1)) * 0.6;
  const placed = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const x = seedPositions?.[i * 3];
    if (x === undefined || Number.isNaN(x)) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      positions[i * 3 + axis] = seedPositions[i * 3 + axis] * scale + (random() - 0.5) * settings.springLength * 0.1;
    }
    placed[i] = 1;
  }
  const neighbors = Array.from({ length: count }, () => []);
  for (let e = 0; e < edges.source.length; e += 1) {
    neighbors[edges.source[e]].push(edges.target[e]);
    neighbors[edges.target[e]].push(edges.source[e]);
  }
  for (let i = 0; i < count; i += 1) {
    if (placed[i]) continue;
    const anchors = neighbors[i].filter((j) => placed[j]);
    for (let axis = 0; axis < 3; axis += 1) {
      const around = anchors.length
        ? anchors.reduce((sum, j) => sum + positions[j * 3 + axis], 0) / anchors.length
        : 0;
      positions[i * 3 + axis] = around + (random() - 0.5) * (anchors.length ? settings.springLength : scale * 2);
    }
  }

  const tree = new Octree(count);
  // A traversal holds at most seven siblings per level of a tree whose depth
  // `insert` caps at 49, so this never overflows.
  const stack = new Int32Array(512);
  const iterations = Math.max(0, Math.floor(settings.iterations));
  for (let step = 0; step < iterations; step += 1) {
    force.fill(0);
    if (count > 1) {
      tree.build(positions, masses, count, random);
      for (let i = 0; i < count; i += 1) {
        tree.repel(i, positions, masses, settings.repulsion, settings.theta, force, stack);
      }
    }
    for (let e = 0; e < edges.source.length; e += 1) {
      const a = edges.source[e];
      const b = edges.target[e];
      const dx = positions[b * 3] - positions[a * 3];
      const dy = positions[b * 3 + 1] - positions[a * 3 + 1];
      const dz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const pull = stiffness[e] * (distance - settings.springLength) / distance;
      force[a * 3] += pull * dx; force[a * 3 + 1] += pull * dy; force[a * 3 + 2] += pull * dz;
      force[b * 3] -= pull * dx; force[b * 3 + 1] -= pull * dy; force[b * 3 + 2] -= pull * dz;
    }
    for (let i = 0; i < count; i += 1) {
      const coefficient = settings.timeStep / masses[i];
      let speedSquared = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const index = i * 3 + axis;
        const total = force[index]
          - settings.drag * velocity[index]
          - settings.centerPull * masses[i] * positions[index];
        velocity[index] += coefficient * total;
        speedSquared += velocity[index] * velocity[index];
      }
      // ngraph caps the speed at one unit per time step.
      if (speedSquared > 1) {
        const speed = Math.sqrt(speedSquared);
        for (let axis = 0; axis < 3; axis += 1) velocity[i * 3 + axis] /= speed;
      }
      for (let axis = 0; axis < 3; axis += 1) positions[i * 3 + axis] += settings.timeStep * velocity[i * 3 + axis];
    }
  }

  const center = [0, 0, 0];
  for (let i = 0; i < count; i += 1) for (let axis = 0; axis < 3; axis += 1) center[axis] += positions[i * 3 + axis] / count;
  const result = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) for (let axis = 0; axis < 3; axis += 1) result[i * 3 + axis] = positions[i * 3 + axis] - center[axis];
  return { positions: result, iterations };
}
