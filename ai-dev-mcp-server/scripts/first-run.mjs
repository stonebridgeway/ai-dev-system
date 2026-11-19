#!/usr/bin/env node
/**
 * `node scripts/first-run.mjs` — what `npm run setup` ran in 2.x. It is
 * `ai-dev setup` now (`src/cli/setup.mjs`); this path runs that.
 */
import { main } from "../src/cli/main.mjs";

process.exitCode = await main(["setup", ...process.argv.slice(2)]);
