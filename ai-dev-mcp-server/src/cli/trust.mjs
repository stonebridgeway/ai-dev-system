import { listTrustedProjects, removeTrustedProject, trustProject } from "../core/project-trust.mjs";
export async function run(args = []) {
  if (args[0] === "--list") { process.stdout.write(`${JSON.stringify(await listTrustedProjects(), null, 2)}\n`); return; }
  if (args[0] === "--remove") { if (!args[1]) throw new Error("trust --remove requires a path"); process.stdout.write(`${JSON.stringify({ removed: await removeTrustedProject(args[1]) })}\n`); return; }
  if (!args[0]) throw new Error("trust requires a repository path, --list, or --remove <path>");
  process.stdout.write(`${JSON.stringify({ path: await trustProject(args[0]) })}\n`);
}
