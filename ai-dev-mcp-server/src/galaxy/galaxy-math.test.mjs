import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COLOR_MODES,
  cameraBasis,
  clusterColor,
  decodeBase64,
  easeInOut,
  formatViewHash,
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
import { GALAXY_VIEWER_FILES, readGalaxyViewer } from "../extensions/galaxy.mjs";

const close = (actual, expected, epsilon = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < epsilon, `${actual} ≉ ${expected}`));
};

test("quaternions turn the camera the way the keys say", () => {
  // A quarter turn left about up takes forward (−Z) to −X.
  const left = quatAxisAngle([0, 1, 0], Math.PI / 2);
  close(quatRotate(left, [0, 0, -1]), [-1, 0, 0]);
  // Local rotations compose on the right: yaw then pitch.
  const pitched = quatMultiply(left, quatAxisAngle([1, 0, 0], Math.PI / 2));
  close(quatRotate(pitched, [0, 0, -1]), [0, 1, 0]);
  close(quatNormalize([0, 0, 0, 2]), [0, 0, 0, 1]);
  close(quatSlerp([0, 0, 0, 1], left, 0), [0, 0, 0, 1]);
  close(quatSlerp([0, 0, 0, 1], left, 1), left);
  close(quatRotate(quatSlerp([0, 0, 0, 1], left, 0.5), [0, 0, -1]), [-Math.SQRT1_2, 0, -Math.SQRT1_2]);
  // Nearly equal rotations take the linear path and stay unit length.
  const tiny = quatSlerp([0, 0, 0, 1], quatAxisAngle([0, 1, 0], 1e-4), 0.5);
  assert.ok(Math.abs(Math.hypot(...tiny) - 1) < 1e-9);
});

test("quatLookAt faces the target, keeps up up, and survives looking straight up", () => {
  for (const forward of [[1, 0, 0], [0, 0, -1], [0.3, -0.5, 0.8]]) {
    const unit = forward.map((value) => value / Math.hypot(...forward));
    const q = quatLookAt(forward);
    close(quatRotate(q, [0, 0, -1]), unit, 1e-6);
    assert.ok(cameraBasis(q).up[1] > 0);
  }
  const vertical = quatLookAt([0, 1, 0], [0, 1, 0]);
  close(quatRotate(vertical, [0, 0, -1]), [0, 1, 0], 1e-6);
  assert.ok([0, 1, 2, 3].every((index) => Number.isFinite(vertical[index])));
});

test("the view matrix puts the camera at the origin looking down −Z", () => {
  const position = [10, -4, 7];
  const q = quatLookAt([0, 0, 1]);
  const m = viewMatrix(position, q);
  const apply = (p) => [0, 1, 2].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);
  close(apply(position), [0, 0, 0], 1e-5);
  // A point ahead of the camera ends up in front, on −Z.
  close(apply([10, -4, 17]), [0, 0, -10], 1e-5);
  const p = perspectiveMatrix(Math.PI / 2, 2, 1, 100);
  close([p[0], p[5], p[11]], [0.5, 1, -1], 1e-6);
});

test("the address keeps the view in Software Galaxies' shape", () => {
  const view = {
    camera: { position: [12.4, -3.6, 800], quaternion: [0, 0.2588, 0, 0.9659] },
    speed: 1.5, links: false, labels: true, color: "scope", maxLink: 151.2, node: "abc123"
  };
  const hash = formatViewHash("My Vault", view);
  assert.equal(hash, "#/galaxy/My%20Vault?cx=12&cy=-4&cz=800&lx=0.0000&ly=0.2588&lz=0.0000&lw=0.9659&ml=151&s=1.5&l=0&t=1&c=scope&n=abc123");
  const parsed = parseViewHash(hash);
  close(parsed.camera.position, [12, -4, 800]);
  close(parsed.camera.quaternion, quatNormalize([0, 0.2588, 0, 0.9659]), 1e-4);
  assert.deepEqual(
    { speed: parsed.speed, links: parsed.links, labels: parsed.labels, color: parsed.color, maxLink: parsed.maxLink, node: parsed.node },
    { speed: 1.5, links: false, labels: true, color: "scope", maxLink: 151, node: "abc123" }
  );
  // The reference link the viewer imitates parses too.
  const reference = parseViewHash("#/galaxy/word2vec-wiki?cx=108&cy=-5356&cz=3352&lx=-0.1083&ly=0.4722&lz=0.8423&lw=0.2361&ml=300&s=1.75&l=1&v=d50_clean");
  close(reference.camera.position, [108, -5356, 3352]);
  assert.equal(reference.speed, 1.75);
  assert.equal(reference.maxLink, 300);
});

test("a hand-edited address cannot break the view", () => {
  const empty = parseViewHash("");
  assert.equal(empty.camera, null);
  assert.deepEqual([empty.speed, empty.links, empty.labels, empty.color, empty.node], [1, true, true, "cluster", ""]);
  const hostile = parseViewHash("#/galaxy/x?cx=abc&cy=1&cz=2&s=1e9&c=<script>&n=\"><img");
  assert.equal(hostile.camera, null);
  assert.equal(hostile.speed, 50);
  assert.equal(hostile.color, "cluster");
  assert.equal(hostile.node, "");
  assert.equal(parseViewHash("#?s=-4").speed, 0.05);
  // A zero rotation would collapse every camera axis; it reads as none.
  assert.deepEqual(parseViewHash("#?cx=0&cy=0&cz=0&lx=0&ly=0&lz=0&lw=0").camera.quaternion, [0, 0, 0, 1]);
});

test("search ranks a title that starts with the query first, then one containing it, then the path", () => {
  const titles = ["Security", "application-security", "API Gateway", "Notes", "security-scan"];
  const paths = ["a.md", "b.md", "c.md", "03-skills-catalog/security/notes.md", "e.md"];
  assert.deepEqual(searchNodes(titles, paths, "secur"), [0, 4, 1, 3]);
  assert.deepEqual(searchNodes(titles, paths, "SECURITY scan"), [4]);
  assert.deepEqual(searchNodes(titles, paths, "   "), []);
  assert.deepEqual(searchNodes(titles, paths, "secur", 2), [0, 4]);
  assert.deepEqual(searchNodes(["Заметка о безопасности"], ["x.md"], "безопас"), [0]);
});

test("base64 arrays written by the page builder decode to the same numbers", () => {
  const floats = Float32Array.from([1.5, -2, 3.25]);
  const text = Buffer.from(floats.buffer).toString("base64");
  assert.deepEqual(Array.from(decodeBase64(text, Float32Array)), [1.5, -2, 3.25]);
  const pairs = Uint32Array.from([0, 70000]);
  assert.deepEqual(Array.from(decodeBase64(Buffer.from(pairs.buffer).toString("base64"), Uint32Array)), [0, 70000]);
  assert.equal(decodeBase64("", Uint8Array).length, 0);
});

test("colours, easing and text", () => {
  assert.deepEqual(clusterColor(0, 2), clusterColor(9, 3), "small constellations share the neutral colour");
  assert.notDeepEqual(clusterColor(0, 50), clusterColor(1, 50));
  for (const id of [0, 11, 12, 40, 999]) {
    assert.ok(clusterColor(id, 50).every((channel) => channel >= 0 && channel <= 1));
  }
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(pickText("ru-RU"), TEXT.ru);
  assert.equal(pickText("en-GB"), TEXT.en);
  assert.equal(pickText(undefined), TEXT.en);
  assert.deepEqual(Object.keys(TEXT.ru).sort(), Object.keys(TEXT.en).sort());
  assert.equal(TEXT.ru.keys.length, TEXT.en.keys.length);
  assert.deepEqual(COLOR_MODES, ["cluster", "scope", "white"]);
});

test("the keymap is physical, so it survives a Russian layout", () => {
  for (const code of Object.keys(HELD_KEYS)) assert.match(code, /^(Key[A-Z]|Arrow\w+|Page\w+)$/);
  assert.equal(HELD_KEYS.KeyW, "forward");
  assert.equal(HELD_KEYS.KeyQ, "rollLeft");
});

test("every viewer module can be inlined, and together they are one valid module", async (t) => {
  for (const name of GALAXY_VIEWER_FILES) {
    const source = await fs.readFile(new URL(`./${name}`, import.meta.url), "utf8");
    assert.ok(!/<\/script/i.test(source), name);
    assert.ok(!source.includes("<!--"), name);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|import\(/.test(source), `${name} makes no request`);
    assert.ok(!/\.innerHTML\b|outerHTML|insertAdjacentHTML|document\.write/.test(source), `${name} never parses vault text as markup`);
  }
  const inlined = await readGalaxyViewer();
  assert.ok(!/^\s*import\s/m.test(inlined));
  assert.match(inlined, /export function bootGalaxy\(/);
  // A top-level name used twice across modules is a syntax error only the
  // joined module shows.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "galaxy-viewer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "viewer.mjs");
  await fs.writeFile(file, inlined, "utf8");
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
