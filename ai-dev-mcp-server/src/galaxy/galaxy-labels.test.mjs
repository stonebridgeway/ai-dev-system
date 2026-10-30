import assert from "node:assert/strict";
import test from "node:test";
import { MAX_STAR_LABELS, chooseClusterLabels, chooseStarLabels, createBoxes } from "./galaxy-labels.mjs";

/** Stars at the given screen points, all visible with the given radius. */
function screen(points, radius = 3) {
  return {
    screenX: Float32Array.from(points.map(([x]) => x)),
    screenY: Float32Array.from(points.map(([, y]) => y)),
    screenRadius: Float32Array.from(points.map(([, , r = radius]) => r)),
    width: 800,
    height: 600,
    titles: points.map((_, i) => `star ${i}`)
  };
}

test("boxes refuse an overlap unless the space is reserved", () => {
  const boxes = createBoxes();
  assert.equal(boxes.fits(0, 0, 10, 10), true);
  assert.equal(boxes.fits(5, 5, 10, 10), false);
  assert.equal(boxes.fits(10, 0, 10, 10), true, "touching edges do not overlap");
  boxes.reserve(100, 100, 10, 10);
  assert.equal(boxes.fits(105, 105, 2, 2), false);
});

test("with labels on, the biggest stars are named and no two names collide", () => {
  const view = screen([[100, 100, 5], [102, 101, 9], [400, 300, 3], [900, 100, 9], [300, 300, 1], [200, 200, 0]]);
  const placed = chooseStarLabels({ ...view, focus: null, selected: -1, labelsOn: true, boxes: createBoxes() });
  // Star 1 outranks star 0, which sits under its name; 3 is off screen; 4 is
  // too small to name; 5 is behind the camera.
  assert.deepEqual(placed.map((label) => label.index), [1, 2]);
  assert.ok(placed.every((label) => !label.focus));
  assert.deepEqual(chooseStarLabels({ ...view, focus: null, selected: -1, labelsOn: false, boxes: createBoxes() }), []);
});

test("a selection names itself and its neighbours, even where names crowd", () => {
  const view = screen([[100, 100, 1], [101, 100, 1], [300, 300, 9], [500, 500, 1]]);
  const placed = chooseStarLabels({ ...view, focus: new Set([0, 1, 3]), selected: 0, labelsOn: true, boxes: createBoxes() });
  assert.equal(placed[0].index, 0);
  assert.ok(placed.every((label) => label.focus));
  // The neighbour under the selected name gives way; the far one is named; the
  // big star outside the selection is not.
  assert.deepEqual(placed.map((label) => label.index), [0, 3]);
});

test("long titles are cut, and there is a ceiling on names", () => {
  const points = Array.from({ length: 200 }, (_, i) => [(i % 20) * 40, Math.floor(i / 20) * 60, 5]);
  const view = screen(points);
  view.titles[0] = "x".repeat(80);
  const placed = chooseStarLabels({ ...view, focus: null, selected: -1, labelsOn: true, boxes: createBoxes() });
  assert.ok(placed.length <= MAX_STAR_LABELS);
  const first = placed.find((label) => label.index === 0);
  assert.equal(first.text.length, 48);
  assert.ok(first.text.endsWith("…"));
});

test("constellation names fade inside their constellation and skip the tiny ones", () => {
  const clusters = [
    { id: 0, label: "big", size: 400, center: [0, 0, -1000], radius: 100 },
    { id: 1, label: "near", size: 50, center: [0, 0, -10], radius: 100 },
    { id: 2, label: "tiny", size: 3, center: [50, 0, -1000], radius: 10 },
    { id: 3, label: "", size: 90, center: [80, 0, -1000], radius: 10 },
    { id: 4, label: "behind", size: 90, center: [0, 0, 1000], radius: 10 }
  ];
  const project = (point) => (point[2] < 0 ? { x: 400 + point[0], y: 300 + point[1] * 3 } : null);
  const placed = chooseClusterLabels({ clusters, project, camera: [0, 0, 0], width: 800, height: 600, count: 1000, boxes: createBoxes() });
  assert.deepEqual(placed.map((label) => label.label), ["big"]);
  assert.ok(placed[0].opacity > 0.8 && placed[0].opacity <= 0.85);
  assert.equal(placed[0].scale, 1.5);
});
