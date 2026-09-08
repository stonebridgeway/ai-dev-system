import fs from "node:fs/promises";
import process from "node:process";
import { modelStatus } from "../../scripts/models.mjs";
import { daemonInfoPath } from "../core/runtime-paths.mjs";
import { listTrustedProjects } from "../core/project-trust.mjs";
export async function doctorReport() {
  const node = process.versions.node; const versionOk = Number(node.split('.')[0]) >= 22;
  const daemon = await fs.readFile(daemonInfoPath(), "utf8").then(JSON.parse).catch(() => null);
  const model = await modelStatus(); const trusted = await listTrustedProjects();
  return { node: { ok: versionOk, detail: node, repair: "Install Node.js 22.12 or later." }, daemon: { ok: Boolean(daemon), detail: daemon || "not running", repair: "Run ai-dev serve or ai-dev daemon." }, model: { ok: model.ready, detail: model, repair: "Run ai-dev models pull." }, projects: { ok: true, detail: trusted.length, repair: "Run ai-dev trust <path>." } };
}
export async function run() { const report = await doctorReport(); for (const [name, check] of Object.entries(report)) process.stdout.write(`${check.ok ? "✔" : "✘"} ${name}: ${typeof check.detail === "string" ? check.detail : JSON.stringify(check.detail)}${check.ok ? "" : ` → ${check.repair}`}\n`); if (Object.values(report).some((check) => !check.ok)) process.exitCode = 1; }
