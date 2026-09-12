/**
 * The one line worth reading out of a Python traceback.
 *
 * The search helper and the embedding workers are Python, and when one of them
 * refuses it refuses with an explanation: "sentence-transformers is required
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
