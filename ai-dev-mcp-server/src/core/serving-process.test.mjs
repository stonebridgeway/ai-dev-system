import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { markServingDaemon, servingProcess } from "./serving-process.mjs";

test("the serving process: a client's own, then the daemon, which says when it has retired", () => {
  assert.deepEqual(servingProcess(), { kind: "process", pid: process.pid });
  let retired = null;
  markServingDaemon({ build: "b1", startedAt: "2026-10-12T00:00:00.000Z", idleTimeoutMs: 1800000.4, sessions: () => 2, retired: () => retired });
  assert.deepEqual(servingProcess(), { kind: "daemon", pid: process.pid, build: "b1", sessions: 2, started_at: "2026-10-12T00:00:00.000Z", idle_timeout_ms: 1800000 });
  retired = { at: "2026-10-12T01:00:00.000Z", reason: "the code it runs was replaced, and a daemon of the new code serves now" };
  const now = servingProcess();
  assert.equal(now.retired, true);
  assert.match(now.retired_reason, /code it runs was replaced/);
  // A daemon that never says whether it retired is not taken for one that did.
  markServingDaemon({ build: "b2", startedAt: "2026-10-12T00:00:00.000Z", idleTimeoutMs: 0, sessions: () => 0 });
  assert.equal(Object.hasOwn(servingProcess(), "retired"), false);
});
