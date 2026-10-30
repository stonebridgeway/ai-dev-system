// Isolates every `node --test` process (and the workers node:test spawns per
// file) from the developer's real ~/.ai-dev tree and from the checked-in seed.
//
// Wired in through `node --import ./test/setup.mjs --test …` (see package.json
// and the `check` script). `--import` runs before any test module graph loads,
// so mcp-stdio.mjs resolves its runtime roots — which it does once, at import
// time — against this throwaway directory rather than the developer's own.
//
// Only the explicit `AI_DEV_*` roots are pinned: `aiDevRuntimePath()` honours
// them ahead of the `~/.ai-dev` default, and they cover every path the runtime
// actually writes (task/skill/pilot state, the search index, Frontend QA and
// Archify artifacts, downloaded models). `HOME`/`os.homedir()` is left alone so
// project-boundary detection behaves exactly as it does in production.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-test-home-"));

// The runtime tree itself: AI_DEV_HOME names it, so the
// daemon's socket and lock, config.json and the runtime_home health check all
// stay out of the developer's real ~/.ai-dev too.
process.env.AI_DEV_HOME = stateHome;
process.env.AI_DEV_STATE_ROOT = path.join(stateHome, "state");
process.env.AI_DEV_SEARCH_INDEX_DIR = path.join(stateHome, "cache", "search-index");
process.env.AI_DEV_FRONTEND_QA_ARTIFACT_ROOT = path.join(stateHome, "artifacts", "frontend-qa");
process.env.AI_DEV_ARCHIFY_ARTIFACT_ROOT = path.join(stateHome, "artifacts", "archify");
// Every place the Codex-era migration takes from ~/.codex is pinned, so a test
// run never moves a developer's own ~/.codex/state/archify-receipts into this
// throwaway tree.
process.env.AI_DEV_ARCHIFY_RECEIPTS_ROOT = path.join(stateHome, "state", "archify-receipts");
process.env.BGE_M3_ONNX_DIR = path.join(stateHome, "models", "bge-m3-onnx");

// Python helpers must never drop __pycache__/*.pyc into the repo or the seed.
process.env.PYTHONDONTWRITEBYTECODE = "1";

// `ai-dev mcp` started by a test serves in its own process, as 2.x did: a
// daemon it started would outlive the test. `src/cli/daemon.test.mjs` starts
// its daemons on purpose, with an environment of its own, and stops them.
process.env.AI_DEV_DAEMON = "0";

// The suite checks the host: AI_DEV_RUNTIME=docker in a developer's shell would
// make the install layout and every hint the image's. The tests about the
// image give it themselves, as a value or in a child's environment.
delete process.env.AI_DEV_RUNTIME;

// `--experimental-test-coverage` sets NODE_V8_COVERAGE, and every process the
// suite spawns — git, python, the installed hooks, the MCP smokes — inherits it
// and creates its own coverage file in the same directory. A child that dies
// before V8 writes anything leaves that file at zero bytes, the reporter parses
// every file in the directory, and the run ends with `# fail 0` and
// "Could not report code coverage. SyntaxError: Unexpected end of JSON input".
// Measured: on the failing run the directory
// held 377 files against 376 on every passing one, and the extra file was empty.
//
// This process already captured its own coverage path at startup, so dropping
// the variable here costs nothing and stops it reaching anything spawned from
// here — including the workers' own children, since node:test runs this import
// inside every worker.
delete process.env.NODE_V8_COVERAGE;

process.on("exit", () => {
  try {
    fs.rmSync(stateHome, { recursive: true, force: true });
  } catch {
    /* best effort: the OS reclaims the temp directory anyway */
  }
});
