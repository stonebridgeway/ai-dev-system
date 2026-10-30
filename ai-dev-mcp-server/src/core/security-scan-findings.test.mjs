import assert from "node:assert/strict";
import test from "node:test";
import { mergeDuplicateFindings } from "./security-scan-findings.mjs";

function packageFinding(overrides) {
  return {
    tool: "pnpm audit",
    kind: "dependency",
    severity: "high",
    file: "pnpm-lock.yaml",
    line: 0,
    message: "m",
    rule: "GHSA-35jh-r3h4-6jhm",
    package: "lodash",
    version: "4.17.20",
    vulnerable: "<4.17.21",
    fixed_in: "",
    aliases: [],
    ...overrides
  };
}

test("one advisory from two scanners is one finding, confirmed by the second", () => {
  const merged = mergeDuplicateFindings([
    packageFinding({}),
    packageFinding({ tool: "osv-scanner", rule: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337", "GHSA-r5fr-rjxr-66jc"], fixed_in: "4.18.0", severity: "critical" })
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tool, "pnpm audit", "the package manager's own finding is kept");
  assert.deepEqual(merged[0].confirmed_by, ["osv-scanner"]);
  assert.equal(merged[0].severity, "critical", "the worse severity is taken over");
  assert.equal(merged[0].fixed_in, "4.18.0", "and the detail the first one lacked");
  assert.deepEqual(merged[0].aliases, ["CVE-2021-23337", "GHSA-r5fr-rjxr-66jc"]);
});

test("a match through an alias merges, and malware stays malware", () => {
  const merged = mergeDuplicateFindings([
    packageFinding({ tool: "npm audit", file: "package-lock.json", package: "axios", version: "", rule: "GHSA-fw8c-xr5c-95f9", kind: "malware", severity: "critical" }),
    packageFinding({ tool: "osv-scanner", file: "package-lock.json", package: "axios", version: "1.14.1", rule: "MAL-2026-2307", aliases: ["GHSA-fw8c-xr5c-95f9"], kind: "malware", severity: "critical" })
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].version, "1.14.1", "a report that named no version takes the one the other named");
  assert.equal(merged[0].kind, "malware");
  assert.ok(merged[0].aliases.includes("MAL-2026-2307"));
});

test("different advisories, lockfiles or installed versions stay apart", () => {
  const merged = mergeDuplicateFindings([
    packageFinding({}),
    packageFinding({ rule: "GHSA-29mw-wpgm-hmr9" }),
    packageFinding({ file: "frontend/pnpm-lock.yaml" }),
    packageFinding({ version: "4.17.15" }),
    packageFinding({ tool: "osv-scanner", version: "4.17.15" })
  ]);
  assert.equal(merged.length, 4, "the last one merges into the 4.17.15 finding, not the 4.17.20 one");
  assert.deepEqual(merged[3].confirmed_by, ["osv-scanner"]);
  assert.equal(merged[0].confirmed_by, undefined);
});

test("findings about no package are never merged", () => {
  const secret = { tool: "gitleaks", kind: "secret", severity: "critical", file: "a.env", line: 1, message: "m", rule: "aws" };
  const merged = mergeDuplicateFindings([secret, { ...secret, tool: "trivy fs" }]);
  assert.equal(merged.length, 2);
  assert.deepEqual(mergeDuplicateFindings([]), []);
});
