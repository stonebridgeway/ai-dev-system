export function createSystemOpsService({ callLegacy }) {
  return Object.freeze({
    execute: (args) => callLegacy("system", args)
  });
}
