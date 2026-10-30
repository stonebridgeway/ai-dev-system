import assert from "node:assert/strict";
import test from "node:test";
import {
  GALAXY_EXPORT_SCHEMA,
  MAX_GALAXY_DOCUMENTS,
  composeGalaxy,
  parseGalaxyExport,
  selectGalaxyDocuments
} from "./galaxy.mjs";
import { seededRandom } from "./galaxy-graph.mjs";

const DIMS = 16;

/** An export of `groups` × `size` documents whose keyword vectors cluster. */
function exportOf({ groups = 3, size = 10, dense = false } = {}) {
  const random = seededRandom(9);
  const count = groups * size;
  const semantic = new Float32Array(count * DIMS);
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const group = Math.floor(i / size);
    // Each group owns a band of dimensions, plus a little noise everywhere.
    for (let d = 0; d < DIMS; d += 1) semantic[i * DIMS + d] = (Math.floor(d / 5) === group ? 1 : 0) + random() * 0.05;
    nodes.push({
      id: `${i}`.padStart(40, "0"),
      title: `${["react hooks", "postgres vacuum", "docker compose"][group]} ${i}`,
      path: `02-knowledge/n${i}.md`,
      scope: group === 2 ? "workflows" : "knowledge",
      source: "vault-note",
      categories: "",
      preview: `note ${i}`,
      dense: dense ? i : -1,
      links: i === 0 ? [`n${size}`] : []
    });
  }
  const manifest = {
    schema: GALAXY_EXPORT_SCHEMA,
    document_count: count,
    semantic_dimensions: DIMS,
    dense_dimensions: dense ? DIMS : 0,
    dense_documents: dense ? count : 0,
    dense_model: dense ? "BAAI/bge-m3" : "",
    nodes
  };
  const bytes = (array) => new Uint8Array(array.buffer.slice(0));
  return { manifest, semanticBytes: bytes(semantic), denseBytes: dense ? bytes(semantic) : new Uint8Array(0) };
}

test("an export is checked against the format the helper promised", () => {
  const good = exportOf();
  const parsed = parseGalaxyExport(good);
  assert.equal(parsed.nodes.length, 30);
  assert.equal(parsed.semantic.length, 30 * DIMS);
  assert.equal(parsed.dense.length, 0);
  assert.throws(() => parseGalaxyExport({ ...good, manifest: { ...good.manifest, schema: 99 } }), /schema 99/);
  assert.throws(() => parseGalaxyExport({ ...good, manifest: null }), /schema missing/);
  assert.throws(() => parseGalaxyExport({ ...good, semanticBytes: good.semanticBytes.subarray(0, 8) }), /semantic values/);
  assert.throws(() => parseGalaxyExport({ ...good, semanticBytes: good.semanticBytes.subarray(0, 7) }), /whole number/);
  const dense = exportOf({ dense: true });
  assert.equal(parseGalaxyExport(dense).dense.length, 30 * DIMS);
  assert.throws(() => parseGalaxyExport({ ...dense, denseBytes: new Uint8Array(0) }), /dense values/);
  // A Buffer from a pool starts at an unaligned offset; the parser copies.
  const pooled = Buffer.concat([Buffer.from([1]), Buffer.from(good.semanticBytes)]).subarray(1);
  assert.equal(parseGalaxyExport({ ...good, semanticBytes: pooled }).semantic[0], parsed.semantic[0]);
});

test("scopes narrow the galaxy without copying the vectors", () => {
  const { nodes } = parseGalaxyExport(exportOf());
  const chosen = selectGalaxyDocuments(nodes, { scopes: ["Workflows"] });
  assert.equal(chosen.length, 10);
  assert.deepEqual(chosen.map((node) => node.semantic), Array.from({ length: 10 }, (_, i) => 20 + i));
  assert.equal(selectGalaxyDocuments(nodes).length, 30);
  assert.throws(() => selectGalaxyDocuments(nodes, { scopes: ["planets"] }), /Unknown scope: planets/);
  const many = Array.from({ length: MAX_GALAXY_DOCUMENTS + 1 }, () => ({ scope: "skills" }));
  assert.throws(() => selectGalaxyDocuments(many), /Narrow it with scopes/);
});

test("composeGalaxy turns an export into a page model with named constellations", () => {
  let tick = 0;
  const { model, summary } = composeGalaxy(parseGalaxyExport(exportOf()), {
    neighbors: 4,
    iterations: 40,
    meta: { vault: "v" },
    clock: () => (tick += 10)
  });
  assert.equal(summary.documents, 30);
  assert.equal(summary.space, "sparse");
  assert.equal(summary.dense_model, "");
  assert.equal(summary.link_edges, 1);
  assert.equal(summary.constellations, 3);
  assert.deepEqual(
    summary.largest_constellations.map((item) => item.label).sort(),
    ["compose · docker", "hooks · react", "postgres · vacuum"]
  );
  assert.deepEqual(summary.timings, { graph_ms: 10, clusters_ms: 10, layout_ms: 10 });
  assert.equal(summary.layout_iterations, 40);
  assert.equal(model.nodes.title.length, 30);
  assert.equal(model.counts.documents, 30);
  assert.equal(model.vault, "v");
  assert.equal(model.space, "sparse");

  const dense = composeGalaxy(parseGalaxyExport(exportOf({ dense: true })), { neighbors: 4, iterations: 10 });
  assert.equal(dense.summary.space, "dense");
  assert.equal(dense.summary.dense_model, "BAAI/bge-m3");

  const narrowed = composeGalaxy(parseGalaxyExport(exportOf()), { scopes: ["workflows"], iterations: 10 });
  assert.equal(narrowed.summary.documents, 10);
  assert.throws(() => composeGalaxy(parseGalaxyExport(exportOf()), { scopes: ["projects"] }), /No documents/);
});
