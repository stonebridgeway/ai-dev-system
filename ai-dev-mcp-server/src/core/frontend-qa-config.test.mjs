import assert from "node:assert/strict";
import test from "node:test";
import { filterProjectQaConfig } from "./frontend-qa-config.mjs";

test("project frontend QA config keeps checks but ignores server-owned writes", () => {
  const result = filterProjectQaConfig({
    url: "http://127.0.0.1:3000",
    routes: ["/"],
    update_registry: true,
    write_report: true,
    artifact_location: "project"
  });
  assert.deepEqual(result.config, { url: "http://127.0.0.1:3000", routes: ["/"] });
  assert.deepEqual(result.ignoredKeys, ["update_registry", "write_report", "artifact_location"]);
});

test("project frontend QA config rejects non-object JSON", () => {
  assert.throws(() => filterProjectQaConfig([]), /JSON object/);
});
