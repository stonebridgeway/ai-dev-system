/**
 * The one line worth reading out of a Python traceback.
 *
 * The legacy embedding workers and the UI UX Pro Max script are Python, and
 * when one of them refuses it refuses with an explanation: "sentence-transformers is required
 * for dense BGE-M3 embeddings. Run this command with the embeddings virtualenv
 * Python." That sentence is the last line of a forty-line traceback, and every
 * caller that reports a failure takes the first line — so a person running
 * `npm run setup -- --dense` was told, in full, "Traceback (most recent call
 * last):".
 *
 * Python puts the exception that actually stopped the program last, after any
 * "The above exception was the direct cause of" chain, so that is the one to
 * lead with. The rest is kept: a traceback is what a bug report needs.
 */

/** `ModuleNotFoundError: No module named 'x'`, and anything else shaped like it. */
const EXCEPTION_LINE = /^(?<type>[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Fault))(?<rest>: [\s\S]*)?$/;

/**
 * The final exception's own line, or "" when this is not a traceback.
 *
 * @param {string} output - Captured stderr.
 * @returns {string}
 */
export function pythonExceptionLine(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    // A frame's source line is indented; an exception's is not, and a bare
    // `Traceback (most recent call last):` is a header rather than a verdict.
    if (!line || lines[index].startsWith(" ") || lines[index].startsWith("\t")) continue;
    const match = EXCEPTION_LINE.exec(line);
    if (match) return match.groups.rest ? line : "";
  }
  return "";
}

/**
 * A failure message that leads with what went wrong.
 *
 * @param {string} output - Captured stderr.
 * @param {string} [fallback] - Used when the output says nothing at all.
 * @returns {string}
 */
export function pythonFailureMessage(output, fallback = "The Python helper failed.") {
  const text = String(output ?? "").trim();
  if (!text) return fallback;
  const verdict = pythonExceptionLine(text);
  if (!verdict) return text;
  // One line for whoever prints the first line, the traceback for whoever reads
  // the whole thing.
  return text.startsWith(verdict) ? text : `${verdict}\n\n${text}`;
}

/**
 * The tools that run the UI UX Pro Max dataset's own Python script — with the
 * legacy dense backend, all that still needs an interpreter.
 */
export const UI_UX_PYTHON_TOOLS = "query_ui_ux_knowledge and generate_ui_ux_design_system";

/**
 * What a caller is told when an optional Python helper could not run: that no
 * interpreter was found and how to provide one, or else what the helper said.
 * Nothing in the server needs Python but the tools that run such a helper —
 * {@link UI_UX_PYTHON_TOOLS} and the legacy dense backend.
 *
 * @param {unknown} error - From running the helper.
 * @param {{ tool: string, interpreter: string }} context - `tool` names the tool, or tools joined by " and ".
 * @returns {Error}
 */
export function optionalPythonFailure(error, { tool, interpreter }) {
  const message = String(error?.message ?? error ?? "");
  if (error?.code === "ENOENT" || /\bENOENT\b/.test(message)) {
    return new Error(
      `${tool} run${/ and /.test(tool) ? "" : "s"} a Python helper, and no Python was found here (tried "${interpreter}"). `
      + "Install Python 3 and put it on PATH, or set AI_DEV_PYTHON to the interpreter. "
      + "Nothing else needs Python: search, skills and the rest of the server run without it.",
      { cause: error }
    );
  }
  return new Error(pythonFailureMessage(message, `${tool} failed.`), { cause: error });
}
