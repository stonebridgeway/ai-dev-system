import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FILE_CLOCK_MARGIN_MS,
  checkSkillRegistry,
  createSkillRegistryReader,
  dateSkillRegistry,
  keepSkillRegistryDate,
  skillRegistryStaleness,
  withCurrentSkillRegistry,
  withSkillRegistryLock
} from "./skill-registry-freshness.mjs";

const PAST = new Date(Date.now() - 120_000);

/**
 * A catalogue with two skills and a registry written after them, every source
 * file and directory dated two minutes back.
 */
async function makeCatalog(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-registry-freshness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "03-skills-catalog");
  const skills = ["sources/custom/alpha/SKILL.md", "sources/external/pack/skills/beta/SKILL.md"];
  for (const relative of skills) {
    await fs.mkdir(path.dirname(path.join(catalog, relative)), { recursive: true });
    await fs.writeFile(path.join(catalog, relative), `# ${relative}\n`);
  }
  for (const relative of [...skills, "sources/custom/alpha", "sources/external/pack/skills/beta", "sources/external/pack/skills",
    "sources/external/pack", "sources/external", "sources/custom", "sources"]) {
    await fs.utimes(path.join(catalog, relative), PAST, PAST);
  }
  const registryPath = path.join(catalog, "registries", "skills.index.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `﻿${JSON.stringify(skills.map((relative) => ({ name: path.basename(path.dirname(relative)), path: relative })))}`);
  return { catalog, registryPath, skills };
}

/**
 * The check, a second after the change it is asked about. Linux 6.13+ dates a
 * file it has been asked about to the nanosecond, Date.now() to the
 * millisecond: checked in the same millisecond, a change reads as a time in
 * the future, and this suite failed once in ten runs under load. Seeing a
 * change that early is the product's question, recorded on its own;
 * here every rule is checked once the change
 * is behind the clock.
 */
async function staleness({ catalog, registryPath }, nowMs = Date.now() + 1000) {
  return checkSkillRegistry({ registryPath, catalogRoot: catalog, nowMs });
}

test("a registry written after its skills is current", async (t) => {
  const fixture = await makeCatalog(t);
  const verdict = await staleness(fixture);
  assert.deepEqual(verdict, { stale: false, missing: 0, changed: 0, directories: 0, examples: [] });
});

test("no registry is not an out-of-date registry", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.rm(fixture.registryPath);
  assert.equal(await staleness(fixture), null);
});

test("a skill removed, as a pull removes it, makes the registry stale", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.rm(path.join(fixture.catalog, "sources/external/pack/skills/beta"), { recursive: true });
  const verdict = await staleness(fixture);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.missing, 1);
  assert.deepEqual(verdict.examples, ["missing sources/external/pack/skills/beta/SKILL.md"]);
});

test("a skill rewritten after the registry makes it stale", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.writeFile(path.join(fixture.catalog, "sources/custom/alpha/SKILL.md"), "# alpha, rewritten\n");
  const verdict = await staleness(fixture);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.changed, 1);
  assert.deepEqual(verdict.examples, ["changed sources/custom/alpha/SKILL.md"]);
});

test("a skill added next to the others makes the registry stale", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.mkdir(path.join(fixture.catalog, "sources/external/pack/skills/gamma"));
  const verdict = await staleness(fixture);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.directories, 1);
  assert.deepEqual(verdict.examples, ["directory sources/external/pack/skills"]);
});

test("a whole new source is seen from the folder above it", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.mkdir(path.join(fixture.catalog, "sources/external/another/skills/delta"), { recursive: true });
  const verdict = await staleness(fixture);
  assert.equal(verdict.stale, true);
  assert.deepEqual(verdict.examples, ["directory sources/external"]);
});

test("files inside a skill's own folder do not count: caches and vendored modules live there", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.mkdir(path.join(fixture.catalog, "sources/custom/alpha/__pycache__"));
  await fs.writeFile(path.join(fixture.catalog, "sources/custom/alpha/__pycache__/x.pyc"), "");
  assert.equal((await staleness(fixture)).stale, false);
});

test("a time in the future is not evidence: no rebuild could get past it", async (t) => {
  const fixture = await makeCatalog(t);
  const ahead = new Date(Date.now() + 3_600_000);
  await fs.utimes(path.join(fixture.catalog, "sources/custom/alpha/SKILL.md"), ahead, ahead);
  assert.equal((await staleness(fixture)).stale, false);
  assert.equal((await staleness(fixture, Date.now() + 7_200_000)).stale, true, "once that time has passed it counts");
});

test("the pure check takes a stat function and the registry's own time", () => {
  const files = new Map([
    ["/v/03-skills-catalog/sources/custom/a/SKILL.md", { mtimeMs: 5 }],
    ["/v/03-skills-catalog/sources/custom", { mtimeMs: 5 }],
    ["/v/03-skills-catalog/sources", { mtimeMs: 50 }]
  ]);
  const verdict = skillRegistryStaleness({
    catalogRoot: "/v/03-skills-catalog",
    builtAtMs: 10,
    paths: ["sources/custom/a/SKILL.md", "sources/custom/b/SKILL.md"],
    nowMs: 100,
    stat: (target) => files.get(target.replaceAll("\\", "/").replace(/^[A-Za-z]:/, ""))
  });
  assert.deepEqual(verdict, {
    stale: true,
    missing: 1,
    changed: 0,
    directories: 1,
    examples: ["missing sources/custom/b/SKILL.md", "directory sources"]
  });
});

/** A reader over the fixture whose rebuild rewrites the registry from what is on disk. */
function readerFor(fixture, { onRebuild = async () => {}, clock = { now: Date.now() }, ...options } = {}) {
  const rebuilds = [];
  const reader = createSkillRegistryReader({
    registryPath: fixture.registryPath,
    catalogRoot: fixture.catalog,
    now: () => clock.now,
    async rebuild(verdict) {
      rebuilds.push(verdict);
      await onRebuild();
      const present = [];
      for (const relative of fixture.skills) {
        if (await fs.stat(path.join(fixture.catalog, relative)).then(() => true, () => false)) present.push({ path: relative });
      }
      await fs.writeFile(fixture.registryPath, JSON.stringify(present));
    },
    ...options
  });
  return { reader, rebuilds, clock };
}

test("the reader serves a current registry as it is and rebuilds a stale one first", async (t) => {
  const fixture = await makeCatalog(t);
  const { reader, rebuilds } = readerFor(fixture, { intervalMs: 0 });
  assert.equal((await reader.read()).length, 2, "a leading BOM is read as it always was");
  assert.equal(rebuilds.length, 0);

  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  const after = await reader.read();
  assert.equal(rebuilds.length, 1);
  assert.deepEqual(after.map((item) => item.path), ["sources/external/pack/skills/beta/SKILL.md"]);
  assert.equal(rebuilds[0].missing, 1);
});

test("a registry that is not there is built before the first read: no `ai-dev setup` needed", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.rm(fixture.registryPath);
  const { reader, rebuilds } = readerFor(fixture, { intervalMs: 0 });
  const [first, second] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(rebuilds.length, 1, "two first readers share one build");
  assert.deepEqual(first.map((item) => item.path), fixture.skills);
  assert.deepEqual(second, first);
  assert.equal(rebuilds[0].stale, true);
  assert.equal((await reader.ensureFresh()).action, "current", "built once, then read as any registry");
  assert.equal(rebuilds.length, 1);
});

test("a registry that cannot be built where it is missing is tried again after a pause, and the read still says why", async (t) => {
  const fixture = await makeCatalog(t);
  await fs.rm(fixture.registryPath);
  const clock = { now: Date.now() };
  const errors = [];
  let attempts = 0;
  const reader = createSkillRegistryReader({
    registryPath: fixture.registryPath,
    catalogRoot: fixture.catalog,
    now: () => clock.now,
    retryDelays: [60_000],
    onError: (error) => errors.push(error.message),
    async rebuild() {
      attempts += 1;
      throw new Error("read-only vault");
    }
  });
  await assert.rejects(reader.read(), { code: "ENOENT" });
  assert.deepEqual(errors, ["read-only vault"]);
  clock.now += 30_000;
  assert.equal((await reader.ensureFresh()).action, "absent", "inside the pause it is not tried again");
  assert.equal(attempts, 1);
  clock.now += 30_000;
  assert.equal((await reader.ensureFresh()).action, "failed", "after the pause it is");
  assert.equal(attempts, 2);
});

test("the reader looks at the files at most once per interval while the registry stays the same", async (t) => {
  const fixture = await makeCatalog(t);
  const clock = { now: Date.now() };
  const { reader, rebuilds } = readerFor(fixture, { clock, intervalMs: 5_000 });
  assert.equal((await reader.ensureFresh()).action, "current");
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  assert.equal((await reader.ensureFresh()).action, "current", "inside the interval the last verdict stands");
  assert.equal(rebuilds.length, 0);
  clock.now += 5_000;
  assert.equal((await reader.ensureFresh()).action, "rebuilt");
  assert.equal(rebuilds.length, 1);
});

test("concurrent readers share one rebuild, and reads made by the rebuild do not wait for it", async (t) => {
  const fixture = await makeCatalog(t);
  let inner;
  const { reader, rebuilds } = readerFor(fixture, {
    // The registry rebuild reads the registry itself (cards, taxonomy); were
    // that read to wait for the rebuild, it would wait forever.
    onRebuild: async () => {
      inner = await reader.read();
    }
  });
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  const [first, second] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(rebuilds.length, 1, "one rebuild for both");
  assert.equal(first.length, 1);
  assert.equal(second.length, 1, "the second reader waited for the rebuild instead of reading the old registry");
  assert.equal(inner.length, 2, "the rebuild's own read saw the registry as it stood");
});

test("a writer under the registry's lock reads the registry as it stands: a stale one starts no rebuild to wait for it", async (t) => {
  const fixture = await makeCatalog(t);
  const registryDir = path.dirname(fixture.registryPath);
  // The rebuild a read would start takes the registry's lock, as `rebuild_index` does.
  const { reader, rebuilds } = readerFor(fixture, { intervalMs: 0, onRebuild: () => withSkillRegistryLock(registryDir, async () => {}) });
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  const inner = await withSkillRegistryLock(registryDir, () => reader.read());
  assert.equal(rebuilds.length, 0, "a writer's own read started a rebuild");
  assert.equal(inner.length, 2, "the registry as it stood");
  assert.equal((await reader.read()).length, 1, "outside a writer the stale registry is rebuilt");
});

test("a writer of the registry that calls another runs it at once; writers apart go one after the other", async (t) => {
  const fixture = await makeCatalog(t);
  const registryDir = path.dirname(fixture.registryPath);
  const started = Date.now();
  assert.equal(await withSkillRegistryLock(registryDir, () => withSkillRegistryLock(registryDir, async () => "inner")), "inner");
  assert.ok(Date.now() - started < 5_000, "the inner writer waited for the outer one's lock");
  const events = [];
  const writer = (name) => withSkillRegistryLock(registryDir, async () => {
    events.push(`${name} start`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push(`${name} end`);
  });
  await Promise.all([writer("a"), writer("b")]);
  // Which of two writers that start together goes first is the lock's to say: one runs whole, then the other.
  const [first, second] = events[0] === "a start" ? ["a", "b"] : ["b", "a"];
  assert.deepEqual(events, [`${first} start`, `${first} end`, `${second} start`, `${second} end`]);
});

test("a writer that builds from the registry gets a current one: a stale registry is rebuilt before it runs", async (t) => {
  const fixture = await makeCatalog(t);
  const registryDir = path.dirname(fixture.registryPath);
  const events = [];
  // The rebuild a read starts takes the registry's lock, as `rebuild_index` does.
  const { reader, rebuilds } = readerFor(fixture, {
    intervalMs: 0,
    onRebuild: () => withSkillRegistryLock(registryDir, async () => { events.push("rebuild"); })
  });
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  const seen = await withCurrentSkillRegistry(reader, registryDir, async () => {
    events.push("writer");
    return reader.read();
  });
  assert.equal(rebuilds.length, 1);
  assert.deepEqual(events, ["rebuild", "writer"]);
  assert.deepEqual(seen.map((item) => item.path), ["sources/external/pack/skills/beta/SKILL.md"], "the taxonomy saw the skill gone");
});

test("a writer that builds from the registry waits for a rebuild another call started, not under the lock that rebuild needs", async (t) => {
  const fixture = await makeCatalog(t);
  const registryDir = path.dirname(fixture.registryPath);
  const events = [];
  const { reader, rebuilds } = readerFor(fixture, {
    intervalMs: 0,
    onRebuild: () => withSkillRegistryLock(registryDir, async () => {
      events.push("rebuild start");
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push("rebuild end");
    })
  });
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  const started = Date.now();
  // Another call's read starts the rebuild first; the taxonomy comes while it runs.
  const other = reader.read();
  const writer = withCurrentSkillRegistry(reader, registryDir, async () => { events.push("writer"); });
  const stuck = new Promise((resolve) => setTimeout(() => resolve("stuck"), 10_000).unref());
  assert.notEqual(await Promise.race([Promise.all([other, writer]), stuck]), "stuck", "the writer held the lock the rebuild it waits for needs");
  assert.ok(Date.now() - started < 10_000);
  assert.equal(rebuilds.length, 1, "one rebuild for both");
  assert.deepEqual(events, ["rebuild start", "rebuild end", "writer"]);
});

test("a rebuild that fails is retried after a pause, or at once when the registry changes", async (t) => {
  const fixture = await makeCatalog(t);
  const clock = { now: Date.now() };
  const errors = [];
  let attempts = 0;
  const reader = createSkillRegistryReader({
    registryPath: fixture.registryPath,
    catalogRoot: fixture.catalog,
    now: () => clock.now,
    retryDelays: [60_000, 120_000],
    onError: (error) => errors.push(error.message),
    async rebuild() {
      attempts += 1;
      throw new Error("read-only vault");
    }
  });
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  assert.equal((await reader.read()).length, 2, "the registry on disk is served as it is");
  clock.now += 30_000;
  assert.equal((await reader.ensureFresh()).action, "stale", "inside the pause it is not tried again");
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ["read-only vault"]);
  clock.now += 30_000;
  assert.equal((await reader.ensureFresh()).action, "failed", "after the pause it is");
  assert.equal(attempts, 2);
  clock.now += 60_000;
  assert.equal((await reader.ensureFresh()).action, "stale", "the second pause is longer");
  assert.equal(attempts, 2);

  // Someone rebuilds it by hand: the next look starts afresh.
  await fs.writeFile(fixture.registryPath, JSON.stringify([{ path: "sources/external/pack/skills/beta/SKILL.md" }]));
  clock.now += 1_000;
  assert.equal((await reader.ensureFresh()).action, "current");
});

test("a rebuild that leaves the registry stale is not run in a loop, but is tried again later", async (t) => {
  const fixture = await makeCatalog(t);
  const clock = { now: Date.now() };
  const errors = [];
  let attempts = 0;
  const reader = createSkillRegistryReader({
    registryPath: fixture.registryPath,
    catalogRoot: fixture.catalog,
    now: () => clock.now,
    retryDelays: [60_000],
    onError: (error) => errors.push(error.message),
    async rebuild() {
      attempts += 1;
      // Writes a registry that still names a file that is not there.
      await fs.writeFile(fixture.registryPath, JSON.stringify([{ path: "sources/custom/ghost/SKILL.md" }]));
    }
  });
  await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  assert.equal((await reader.ensureFresh()).action, "rebuilt");
  for (let round = 0; round < 3; round += 1) {
    clock.now += 10_000;
    assert.equal((await reader.ensureFresh()).action, "stale");
  }
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /still out of date after a rebuild: missing sources\/custom\/ghost\/SKILL\.md/);
  clock.now += 60_000;
  assert.equal((await reader.ensureFresh()).action, "rebuilt");
  assert.equal(attempts, 2);
});

test("skills changed, added or removed while the rebuild runs are put right by the next looks", async (t) => {
  const fixture = await makeCatalog(t);
  // Later than every write below, however slow the machine: the reader takes
  // a file stamped after its clock for one from the future and ignores it.
  // Time still moves only by the steps below.
  const clock = { now: Date.now() + 60_000 };
  const put = async (relative, text) => {
    await fs.mkdir(path.dirname(path.join(fixture.catalog, relative)), { recursive: true });
    await fs.writeFile(path.join(fixture.catalog, relative), text);
  };
  let duringRebuild = async () => {};
  const rebuilds = [];
  const reader = createSkillRegistryReader({
    registryPath: fixture.registryPath,
    catalogRoot: fixture.catalog,
    now: () => clock.now,
    intervalMs: 0,
    retryDelays: [1_000],
    // As rebuild_index does it: note the time, read the sources, write, date the registry.
    async rebuild() {
      const sourcesReadAt = new Date();
      const entries = [];
      for (const group of ["custom", "external/pack/skills"]) {
        const root = path.join(fixture.catalog, "sources", group);
        for (const name of await fs.readdir(root)) {
          const relative = `sources/${group}/${name}/SKILL.md`;
          entries.push({ path: relative, body: await fs.readFile(path.join(fixture.catalog, relative), "utf8") });
        }
      }
      rebuilds.push(entries.map((entry) => `${entry.path.split("/").at(-2)}=${entry.body.trim()}`).sort().join(" "));
      await duringRebuild();
      duringRebuild = async () => {};
      await fs.writeFile(fixture.registryPath, JSON.stringify(entries));
      // On the process's clock alone: this test is about the looks after a
      // rebuild, and every write here lands within the file-clock margin.
      await dateSkillRegistry(fixture.registryPath, sourcesReadAt, { marginMs: 0 });
    }
  });
  // A pull lands while the first rebuild runs: a skill rewritten, one added, one removed.
  await put("sources/custom/alpha/SKILL.md", "v2");
  duringRebuild = async () => {
    await put("sources/external/pack/skills/beta/SKILL.md", "v2");
    await put("sources/custom/gamma/SKILL.md", "v1");
    await fs.rm(path.join(fixture.catalog, "sources/custom/alpha"), { recursive: true });
  };
  assert.equal((await reader.ensureFresh()).action, "rebuilt");
  // The next rebuild notes its time once the process's clock has passed what
  // the pull wrote, as a look seconds later does. On Windows a file is stamped
  // up to a tick (~16 ms) after the process's clock: V8 counts on from one
  // coarse reading of the system time, NTFS stamps a fresh one, and a pull
  // made before the rebuild began would read as made after it.
  const pulled = ["sources/custom", "sources/custom/gamma/SKILL.md", "sources/external/pack/skills/beta/SKILL.md"];
  const pulledAt = Math.max(...await Promise.all(pulled.map(async (relative) => (await fs.stat(path.join(fixture.catalog, relative))).mtimeMs)));
  while (Date.now() <= pulledAt) await new Promise((resolve) => setTimeout(resolve, 5));
  clock.now += 1_000;
  assert.equal((await reader.ensureFresh()).action, "rebuilt", "the next look sees what the pull did under the rebuild");
  clock.now += 1_000;
  assert.equal((await reader.ensureFresh()).action, "current");
  assert.equal(rebuilds.at(-1), "beta=v2 gamma=v1");
  const registry = JSON.parse(await fs.readFile(fixture.registryPath, "utf8"));
  assert.deepEqual(registry.map((entry) => entry.path).sort(), ["sources/custom/gamma/SKILL.md", "sources/external/pack/skills/beta/SKILL.md"]);
});

test("a skill rewritten just after the rebuild noted its time is newer than the registry, stamped a tick early or not", async (t) => {
  const fixture = await makeCatalog(t);
  const skill = path.join(fixture.catalog, "sources/custom/alpha/SKILL.md");
  const sourcesReadAt = new Date(Date.now() - 10_000);
  // The pull rewrites the skill after that moment, and the file clock stamps it
  // a coarse tick before it — what Linux before 6.13, Windows and HFS+ do.
  await fs.writeFile(skill, "# alpha, pulled\n");
  const stamped = new Date(sourcesReadAt.getTime() - 5);
  await fs.utimes(skill, stamped, stamped);
  await dateSkillRegistry(fixture.registryPath, sourcesReadAt);
  assert.equal((await staleness(fixture)).stale, true, "seen with the margin");
  await dateSkillRegistry(fixture.registryPath, sourcesReadAt, { marginMs: 0 });
  assert.equal((await staleness(fixture)).stale, false, "without it the rewrite reads as older than the registry");
  const registryTime = (await fs.stat(fixture.registryPath)).mtimeMs;
  await dateSkillRegistry(fixture.registryPath, sourcesReadAt);
  assert.equal(registryTime - (await fs.stat(fixture.registryPath)).mtimeMs, FILE_CLOCK_MARGIN_MS);
});

test("a change stamped finer than Date.now(), in the same millisecond, is not from the future", () => {
  const verdict = (mtimeMs) => skillRegistryStaleness({
    catalogRoot: "/v/03-skills-catalog",
    builtAtMs: 10,
    paths: ["sources/custom/a/SKILL.md"],
    nowMs: 100,
    stat: (target) => (target.replaceAll("\\", "/").endsWith("SKILL.md") ? { mtimeMs } : { mtimeMs: 1 })
  }).changed;
  assert.equal(verdict(100.6), 1, "this millisecond");
  assert.equal(verdict(100), 1);
  assert.equal(verdict(101), 0, "the next millisecond is still the future");
  assert.equal(verdict(3_600_100), 0);
});

test("a rewrite of the registry from itself keeps the date of the sources it describes", async (t) => {
  const fixture = await makeCatalog(t);
  const before = (await fs.stat(fixture.registryPath)).mtimeMs;
  await keepSkillRegistryDate(fixture.registryPath, () => fs.writeFile(fixture.registryPath, "[]"));
  const after = (await fs.stat(fixture.registryPath)).mtimeMs;
  assert.ok(after <= before && before - after < 0.01, `kept to the microsecond, never later: ${before} -> ${after}`);
  // A skill changed before the rewrite is still newer than the registry.
  await fs.writeFile(path.join(fixture.catalog, "sources/custom/alpha/SKILL.md"), "# alpha, pulled\n");
  await keepSkillRegistryDate(fixture.registryPath, () => fs.writeFile(fixture.registryPath, JSON.stringify(fixture.skills.map((relative) => ({ path: relative })))));
  // Asked a second later, as every check here is: in the same millisecond the change reads as future.
  assert.equal((await staleness(fixture)).stale, true);
});
