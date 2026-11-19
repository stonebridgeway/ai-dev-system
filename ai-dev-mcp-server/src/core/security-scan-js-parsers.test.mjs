import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RECOGNIZED_REPORTS, osvRangeFor, parseBunAudit, parseOsvScanner, parsePnpmAudit, parseYarnAudit } from "./security-scan-js-parsers.mjs";
import { SECURITY_FINDING_KINDS, SECURITY_SEVERITIES, isMalwareAdvisory } from "./security-scan-parsers.mjs";

// Every fixture is what the tool printed on 2026-09-27 for the same project —
// minimist 1.2.5, lodash 4.17.20 and ajv 8.17.1, and in the npm copy the
// malicious axios 1.14.1 — trimmed to the fields the parsers read.
const FIXTURES = fileURLToPath(new URL("../../test/fixtures/security-scan/", import.meta.url));
const fixture = (name) => fs.readFile(path.join(FIXTURES, name), "utf8");

const DETAIL_KEYS = ["aliases", "file", "fixed_in", "kind", "line", "message", "package", "rule", "severity", "tool", "version", "vulnerable"];

function assertShape(findings) {
  for (const item of findings) {
    assert.deepEqual(Object.keys(item).sort(), DETAIL_KEYS, `${item.tool}: a package finding carries the details a fix plan reads`);
    assert.ok(SECURITY_SEVERITIES.includes(item.severity), `${item.tool}: ${item.severity}`);
    assert.ok(SECURITY_FINDING_KINDS.includes(item.kind), `${item.tool}: ${item.kind}`);
    assert.ok(item.package, `${item.tool}: names the package`);
    assert.equal(item.message.includes("\n"), false);
    assert.equal(item.aliases.includes(item.rule), false, "the rule is not repeated among its aliases");
  }
}

test("pnpm audit: one finding per advisory and installed version, with the fix it names", async () => {
  const findings = parsePnpmAudit(await fixture("pnpm-audit.json"));
  assertShape(findings);
  assert.equal(findings.length, 7);
  const minimist = findings.find((item) => item.package === "minimist");
  assert.deepEqual(
    { rule: minimist.rule, severity: minimist.severity, version: minimist.version, vulnerable: minimist.vulnerable, fixed_in: minimist.fixed_in, file: minimist.file, aliases: minimist.aliases },
    { rule: "GHSA-xvch-5gv4-984h", severity: "critical", version: "1.2.5", vulnerable: ">=1.0.0 <1.2.6", fixed_in: "1.2.6", file: "pnpm-lock.yaml", aliases: ["CVE-2021-44906"] }
  );
  assert.match(minimist.message, /^minimist 1\.2\.5 \(>=1\.0\.0 <1\.2\.6\): Prototype Pollution in minimist \(fixed in 1\.2\.6\)$/);
  assert.equal(findings.every((item) => item.tool === "pnpm audit" && item.kind === "dependency"), true);
});

test("yarn audit reads Yarn 1's advisory lines and Yarn 2+'s tree lines alike", async () => {
  const classic = parseYarnAudit(await fixture("yarn-classic-audit.ndjson"));
  const berry = parseYarnAudit(await fixture("yarn-berry-audit.ndjson"));
  assertShape(classic);
  assertShape(berry);
  // The same project, so the same seven advisories, whichever Yarn printed them.
  const rules = (list) => list.map((item) => `${item.package}@${item.version} ${item.rule}`).sort();
  assert.deepEqual(rules(berry), rules(classic));
  assert.equal(classic.length, 7);
  // Yarn 2+ does not say what fixes an advisory; Yarn 1 does.
  assert.equal(classic.find((item) => item.package === "minimist").fixed_in, "1.2.6");
  assert.equal(berry.find((item) => item.package === "minimist").fixed_in, "");
  assert.equal(berry.every((item) => item.file === "yarn.lock"), true);
  // The summary line at the end of Yarn 1's output is not a finding.
  assert.equal(parseYarnAudit('{"type":"auditSummary","data":{"vulnerabilities":{"high":1}}}').length, 0);
});

test("bun audit: the registry's bulk response, which names no installed version", async () => {
  const findings = parseBunAudit(await fixture("bun-audit.json"));
  assertShape(findings);
  assert.equal(findings.length, 7);
  assert.equal(findings.every((item) => item.version === "" && item.file === "bun.lock"), true);
  assert.deepEqual(
    findings.filter((item) => item.package === "lodash").map((item) => item.severity).sort(),
    ["high", "high", "medium", "medium", "medium"]
  );
  // An advisory with no severity word is graded by its CVSS score.
  const scored = parseBunAudit(JSON.stringify({ p: [{ id: 1, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", title: "t", vulnerable_versions: "<1.0.0", cvss: { score: 9.1 } }] }));
  assert.equal(scored[0].severity, "critical");
});

test("osv-scanner: one finding per alias group, malware first-class, fixes read from the ranges", async () => {
  const findings = parseOsvScanner(await fixture("osv-scanner.json"), { projectRoot: "/work/app" });
  assertShape(findings);
  assert.equal(findings.every((item) => item.file === "package-lock.json"), true, "paths are made relative to the project");

  const malware = findings.filter((item) => item.kind === "malware");
  assert.equal(malware.length, 1);
  assert.deepEqual(
    { rule: malware[0].rule, package: malware[0].package, version: malware[0].version, severity: malware[0].severity, fixed_in: malware[0].fixed_in },
    { rule: "MAL-2026-2307", package: "axios", version: "1.14.1", severity: "critical", fixed_in: "" }
  );
  assert.ok(malware[0].aliases.includes("GHSA-fw8c-xr5c-95f9"), "GitHub's copy of the report is an alias, so a second scanner's finding merges");
  assert.match(malware[0].message, /rotate every credential/);
  assert.equal(malware[0].vulnerable, "=0.30.4 || =1.14.1");

  // lodash's two code-injection advisories are one OSV group, and the version
  // that fixes both is the later of the two fixes.
  const injection = findings.find((item) => item.rule === "GHSA-35jh-r3h4-6jhm");
  assert.ok(injection.aliases.includes("GHSA-r5fr-rjxr-66jc"));
  assert.equal(injection.fixed_in, "4.18.0");
  assert.equal(injection.severity, "high", "graded by the group's CVSS score, 8.1");
  const minimist = findings.find((item) => item.package === "minimist");
  assert.equal(minimist.severity, "critical");
  assert.equal(minimist.fixed_in, "1.2.6");
});

test("an OSV range says which interval the installed version is in, and what fixes that one", () => {
  const affected = [{
    package: { name: "fast-uri", ecosystem: "npm" },
    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.4.4" }, { introduced: "3.0.0" }, { fixed: "3.1.5" }, { introduced: "4.0.0" }, { fixed: "4.1.2" }] }]
  }];
  const three = osvRangeFor(affected, { name: "fast-uri", ecosystem: "npm", version: "3.1.4" });
  assert.equal(three.fixedIn, "3.1.5", "not 2.4.4, which is a different line");
  assert.equal(three.vulnerable, ">=0.0.0-0 <2.4.4 || >=3.0.0 <3.1.5 || >=4.0.0 <4.1.2");
  assert.equal(osvRangeFor(affected, { name: "fast-uri", ecosystem: "npm", version: "4.0.9" }).fixedIn, "4.1.2");
  assert.equal(osvRangeFor(affected, { name: "other", ecosystem: "npm", version: "3.1.4" }).vulnerable, "");

  const open = osvRangeFor([{ package: { name: "p", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }] }] }], { name: "p", ecosystem: "npm", version: "1.5.0" });
  assert.deepEqual(open, { vulnerable: ">=1.0.0", fixedIn: "", fixKnown: false }, "introduced and never fixed");
  const lastAffected = osvRangeFor([{ package: { name: "p", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { last_affected: "2.0.0" }] }] }], { name: "p", ecosystem: "npm", version: "1.0.0" });
  assert.equal(lastAffected.vulnerable, ">=0.0.0-0 <=2.0.0");
  assert.equal(lastAffected.fixKnown, false, "last_affected says where it stops, not what fixes it");
});

test("malware is recognized by GitHub's title or by an OSV MAL- id, and nothing else", () => {
  assert.equal(isMalwareAdvisory({ title: "Malware in axios" }), true);
  assert.equal(isMalwareAdvisory({ ids: ["GHSA-x", "MAL-2026-2307"] }), true);
  assert.equal(isMalwareAdvisory({ title: "Prototype pollution in malware-scanner" }), false);
  assert.equal(isMalwareAdvisory({ title: "Command Injection in lodash", ids: ["GHSA-35jh-r3h4-6jhm"] }), false);
  assert.equal(isMalwareAdvisory(), false);
});

test("output these parsers cannot read is no findings, never a throw", () => {
  for (const parse of [parsePnpmAudit, parseYarnAudit, parseBunAudit, parseOsvScanner]) {
    for (const input of ["", undefined, "not json", "{", "[]", JSON.stringify({ unexpected: true }), "null"]) {
      assert.deepEqual(parse(input), [], `${parse.name}(${JSON.stringify(input)})`);
    }
  }
  assert.deepEqual(parseOsvScanner(JSON.stringify({ results: [{ source: { path: "x" }, packages: [{ package: { name: "p" }, groups: [{ ids: ["GHSA-missing"] }] }] }] })), []);
  assert.deepEqual(parseBunAudit(JSON.stringify({ p: "not a list", q: [null, { no: "title" }] })), []);
});

test("a report is recognized by its shape, so a failure in prose is not read as clean", async () => {
  assert.equal(RECOGNIZED_REPORTS.pnpm_audit(await fixture("pnpm-audit.json")), true);
  assert.equal(RECOGNIZED_REPORTS.pnpm_audit(JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } })), false);
  assert.equal(RECOGNIZED_REPORTS.yarn_audit(await fixture("yarn-classic-audit.ndjson")), true);
  assert.equal(RECOGNIZED_REPORTS.yarn_audit(await fixture("yarn-berry-audit.ndjson")), true);
  assert.equal(RECOGNIZED_REPORTS.yarn_audit("error Command \"npm\" not found."), false);
  assert.equal(RECOGNIZED_REPORTS.bun_audit(await fixture("bun-audit.json")), true);
  assert.equal(RECOGNIZED_REPORTS.bun_audit("{}"), true, "no advisories is still bun's report");
  assert.equal(RECOGNIZED_REPORTS.bun_audit("error: lockfile not found"), false);
  assert.equal(RECOGNIZED_REPORTS.bun_audit(JSON.stringify({ message: "boom" })), false);
  assert.equal(RECOGNIZED_REPORTS.osv_scanner(await fixture("osv-scanner.json")), true);
  assert.equal(RECOGNIZED_REPORTS.osv_scanner("Error during extraction"), false);
});

test("an osv-scanner package without alias groups gives one finding per vulnerability", () => {
  const report = JSON.stringify({
    results: [{
      source: { path: "/work/app/pnpm-lock.yaml" },
      packages: [{
        package: { name: "minimist", version: "1.2.5", ecosystem: "npm" },
        vulnerabilities: [{
          id: "GHSA-xvch-5gv4-984h",
          details: "Prototype pollution.\nMore text.",
          affected: [{ package: { name: "minimist", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.6" }] }] }],
          database_specific: { severity: "CRITICAL" }
        }]
      }]
    }]
  });
  const [item] = parseOsvScanner(report, { projectRoot: "/work/app" });
  assert.equal(item.rule, "GHSA-xvch-5gv4-984h");
  assert.equal(item.severity, "critical", "no group score, so the advisory's own grade");
  assert.equal(item.fixed_in, "1.2.6");
  assert.equal(item.file, "pnpm-lock.yaml");
  assert.match(item.message, /: Prototype pollution\. \(fixed in 1\.2\.6\)$/, "the first line of the details when there is no summary");
  // A path outside the project stays as the scanner printed it.
  assert.equal(parseOsvScanner(report, { projectRoot: "/elsewhere" })[0].file, "/work/app/pnpm-lock.yaml");
});
