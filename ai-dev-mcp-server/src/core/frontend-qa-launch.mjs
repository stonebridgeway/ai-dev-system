/**
 * Why the Frontend QA runner never got as far as its own diagnostics.
 *
 * The runner is a separate process with its own dependencies, so the probe that
 * asks it for a status gets, on failure, whatever Node printed to stderr. That
 * text was reduced to its first line, which for a module-resolution failure is
 * the frame Node happens to throw from — `node:internal/modules/esm/resolve:275`
 * — and never the reason. The health check then read `playwright_available:
 * false`, concluded the optional install was skipped, and told the reader to
 * run `npm run setup -- --frontend-qa`.
 *
 * In the published image that advice was wrong twice over: Playwright and
 * Chromium are installed, and the command cannot be run inside the container at
 * all. What had actually happened was that the runner imports two modules from
 * the server by relative path, and in the image the server is not where that
 * path points, so the runner died on its first import.
 *
 * Node distinguishes the two cases itself and the wording is stable:
 *
 *   Cannot find package '@axe-core/playwright' imported from …/frontend_qa_runner.mjs
 *   Cannot find module '/opt/ai-dev/ai-dev-mcp-server/src/core/command-policy.mjs' imported from …
 *
 * A package is a dependency nobody installed — the opt-in step, and not a
 * fault. A module is a file that was supposed to be there, which means the
 * install is broken and saying anything softer sends the reader after the wrong
 * thing.
 */

/** A package name is missing: the runner's dependencies were never installed. */
export const LAUNCH_MISSING_PACKAGE = "missing-package";

/** A file the runner imports is not in this install: the runner is broken. */
export const LAUNCH_MISSING_FILE = "missing-file";

/** The runner died for a reason this does not recognise. */
export const LAUNCH_UNKNOWN = "unknown";

const MISSING_PACKAGE = /Cannot find package ['"]([^'"]+)['"]/;
const MISSING_MODULE = /Cannot find module ['"]([^'"]+)['"]/;

/**
 * Read a runner's failure output as a reason a person can act on.
 *
 * The summary is a whole sentence: its callers put it after one of their own,
 * and a bare clause read as a fragment there.
 *
 * @param {string} output - Whatever the failed launch wrote, usually stderr.
 * @returns {{ kind: string, specifier: string, summary: string }}
 */
export function classifyFrontendQaLaunchFailure(output) {
  const text = String(output ?? "");
  // The line that carries the reason, not the frame Node threw from. Both
  // shapes name the specifier, so one pass over the lines finds either.
  for (const line of text.split("\n")) {
    const asPackage = MISSING_PACKAGE.exec(line);
    if (asPackage) {
      return {
        kind: LAUNCH_MISSING_PACKAGE,
        specifier: asPackage[1],
        summary: `The runner's dependency "${asPackage[1]}" is not installed.`
      };
    }
    const asModule = MISSING_MODULE.exec(line);
    if (asModule) {
      return {
        kind: LAUNCH_MISSING_FILE,
        specifier: asModule[1],
        summary: `The runner imports ${asModule[1]}, which this install does not carry.`
      };
    }
  }
  // Nothing recognisable: the first non-empty line is still better than
  // nothing, and it is what the caller used to report unconditionally.
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) || "";
  return { kind: LAUNCH_UNKNOWN, specifier: "", summary: firstLine };
}
