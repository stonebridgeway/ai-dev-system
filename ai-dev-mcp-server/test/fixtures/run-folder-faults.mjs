// Preloaded into a daemon a test starts (`NODE_OPTIONS=--import <this file>`):
// what a file system may do to the daemon's look at its run folder.
// `AI_DEV_TEST_RUN_FOLDER` says which:
// `chmod-ignored` — a chmod through a handle is taken and changes nothing, as
// on drvfs or a FUSE mount; `stat-fails` — the first look through a handle on
// a folder named `run` fails with EIO, as on a flaky network mount.
import fsp from "node:fs/promises";

const fault = process.argv.slice(2).join(" ") === "daemon run" ? process.env.AI_DEV_TEST_RUN_FOLDER : undefined;
if (fault) {
  const probe = await fsp.open(process.execPath, "r");
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  if (fault === "chmod-ignored") handles.chmod = async () => undefined;
  if (fault === "stat-fails") {
    const onRun = new WeakSet();
    const open = fsp.open;
    fsp.open = async (target, ...rest) => {
      const handle = await open.call(fsp, target, ...rest);
      if (/[\\/]run$/.test(String(target))) onRun.add(handle);
      return handle;
    };
    const stat = handles.stat;
    let failed = false;
    handles.stat = async function (...args) {
      if (!failed && onRun.has(this)) {
        failed = true;
        throw Object.assign(new Error("EIO: i/o error, fstat"), { code: "EIO" });
      }
      return stat.apply(this, args);
    };
  }
}
