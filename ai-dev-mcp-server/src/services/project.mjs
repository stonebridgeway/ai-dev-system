export function createProjectService({ callLegacy }) {
  return Object.freeze({
    execute: (args) => callLegacy("project", args),
    prepare: (args) => callLegacy("prepare_project", args)
  });
}
