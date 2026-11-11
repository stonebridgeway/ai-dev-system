#!/usr/bin/env node
/**
 * The 2.x local client installer. It wrote the server as `ai-dev-system`,
 * while the Docker installer wrote `ai-dev`, so a machine that ran both listed
 * the server twice. Both write through one module now
 * (`src/core/mcp-clients.mjs`), and this command is `ai-dev clients install`:
 * kept until 4.0 with a note on stderr and the same flags — a dry run unless
 * `--apply`, the four clients 2.x wrote unless `--clients` names others, and
 * `claude` meaning Claude Code alone, as it did. The
 * JSON on stdout is `clients install --json`'s.
 */
import { main } from "../src/cli/main.mjs";

/** The clients 2.x wrote, whether they were installed or not. */
const LEGACY_CLIENTS = "cursor,gemini,vscode,claude-code";

/** A 2.x client list in today's names. */
function legacyNames(value) {
  return String(value).split(",").map((name) => (name.trim().toLowerCase() === "claude" ? "claude-code" : name)).join(",");
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const rest = [];
let named = false;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--apply") continue;
  if (argument === "--clients" && index + 1 < argv.length) {
    rest.push(argument, legacyNames(argv[index + 1]));
    index += 1;
    named = true;
  } else if (argument.startsWith("--clients=")) {
    rest.push(`--clients=${legacyNames(argument.slice("--clients=".length))}`);
    named = true;
  } else {
    rest.push(argument);
  }
}
if (rest.includes("--help") || rest.includes("-h")) {
  process.stdout.write("Usage: node scripts/install-local-mcp-clients.mjs [--apply] [--clients <names>]\n"
    + "Replaced by `ai-dev clients install` (npm run clients:install); see `ai-dev help clients`.\n");
} else {
  process.stderr.write("ai-dev: install-local-mcp-clients.mjs is `ai-dev clients install` now (npm run clients:install); "
    + "it writes the server as ai-dev and removes ai-dev-system. Without --clients it writes the four clients 2.x did "
    + "(Cursor, Gemini, VS Code, Claude Code); `ai-dev clients install` connects every client found. This path stays until 4.0.\n");
  process.exitCode = await main(["clients", "install", "--json", ...(apply ? [] : ["--dry-run"]), ...(named ? [] : ["--clients", LEGACY_CLIENTS]), ...rest]);
}
