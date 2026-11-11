// Preloaded into a daemon a test starts (`NODE_OPTIONS=--import <this file>`):
// removing a retired daemon's record lock takes six seconds — longer than the
// daemon's watch takes to look — which holds open the moment between a leaving
// daemon removing its record and its exit.
import fsp from "node:fs/promises";

const original = fsp.rm.bind(fsp);
fsp.rm = async (target, options) => {
  if (/retired-\d+\.json\.lock$/.test(String(target))) await new Promise((resolve) => setTimeout(resolve, 6_000));
  return original(target, options);
};
