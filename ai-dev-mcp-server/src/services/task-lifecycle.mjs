export function createTaskLifecycleService({ callLegacy }) {
  return Object.freeze({
    begin: (args) => callLegacy("begin_task", args),
    checkpoint: (args) => callLegacy("checkpoint_task", args),
    verify: (args) => callLegacy("verify_task", args),
    complete: (args) => callLegacy("complete_task", args)
  });
}
