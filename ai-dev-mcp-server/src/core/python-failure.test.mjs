import assert from "node:assert/strict";
import test from "node:test";
import { pythonExceptionLine, pythonFailureMessage } from "./python-failure.mjs";

// What the search helper printed when `npm run setup -- --dense` ran without
// the embeddings virtualenv. The useful sentence is the last line; the setup
// report prints the first.
const CHAINED = [
  "Traceback (most recent call last):",
  '  File "/repo/search-index/search_cli.py", line 541, in load_dense_model',
  "    from sentence_transformers import SentenceTransformer",
  "ModuleNotFoundError: No module named 'sentence_transformers'",
  "",
  "The above exception was the direct cause of the following exception:",
  "",
  "Traceback (most recent call last):",
  '  File "/repo/search-index/search_cli.py", line 1702, in main',
  "    raise RuntimeError(message) from err",
  "RuntimeError: sentence-transformers is required for dense BGE-M3 embeddings. "
    + "Run this command with the embeddings virtualenv Python.",
  ""
].join("\n");

test("the exception that stopped the program is the one reported", () => {
  assert.equal(
    pythonExceptionLine(CHAINED),
    "RuntimeError: sentence-transformers is required for dense BGE-M3 embeddings. "
      + "Run this command with the embeddings virtualenv Python."
  );
  // A caller that prints one line prints that one.
  assert.match(pythonFailureMessage(CHAINED).split("\n")[0], /^RuntimeError: sentence-transformers is required/);
  // And the traceback is still there for whoever reads the whole thing.
  assert.match(pythonFailureMessage(CHAINED), /ModuleNotFoundError: No module named 'sentence_transformers'/);
});

test("a traceback that already leads with its verdict is not rearranged", () => {
  const already = "RuntimeError: model directory is empty\n\nTraceback (most recent call last):\n  File \"a.py\"";
  assert.equal(pythonFailureMessage(already), already);
});

test("output that is not a traceback is passed through", () => {
  assert.equal(pythonExceptionLine("python: can't open file 'search_cli.py'"), "");
  assert.equal(pythonFailureMessage("python: can't open file 'search_cli.py'"), "python: can't open file 'search_cli.py'");
  assert.equal(pythonFailureMessage("   \n  "), "The Python helper failed.");
  assert.equal(pythonFailureMessage("", "Search helper failed: rebuild"), "Search helper failed: rebuild");
});

test("a header without a message is not mistaken for a verdict", () => {
  // `Traceback (most recent call last):` is unindented and ends in a colon, and
  // saying it back to a person tells them nothing.
  const headerOnly = 'Traceback (most recent call last):\n  File "a.py", line 1, in <module>\n';
  assert.equal(pythonExceptionLine(headerOnly), "");
  assert.equal(pythonFailureMessage(headerOnly), headerOnly.trim());
});

test("an exception message that runs over several lines keeps all of them", () => {
  const multiline = [
    "Traceback (most recent call last):",
    '  File "a.py", line 3, in <module>',
    "ValueError: the index is at schema 4 and this helper writes 5.",
    "Rebuild it with rebuild_search_index."
  ].join("\n");
  assert.match(pythonExceptionLine(multiline), /^ValueError: the index is at schema 4/);
  assert.match(pythonFailureMessage(multiline).split("\n")[0], /^ValueError:/);
});
