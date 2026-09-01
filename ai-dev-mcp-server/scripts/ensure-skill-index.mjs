import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { callTool, vaultRoot } from "../src/mcp-stdio.mjs";

// Make sure <vault>/03-skills-catalog carries a generated skill registry so the
// vault-coupled test suite and the protocol / lifecycle smokes can route skills.
//
// In a full vault the registry is committed and this is a no-op. In a standalone
// checkout the vault root resolves to the bundled docker/public-seed, which ships
// only skill sources; this builds the small registry for that tree on demand.
// The generated files are git-ignored under docker/public-seed.
const registryPath = path.join(vaultRoot, "03-skills-catalog", "registries", "skills.index.json");

if (existsSync(registryPath)) {
  process.stdout.write(`skill registry present: ${registryPath}\n`);
} else {
  process.stdout.write(`building skill registry for ${vaultRoot}\n`);
  const result = await callTool("rebuild_index", {});
  const text = result.content?.find((item) => item.type === "text")?.text ?? "{}";
  process.stdout.write(`${text}\n`);
  if (result.isError) {
    process.exitCode = 1;
  }
}
