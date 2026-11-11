#!/usr/bin/env node
/**
 * `node scripts/model.mjs <command>` — what `npm run model` ran before the
 * CLI. It is `ai-dev model <command>` now (`src/cli/model.mjs`).
 */
import { main } from "../src/cli/main.mjs";

process.exitCode = await main(["model", ...process.argv.slice(2)]);
