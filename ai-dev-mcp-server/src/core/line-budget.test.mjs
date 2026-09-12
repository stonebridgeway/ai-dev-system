import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODULE_LINE_CEILING,
  MODULE_LINE_EXCEPTIONS,
  evaluateLineBudget
} from "./line-budget.mjs";
import { SYSTEM_LINE_CEILING } from "./system-health.mjs";

// Д-12. The gate is the only thing holding the ratchet, and its five branches
// were checked once, by hand, by breaking real files and putting them back.
// Each branch gets an input here that must produce exactly one finding, and the
// healthy tree must produce none — so a rewrite of the gate that silently drops
// a branch fails `npm run check` instead of passing it.

const EXCEPTIONS = Object.freeze([["src/core/pinned.mjs", 1000]]);

function evaluate(modules, overrides = {}) {
  return evaluateLineBudget({ modules, exceptions: EXCEPTIONS, moduleCeiling: 800, systemCeiling: 5000, ...overrides });
}

test("a module with no pin may not pass the ceiling", () => {
  assert.deepEqual(evaluate([{ path: "src/core/pinned.mjs", lines: 900 }, { path: "src/core/fine.mjs", lines: 800 }]), []);
  const findings = evaluate([{ path: "src/core/pinned.mjs", lines: 900 }, { path: "src/core/big.mjs", lines: 801 }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "module_over_ceiling");
  assert.equal(findings[0].path, "src/core/big.mjs");
  assert.equal(findings[0].lines, 801);
  assert.equal(findings[0].allowance, 800);
  assert.match(findings[0].message, /801 lines exceeds the 800-line module ceiling\. Split it, or pin it in MODULE_LINE_EXCEPTIONS/);
});

test("a pinned module may only shrink", () => {
  assert.deepEqual(evaluate([{ path: "src/core/pinned.mjs", lines: 1000 }]), [], "staying at its pin is allowed");
  assert.deepEqual(evaluate([{ path: "src/core/pinned.mjs", lines: 999 }]), [], "shrinking is the point");
  const findings = evaluate([{ path: "src/core/pinned.mjs", lines: 1001 }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "pinned_module_grew");
  assert.equal(findings[0].allowance, 1000);
  assert.match(findings[0].message, /1001 lines exceeds its pinned allowance of 1000\. A pinned module may only shrink\./);
});

test("a pinned module that came back under the ceiling has to lose its pin", () => {
  const findings = evaluate([{ path: "src/core/pinned.mjs", lines: 800 }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "pinned_module_under_ceiling");
  assert.match(findings[0].message, /800 lines is back under the 800-line ceiling; drop its MODULE_LINE_EXCEPTIONS entry\./);
  // The point of the branch: without it the pin would quietly permit a regrowth
  // to 1000 lines for a module that no longer needs any permission at all.
  assert.deepEqual(evaluate([{ path: "src/core/pinned.mjs", lines: 950 }]), []);
});

test("a pin for a module that no longer exists has to go", () => {
  const findings = evaluate([{ path: "src/core/fine.mjs", lines: 100 }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "pinned_module_missing");
  assert.equal(findings[0].path, "src/core/pinned.mjs");
  assert.equal(findings[0].allowance, 1000);
  assert.match(findings[0].message, /names a module that no longer exists; drop the entry\./);
  // An empty module list is the same case: every pin is stale.
  assert.deepEqual(evaluate([]).map((finding) => finding.rule), ["pinned_module_missing"]);
});

test("the main module is checked against its own ceiling", () => {
  const modules = [{ path: "src/core/pinned.mjs", lines: 1000 }];
  assert.deepEqual(evaluate(modules, { runtime: { path: "src/mcp-stdio.mjs", lines: 5000 } }), []);
  const findings = evaluate(modules, { runtime: { path: "src/mcp-stdio.mjs", lines: 5001 } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "runtime_over_ceiling");
  assert.match(findings[0].message, /src\/mcp-stdio\.mjs: 5001 lines exceeds the 5,000-line modularity ceiling\./);
  // Lowering the ceiling under the file is the same finding, which is what the
  // ratchet does after every extraction.
  assert.equal(evaluate(modules, { runtime: { path: "src/mcp-stdio.mjs", lines: 4000 }, systemCeiling: 3999 }).length, 1);
  assert.deepEqual(evaluate(modules, { runtime: null }), []);
});

test("the five branches are independent, and defaults are the gate's own", () => {
  const findings = evaluate([
    { path: "src/core/big.mjs", lines: 900 },
    { path: "src/core/shrunk.mjs", lines: 10 }
  ], {
    exceptions: [["src/core/shrunk.mjs", 900], ["src/core/grew.mjs", 810], ["src/core/gone.mjs", 900]],
    runtime: { path: "src/mcp-stdio.mjs", lines: 6000 }
  });
  assert.deepEqual(findings.map((finding) => finding.rule).sort(), [
    "module_over_ceiling",
    "pinned_module_missing",
    "pinned_module_missing",
    "pinned_module_under_ceiling",
    "runtime_over_ceiling"
  ]);

  // Called the way the gate calls it, with nothing passed: the exported policy
  // is the default, so the test and the gate cannot disagree about it.
  assert.equal(MODULE_LINE_CEILING, 800);
  assert.deepEqual(evaluateLineBudget().map((finding) => finding.path), MODULE_LINE_EXCEPTIONS.map(([target]) => target));
  assert.deepEqual(evaluateLineBudget({}), evaluateLineBudget());
});

test("the tree as it stands produces no findings", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const modules = [];
  for (const directory of ["src/core", "src/extensions"]) {
    const names = await fs.readdir(path.join(root, directory));
    for (const name of names.filter((item) => item.endsWith(".mjs"))) {
      const relative = `${directory}/${name}`;
      const source = await fs.readFile(path.join(root, relative), "utf8");
      modules.push({ path: relative, lines: source.split(/\r?\n/).length });
    }
  }
  const runtimeSource = await fs.readFile(path.join(root, "src", "mcp-stdio.mjs"), "utf8");
  const findings = evaluateLineBudget({
    modules,
    runtime: { path: "src/mcp-stdio.mjs", lines: runtimeSource.split(/\r?\n/).length },
    systemCeiling: SYSTEM_LINE_CEILING
  });
  assert.deepEqual(findings.map((finding) => finding.message), [], "the gate's own rules over the real tree");
  assert.ok(modules.length > 50, `expected the whole of src/core and src/extensions, read ${modules.length} modules`);
});
