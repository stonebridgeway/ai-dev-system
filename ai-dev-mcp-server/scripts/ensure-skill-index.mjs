import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { callTool, vaultRoot } from "../src/mcp-stdio.mjs";
import { checkSkillRegistry } from "../src/core/skill-registry-freshness.mjs";

// Make sure <vault>/03-skills-catalog carries a current generated skill registry
// so the vault-coupled test suite and the protocol / lifecycle smokes can route
// skills.
//
// In a full vault the registry is committed and this is a no-op. In a standalone
// checkout the vault root resolves to the bundled docker/public-seed, which ships
// only skill sources; this builds the small registry for that tree on demand.
// The generated files are git-ignored under docker/public-seed.
//
// A registry that is there but out of date — a pull changed the skills — is
// rebuilt here too, once, before the test processes start: each of them would
// otherwise rebuild the same files at the same time.
const catalogRoot = path.join(vaultRoot, "03-skills-catalog");
const registryPath = path.join(catalogRoot, "registries", "skills.index.json");
const verdict = existsSync(registryPath) ? await checkSkillRegistry({ registryPath, catalogRoot }) : null;

if (verdict && !verdict.stale) {
  process.stdout.write(`skill registry present: ${registryPath}\n`);
} else {
  process.stdout.write(verdict
    ? `rebuilding the out-of-date skill registry for ${vaultRoot} (${verdict.examples.join("; ")})\n`
    : `building skill registry for ${vaultRoot}\n`);
  const result = await callTool("rebuild_index", {});
  const text = result.content?.find((item) => item.type === "text")?.text ?? "{}";
  process.stdout.write(`${text}\n`);
  if (result.isError) {
    process.exitCode = 1;
  }
}
