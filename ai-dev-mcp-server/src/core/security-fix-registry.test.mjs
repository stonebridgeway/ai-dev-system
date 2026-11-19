import assert from "node:assert/strict";
import test from "node:test";
import { chooseTarget, DEFAULT_MIN_RELEASE_AGE_DAYS, fetchPackageMetadata, registryUrl } from "./security-fix-registry.mjs";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

// fast-uri as the registry described it on 2026-09-27, trimmed to the 3.x line.
const FAST_URI = {
  ok: true,
  versions: ["3.0.0", "3.1.4", "3.1.5", "3.1.6", "3.1.7", "3.1.8", "4.0.0-beta.1", "4.2.1"],
  time: {
    "3.0.0": daysAgo(700), "3.1.4": daysAgo(90), "3.1.5": daysAgo(58), "3.1.6": daysAgo(35),
    "3.1.7": daysAgo(25), "3.1.8": daysAgo(12), "4.0.0-beta.1": daysAgo(30), "4.2.1": daysAgo(9)
  },
  deprecated: {}
};
const FAST_URI_RANGES = [">=3.0.0 <3.1.5", ">=3.1.3 <3.1.6", ">=3.0.0 <3.1.6", ">=3.1.2 <3.1.6", ">=3.0.0 <3.1.6"];

test("the target is the first safe version, on the installed line, old enough to trust", () => {
  const target = chooseTarget({ installed: "3.1.4", vulnerable: FAST_URI_RANGES, metadata: FAST_URI, now: NOW });
  assert.deepEqual(
    { version: target.version, source: target.source, age: target.age_days, quarantined: target.quarantined, upgrade: target.upgrade },
    { version: "3.1.6", source: "registry", age: 35, quarantined: true, upgrade: "patch" }
  );
  assert.equal(DEFAULT_MIN_RELEASE_AGE_DAYS, 7);
});

test("a declared range is preferred, then no breaking upgrade, then anything safe", () => {
  const metadata = { ok: true, versions: ["1.0.0", "1.0.1", "2.0.0", "2.0.1"], time: Object.fromEntries(["1.0.0", "1.0.1", "2.0.0", "2.0.1"].map((v) => [v, daysAgo(100)])), deprecated: {} };
  // Every 1.x is vulnerable: the only way out is the next major.
  const major = chooseTarget({ installed: "1.0.0", vulnerable: ["<2.0.0"], metadata, now: NOW });
  assert.equal(major.version, "2.0.0");
  assert.equal(major.upgrade, "major");
  // With 2.0.0 also vulnerable and a manifest that allows ^2, the declared range wins.
  const declared = chooseTarget({ installed: "1.0.0", vulnerable: ["<2.0.1"], metadata, preferRange: "^2.0.0", now: NOW });
  assert.equal(declared.version, "2.0.1");
  assert.equal(declared.in_declared_range, true);
  // An empty declared range is no preference at all — it used to short-circuit
  // the whole choice to "" and plan every package as no-fix.
  const noPreference = chooseTarget({ installed: "1.0.0", vulnerable: ["=1.0.0"], metadata, preferRange: "", now: NOW });
  assert.equal(noPreference.version, "1.0.1");
});

test("prereleases and deprecated versions are never picked", () => {
  const metadata = { ok: true, versions: ["1.0.0", "1.1.0-rc.1", "1.1.0", "1.2.0"], time: { "1.0.0": daysAgo(50), "1.1.0-rc.1": daysAgo(40), "1.1.0": daysAgo(30), "1.2.0": daysAgo(20) }, deprecated: { "1.1.0": "broken build" } };
  assert.equal(chooseTarget({ installed: "1.0.0", vulnerable: ["<1.1.0"], metadata, now: NOW }).version, "1.2.0");
});

test("when every safe version is too young, the youngest is named with the reason", () => {
  const metadata = { ok: true, versions: ["1.0.0", "1.0.1"], time: { "1.0.0": daysAgo(300), "1.0.1": daysAgo(2) }, deprecated: {} };
  const target = chooseTarget({ installed: "1.0.0", vulnerable: ["<1.0.1"], metadata, now: NOW });
  assert.equal(target.version, "1.0.1");
  assert.equal(target.quarantined, false);
  assert.match(target.reason, /younger than 7 days; 1\.0\.1 is 2 day\(s\) old\. Waiting is the other option/);
  // A quarantine of 0 days accepts it without comment.
  assert.equal(chooseTarget({ installed: "1.0.0", vulnerable: ["<1.0.1"], metadata, minReleaseAgeDays: 0, now: NOW }).reason, "");
});

test("no safe version, no registry, or no fix named — each says which", () => {
  const malicious = { ok: true, versions: ["4.2.0", "4.2.1"], time: {}, deprecated: {} };
  const none = chooseTarget({ installed: "4.2.1", vulnerable: [">=0"], metadata: malicious, now: NOW });
  assert.equal(none.version, "");
  assert.match(none.reason, /No published version above the installed one/);

  const fromAdvisories = chooseTarget({ installed: "1.2.5", vulnerable: [">=1.0.0 <1.2.6", "<1.2.8"], fixedIn: ["1.2.6", "1.2.8"], metadata: null });
  assert.deepEqual({ version: fromAdvisories.version, source: fromAdvisories.source }, { version: "1.2.8", source: "advisory" });
  assert.match(fromAdvisories.reason, /its age is unchecked/);

  const partial = chooseTarget({ installed: "1.2.5", vulnerable: ["<1.2.6", "<2.0.0"], fixedIn: ["1.2.6", ""], metadata: null });
  assert.equal(partial.version, "", "a fix for one of two advisories is not a fix");
  const unreachable = chooseTarget({ installed: "1.0.0", vulnerable: ["<2.0.0"], metadata: { ok: false, reason: "https://registry.npmjs.org/p answered 503" } });
  assert.match(unreachable.reason, /answered 503/);
  assert.equal(chooseTarget({ installed: "", vulnerable: [] }).upgrade, "none");
});

test("the registry is the caller's, then npm's configuration, then npm's own", () => {
  assert.equal(registryUrl({}), "https://registry.npmjs.org");
  assert.equal(registryUrl({ npm_config_registry: "https://npm.example.test/" }), "https://npm.example.test");
  assert.equal(registryUrl({ NPM_CONFIG_REGISTRY: "https://other.example.test" }), "https://other.example.test");
});

test("registry metadata is read, and every way of not getting it is a reason, never a throw", async () => {
  const calls = [];
  const document = {
    versions: { "1.0.0": {}, "1.0.1": { deprecated: "use 1.0.2" }, "1.0.2": {} },
    time: { "1.0.0": daysAgo(10), "1.0.1": daysAgo(9), "1.0.2": daysAgo(8) }
  };
  const ok = await fetchPackageMetadata("@scope/pkg", {
    registry: "https://registry.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, accept: options.headers.accept });
      return { ok: true, status: 200, headers: new Map([["content-length", "100"]]), json: async () => document };
    }
  });
  assert.deepEqual(calls, [{ url: "https://registry.example.test/@scope%2fpkg", accept: "application/json" }], "the full document: only it has publish times");
  assert.deepEqual(ok.versions, ["1.0.0", "1.0.1", "1.0.2"]);
  assert.deepEqual(ok.deprecated, { "1.0.1": "use 1.0.2" });

  const missing = await fetchPackageMetadata("p", { registry: "https://r.test", fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.deepEqual(missing, { ok: false, reason: "https://r.test/p answered 404" });
  const huge = await fetchPackageMetadata("p", { registry: "https://r.test", fetchImpl: async () => ({ ok: true, status: 200, headers: new Map([["content-length", String(64 * 1024 * 1024)]]), json: async () => ({}) }) });
  assert.match(huge.reason, /64 MB, over the 40 MB cap/);
  const down = await fetchPackageMetadata("p", { registry: "https://r.test", fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND r.test"); } });
  assert.match(down.reason, /could not be read: getaddrinfo ENOTFOUND/);
  const slow = await fetchPackageMetadata("p", {
    registry: "https://r.test",
    timeoutMs: 20,
    // A real request holds the event loop open with its socket; this one holds
    // it with a timer, or the test ends before the abort can fire.
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      const open = setTimeout(resolve, 5000);
      signal.addEventListener("abort", () => {
        clearTimeout(open);
        reject(signal.reason);
      });
    })
  });
  assert.match(slow.reason, /no answer in 0\.02s/);
});
