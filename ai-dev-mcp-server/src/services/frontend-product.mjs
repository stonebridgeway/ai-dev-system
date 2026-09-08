export function createFrontendProductService({ callLegacy }) {
  return Object.freeze({
    execute: (args) => callLegacy("frontend_product", args),
    qa: (args) => callLegacy("run_frontend_qa", args)
  });
}
