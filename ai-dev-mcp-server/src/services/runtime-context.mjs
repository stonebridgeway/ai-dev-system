import path from "node:path";

export function createRuntimeContext({ vaultRoot, userHome, serverDir }) {
  return Object.freeze({
    vaultRoot,
    userHome,
    serverDir,
    paths: Object.freeze({
      skillCatalog: path.join(vaultRoot, "03-skills-catalog"),
      projects: path.join(vaultRoot, "02-knowledge", "Projects"),
      runtimeState: path.join(userHome, "state"),
      searchIndex: path.join(userHome, "cache", "search-index")
    }),
    stores: Object.freeze({}),
    caches: Object.freeze({})
  });
}
