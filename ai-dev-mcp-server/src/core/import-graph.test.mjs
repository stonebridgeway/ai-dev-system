import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  IMPORT_GRAPH_CACHE_PATH,
  collectSourceFiles,
  findImportCycles,
  loadImportGraph,
  parseImportSpecifiers,
  renderImportGraphMarkdown,
  resolveJsSpecifier,
  resolvePySpecifier,
  scanImportGraph,
  sourceFingerprint
} from "./import-graph.mjs";

async function tempProject(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-graph-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

test("import specifiers are read out of both languages' spellings", () => {
  const js = [
    "import fs from \"node:fs\";",
    "import { a, b } from './lib/a.mjs';",
    "export * from \"../shared/index.mjs\";",
    "const c = require('./c');",
    "const d = await import(\"./d.js\");",
    "import \"./side-effect.js\";",
    "// import { nope } from \"./commented.js\";"
  ].join("\n");
  assert.deepEqual(parseImportSpecifiers("src/app.mjs", js), [
    "node:fs", "./lib/a.mjs", "../shared/index.mjs", "./c", "./d.js", "./side-effect.js", "./commented.js"
  ]);

  const py = [
    "import os",
    "import json, sys",
    "from .models import User",
    "from ..shared.util import clamp",
    "from app.services import billing"
  ].join("\n");
  assert.deepEqual(parseImportSpecifiers("app/web/views.py", py), [
    ".models", "..shared.util", "app.services", "os", "json", "sys"
  ]);
  assert.deepEqual(parseImportSpecifiers("a.mjs", undefined), []);
});

test("a specifier resolves to a file in the repository, or to nothing", () => {
  const known = new Set(["src/app.mjs", "src/lib/a.mjs", "src/lib/index.ts", "src/b.tsx", "pkg/__init__.py", "pkg/models.py", "pkg/web/views.py"]);
  assert.equal(resolveJsSpecifier("src/app.mjs", "./lib/a.mjs", known), "src/lib/a.mjs");
  assert.equal(resolveJsSpecifier("src/app.mjs", "./lib/a", known), "src/lib/a.mjs");
  assert.equal(resolveJsSpecifier("src/app.mjs", "./lib", known), "src/lib/index.ts", "a directory resolves through its index");
  assert.equal(resolveJsSpecifier("src/app.mjs", "./b", known), "src/b.tsx");
  // TypeScript writes the compiled extension and means the source.
  assert.equal(resolveJsSpecifier("src/app.mjs", "./lib/index.js", known), "src/lib/index.ts");
  assert.equal(resolveJsSpecifier("src/app.mjs", "react", known), "", "a bare specifier leaves the repository");
  assert.equal(resolveJsSpecifier("src/app.mjs", "./missing", known), "");

  assert.equal(resolvePySpecifier("pkg/web/views.py", ".forms", known), "");
  assert.equal(resolvePySpecifier("pkg/models.py", ".web.views", known), "pkg/web/views.py");
  assert.equal(resolvePySpecifier("pkg/web/views.py", "..models", known), "pkg/models.py");
  assert.equal(resolvePySpecifier("pkg/web/views.py", "pkg.models", known), "pkg/models.py");
  assert.equal(resolvePySpecifier("pkg/web/views.py", "pkg", known), "pkg/__init__.py");
  assert.equal(resolvePySpecifier("pkg/web/views.py", "django.db", known), "");
});

test("cycles are found once each, longest first, self-imports included", () => {
  const edges = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a"]],
    ["d", ["e"]],
    ["e", ["d"]],
    ["f", ["f"]],
    ["g", ["a"]],
    ["h", []]
  ]);
  assert.deepEqual(findImportCycles(edges), [["a", "b", "c"], ["d", "e"], ["f"]]);
  assert.deepEqual(findImportCycles(new Map([["a", ["b"]], ["b", []]])), []);
  assert.deepEqual(findImportCycles(new Map()), []);
});

test("a scan over a real tree answers the three questions the map section asks", async (t) => {
  const root = await tempProject(t, {
    "src/index.mjs": "import { serve } from \"./server.mjs\";\nimport { log } from \"./lib/log.mjs\";\nserve(log);\n",
    "src/server.mjs": "import { log } from \"./lib/log.mjs\";\nimport { route } from \"./router.mjs\";\nexport const serve = () => route(log);\n",
    "src/router.mjs": "import { log } from \"./lib/log.mjs\";\nimport { handler } from \"./handlers/index.mjs\";\nexport const route = () => handler();\n",
    "src/handlers/index.mjs": "import { log } from \"../lib/log.mjs\";\nimport { route } from \"../router.mjs\";\nexport const handler = () => route(log);\n",
    "src/lib/log.mjs": "import util from \"node:util\";\nimport chalk from \"chalk\";\nexport const log = (...args) => util.format(...args);\n",
    "scripts/tool.mjs": "import { log } from \"../src/lib/log.mjs\";\nlog(\"hi\");\n",
    "node_modules/dep/index.mjs": "export const ignored = true;\n",
    "dist/bundle.mjs": "export const ignored = true;\n",
    "README.md": "# not source\n"
  });

  const graph = await scanImportGraph(root);
  assert.equal(graph.scanned_files, 6, "node_modules, dist and non-source files are not read");
  assert.equal(graph.truncated, false);

  // Most depended on, in order.
  assert.deepEqual(graph.modules.slice(0, 2).map((module) => [module.path, module.dependents]), [
    ["src/lib/log.mjs", 5],
    ["src/router.mjs", 2]
  ]);
  // The cycle between the router and its handlers.
  assert.deepEqual(graph.cycles, [["src/handlers/index.mjs", "src/router.mjs"]]);
  // Entry points: nothing in the project imports them.
  assert.deepEqual(graph.entry_points, ["scripts/tool.mjs", "src/index.mjs"]);
  assert.deepEqual(graph.external_dependencies, [{ name: "chalk", imports: 1 }, { name: "node:util", imports: 1 }]);
  assert.deepEqual(graph.edges["src/index.mjs"], ["src/lib/log.mjs", "src/server.mjs"]);

  const markdown = renderImportGraphMarkdown(graph);
  assert.match(markdown, /- Files read: 6, from cache: no\./);
  // Its own two imports are external, so its internal import count is zero.
  assert.match(markdown, /Most depended on:\n- `src\/lib\/log\.mjs` — 5 dependent\(s\), imports 0\./);
  assert.match(markdown, /Cycles:\n- 2 modules: `src\/handlers\/index\.mjs` → `src\/router\.mjs`/);
  assert.match(markdown, /Entry points \(nothing in the project imports them\):\n- `scripts\/tool\.mjs`/);
  assert.match(markdown, /Most imported external packages: `chalk` \(1\), `node:util` \(1\)\./);
});

test("Python packages are read the way Python resolves them", async (t) => {
  const root = await tempProject(t, {
    "app/__init__.py": "",
    "app/main.py": "from .services import billing\nimport os\n",
    "app/services/__init__.py": "from app.models import Invoice\n",
    "app/services/billing.py": "from ..models import Invoice\nfrom app.services import helpers\n",
    "app/services/helpers.py": "import json\n",
    "app/models.py": "from dataclasses import dataclass\n"
  });
  const graph = await scanImportGraph(root);
  assert.deepEqual(graph.edges["app/services/billing.py"], ["app/models.py", "app/services/__init__.py"]);
  // `from .services import billing` imports the package, and `billing` is an
  // attribute of it — which is what Python does, so it is the edge recorded.
  assert.deepEqual(graph.edges["app/main.py"], ["app/services/__init__.py"]);
  assert.equal(graph.modules.find((module) => module.path === "app/models.py").dependents, 2);
  // billing.py is an entry point by the same rule: nothing imports the module
  // itself, only the package that re-exports it.
  assert.deepEqual(graph.entry_points, ["app/main.py", "app/services/billing.py"]);
});

test("the graph is read from cache until the sources move", async (t) => {
  const root = await tempProject(t, {
    "src/a.mjs": "import { b } from \"./b.mjs\";\nexport const a = b;\n",
    "src/b.mjs": "export const b = 1;\n"
  });

  const first = await loadImportGraph(root);
  assert.equal(first.from_cache, false);
  assert.equal(first.scanned_files, 2);
  const cacheFile = path.join(root, ...IMPORT_GRAPH_CACHE_PATH.split("/"));
  assert.ok(await fs.stat(cacheFile).then(() => true).catch(() => false), "the cache is written where the map render looks for it");

  const second = await loadImportGraph(root);
  assert.equal(second.from_cache, true);
  assert.equal(second.generated_at, first.generated_at, "nothing was re-parsed");

  // A new file moves the fingerprint, so the graph is read again.
  await fs.writeFile(path.join(root, "src", "c.mjs"), "import { a } from \"./a.mjs\";\nexport const c = a;\n", "utf8");
  const third = await loadImportGraph(root);
  assert.equal(third.from_cache, false);
  assert.equal(third.scanned_files, 3);
  assert.equal(third.modules.find((module) => module.path === "src/a.mjs").dependents, 1);

  // And `force` re-reads whatever the fingerprint says.
  const forced = await loadImportGraph(root, { force: true });
  assert.equal(forced.from_cache, false);

  // An unreadable cache is a cache miss, not a failure.
  await fs.writeFile(cacheFile, "{ not json", "utf8");
  assert.equal((await loadImportGraph(root)).from_cache, false);
});

test("the fingerprint moves with content, and the file limit is honoured", async (t) => {
  const root = await tempProject(t, { "a.mjs": "export const a = 1;\n", "b.py": "x = 1\n" });
  const files = await collectSourceFiles(root);
  assert.deepEqual(files.map((file) => file.relative), ["a.mjs", "b.py"]);
  const before = sourceFingerprint(files);
  await fs.writeFile(path.join(root, "a.mjs"), "export const a = 2; // longer\n", "utf8");
  assert.notEqual(sourceFingerprint(await collectSourceFiles(root)), before);
  assert.equal(sourceFingerprint([]), "0-e3b0c44298fc1c149afbf4c8996fb924");

  const limited = await scanImportGraph(root, { maxFiles: 1 });
  assert.equal(limited.scanned_files, 1);
  assert.equal(limited.truncated, true);
  assert.match(renderImportGraphMarkdown(limited), /the scan stopped at its file limit/);
});

test("a project with no readable sources says so instead of rendering an empty table", async (t) => {
  const root = await tempProject(t, { "main.go": "package main\n", "README.md": "# docs\n" });
  const graph = await scanImportGraph(root);
  assert.equal(graph.scanned_files, 0);
  assert.match(renderImportGraphMarkdown(graph), /^- No JavaScript, TypeScript or Python sources were read/);
  assert.match(renderImportGraphMarkdown(null), /^- No JavaScript, TypeScript or Python sources were read/);

  const lonely = await tempProject(t, { "a.mjs": "import x from \"react\";\nexport default x;\n" });
  const markdown = renderImportGraphMarkdown(await scanImportGraph(lonely));
  assert.match(markdown, /- Nothing in this project imports anything else in it\./);
  assert.match(markdown, /Cycles:\n- None\./);
});
