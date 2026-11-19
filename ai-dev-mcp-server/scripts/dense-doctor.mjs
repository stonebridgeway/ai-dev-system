#!/usr/bin/env node
/**
 * `node scripts/dense-doctor.mjs` — what `npm run dense:doctor` ran in 2.x. It
 * is `ai-dev model doctor` now (`src/cli/model.mjs`): exit 0 when dense search
 * is ready, 1 when it is not.
 */
import { main } from "../src/cli/main.mjs";

process.exitCode = await main(["model", "doctor", ...process.argv.slice(2)]);
