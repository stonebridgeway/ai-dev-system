import assert from "node:assert/strict";
import test from "node:test";
import { nextSteps } from "./setup.mjs";

test("setup ends on what to do next: a restart only for clients it connected, the first request, and the profiles", () => {
  const connected = nextSteps({ connected: true });
  const left = nextSteps({ connected: false });
  assert.equal(connected[0], "Next:");
  assert.equal(connected.filter((line) => /Restart the AI clients/.test(line)).length, 1);
  assert.equal(left.some((line) => /Restart/.test(line)), false, "nothing was connected, so nothing is to restart");
  for (const lines of [connected, left]) {
    assert.ok(lines.some((line) => line.includes("Use the ai-dev MCP server. Begin a task for")));
    assert.ok(lines.some((line) => /settings set profiles core,git/.test(line)));
  }
});
