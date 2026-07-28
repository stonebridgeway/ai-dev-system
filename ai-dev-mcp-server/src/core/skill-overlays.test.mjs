import assert from "node:assert/strict";
import test from "node:test";
import {
  applySkillOverlay,
  createSkillOverlayDocument,
  skillOverlayKey,
  summarizeSkillOverlays,
  upsertSkillOverlay,
  validateSkillOverlayDocument
} from "./skill-overlays.mjs";

test("source policy lowers connector routing without editing upstream metadata", () => {
  const document = createSkillOverlayDocument();
  const original = {
    name: "github",
    source: "membrane/application-skills",
    description: "Original upstream description."
  };
  const applied = applySkillOverlay(original, document);
  assert.equal(original.routing_priority, undefined);
  assert.equal(applied.routing_priority, "low");
  assert.equal(applied.do_not_use_when.length, 2);
});

test("specific overlay is validated, merged, and summarized", () => {
  let document = createSkillOverlayDocument();
  document = upsertSkillOverlay(document, {
    source: "external/ui",
    name: "taste",
    reviewer: "curator",
    overlay: {
      use_when: "Use for high-value visual direction.",
      aliases: ["premium-ui"],
      primary_group: "frontend-ui"
    }
  });
  const item = { source: "external/ui", name: "taste", aliases: ["visual"] };
  const applied = applySkillOverlay(item, document);
  assert.deepEqual(applied.aliases, ["visual", "premium-ui"]);
  assert.equal(applied.use_when, "Use for high-value visual direction.");
  assert.deepEqual(validateSkillOverlayDocument(document, {
    knownGroups: ["frontend-ui"],
    knownSkills: [skillOverlayKey(item.source, item.name)]
  }), []);
  assert.equal(summarizeSkillOverlays(document, [item]).applied_specific, 1);
});
