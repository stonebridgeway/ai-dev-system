import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";
import { clientConfigPath } from "./runtime-paths.mjs";

async function readConfig() {
  try { return JSON.parse(await fs.readFile(clientConfigPath(), "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read AI Dev configuration: ${error.message}`);
  }
}

export async function listTrustedProjects() {
  const config = await readConfig();
  return Array.isArray(config.trusted_projects) ? config.trusted_projects : [];
}

export async function isTrusted(projectRoot) {
  const real = await fs.realpath(projectRoot);
  return (await listTrustedProjects()).some((entry) => entry.path === real);
}

export async function trustProject(projectRoot, { by = "cli" } = {}) {
  const real = await fs.realpath(projectRoot);
  const config = await readConfig();
  const trusted = Array.isArray(config.trusted_projects) ? config.trusted_projects : [];
  config.trusted_projects = [
    ...trusted.filter((entry) => entry.path !== real),
    { path: real, trusted_at: new Date().toISOString(), by }
  ];
  await atomicWriteJson(clientConfigPath(), config);
  return real;
}

export async function removeTrustedProject(projectRoot) {
  const real = path.resolve(projectRoot);
  const config = await readConfig();
  const trusted = Array.isArray(config.trusted_projects) ? config.trusted_projects : [];
  const retained = trusted.filter((entry) => path.resolve(entry.path) !== real);
  config.trusted_projects = retained;
  await atomicWriteJson(clientConfigPath(), config);
  return retained.length !== trusted.length;
}

export class ProjectNotTrustedError extends Error {
  constructor(projectRoot) {
    super(`Project is not trusted, so its commands cannot be executed: ${projectRoot}. Run ai-dev trust \"${projectRoot}\" or approve trust_project.`);
    this.name = "ProjectNotTrustedError";
    this.code = "PROJECT_NOT_TRUSTED";
  }
}

export async function assertTrusted(projectRoot) {
  // Node's test runner executes each test file with this marker. Tests create
  // throwaway repositories and must not write a user's trust configuration.
  if (process.env.AI_DEV_TRUST_ALL === "1" || process.env.NODE_TEST_CONTEXT) return;
  if (!(await isTrusted(projectRoot))) throw new ProjectNotTrustedError(projectRoot);
}
