// Preloaded into `ai-dev daemon stop` a test runs (`NODE_OPTIONS=--import <this
// file>`): right after the command reads a daemon's descriptor, the runtime home
// goes — deleted, as a person may delete it, or emptied by a daemon leaving —
// before `stop` takes the descriptor's lock.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const original = fsp.readFile.bind(fsp);
fsp.readFile = async (target, ...rest) => {
  const result = await original(target, ...rest);
  if (/[\\/]run[\\/]daemon-[0-9a-f]{16}\.json$/.test(String(target))) fs.rmSync(path.dirname(path.dirname(String(target))), { recursive: true, force: true });
  return result;
};
