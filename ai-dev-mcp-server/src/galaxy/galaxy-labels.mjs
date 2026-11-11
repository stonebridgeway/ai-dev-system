/**
 * Which stars and constellations get a name on screen, and where.
 *
 * Browser code, inlined into the page with the rest of `src/galaxy/` by
 * `src/core/galaxy-page.mjs`, and pure, so `galaxy-labels.test.mjs` runs it in
 * Node. The rule is the one a map uses: the biggest names first, and no name
 * printed over another.
 */

/** Most star names on screen at once. */
export const MAX_STAR_LABELS = 60;

/** Most constellation names on screen at once. */
export const MAX_CLUSTER_LABELS = 24;

/** Longest star name shown before it is cut with an ellipsis. */
const LABEL_CHARACTERS = 48;

/** Rectangles already taken on screen. */
export function createBoxes() {
  const boxes = [];
  const overlaps = (x, y, w, h) => boxes.some((box) => x < box[2] && x + w > box[0] && y < box[3] && y + h > box[1]);
  return {
    /** Take the rectangle if it is free; say whether it was. */
    fits(x, y, w, h) {
      if (overlaps(x, y, w, h)) return false;
      boxes.push([x, y, x + w, y + h]);
      return true;
    },
    /** Take the rectangle whatever is under it. */
    reserve(x, y, w, h) {
      boxes.push([x, y, x + w, y + h]);
    }
  };
}

/**
 * Star names: the selected star always; its neighbours or the search matches
 * when something is picked out; otherwise, with labels on, the stars that look
 * biggest from here.
 *
 * @param {object} input
 * @param {Float32Array} input.screenX
 * @param {Float32Array} input.screenY
 * @param {Float32Array} input.screenRadius - 0 for a star behind the camera.
 * @param {number} input.width
 * @param {number} input.height
 * @param {string[]} input.titles
 * @param {Set<number> | null} input.focus
 * @param {number} input.selected - −1 for none.
 * @param {boolean} input.labelsOn
 * @param {ReturnType<typeof createBoxes>} input.boxes
 * @returns {Array<{ index: number, x: number, y: number, text: string, focus: boolean }>}
 */
export function chooseStarLabels({ screenX, screenY, screenRadius, width, height, titles, focus, selected, labelsOn, boxes }) {
  if (!labelsOn && !focus) return [];
  const candidates = [];
  for (let i = 0; i < titles.length; i += 1) {
    if (screenRadius[i] <= 0) continue;
    if (screenX[i] < -40 || screenX[i] > width + 40 || screenY[i] < -20 || screenY[i] > height + 20) continue;
    if (i === selected) candidates.push([Infinity, i]);
    else if (focus?.has(i) && (selected >= 0 || screenRadius[i] > 1.2)) candidates.push([1000 + screenRadius[i], i]);
    else if (labelsOn && !focus && screenRadius[i] > 2.4) candidates.push([screenRadius[i], i]);
  }
  candidates.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const placed = [];
  for (const [, i] of candidates) {
    if (placed.length >= MAX_STAR_LABELS) break;
    const title = titles[i];
    const labelWidth = Math.min(title.length, LABEL_CHARACTERS) * 6.4 + 10;
    const x = screenX[i] + Math.max(screenRadius[i] * 0.5, 2);
    const y = screenY[i] - 8;
    if (i === selected) boxes.reserve(x, y, labelWidth, 15);
    else if (!boxes.fits(x, y, labelWidth, 15)) continue;
    placed.push({
      index: i,
      x,
      y,
      text: title.length > LABEL_CHARACTERS ? `${title.slice(0, LABEL_CHARACTERS - 1)}…` : title,
      focus: i === selected || Boolean(focus?.has(i))
    });
  }
  return placed;
}

/**
 * Constellation names, largest first. A name reads from outside its
 * constellation and fades as the camera enters it, where the stars' own names
 * take over.
 *
 * @param {object} input
 * @param {Array<{ id: number, label: string, size: number, center: number[], radius: number }>} input.clusters
 * @param {(point: number[]) => { x: number, y: number } | null} input.project
 * @param {number[]} input.camera - Camera position.
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} input.count - Stars in the galaxy; tiny constellations are not named.
 * @param {ReturnType<typeof createBoxes>} input.boxes
 * @returns {Array<{ id: number, label: string, x: number, y: number, scale: number, opacity: number }>}
 */
export function chooseClusterLabels({ clusters, project, camera, width, height, count, boxes }) {
  const ranked = clusters
    .filter((item) => item.label && item.size >= Math.max(8, count / 400))
    .map((item) => ({ item, at: project(item.center) }))
    .filter(({ at }) => at && at.x > -100 && at.x < width + 100 && at.y > -40 && at.y < height + 40)
    .sort((a, b) => b.item.size - a.item.size || a.item.id - b.item.id);
  const placed = [];
  for (const { item, at } of ranked) {
    if (placed.length >= MAX_CLUSTER_LABELS) break;
    const distance = Math.hypot(item.center[0] - camera[0], item.center[1] - camera[1], item.center[2] - camera[2]);
    const fade = Math.max(0, Math.min(1, (distance - item.radius * 0.8) / (item.radius * 1.5 || 1)));
    if (fade < 0.05) continue;
    const scale = Math.max(0.8, Math.min(1.5, 0.7 + item.size / 300));
    const labelWidth = item.label.length * 9 * scale + 10;
    const x = at.x - labelWidth / 2;
    const y = at.y - 10;
    if (!boxes.fits(x, y, labelWidth, 20 * scale)) continue;
    placed.push({ id: item.id, label: item.label, x, y, scale, opacity: 0.35 + 0.5 * fade });
  }
  return placed;
}
