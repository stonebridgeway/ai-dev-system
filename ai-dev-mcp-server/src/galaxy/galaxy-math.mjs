/**
 * The Knowledge Galaxy viewer's pure half: camera maths, the view kept in the
 * address, decoding the page's data, search, and colour.
 *
 * Browser code, inlined into the page with the rest of `src/galaxy/` by
 * `src/core/galaxy-page.mjs`, and tested in Node (`galaxy-math.test.mjs`)
 * because none of it needs a document.
 */

/** Field of view, radians. */
export const FOV = (60 * Math.PI) / 180;

/** Palette for the largest constellations, readable on the dark sky. */
const PALETTE = [
  [0.49, 0.75, 1.0], [1.0, 0.78, 0.36], [0.56, 0.87, 0.55], [1.0, 0.52, 0.52],
  [0.76, 0.6, 1.0], [0.33, 0.87, 0.9], [1.0, 0.6, 0.85], [0.93, 0.93, 0.5],
  [0.44, 0.83, 0.7], [1.0, 0.66, 0.42], [0.62, 0.7, 1.0], [0.85, 0.95, 0.62]
];

/** Colour of a document by what kind of note it is. */
export const SCOPE_COLORS = {
  knowledge: [0.49, 0.75, 1.0],
  skills: [1.0, 0.8, 0.38],
  workflows: [0.56, 0.87, 0.55],
  quality: [1.0, 0.52, 0.52],
  projects: [0.76, 0.6, 1.0]
};

/** Constellations smaller than this are drawn in the neutral colour. */
export const SMALL_CLUSTER = 5;

/** The three colour modes, in the order `C` cycles them. */
export const COLOR_MODES = ["cluster", "scope", "white"];

// ---------------------------------------------------------------- quaternions

export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

export function quatNormalize(q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

export function quatAxisAngle(axis, angle) {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Rotate vector v by unit quaternion q. */
export function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x
  ];
}

export function quatSlerp(a, b, t) {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    return quatNormalize([a[0] + t * (bx - a[0]), a[1] + t * (by - a[1]), a[2] + t * (bz - a[2]), a[3] + t * (bw - a[3])]);
  }
  const angle = Math.acos(cos);
  const sin = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / sin;
  const wb = Math.sin(t * angle) / sin;
  return [wa * a[0] + wb * bx, wa * a[1] + wb * by, wa * a[2] + wb * bz, wa * a[3] + wb * bw];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize3(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * The orientation of a camera looking along `forward` with `up` roughly up.
 * The camera looks down its own −Z axis, as in OpenGL.
 */
export function quatLookAt(forward, up = [0, 1, 0]) {
  const back = normalize3([-forward[0], -forward[1], -forward[2]]);
  let right = cross(up, back);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = cross([1, 0, 0], back);
  right = normalize3(right);
  const trueUp = cross(back, right);
  const m00 = right[0]; const m01 = trueUp[0]; const m02 = back[0];
  const m10 = right[1]; const m11 = trueUp[1]; const m12 = back[1];
  const m20 = right[2]; const m21 = trueUp[2]; const m22 = back[2];
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** The camera's right, up and back axes in world space. */
export function cameraBasis(q) {
  return { right: quatRotate(q, [1, 0, 0]), up: quatRotate(q, [0, 1, 0]), back: quatRotate(q, [0, 0, 1]) };
}

/** Column-major view matrix for a camera at `position` with orientation `q`. */
export function viewMatrix(position, q) {
  const { right: r, up: u, back: b } = cameraBasis(q);
  const dot = (a) => a[0] * position[0] + a[1] * position[1] + a[2] * position[2];
  return new Float32Array([
    r[0], u[0], b[0], 0,
    r[1], u[1], b[1], 0,
    r[2], u[2], b[2], 0,
    -dot(r), -dot(u), -dot(b), 1
  ]);
}

/** Column-major perspective projection. */
export function perspectiveMatrix(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ]);
}

// ------------------------------------------------------------- address state

function number(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read the view from the address, in the shape Software Galaxies uses:
 * `#/galaxy/<name>?cx=…&cy=…&cz=…&lx=…&ly=…&lz=…&lw=…&ml=…&s=…&l=1`.
 *
 * @param {string} hash
 * @returns {{ camera: { position: number[], quaternion: number[] } | null, speed: number, links: boolean, labels: boolean, color: string, maxLink: number, node: string }}
 */
export function parseViewHash(hash) {
  const text = String(hash || "");
  const query = new URLSearchParams(text.includes("?") ? text.slice(text.indexOf("?") + 1) : "");
  const has = (key) => query.has(key) && Number.isFinite(Number.parseFloat(query.get(key)));
  const rotation = [number(query.get("lx"), 0), number(query.get("ly"), 0), number(query.get("lz"), 0), number(query.get("lw"), 1)];
  const camera = has("cx") && has("cy") && has("cz")
    ? {
      position: [number(query.get("cx"), 0), number(query.get("cy"), 0), number(query.get("cz"), 0)],
      // A zero rotation is no rotation at all: every axis would collapse.
      quaternion: Math.hypot(...rotation) > 1e-6 ? quatNormalize(rotation) : [0, 0, 0, 1]
    }
    : null;
  const color = COLOR_MODES.includes(query.get("c")) ? query.get("c") : "cluster";
  return {
    camera,
    speed: Math.min(Math.max(number(query.get("s"), 1), 0.05), 50),
    links: query.get("l") !== "0",
    labels: query.get("t") !== "0",
    color,
    maxLink: Math.max(number(query.get("ml"), 0), 0),
    node: String(query.get("n") || "").replace(/[^0-9a-f]/gi, "").slice(0, 12)
  };
}

/** Write the view back in the same shape. */
export function formatViewHash(name, view) {
  const [x, y, z] = view.camera.position;
  const [qx, qy, qz, qw] = view.camera.quaternion;
  const parts = [
    `cx=${Math.round(x)}`, `cy=${Math.round(y)}`, `cz=${Math.round(z)}`,
    `lx=${qx.toFixed(4)}`, `ly=${qy.toFixed(4)}`, `lz=${qz.toFixed(4)}`, `lw=${qw.toFixed(4)}`,
    `ml=${Math.round(view.maxLink || 0)}`, `s=${Number(view.speed.toFixed(2))}`,
    `l=${view.links ? 1 : 0}`, `t=${view.labels ? 1 : 0}`, `c=${view.color}`
  ];
  if (view.node) parts.push(`n=${view.node}`);
  return `#/galaxy/${encodeURIComponent(name || "vault")}?${parts.join("&")}`;
}

// --------------------------------------------------------------------- data

/** Decode a base64 typed array written by the page builder. */
export function decodeBase64(text, Type) {
  const binary = atob(String(text || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

/**
 * Titles matching every word of the query, best first: a title that starts
 * with the query, then one containing it, then matches found only in the path.
 *
 * @returns {number[]} Node indices.
 */
export function searchNodes(titles, paths, query, limit = 12) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(" ");
  const scored = [];
  for (let i = 0; i < titles.length; i += 1) {
    const title = titles[i].toLowerCase();
    const path = String(paths[i] || "").toLowerCase();
    let inTitle = true;
    let anywhere = true;
    for (const word of words) {
      if (!title.includes(word)) inTitle = false;
      if (!title.includes(word) && !path.includes(word)) { anywhere = false; break; }
    }
    if (!anywhere) continue;
    const rank = title.startsWith(phrase) ? 0 : inTitle ? 1 : 2;
    scored.push([rank, title.length, i]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return (limit > 0 ? scored.slice(0, limit) : scored).map((item) => item[2]);
}

/** A constellation's colour: the palette first, then golden-angle hues. */
export function clusterColor(id, size) {
  if (size < SMALL_CLUSTER) return [0.62, 0.66, 0.74];
  if (id < PALETTE.length) return PALETTE[id];
  const hue = (id * 137.508) % 360;
  return hslToRgb(hue / 360, 0.62, 0.7);
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

export function cssColor(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

/** Ease in and out, for camera flights. */
export function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}
