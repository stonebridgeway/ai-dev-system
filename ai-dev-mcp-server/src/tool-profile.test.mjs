import assert from "node:assert/strict";
import test from "node:test";
import { buildCoreToolDefinitions, resolveCoreToolCall, resolveToolProfile } from "./core/tool-profile.mjs";

test("core profile stays within the context budget", () => {
  const tools = buildCoreToolDefinitions();
  assert.ok(tools.length <= 25);
  assert.ok(Buffer.byteLength(JSON.stringify(tools), "utf8") <= 25_000);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false));
});

test("full profile preserves every legacy definition", () => {
  const legacy = [{ name: "legacy_one" }, { name: "legacy_two" }];
  assert.deepEqual(resolveToolProfile(legacy), buildCoreToolDefinitions());
  process.env.AI_DEV_TOOL_PROFILE = "full";
  try {
    assert.deepEqual(resolveToolProfile(legacy), legacy);
  } finally {
    delete process.env.AI_DEV_TOOL_PROFILE;
  }
});

test("core actions resolve to legacy handlers", () => {
  assert.deepEqual(resolveCoreToolCall("search", { query: "commands", scope: "skills" }), {
    name: "search_skills",
    args: { query: "commands", scope: "skills" }
  });
  assert.deepEqual(resolveCoreToolCall("system", { action: "health" }), {
    name: "system_health_check",
    args: {}
  });
  assert.deepEqual(resolveCoreToolCall("diagram", { action: "validate", spec: {} }), {
    name: "archify_validate",
    args: { spec: {} }
  });
});
