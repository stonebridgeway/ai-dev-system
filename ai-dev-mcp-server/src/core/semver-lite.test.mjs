import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  isPrerelease,
  isValidRange,
  parseVersion,
  satisfies,
  sortVersions,
  upgradeKind
} from "./semver-lite.mjs";

test("versions parse, with prerelease identifiers numeric where they are digits", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("v2.0.0-rc.1+build.5"), { major: 2, minor: 0, patch: 0, prerelease: ["rc", 1] });
  assert.equal(parseVersion("1.2"), null, "a partial version is a range, not a version");
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(undefined), null);
});

test("precedence follows semver, prereleases below their release", () => {
  const ordered = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1, `${ordered[index - 1]} < ${ordered[index]}`);
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(compareVersions("1.2.3", "v1.2.3"), 0);
  assert.equal(compareVersions("garbage", "1.0.0"), -1, "unreadable sorts first, where nobody picks it");
  assert.deepEqual(sortVersions(["1.10.0", "nope", "1.2.0", "1.2.0", "1.9.0-rc.1"]), ["1.2.0", "1.9.0-rc.1", "1.10.0"]);
  assert.equal(isPrerelease("3.0.0-beta.1"), true);
  assert.equal(isPrerelease("3.0.0"), false);
});

test("advisory ranges as npm and GitHub write them", () => {
  // fast-uri, sharp and lodash, as the npm bulk advisory endpoint returned them on 2026-09-27.
  assert.equal(satisfies("3.1.4", ">=3.0.0 <3.1.6"), true);
  assert.equal(satisfies("3.1.6", ">=3.0.0 <3.1.6"), false);
  assert.equal(satisfies("0.34.5", "<0.35.4"), true);
  assert.equal(satisfies("0.35.4", "<0.35.4"), false);
  assert.equal(satisfies("4.17.23", ">=4.0.0 <=4.17.23"), true);
  assert.equal(satisfies("4.17.24", ">=4.0.0 <=4.17.23"), false);
  assert.equal(satisfies("1.14.1", "=1.14.1"), true, "a malware advisory names one version");
  assert.equal(satisfies("1.14.0", "=1.14.1"), false);
  assert.equal(satisfies("0.0.1", ">=0"), true);
  // An advisory that starts at a prerelease admits that line's prereleases.
  assert.equal(satisfies("7.0.0-alpha.3", ">=7.0.0-alpha.0 <8.18.0"), true);
  assert.equal(satisfies("8.17.1", ">=7.0.0-alpha.0 <8.18.0"), true);
  assert.equal(satisfies("8.18.0-beta.1", ">=7.0.0-alpha.0 <8.18.0"), false, "a prerelease of another tuple is not admitted");
  assert.equal(satisfies("2.4.3", ">=0 <2.4.4 || >=3.0.0 <3.1.5 || >=4.0.0 <4.1.2"), true);
  assert.equal(satisfies("3.1.8", ">=0 <2.4.4 || >=3.0.0 <3.1.5 || >=4.0.0 <4.1.2"), false);
});

test("the ranges parents declare: caret, tilde, x-ranges, hyphens", () => {
  assert.equal(satisfies("3.1.8", "^3.0.1"), true);
  assert.equal(satisfies("4.0.0", "^3.0.1"), false);
  assert.equal(satisfies("0.34.9", "^0.34.1"), true);
  assert.equal(satisfies("0.35.4", "^0.34.1"), false, "below 1.0.0 the caret stops at the minor");
  assert.equal(satisfies("0.0.4", "^0.0.3"), false, "below 0.1.0 it stops at the patch");
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
  assert.equal(satisfies("1.9.0", "~1"), true);
  assert.equal(satisfies("1.2.7", "1.2.x"), true);
  assert.equal(satisfies("1.3.0", "1.2.x"), false);
  assert.equal(satisfies("1.3.0-alpha", "1.2.x"), false);
  assert.equal(satisfies("5.0.0", "*"), true);
  assert.equal(satisfies("5.0.0", ""), true);
  assert.equal(satisfies("1.5.0", "1.2.3 - 1.6"), true);
  assert.equal(satisfies("1.7.0", "1.2.3 - 1.6"), false);
  assert.equal(satisfies("2.3.4", "1.2.3 - 2.3.4"), true);
  assert.equal(satisfies("1.2.0", "<1.2"), false);
  assert.equal(satisfies("1.1.9", "<1.2"), true);
  assert.equal(satisfies("1.3.0", ">1.2"), true);
  assert.equal(satisfies("1.2.5", ">1.2"), false);
  assert.equal(satisfies("1.2.5", ">= 1.2.0 < 2"), true, "operators may be followed by a space");
});

test("an unreadable range matches nothing and says so", () => {
  assert.equal(satisfies("1.0.0", "npm:other@^1"), false);
  assert.equal(satisfies("1.0.0", "github:user/repo"), false);
  assert.equal(isValidRange("github:user/repo"), false);
  assert.equal(isValidRange(">=1.0.0 <2 || 3.x"), true);
  assert.equal(isValidRange(""), true);
  assert.equal(satisfies("not-a-version", "*"), false);
});

test("upgrade kind reads a 0.x minor as breaking, the way the caret does", () => {
  assert.equal(upgradeKind("3.1.4", "3.1.8"), "patch");
  assert.equal(upgradeKind("4.12.32", "4.13.8"), "minor");
  assert.equal(upgradeKind("0.34.5", "0.35.4"), "major");
  assert.equal(upgradeKind("0.0.3", "0.0.4"), "major");
  assert.equal(upgradeKind("3.7.5", "4.3.0"), "major");
  assert.equal(upgradeKind("1.0.0-rc.1", "1.0.0"), "prerelease");
  assert.equal(upgradeKind("1.0.0", "1.0.0"), "none");
  assert.equal(upgradeKind("?", "1.0.0"), "unknown");
});
