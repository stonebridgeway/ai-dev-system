export function createSearchService({ callLegacy }) {
  return Object.freeze({
    search: (args) => callLegacy("search", args),
    index: (args) => callLegacy("search_index", args)
  });
}
