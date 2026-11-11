#!/usr/bin/env node
/**
 * `ai-dev` — the one command line of AI Dev System. `ai-dev help` lists the
 * commands; the code is in `src/cli/`.
 */
import { main } from "../src/cli/main.mjs";

const code = await main(process.argv.slice(2));
// `mcp` keeps serving after main returns; every other command is done.
if (code !== null) process.exitCode = code;
