import assert from "node:assert/strict";
import test from "node:test";
import {
  LAUNCH_MISSING_FILE,
  LAUNCH_MISSING_PACKAGE,
  LAUNCH_UNKNOWN,
  classifyFrontendQaLaunchFailure
} from "./frontend-qa-launch.mjs";

// Both fixtures are the real output, copied from a run of the runner: the first
// from a clone that never ran `npm run setup -- --frontend-qa`, the second from
// the image's layout (`app/` + `frontend-qa/`, no `ai-dev-mcp-server/`) with
// the runner's own dependencies installed.
const MISSING_PACKAGE_OUTPUT = [
  "node:internal/modules/package_json_reader:314",
  "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
  "        ^",
  "",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@axe-core/playwright' imported from "
    + "/repo/frontend-qa/frontend_qa_runner.mjs",
  "    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)",
  "  code: 'ERR_MODULE_NOT_FOUND'",
  "}"
].join("\n");

const MISSING_FILE_OUTPUT = [
  "node:internal/modules/esm/resolve:275",
  "    throw new ERR_MODULE_NOT_FOUND(",
  "          ^",
  "",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module "
    + "'/opt/ai-dev/ai-dev-mcp-server/src/core/command-policy.mjs' imported from "
    + "/opt/ai-dev/frontend-qa/frontend_qa_runner.mjs",
  "    at finalizeResolution (node:internal/modules/esm/resolve:275:11)",
  "  code: 'ERR_MODULE_NOT_FOUND',",
  "}"
].join("\n");

test("a dependency nobody installed is told apart from a file that should be there", () => {
  // Both used to be reduced to the first line of stderr, which for either is
  // the frame Node threw from — `node:internal/modules/esm/resolve:275` — and
  // never the reason.
  const notInstalled = classifyFrontendQaLaunchFailure(MISSING_PACKAGE_OUTPUT);
  assert.equal(notInstalled.kind, LAUNCH_MISSING_PACKAGE);
  assert.equal(notInstalled.specifier, "@axe-core/playwright");
  assert.match(notInstalled.summary, /The runner's dependency "@axe-core\/playwright" is not installed\./);

  const broken = classifyFrontendQaLaunchFailure(MISSING_FILE_OUTPUT);
  assert.equal(broken.kind, LAUNCH_MISSING_FILE);
  assert.equal(broken.specifier, "/opt/ai-dev/ai-dev-mcp-server/src/core/command-policy.mjs");
  assert.match(broken.summary, /^The runner imports \/opt\/.*which this install does not carry\.$/);
  assert.doesNotMatch(broken.summary, /internal\/modules/);
});

test("a failure with no module-resolution line keeps the first line it has", () => {
  const timedOut = classifyFrontendQaLaunchFailure("\n\nCommand timed out after 60000ms: node runner.mjs\nmore\n");
  assert.equal(timedOut.kind, LAUNCH_UNKNOWN);
  assert.equal(timedOut.specifier, "");
  assert.equal(timedOut.summary, "Command timed out after 60000ms: node runner.mjs");
});

test("nothing at all is classified without throwing", () => {
  for (const value of ["", null, undefined]) {
    const empty = classifyFrontendQaLaunchFailure(value);
    assert.equal(empty.kind, LAUNCH_UNKNOWN);
    assert.equal(empty.summary, "");
  }
});
