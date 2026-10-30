// Preloaded into the daemon a test starts (`NODE_OPTIONS=--import <this file>`
// in the client's environment, which its daemon inherits): the first time a
// retired daemon makes its run folder and finds it already there, the runtime
// home goes before the daemon takes its record's lock — the lock makes the
// folders again.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const original = fsp.mkdir.bind(fsp);
let done = false;
fsp.mkdir = async (target, ...rest) => {
  const caller = new Error().stack ?? "";
  const made = await original(target, ...rest);
  if (!done && made === undefined && /[\\/]run$/.test(String(target)) && caller.includes("holdRetiredRecord")) {
    done = true;
    fs.rmSync(path.dirname(String(target)), { recursive: true, force: true });
  }
  return made;
};
