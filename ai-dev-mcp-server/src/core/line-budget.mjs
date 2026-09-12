/**
 * The size rules the static gate enforces, as a function of its inputs.
 *
 * `scripts/static-quality.mjs` is the only thing keeping `mcp-stdio.mjs` from
 * growing back and `src/core` modules from turning into second main modules.
 * Its five branches used to live inside the walk over the tree, which meant the
 * only way to test them was to break a real file on purpose and put it back —
 * a check that happened once, by hand, and could not run again
 * (docs/ecc-upgrades/DEBTS.md, Д-12). A rewrite of the gate that silently
 * disabled a branch would have passed `npm run check`.
 *
 * So the rules are here, over a list of `{ path, lines }` the caller has
 * already collected, and the gate is the input and output around them.
 *
 * The ratchet the rules implement: a module may shrink and never grow. A module
 * over the ceiling with no entry in {@link MODULE_LINE_EXCEPTIONS} is a
 * finding; one with an entry may not exceed it; one that has come back under
 * the ceiling has to lose its entry, so the map cannot accumulate permissions
 * nobody needs; and an entry for a module that no longer exists has to go, so
 * the map keeps meaning what its comment says.
 */

/**
 * The same soft ceiling `COMMON_RULES` puts on user projects ("800 lines is the
 * soft ceiling", `rules-catalog.mjs`), applied to our own modules.
 */
export const MODULE_LINE_CEILING = 800;

/**
 * Modules that were already over the ceiling when the rule landed, each pinned
 * at its size on that day.
 *
 * Both are the frontend pair. Stage 1.3 moved the frontend tools out of
 * `mcp-stdio.mjs` on top of these two rather than into them, so neither
 * shrank: what left the main module was orchestration, and what these hold is
 * the product state machine and the reference manifest logic. Splitting them is
 * its own piece of work, not a side effect of an extraction.
 */
export const MODULE_LINE_EXCEPTIONS = Object.freeze([
  ["src/core/frontend-product-quality.mjs", 1222],
  ["src/core/reference-factory.mjs", 812]
]);

/**
 * Check a set of modules against the ceiling, the pins and the main module's
 * own budget.
 *
 * @param {object} input
 * @param {Array<{ path: string, lines: number }>} input.modules - Every module
 *   the ceiling applies to, repository-relative and POSIX-separated. The caller
 *   decides which files those are; a pin naming a path that is not in this list
 *   is reported as stale, so the list has to be the complete one.
 * @param {{ path: string, lines: number } | null} [input.runtime] - The main
 *   module, checked against `systemCeiling` instead of the module ceiling.
 * @param {number} [input.moduleCeiling]
 * @param {number} [input.systemCeiling]
 * @param {Iterable<[string, number]>} [input.exceptions]
 * @returns {Array<{ rule: string, path: string, lines: number, allowance: number, message: string }>}
 */
export function evaluateLineBudget({
  modules = [],
  runtime = null,
  moduleCeiling = MODULE_LINE_CEILING,
  systemCeiling = 0,
  exceptions = MODULE_LINE_EXCEPTIONS
} = {}) {
  const pinned = new Map([...exceptions].map(([path, allowance]) => [String(path), Number(allowance)]));
  const findings = [];
  const seen = new Set();
  for (const module of modules) {
    const relative = String(module?.path ?? "");
    const lines = Number(module?.lines ?? 0);
    const allowance = pinned.get(relative);
    if (allowance === undefined) {
      if (lines > moduleCeiling) {
        findings.push({
          rule: "module_over_ceiling",
          path: relative,
          lines,
          allowance: moduleCeiling,
          message: `${relative}: ${lines} lines exceeds the ${moduleCeiling}-line module ceiling. Split it, or pin it in MODULE_LINE_EXCEPTIONS with a reason.`
        });
      }
      continue;
    }
    seen.add(relative);
    if (lines <= moduleCeiling) {
      findings.push({
        rule: "pinned_module_under_ceiling",
        path: relative,
        lines,
        allowance,
        message: `${relative}: ${lines} lines is back under the ${moduleCeiling}-line ceiling; drop its MODULE_LINE_EXCEPTIONS entry.`
      });
    } else if (lines > allowance) {
      findings.push({
        rule: "pinned_module_grew",
        path: relative,
        lines,
        allowance,
        message: `${relative}: ${lines} lines exceeds its pinned allowance of ${allowance}. A pinned module may only shrink.`
      });
    }
  }
  for (const [relative, allowance] of pinned) {
    if (seen.has(relative)) continue;
    findings.push({
      rule: "pinned_module_missing",
      path: relative,
      lines: 0,
      allowance,
      message: `${relative}: MODULE_LINE_EXCEPTIONS names a module that no longer exists; drop the entry.`
    });
  }
  if (runtime && Number(runtime.lines) > Number(systemCeiling)) {
    findings.push({
      rule: "runtime_over_ceiling",
      path: String(runtime.path ?? ""),
      lines: Number(runtime.lines),
      allowance: Number(systemCeiling),
      message: `${runtime.path}: ${runtime.lines} lines exceeds the ${Number(systemCeiling).toLocaleString("en-US")}-line modularity ceiling.`
    });
  }
  return findings;
}
