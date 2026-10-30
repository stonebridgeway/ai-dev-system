#!/usr/bin/env node
/**
 * The 2.x command line, `node scripts/ai-dev.mjs <command>`. It is the `ai-dev`
 * CLI now (`bin/ai-dev.mjs`, `src/cli/`); this path keeps working for the docs,
 * scripts and `runtime-distribution.json` files that name it, with a note on
 * stderr, until 4.0. Its `start` used to import a server that only runs when
 * started directly, and exit 0 having served nothing.
 */
import { main } from "../src/cli/main.mjs";

process.stderr.write("ai-dev: scripts/ai-dev.mjs is `ai-dev` now (bin/ai-dev.mjs); this path stays until 4.0.\n");
const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
