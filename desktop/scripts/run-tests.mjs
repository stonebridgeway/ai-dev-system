// The desktop app's tests: the unit tests, then the end-to-end ones, which
// launch Electron. A Linux machine without a display runs them under
// xvfb-run, as CI does.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, windowsHide: true }).status ?? 1;

const unit = run(process.execPath, ["--test", "test/unit/*.test.mjs"]);
if (unit !== 0) process.exit(unit);

// The binary first, so a download is not counted against a test's time.
createRequire(import.meta.url)("electron");
const e2e = [process.execPath, "--test", "--test-concurrency=1", "test/e2e/*.test.mjs"];
const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (headless) {
  const probe = spawnSync("xvfb-run", ["--help"], { stdio: "ignore", shell: false });
  if (probe.error) {
    console.error("No display and no xvfb-run: install xvfb (apt install xvfb) to run the end-to-end tests here.");
    process.exit(1);
  }
  process.exit(run("xvfb-run", ["-a", "-s", "-screen 0 1280x900x24", ...e2e]));
}
process.exit(run(e2e[0], e2e.slice(1)));
