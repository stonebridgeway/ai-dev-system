#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSkillRoutingSuite, readSkillRoutingCases } from "../src/core/skill-routing-eval.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cases = await readSkillRoutingCases(path.resolve(scriptDir, "../../search-eval/skill_routing_eval_cases.json"));
const report = evaluateSkillRoutingSuite(cases.cases);
process.stdout.write(`${JSON.stringify(report.summary)}\n`);
if (report.status !== "pass") process.exitCode = 1;
