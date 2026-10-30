import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EDGE_LINK, EDGE_SEMANTIC } from "./galaxy-graph.mjs";
import { GALAXY_FORMAT, buildGalaxyModel, embedJson, inlineModules, isVaultMarkdown, renderGalaxyPage } from "./galaxy-page.mjs";

const HOSTILE = "</script><script>alert(1)</script><!-- \u2028 & \"quotes\"";

function model(overrides = {}) {
  return buildGalaxyModel({
    nodes: [
      { id: "a".repeat(40), title: HOSTILE, path: "02-knowledge/A.md", scope: "knowledge", source: "vault-note", preview: "x".repeat(500) },
      { id: "b".repeat(40), title: "Beta", path: "03-skills-catalog/sources/custom/b/SKILL.md", scope: "skills", source: "custom" },
      { id: "c".repeat(40), title: "Gamma", path: "/home/me/project/AGENTS.md", scope: "projects", source: "project-agents" }
    ],
    edges: {
      source: Uint32Array.from([0, 1]),
      target: Uint32Array.from([1, 2]),
      weight: Float32Array.from([0.5, 1.7]),
      kind: Uint8Array.from([EDGE_SEMANTIC, EDGE_LINK])
    },
    positions: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    community: [0, 0, 1],
    clusters: [{ label: "alpha", size: 2 }, { label: "", size: 1 }],
    meta: { vault: "My Vault", obsidian_vault: "My Vault", space: "sparse", counts: { documents: 3 } },
    ...overrides
  });
}

test("the model is columns, lookup tables and base64 arrays", () => {
  const built = model();
  assert.equal(built.format, GALAXY_FORMAT);
  assert.deepEqual(built.scopes, ["knowledge", "skills", "projects"]);
  assert.deepEqual(built.nodes.scope, [0, 1, 2]);
  assert.deepEqual(built.nodes.id, ["a".repeat(12), "b".repeat(12), "c".repeat(12)]);
  assert.equal(built.nodes.preview[0].length, 240);
  // Obsidian opens Markdown inside the vault, registry skills included, and
  // nothing with an absolute path.
  assert.deepEqual(built.nodes.note, [1, 1, 0]);
  const positions = new Float32Array(Uint8Array.from(Buffer.from(built.positions, "base64")).buffer);
  assert.deepEqual(Array.from(positions), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const pairs = new Uint32Array(Uint8Array.from(Buffer.from(built.edges.pairs, "base64")).buffer);
  assert.deepEqual(Array.from(pairs), [0, 1, 1, 2]);
  // Similarities are bytes, clamped to [0, 1].
  assert.deepEqual(Array.from(Buffer.from(built.edges.weight, "base64")), [128, 255]);
  assert.equal(built.edges.link_kind, EDGE_LINK);
  assert.deepEqual(built.clusters, [{ label: "alpha", size: 2 }, { label: "", size: 1 }]);
});

test("isVaultMarkdown accepts vault-relative Markdown only", () => {
  assert.equal(isVaultMarkdown("01-system/Note.md"), true);
  assert.equal(isVaultMarkdown("01-system/Note.MD"), true);
  assert.equal(isVaultMarkdown("03-skills-catalog/sources/custom/x/"), false);
  assert.equal(isVaultMarkdown("/abs/Note.md"), false);
  assert.equal(isVaultMarkdown("C:\\vault\\Note.md"), false);
  assert.equal(isVaultMarkdown("\\\\server\\share\\Note.md"), false);
  assert.equal(isVaultMarkdown(""), false);
});

test("embedded JSON cannot close its block and still parses back", () => {
  const text = embedJson({ title: HOSTILE });
  assert.ok(!/[<>&\u2028\u2029]/.test(text));
  assert.deepEqual(JSON.parse(text), { title: HOSTILE });
});

test("the page carries its data and viewer, and a policy that allows only them", () => {
  const client = "export function bootGalaxy(element) { return element; }";
  const { html, bytes } = renderGalaxyPage({ model: model(), clientSource: client });
  assert.equal(bytes, Buffer.byteLength(html, "utf8"));
  // Exactly one closing tag per block: no title escaped its data block.
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.ok(!html.includes("<script>alert(1)"));
  assert.match(html, /<title>Knowledge Galaxy — My Vault<\/title>/);

  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(script.startsWith(client));
  assert.ok(script.includes("bootGalaxy(document.getElementById(\"galaxy-data\"))"));
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1].replaceAll("&#39;", "'");
  const hash = (value) => `'sha256-${createHash("sha256").update(value, "utf8").digest("base64")}'`;
  assert.ok(policy.includes(`script-src ${hash(script)}`), policy);
  assert.ok(policy.includes(`style-src ${hash(style)}`), policy);
  assert.ok(policy.startsWith("default-src 'none'"));
  assert.ok(!policy.includes("unsafe-inline"));
  assert.ok(!/connect-src|https?:/.test(policy), "nothing may be fetched");

  const data = html.match(/<script type="application\/json" id="galaxy-data">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(data).nodes.title[0], HOSTILE);
});

test("a viewer that could break out of its block is refused", () => {
  assert.throws(() => renderGalaxyPage({ model: model(), clientSource: "" }), /empty/);
  assert.throws(() => renderGalaxyPage({ model: model(), clientSource: "const s = '</SCRIPT>';" }), /delimiter/);
  assert.throws(() => renderGalaxyPage({ model: model(), clientSource: "x <!-- y" }), /delimiter/);
});

test("inlineModules joins siblings into one module and refuses what it cannot join", () => {
  const joined = inlineModules([
    { name: "a.mjs", source: "export const A = 1;\n" },
    { name: "b.mjs", source: "import {\n  A\n} from \"./a.mjs\";\nexport const B = A + 1;\n" },
    { name: "c.mjs", source: "import { A } from \"./a.mjs\";\nimport { B } from \"./b.mjs\";\nexport function bootGalaxy() { return A + B; }\n" }
  ]);
  assert.ok(!joined.includes("import"));
  assert.match(joined, /\/\/ a\.mjs\nexport const A = 1;/);
  assert.ok(joined.indexOf("const A") < joined.indexOf("const B"));
  assert.throws(
    () => inlineModules([{ name: "b.mjs", source: "import { A } from \"./a.mjs\";" }]),
    /not part of the viewer/
  );
  assert.throws(
    () => inlineModules([{ name: "b.mjs", source: "import { A } from \"./a.mjs\";" }, { name: "a.mjs", source: "export const A = 1;" }]),
    /must come before it/
  );
  assert.throws(() => inlineModules([{ name: "x.mjs", source: "import fs from \"node:fs\";" }]), /cannot inline/);
  assert.throws(() => inlineModules([{ name: "x.mjs", source: "import \"./side-effect.mjs\";" }]), /cannot inline/);
});
