import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, idleTimeoutMs } from "./daemon-idle.mjs";

test("the idle timeout: milliseconds from the environment, 30 minutes otherwise, 0 for never, and never more than a timer holds", () => {
  assert.equal(idleTimeoutMs({}), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(idleTimeoutMs({ AI_DEV_IDLE_TIMEOUT_MS: "60000" }), 60_000);
  assert.equal(idleTimeoutMs({ AI_DEV_IDLE_TIMEOUT_MS: "0" }), 0);
  for (const value of ["", "  ", "soon", "Infinity"]) assert.equal(idleTimeoutMs({ AI_DEV_IDLE_TIMEOUT_MS: value }), DEFAULT_IDLE_TIMEOUT_MS, value);
  // Thirty days: past what setTimeout holds, which would fire it at once.
  assert.equal(idleTimeoutMs({ AI_DEV_IDLE_TIMEOUT_MS: String(30 * 24 * 3600 * 1000) }), MAX_IDLE_TIMEOUT_MS);
  assert.equal(MAX_IDLE_TIMEOUT_MS, 2 ** 31 - 1);
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, MAX_IDLE_TIMEOUT_MS);
  return new Promise((resolve) => setTimeout(() => {
    clearTimeout(timer);
    assert.equal(fired, false, "the longest delay a timer holds does not fire at once");
    resolve();
  }, 20));
});
