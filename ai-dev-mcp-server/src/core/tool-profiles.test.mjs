import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_PROFILES,
  ALWAYS_ON_PROFILE,
  DEFAULT_PROFILE_IDS,
  PROFILE_IDS,
  TOOL_PROFILES,
  auditProfileCoverage,
  filterToolsByProfiles,
  findProfile,
  parseProfileSetting,
  profileNotes,
  profileOfTool,
  profilesFromEnvironment,
  resolveToolNames
} from "./tool-profiles.mjs";

test("every profile is described well enough to choose it from a list", () => {
  for (const profile of TOOL_PROFILES) {
    assert.match(profile.id, /^[a-z]+$/, `${profile.id} is not a usable setting value`);
    assert.ok(profile.title.length > 0, `${profile.id} has no title`);
    assert.ok(profile.summary.endsWith("."), `${profile.id}: summary should be a sentence`);
    assert.ok(profile.tools.length > 0, `${profile.id} carries no tools`);
  }
  assert.deepEqual(PROFILE_IDS, TOOL_PROFILES.map((profile) => profile.id));
});

test("core is the only profile that cannot be switched off", () => {
  const always = TOOL_PROFILES.filter((profile) => profile.always).map((profile) => profile.id);
  assert.deepEqual(always, [ALWAYS_ON_PROFILE]);
});

test("core carries the spine of the promise and nothing optional", () => {
  const core = findProfile("core");
  for (const tool of ["compile_project_context", "recommend_skills", "begin_task", "verify_task", "complete_task"]) {
    assert.ok(core.tools.includes(tool), `core should carry ${tool}`);
  }
  for (const tool of ["run_frontend_qa", "archify_render", "import_skill_repo"]) {
    assert.ok(!core.tools.includes(tool), `core should not carry ${tool}`);
  }
});

test("no tool is filed under two profiles", () => {
  const seen = new Set();
  for (const profile of TOOL_PROFILES) {
    for (const tool of profile.tools) {
      assert.ok(!seen.has(tool), `${tool} is filed under more than one profile`);
      seen.add(tool);
    }
  }
});

test("findProfile is forgiving about case and padding, and reports a miss", () => {
  assert.equal(findProfile("  Frontend ").id, "frontend");
  assert.equal(findProfile("nope"), undefined);
  assert.equal(findProfile(""), undefined);
  assert.equal(findProfile(null), undefined);
});

test("profileOfTool answers for a known tool and stays quiet for an unknown one", () => {
  assert.equal(profileOfTool("rollback_task"), "git");
  assert.equal(profileOfTool("record_decision"), "memory");
  assert.equal(profileOfTool("not_a_tool"), undefined);
});

test("an absent setting means the whole surface an agent gets: every profile but the opt-in ones", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const parsed = parseProfileSetting(raw);
    assert.equal(parsed.all, true);
    assert.deepEqual(parsed.ids, [...DEFAULT_PROFILE_IDS]);
    assert.deepEqual(parsed.unknown, []);
  }
  assert.deepEqual(PROFILE_IDS.filter((id) => !DEFAULT_PROFILE_IDS.includes(id)), ["control"]);
});

test("an opt-in profile is listed only when a session names it: beside all, or with core alone", () => {
  assert.deepEqual(parseProfileSetting("control"), { ids: ["core", "control"], all: false, unknown: [] });
  assert.deepEqual(parseProfileSetting("all,control"), { ids: [...PROFILE_IDS], all: true, unknown: [] });
  assert.equal(parseProfileSetting("all").ids.includes("control"), false);
});

test("stderr says what a narrowed session leaves out, and how to list everything", () => {
  assert.deepEqual(profileNotes({ tools_listed: 135, tools_total: 135, tools_opt_in: 0, profiles: [] }), []);
  assert.deepEqual(profileNotes({ tools_listed: 148, tools_total: 135, tools_opt_in: 13, profiles: [] }), []);
  assert.deepEqual(profileNotes({ tools_listed: 25, tools_total: 135, tools_opt_in: 0, profiles: ["core"] }), [
    "ai-dev: capability profiles core — 25 of 135 tools listed. Unset AI_DEV_PROFILES for all of them."
  ]);
  assert.deepEqual(profileNotes({ tools_listed: 38, tools_total: 135, tools_opt_in: 13, profiles: ["core", "control"], unknown_profiles: ["contrl"] }), [
    "ai-dev: capability profiles core, control — 25 of 135 tools listed, and the 13 of control. AI_DEV_PROFILES=all,control lists all of them.",
    "ai-dev: AI_DEV_PROFILES names \"contrl\", which is not a capability profile; ignoring it."
  ]);
});

test("`all` means the whole surface however it is written", () => {
  assert.equal(parseProfileSetting(ALL_PROFILES).all, true);
  assert.equal(parseProfileSetting("core, ALL").all, true);
});

test("a setting always includes core and is returned in documentation order", () => {
  const parsed = parseProfileSetting("qa,git");
  assert.deepEqual(parsed.ids, ["core", "git", "qa"]);
  assert.equal(parsed.all, false);
});

test("profiles may be separated by commas, spaces or both", () => {
  assert.deepEqual(parseProfileSetting("git qa").ids, ["core", "git", "qa"]);
  assert.deepEqual(parseProfileSetting("git,  qa ,").ids, ["core", "git", "qa"]);
});

test("a typo costs a session nothing but the profile it misspelled", () => {
  const parsed = parseProfileSetting("git,frontened,memory");
  assert.deepEqual(parsed.ids, ["core", "memory", "git"]);
  assert.deepEqual(parsed.unknown, ["frontened"]);
});

test("naming every profile by hand is the same as asking for all", () => {
  const parsed = parseProfileSetting(PROFILE_IDS.join(","));
  assert.equal(parsed.all, true);
});

test("profilesFromEnvironment reads AI_DEV_PROFILES and says where the answer came from", () => {
  const set = profilesFromEnvironment({ AI_DEV_PROFILES: "memory" });
  assert.deepEqual(set.ids, ["core", "memory"]);
  assert.equal(set.source, "AI_DEV_PROFILES");

  const unset = profilesFromEnvironment({});
  assert.equal(unset.all, true);
  assert.match(unset.source, /default/);
});

test("profilesFromEnvironment falls back to the real environment", () => {
  const previous = process.env.AI_DEV_PROFILES;
  delete process.env.AI_DEV_PROFILES;
  try {
    assert.equal(profilesFromEnvironment().all, true);
  } finally {
    if (previous !== undefined) process.env.AI_DEV_PROFILES = previous;
  }
});

test("resolveToolNames adds core to whatever it is given, and ignores a name it does not know", () => {
  const names = resolveToolNames(["git", "made_up"]);
  assert.ok(names.has("begin_task"), "core should always resolve");
  assert.ok(names.has("rollback_task"), "git should resolve");
  assert.ok(!names.has("run_frontend_qa"), "frontend was not asked for");
  assert.equal(names.size, findProfile("core").tools.length + findProfile("git").tools.length);
});

test("filterToolsByProfiles keeps the server's order and drops the rest", () => {
  const tools = [
    { name: "begin_task" },
    { name: "run_frontend_qa" },
    { name: "rollback_task" },
    { name: "complete_task" }
  ];
  assert.deepEqual(
    filterToolsByProfiles(tools, ["git"]).map((tool) => tool.name),
    ["begin_task", "rollback_task", "complete_task"]
  );
});

test("filterToolsByProfiles keeps a tool no profile has heard of", () => {
  const tools = [{ name: "begin_task" }, { name: "some_extension_tool" }];
  assert.deepEqual(
    filterToolsByProfiles(tools, []).map((tool) => tool.name),
    ["begin_task", "some_extension_tool"]
  );
});

test("asking for every profile filters nothing away", () => {
  const tools = TOOL_PROFILES.flatMap((profile) => profile.tools.map((name) => ({ name })));
  assert.equal(filterToolsByProfiles(tools, [...PROFILE_IDS]).length, tools.length);
});

test("auditProfileCoverage names a tool with no profile and a profile with no tool", () => {
  const mapped = TOOL_PROFILES.flatMap((profile) => [...profile.tools]);
  assert.deepEqual(auditProfileCoverage(mapped), { missing: [], unknown: [], duplicated: [] });

  const added = auditProfileCoverage([...mapped, "brand_new_tool"]);
  assert.deepEqual(added.missing, ["brand_new_tool"]);
  assert.deepEqual(added.unknown, []);

  const removed = auditProfileCoverage(mapped.filter((name) => name !== "usage_report"));
  assert.deepEqual(removed.missing, []);
  assert.deepEqual(removed.unknown, ["usage_report"]);
});
