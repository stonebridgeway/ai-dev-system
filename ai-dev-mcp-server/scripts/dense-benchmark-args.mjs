/**
 * The command line of `scripts/dense-benchmark.mjs`, apart from the run.
 *
 * The benchmark itself cannot be exercised without the weights, so the part
 * that can be — reading the flags — lives here and is tested. What made this
 * worth separating: `.github/workflows/dense-eval.yml` offers a `max_cases`
 * input, and until this module existed nothing read it. Dispatching the
 * workflow with 20 scored 50, quietly. A knob that does nothing is the kind of
 * claim this project keeps removing.
 */

/** Golden cases per backend when the caller names no number. */
export const DEFAULT_MAX_CASES = 50;

/**
 * A positive whole number, or the fallback.
 *
 * The workflow interpolates its input straight into the command, so the value
 * arriving here can be an empty string when the run was dispatched without
 * inputs. That is not an error: it means "as many as the default".
 *
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function readCount(value, fallback) {
  // Number, not parseInt: "1.5" is a mistake, not a request for one case, and
  // parseInt would read it as 1 and score one golden case without saying so.
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse the benchmark's arguments.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ out: string, label: string, maxCases: number }}
 */
export function parseBenchmarkArgs(argv, env = {}) {
  const options = {
    out: "",
    label: env.AI_DEV_DENSE_BACKEND || "auto",
    maxCases: DEFAULT_MAX_CASES
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") options.out = String(argv[index + 1] ?? "");
    else if (argument === "--label") options.label = String(argv[index + 1] ?? options.label);
    else if (argument === "--max-cases") options.maxCases = readCount(argv[index + 1], options.maxCases);
  }
  return options;
}
