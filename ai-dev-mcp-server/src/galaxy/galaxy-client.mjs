/**
 * The Knowledge Galaxy viewer.
 *
 * Browser code, inlined into the page with the rest of `src/galaxy/` by
 * `src/core/galaxy-page.mjs`: no dependencies, no requests. Navigation follows
 * anvaka's Software Galaxies (https://github.com/anvaka/pm), so a reader who
 * has flown one can fly this: WASD to move, arrows to turn, Q/E to roll, R/F to
 * rise and sink, Shift to go faster, Space for steering mode, L for links, H
 * for help, and the camera kept in the address so a view can be bookmarked.
 *
 * `bootGalaxy` needs a document and WebGL, which `node --test` has neither of:
 * it is checked by driving the generated page in Chromium, and `window.galaxy`
 * is the read-only handle such a probe reads the camera and selection from.
 * Everything that can be pure is, in the sibling modules, and tested in Node.
 */
import {
  COLOR_MODES,
  FOV,
  SCOPE_COLORS,
  SMALL_CLUSTER,
  cameraBasis,
  clusterColor,
  cssColor,
  decodeBase64,
  easeInOut,
  formatViewHash,
  normalize3,
  parseViewHash,
  perspectiveMatrix,
  quatAxisAngle,
  quatLookAt,
  quatMultiply,
  quatNormalize,
  quatRotate,
  quatSlerp,
  searchNodes,
  viewMatrix
} from "./galaxy-math.mjs";
import { HELD_KEYS, TEXT, pickText } from "./galaxy-text.mjs";
import { createStarRenderer } from "./galaxy-gl.mjs";
import { buildChrome, colorDot, element, renderDetails } from "./galaxy-panels.mjs";
import { chooseClusterLabels, chooseStarLabels, createBoxes } from "./galaxy-labels.mjs";

/**
 * Start the viewer on the page's data block.
 *
 * @param {HTMLScriptElement} dataElement
 */
export function bootGalaxy(dataElement) {
  const model = JSON.parse(dataElement.textContent || "{}");
  const text = pickText(navigator.language);
  document.documentElement.lang = text === TEXT.ru ? "ru" : "en";

  const count = model.nodes.title.length;
  const positions = decodeBase64(model.positions, Float32Array);
  const pairs = decodeBase64(model.edges.pairs, Uint32Array);
  const edgeWeight = decodeBase64(model.edges.weight, Uint8Array);
  const edgeKind = decodeBase64(model.edges.kind, Uint8Array);
  const edgeCount = edgeWeight.length;
  const titles = model.nodes.title;
  const paths = model.nodes.path;
  const cluster = model.nodes.cluster;

  // Neighbour lists, degree, sizes, and the scale everything else is set by.
  const neighbors = Array.from({ length: count }, () => []);
  const edgeLengths = new Float32Array(edgeCount);
  for (let e = 0; e < edgeCount; e += 1) {
    const a = pairs[e * 2];
    const b = pairs[e * 2 + 1];
    neighbors[a].push(e);
    neighbors[b].push(e);
    edgeLengths[e] = Math.hypot(
      positions[a * 3] - positions[b * 3],
      positions[a * 3 + 1] - positions[b * 3 + 1],
      positions[a * 3 + 2] - positions[b * 3 + 2]
    );
  }
  const center = [0, 0, 0];
  for (let i = 0; i < count; i += 1) for (let axis = 0; axis < 3; axis += 1) center[axis] += positions[i * 3 + axis] / Math.max(count, 1);
  const distances = [];
  for (let i = 0; i < count; i += 1) {
    distances.push(Math.hypot(positions[i * 3] - center[0], positions[i * 3 + 1] - center[1], positions[i * 3 + 2] - center[2]));
  }
  distances.sort((a, b) => a - b);
  const radius = Math.max(distances[Math.floor(distances.length * 0.95)] || 1, 1);
  const sortedLengths = Array.from(edgeLengths).sort((a, b) => a - b);
  const typicalEdge = sortedLengths[Math.floor(sortedLengths.length / 2)] || radius / 10;
  let maxDegree = 1;
  for (let i = 0; i < count; i += 1) maxDegree = Math.max(maxDegree, neighbors[i].length);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i += 1) sizes[i] = typicalEdge * (0.1 + 0.22 * Math.sqrt(neighbors[i].length / maxDegree));

  const clusters = model.clusters.map((item, id) => ({ ...item, id, center: [0, 0, 0], radius: 0 }));
  for (let i = 0; i < count; i += 1) {
    const target = clusters[cluster[i]];
    if (!target) continue;
    for (let axis = 0; axis < 3; axis += 1) target.center[axis] += positions[i * 3 + axis] / target.size;
  }
  for (let i = 0; i < count; i += 1) {
    const target = clusters[cluster[i]];
    if (!target) continue;
    const d = Math.hypot(positions[i * 3] - target.center[0], positions[i * 3 + 1] - target.center[1], positions[i * 3 + 2] - target.center[2]);
    target.radius += d / target.size;
  }
  const idIndex = new Map(model.nodes.id.map((id, index) => [id, index]));

  // --------------------------------------------------------------- state
  const initial = parseViewHash(location.hash);
  const state = {
    position: initial.camera?.position ?? [center[0], center[1], center[2] + radius * 2.4],
    quaternion: initial.camera?.quaternion ?? [0, 0, 0, 1],
    velocity: [0, 0, 0],
    speed: initial.speed,
    links: initial.links,
    labels: initial.labels,
    color: initial.color,
    maxLink: initial.maxLink > 0 ? initial.maxLink : sortedLengths[Math.floor(sortedLengths.length * 0.6)] || typicalEdge,
    steering: false,
    held: new Set(),
    shift: false,
    selected: -1,
    hovered: -1,
    matches: null,
    flight: null,
    touch: null,
    pointer: { x: innerWidth / 2, y: innerHeight / 2, inside: false },
    dirty: true,
    lastHash: ""
  };

  // ----------------------------------------------------------------- DOM
  const {
    canvas, labelLayer, steer, search, searchCount, results, buttons,
    stats, speedLabel, details, tooltip, help
  } = buildChrome(text, model.title);

  const spaceName = text.spaces[model.space] || model.space || "";
  stats.textContent = text.stats({
    stars: count.toLocaleString(),
    edges: edgeCount.toLocaleString(),
    clusters: clusters.filter((item) => item.size >= SMALL_CLUSTER).length,
    space: spaceName
  });

  const renderer = createStarRenderer(canvas, { positions, sizes });
  if (!renderer) {
    document.body.textContent = "";
    document.body.append(element("div", { id: "fallback", text: text.noWebgl }));
    return;
  }

  const colors = new Float32Array(count * 3);
  const glow = new Float32Array(count);

  function nodeColor(i) {
    if (state.color === "scope") return SCOPE_COLORS[model.scopes[model.nodes.scope[i]]] || [0.8, 0.82, 0.9];
    if (state.color === "white") {
      const tint = ((i * 2654435761) >>> 0) / 4294967296;
      return [0.86 + tint * 0.1, 0.88 + tint * 0.04, 0.96 - tint * 0.08];
    }
    const id = cluster[i];
    return clusterColor(id, clusters[id]?.size ?? 0);
  }

  function refreshColors() {
    for (let i = 0; i < count; i += 1) colors.set(nodeColor(i), i * 3);
    renderer.setColors(colors);
    buttons.color.textContent = `${text.colors[state.color]} (C)`;
    buildAllLines();
    buildFocusLines();
    state.dirty = true;
  }

  /** Segments for `list` of [edge, alpha]; wikilinks are drawn warm, the rest in their stars' colours. */
  function setLines(name, list) {
    const position = new Float32Array(list.length * 6);
    const color = new Float32Array(list.length * 8);
    list.forEach(([e, alpha], index) => {
      const a = pairs[e * 2];
      const b = pairs[e * 2 + 1];
      position.set(positions.subarray(a * 3, a * 3 + 3), index * 6);
      position.set(positions.subarray(b * 3, b * 3 + 3), index * 6 + 3);
      const link = edgeKind[e] === model.edges.link_kind;
      const ca = link ? [1, 0.86, 0.55] : colors.subarray(a * 3, a * 3 + 3);
      const cb = link ? [1, 0.86, 0.55] : colors.subarray(b * 3, b * 3 + 3);
      color.set([ca[0], ca[1], ca[2], alpha], index * 8);
      color.set([cb[0], cb[1], cb[2], alpha], index * 8 + 4);
    });
    renderer.setLines(name, position, color);
  }

  // Software Galaxies draws only the short links by default: all of them is a
  // hairball that hides the stars. `ml` in the address sets the cut-off.
  function buildAllLines() {
    const list = [];
    for (let e = 0; e < edgeCount; e += 1) {
      if (edgeLengths[e] > state.maxLink && edgeKind[e] !== model.edges.link_kind) continue;
      list.push([e, edgeKind[e] === model.edges.link_kind ? 0.2 : 0.07]);
    }
    setLines("all", list);
  }

  function buildFocusLines() {
    setLines("focus", state.selected >= 0 ? neighbors[state.selected].map((e) => [e, 0.75]) : []);
  }

  function focusSet() {
    if (state.selected >= 0) {
      const set = new Set([state.selected]);
      for (const e of neighbors[state.selected]) { set.add(pairs[e * 2]); set.add(pairs[e * 2 + 1]); }
      return set;
    }
    return state.matches ? new Set(state.matches) : null;
  }

  function refreshGlow() {
    const focus = focusSet();
    for (let i = 0; i < count; i += 1) glow[i] = focus ? (focus.has(i) ? 1.35 : 0.16) : 1;
    if (state.selected >= 0) glow[state.selected] = 2;
    if (state.hovered >= 0) glow[state.hovered] = 2;
    renderer.setGlow(glow);
    state.dirty = true;
  }

  // ---------------------------------------------------------- projection
  const screenX = new Float32Array(count);
  const screenY = new Float32Array(count);
  const screenDepth = new Float32Array(count);
  const screenRadius = new Float32Array(count);
  let frame = { width: 1, height: 1, focal: 1, basis: cameraBasis(state.quaternion) };

  function project() {
    const width = innerWidth;
    const height = innerHeight;
    const focal = (height / 2) / Math.tan(FOV / 2);
    const basis = cameraBasis(state.quaternion);
    const [px, py, pz] = state.position;
    const { right: r, up: u, back: b } = basis;
    for (let i = 0; i < count; i += 1) {
      const dx = positions[i * 3] - px;
      const dy = positions[i * 3 + 1] - py;
      const dz = positions[i * 3 + 2] - pz;
      const depth = -(b[0] * dx + b[1] * dy + b[2] * dz);
      screenDepth[i] = depth;
      if (depth <= 0.5) { screenRadius[i] = 0; continue; }
      screenX[i] = width / 2 + ((r[0] * dx + r[1] * dy + r[2] * dz) / depth) * focal;
      screenY[i] = height / 2 - ((u[0] * dx + u[1] * dy + u[2] * dz) / depth) * focal;
      screenRadius[i] = (sizes[i] * focal) / depth / 2;
    }
    frame = { width, height, focal, basis };
  }

  function projectPoint(point) {
    const { right: r, up: u, back: b } = frame.basis;
    const dx = point[0] - state.position[0];
    const dy = point[1] - state.position[1];
    const dz = point[2] - state.position[2];
    const depth = -(b[0] * dx + b[1] * dy + b[2] * dz);
    if (depth <= 0.5) return null;
    return {
      x: frame.width / 2 + ((r[0] * dx + r[1] * dy + r[2] * dz) / depth) * frame.focal,
      y: frame.height / 2 - ((u[0] * dx + u[1] * dy + u[2] * dz) / depth) * frame.focal,
      depth
    };
  }

  function pick(x, y) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < count; i += 1) {
      if (screenRadius[i] <= 0) continue;
      const dx = screenX[i] - x;
      const dy = screenY[i] - y;
      const reach = Math.max(8, screenRadius[i] * 1.2);
      const distance = dx * dx + dy * dy;
      if (distance > reach * reach) continue;
      // Prefer the star under the cursor, then the nearer one.
      const score = Math.sqrt(distance) / reach + screenDepth[i] / (radius * 40);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // -------------------------------------------------------------- labels
  const starLabels = [];
  const clusterLabels = [];
  const labelFor = (pool, className) => {
    const node = element("div", { className });
    labelLayer.append(node);
    pool.push(node);
    return node;
  };

  function placeLabels() {
    const boxes = createBoxes();
    const focus = focusSet();
    const stars = chooseStarLabels({
      screenX, screenY, screenRadius, width: frame.width, height: frame.height, titles,
      focus, selected: state.selected, labelsOn: state.labels, boxes
    });
    stars.forEach((label, slot) => {
      const node = starLabels[slot] || labelFor(starLabels, "star-label");
      node.textContent = label.text;
      node.className = label.focus ? "star-label focus" : "star-label";
      node.style.transform = `translate(${Math.round(label.x)}px, ${Math.round(label.y)}px)`;
      node.hidden = false;
    });
    const names = state.labels && state.selected < 0
      ? chooseClusterLabels({ clusters, project: projectPoint, camera: state.position, width: frame.width, height: frame.height, count, boxes })
      : [];
    names.forEach((label, slot) => {
      const node = clusterLabels[slot] || labelFor(clusterLabels, "cluster-label");
      node.textContent = label.label;
      node.style.color = cssColor(state.color === "cluster" ? clusterColor(label.id, clusters[label.id].size) : [0.8, 0.84, 0.95]);
      node.style.opacity = String(label.opacity);
      node.style.transform = `translate(${Math.round(label.x)}px, ${Math.round(label.y)}px) scale(${label.scale.toFixed(2)})`;
      node.hidden = false;
    });
    for (let i = stars.length; i < starLabels.length; i += 1) starLabels[i].hidden = true;
    for (let i = names.length; i < clusterLabels.length; i += 1) clusterLabels[i].hidden = true;
  }

  // ------------------------------------------------------------- details
  function showDetails(i) {
    if (i < 0) { renderDetails(details, null); return; }
    const other = (e) => (pairs[e * 2] === i ? pairs[e * 2 + 1] : pairs[e * 2]);
    const constellation = clusters[cluster[i]];
    renderDetails(details, {
      text,
      title: titles[i],
      path: paths[i],
      preview: model.nodes.preview[i],
      scope: model.scopes[model.nodes.scope[i]],
      source: model.sources[model.nodes.source[i]],
      constellation: constellation?.label || "",
      color: cssColor(nodeColor(i)),
      obsidianHref: model.nodes.note[i] && model.obsidian_vault
        ? `obsidian://open?vault=${encodeURIComponent(model.obsidian_vault)}&file=${encodeURIComponent(paths[i])}`
        : "",
      nearest: neighbors[i]
        .filter((e) => edgeKind[e] !== model.edges.link_kind || edgeWeight[e] > 0)
        .map((e) => ({ index: other(e), score: edgeWeight[e] / 255 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 16),
      linked: neighbors[i].filter((e) => edgeKind[e] === model.edges.link_kind).map((e) => ({ index: other(e) })).slice(0, 40),
      titleOf: (index) => titles[index],
      colorOf: (index) => cssColor(nodeColor(index)),
      onPick: (index) => { select(index); flyTo(index); },
      onClose: () => select(-1),
      onFly: () => flyTo(i)
    });
  }

  function select(i) {
    state.selected = i;
    buildFocusLines();
    refreshGlow();
    showDetails(i);
    state.hashDirty = true;
  }

  // -------------------------------------------------------------- flight
  function flyTo(i, { distance = typicalEdge * 2.5 } = {}) {
    const target = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    let direction = [target[0] - state.position[0], target[1] - state.position[1], target[2] - state.position[2]];
    if (Math.hypot(...direction) < 1e-3) direction = quatRotate(state.quaternion, [0, 0, -1]);
    direction = normalize3(direction);
    const up = quatRotate(state.quaternion, [0, 1, 0]);
    startFlight(
      [target[0] - direction[0] * distance, target[1] - direction[1] * distance, target[2] - direction[2] * distance],
      quatLookAt(direction, up)
    );
  }

  function overview() {
    const forward = quatRotate(state.quaternion, [0, 0, -1]);
    const distance = radius * 2.4;
    startFlight([center[0] - forward[0] * distance, center[1] - forward[1] * distance, center[2] - forward[2] * distance], state.quaternion);
  }

  function startFlight(position, quaternion) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    state.flight = {
      from: [...state.position], to: position,
      fromQ: [...state.quaternion], toQ: quaternion,
      start: performance.now(), duration: reduced ? 1 : 1100
    };
    state.velocity = [0, 0, 0];
  }

  // ------------------------------------------------------------- controls
  function rotateLocal(axis, angle) {
    state.quaternion = quatNormalize(quatMultiply(state.quaternion, quatAxisAngle(axis, angle)));
    state.dirty = true;
  }

  function typing(event) {
    const tag = event.target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
  }

  function toggle(name) {
    if (name === "links") state.links = !state.links;
    if (name === "labels") state.labels = !state.labels;
    if (name === "steering") {
      state.steering = !state.steering;
      canvas.classList.toggle("steering", state.steering);
      steer.hidden = !state.steering;
    }
    if (name === "color") {
      state.color = COLOR_MODES[(COLOR_MODES.indexOf(state.color) + 1) % COLOR_MODES.length];
      refreshColors();
      if (state.selected >= 0) showDetails(state.selected);
    }
    if (name === "help") help.hidden = !help.hidden;
    syncButtons();
    state.dirty = true;
    state.hashDirty = true;
  }

  function syncButtons() {
    buttons.links.setAttribute("aria-pressed", String(state.links));
    buttons.labels.setAttribute("aria-pressed", String(state.labels));
    buttons.steering.setAttribute("aria-pressed", String(state.steering));
    buttons.help.setAttribute("aria-pressed", String(!help.hidden));
    speedLabel.textContent = text.speed(Number(state.speed.toFixed(2)));
  }

  buttons.links.addEventListener("click", () => toggle("links"));
  buttons.labels.addEventListener("click", () => toggle("labels"));
  buttons.color.addEventListener("click", () => toggle("color"));
  buttons.steering.addEventListener("click", () => toggle("steering"));
  buttons.help.addEventListener("click", () => toggle("help"));
  buttons.overview.addEventListener("click", overview);

  addEventListener("keydown", (event) => {
    if (typing(event)) {
      if (event.key === "Escape") { search.value = ""; runSearch(); canvas.focus(); }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") { event.preventDefault(); search.focus(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    state.shift = event.shiftKey;
    if (HELD_KEYS[event.code]) {
      state.held.add(HELD_KEYS[event.code]);
      state.flight = null;
      event.preventDefault();
      return;
    }
    if (event.code === "Space") { event.preventDefault(); toggle("steering"); }
    else if (event.code === "KeyL") toggle("links");
    else if (event.code === "KeyT") toggle("labels");
    else if (event.code === "KeyC") toggle("color");
    else if (event.code === "KeyH" || (event.code === "Slash" && event.shiftKey)) toggle("help");
    else if (event.code === "Slash") { event.preventDefault(); search.focus(); }
    else if (event.code === "Equal" || event.code === "NumpadAdd") { state.speed = Math.min(state.speed * 1.5, 50); syncButtons(); }
    else if (event.code === "Minus" || event.code === "NumpadSubtract") { state.speed = Math.max(state.speed / 1.5, 0.05); syncButtons(); }
    else if (event.code === "Digit0" || event.code === "Home") overview();
    else if (event.code === "Escape") {
      if (!help.hidden) toggle("help");
      else if (state.selected >= 0) select(-1);
      else if (state.matches) { search.value = ""; runSearch(); }
    }
  });
  addEventListener("keyup", (event) => {
    state.shift = event.shiftKey;
    if (HELD_KEYS[event.code]) state.held.delete(HELD_KEYS[event.code]);
  });
  addEventListener("blur", () => { state.held.clear(); state.shift = false; });

  // Pointer: drag to look, click to select, double click to fly.
  let drag = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    canvas.focus();
    drag = { x: event.clientX, y: event.clientY, moved: 0 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    state.pointer = { x: event.clientX, y: event.clientY, inside: true };
    if (drag && event.pointerType !== "touch") {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.moved > 4 && !state.steering) {
        canvas.classList.add("dragging");
        rotateLocal([0, 1, 0], -dx * 0.004);
        rotateLocal([1, 0, 0], -dy * 0.004);
        state.flight = null;
      }
    }
    state.hoverDirty = true;
  });
  canvas.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch") return;
    canvas.classList.remove("dragging");
    if (drag && drag.moved <= 4) {
      const hit = pick(event.clientX, event.clientY);
      select(hit);
    }
    drag = null;
  });
  canvas.addEventListener("pointerleave", () => {
    state.pointer.inside = false;
    state.hoverDirty = true;
  });
  canvas.addEventListener("dblclick", (event) => {
    const hit = pick(event.clientX, event.clientY);
    if (hit >= 0) { select(hit); flyTo(hit); }
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const forward = quatRotate(state.quaternion, [0, 0, -1]);
    const step = -Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 200) * radius * 0.0008 * state.speed;
    for (let axis = 0; axis < 3; axis += 1) state.position[axis] += forward[axis] * step;
    state.flight = null;
    state.dirty = true;
  }, { passive: false });

  // Touch, as in Software Galaxies: drag to look, hold one finger to fly
  // forward, two to fly back, tap to select.
  canvas.addEventListener("touchstart", (event) => {
    event.preventDefault();
    const touch = event.touches[0];
    state.touch = { x: touch.clientX, y: touch.clientY, moved: 0, fingers: event.touches.length, start: performance.now() };
  }, { passive: false });
  canvas.addEventListener("touchmove", (event) => {
    event.preventDefault();
    if (!state.touch) return;
    const touch = event.touches[0];
    const dx = touch.clientX - state.touch.x;
    const dy = touch.clientY - state.touch.y;
    state.touch.moved += Math.abs(dx) + Math.abs(dy);
    state.touch.x = touch.clientX;
    state.touch.y = touch.clientY;
    if (event.touches.length === 1) {
      rotateLocal([0, 1, 0], -dx * 0.005);
      rotateLocal([1, 0, 0], -dy * 0.005);
    }
  }, { passive: false });
  canvas.addEventListener("touchend", (event) => {
    event.preventDefault();
    if (state.touch && event.touches.length === 0) {
      if (state.touch.moved < 8 && performance.now() - state.touch.start < 250) {
        select(pick(state.touch.x, state.touch.y));
      }
      state.touch = null;
    } else if (state.touch) {
      state.touch.fingers = event.touches.length;
    }
  }, { passive: false });

  // --------------------------------------------------------------- search
  let activeResult = -1;
  let resultIndices = [];
  function runSearch() {
    const query = search.value.trim();
    results.textContent = "";
    activeResult = -1;
    if (!query) {
      state.matches = null;
      searchCount.hidden = true;
      resultIndices = [];
      refreshGlow();
      return;
    }
    const all = searchNodes(titles, paths, query, 0);
    state.matches = all;
    searchCount.hidden = false;
    searchCount.textContent = text.matches(all.length);
    resultIndices = all.slice(0, 12);
    resultIndices.forEach((index, position) => {
      const item = element("li", { role: "option", "aria-selected": "false" }, [
        colorDot(cssColor(nodeColor(index))),
        element("div", {}, [element("div", { className: "result-title", text: titles[index] }), element("div", { className: "result-path", text: paths[index] })])
      ]);
      item.addEventListener("mousedown", (event) => { event.preventDefault(); choose(position); });
      results.append(item);
    });
    refreshGlow();
  }
  function choose(position) {
    const index = resultIndices[position];
    if (index === undefined) return;
    results.hidden = true;
    search.blur();
    canvas.focus();
    select(index);
    flyTo(index);
  }
  search.addEventListener("input", () => { results.hidden = false; runSearch(); });
  search.addEventListener("focus", () => { results.hidden = false; });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [...results.children];
      if (!items.length) return;
      activeResult = (activeResult + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((item, position) => item.setAttribute("aria-selected", String(position === activeResult)));
      items[activeResult].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      choose(Math.max(activeResult, 0));
    }
  });

  // --------------------------------------------------------------- frame
  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * ratio);
    canvas.height = Math.round(innerHeight * ratio);
    steer.width = innerWidth;
    steer.height = innerHeight;
    state.dirty = true;
  }
  addEventListener("resize", resize);
  addEventListener("hashchange", () => {
    if (location.hash === state.lastHash) return;
    const next = parseViewHash(location.hash);
    if (next.camera) {
      state.position = next.camera.position;
      state.quaternion = next.camera.quaternion;
      state.dirty = true;
    }
  });

  function drawSteering() {
    const context = steer.getContext("2d");
    context.clearRect(0, 0, steer.width, steer.height);
    if (!state.steering) return;
    const cx = steer.width / 2;
    const cy = steer.height / 2;
    context.strokeStyle = "rgba(158, 197, 255, 0.55)";
    context.lineWidth = 1;
    context.beginPath();
    context.arc(cx, cy, 14, 0, Math.PI * 2);
    context.moveTo(cx, cy);
    context.lineTo(state.pointer.x, state.pointer.y);
    context.stroke();
  }

  function updateMotion(dt) {
    if (state.flight) {
      const t = Math.min((performance.now() - state.flight.start) / state.flight.duration, 1);
      const k = easeInOut(t);
      state.position = state.flight.from.map((value, axis) => value + (state.flight.to[axis] - value) * k);
      state.quaternion = quatNormalize(quatSlerp(state.flight.fromQ, state.flight.toQ, k));
      if (t >= 1) state.flight = null;
      state.dirty = true;
      return;
    }
    const held = state.held;
    const turn = 1.1 * dt * (state.shift ? 1.8 : 1);
    if (held.has("yawLeft")) rotateLocal([0, 1, 0], turn);
    if (held.has("yawRight")) rotateLocal([0, 1, 0], -turn);
    if (held.has("pitchUp")) rotateLocal([1, 0, 0], turn);
    if (held.has("pitchDown")) rotateLocal([1, 0, 0], -turn);
    if (held.has("rollLeft")) rotateLocal([0, 0, 1], turn);
    if (held.has("rollRight")) rotateLocal([0, 0, 1], -turn);
    if (state.steering && state.pointer.inside) {
      const nx = (state.pointer.x - innerWidth / 2) / (innerWidth / 2);
      const ny = (state.pointer.y - innerHeight / 2) / (innerHeight / 2);
      const dead = (value) => (Math.abs(value) < 0.06 ? 0 : value - Math.sign(value) * 0.06);
      if (dead(nx)) rotateLocal([0, 1, 0], -dead(nx) * 1.4 * dt);
      if (dead(ny)) rotateLocal([1, 0, 0], -dead(ny) * 1.4 * dt);
    }
    const local = [
      (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0),
      (held.has("up") ? 1 : 0) - (held.has("down") ? 1 : 0),
      (held.has("back") ? 1 : 0) - (held.has("forward") ? 1 : 0)
    ];
    if (state.touch && state.touch.moved < 8 && performance.now() - state.touch.start > 250) {
      local[2] = state.touch.fingers >= 2 ? 1 : -1;
    }
    const cruise = radius * 0.22 * state.speed * (state.shift ? 4 : 1);
    const world = quatRotate(state.quaternion, local);
    const blend = 1 - Math.exp(-dt * 7);
    let moving = false;
    for (let axis = 0; axis < 3; axis += 1) {
      state.velocity[axis] += (world[axis] * cruise - state.velocity[axis]) * blend;
      if (Math.abs(state.velocity[axis]) > radius * 1e-4) moving = true;
      else state.velocity[axis] = world[axis] ? state.velocity[axis] : 0;
      state.position[axis] += state.velocity[axis] * dt;
    }
    if (moving) state.dirty = true;
  }

  function render() {
    const near = Math.max(radius * 0.0005, 0.05);
    renderer.draw({
      view: viewMatrix(state.position, state.quaternion),
      projection: perspectiveMatrix(FOV, canvas.width / canvas.height, near, radius * 60),
      pixelScale: (canvas.height / 2) / Math.tan(FOV / 2),
      // The short links show while nothing is picked out; a selection shows its own.
      lines: state.links && state.selected < 0 && !state.matches ? ["all", "focus"] : ["focus"]
    });
  }

  function updateHover() {
    const hit = state.pointer.inside && !drag ? pick(state.pointer.x, state.pointer.y) : -1;
    if (hit !== state.hovered) {
      state.hovered = hit;
      refreshGlow();
    }
    if (hit >= 0) {
      tooltip.textContent = titles[hit];
      tooltip.style.transform = `translate(${Math.round(state.pointer.x + 14)}px, ${Math.round(state.pointer.y + 12)}px)`;
      tooltip.style.left = "0";
      tooltip.style.top = "0";
      tooltip.hidden = false;
      canvas.style.cursor = "pointer";
    } else {
      tooltip.hidden = true;
      canvas.style.cursor = "";
    }
  }

  let last = performance.now();
  let lastHashWrite = 0;
  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    updateMotion(dt);
    if (state.dirty || state.hoverDirty) {
      if (state.dirty) {
        project();
        render();
        drawSteering();
      }
      updateHover();
      placeLabels();
      if (state.dirty) state.hashDirty = true;
      state.dirty = false;
      state.hoverDirty = false;
    } else if (state.steering) {
      drawSteering();
    }
    if (state.hashDirty && now - lastHashWrite > 400) {
      lastHashWrite = now;
      state.hashDirty = false;
      state.lastHash = formatViewHash(model.vault, {
        camera: { position: state.position, quaternion: state.quaternion },
        speed: state.speed, links: state.links, labels: state.labels, color: state.color,
        maxLink: state.maxLink, node: state.selected >= 0 ? model.nodes.id[state.selected] : ""
      });
      if (location.hash !== state.lastHash) history.replaceState(null, "", state.lastHash);
    }
    requestAnimationFrame(tick);
  }

  resize();
  refreshColors();
  refreshGlow();
  syncButtons();
  if (initial.node && idIndex.has(initial.node)) select(idIndex.get(initial.node));
  canvas.focus();
  window.galaxy = {
    get state() { return { position: [...state.position], quaternion: [...state.quaternion], selected: state.selected, links: state.links, labels: state.labels, color: state.color, steering: state.steering, matches: state.matches?.length ?? 0 }; },
    count,
    radius,
    project: (i) => (screenRadius[i] > 0 ? { x: screenX[i], y: screenY[i], radius: screenRadius[i] } : null),
    indexOf: (title) => titles.indexOf(title)
  };
  requestAnimationFrame(tick);
}
