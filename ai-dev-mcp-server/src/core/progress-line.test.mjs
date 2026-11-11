import assert from "node:assert/strict";
import test from "node:test";
import { createProgressPrinter, describeProgress, formatDuration, LOG_PROGRESS_INTERVAL_MS } from "./progress-line.mjs";

const MB = 1024 * 1024;

test("durations read as a person says them", () => {
  assert.deepEqual([0.2, 21, 59, 61, 600, 3725, null, -1].map(formatDuration), ["1 s", "21 s", "59 s", "1 min", "10 min", "1 h 2 min", "", ""]);
});

test("each phase has its own line: bytes, share, speed and time left where they are known", () => {
  assert.equal(
    describeProgress({ phase: "downloading", file: "onnx/model_int8.onnx", bytes: 312 * MB, total: 568 * MB, speed: 12.3 * MB, etaSeconds: 21 }),
    "onnx/model_int8.onnx  312 MB of 568 MB (54%) · 12.3 MB/s · 21 s left"
  );
  assert.equal(describeProgress({ phase: "downloading", file: "config.json", bytes: 700, total: null, speed: 0, etaSeconds: null }), "config.json  700 B");
  assert.equal(describeProgress({ phase: "verifying", file: "config.json", bytes: MB, total: 568 * MB }), "checking config.json  1.0 MB of 568 MB (0%)");
  assert.equal(describeProgress({ phase: "importing", file: "tokenizer.json", bytes: 16 * MB, total: 16 * MB }), "copying tokenizer.json  16.0 MB of 16.0 MB (100%)");
  assert.equal(describeProgress({ phase: "embedding", done: 64, total: 825, etaSeconds: 190 }), "embedding 64 of 825 document(s) (7%) · 3 min left");
  assert.equal(describeProgress({ phase: "done", bytes: 568 * MB }), "568 MB in place");
  assert.equal(describeProgress({ phase: "something else" }), "something else");
});

test("in a terminal one line is rewritten in place, cut to the width, and ended once", () => {
  const written = [];
  const print = createProgressPrinter({ stream: { isTTY: true, columns: 40, write: (text) => written.push(text) }, indent: "" });
  print({ phase: "embedding", done: 1, total: 10 });
  print({ phase: "embedding", done: 2, total: 10 });
  print({ phase: "downloading", file: "a-very-long-file-name-that-does-not-fit.onnx", bytes: 1, total: 2, speed: 1, etaSeconds: 1 });
  print.end();
  print.end();
  assert.ok(written.slice(0, 3).every((text) => text.startsWith("\r")));
  assert.ok(written[2].length <= 40, "never wider than the terminal");
  assert.ok(written[2].includes("…"));
  assert.deepEqual(written.slice(3), ["\n"], "one newline at the end, not two");
});

test("into a log a line goes out when the file or phase changes, and otherwise every few seconds", () => {
  const written = [];
  let clock = 0;
  const print = createProgressPrinter({ stream: { isTTY: false, write: (text) => written.push(text) }, indent: "", now: () => clock });
  print({ phase: "downloading", file: "a", bytes: 1, total: 10 });
  print({ phase: "downloading", file: "a", bytes: 2, total: 10 });
  clock = LOG_PROGRESS_INTERVAL_MS;
  print({ phase: "downloading", file: "a", bytes: 3, total: 10 });
  print({ phase: "downloading", file: "b", bytes: 4, total: 10 });
  print({ phase: "done", bytes: 10 });
  print.end();
  assert.equal(written.length, 4);
  assert.ok(written.every((text) => text.endsWith("\n") && !text.includes("\r")));
});
