import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { mergeCodexDocument } from "../../scripts/install-docker-mcp-clients.mjs";
const supported = new Set(["codex", "cursor", "gemini", "vscode", "claude"]);
const bin = fileURLToPath(new URL("../../bin/ai-dev.mjs", import.meta.url));
const targets = (home = os.homedir()) => ({ codex: path.join(home, ".codex", "config.toml"), cursor: path.join(home, ".cursor", "mcp.json"), gemini: path.join(home, ".gemini", "settings.json"), vscode: path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json"), claude: path.join(home, ".claude.json") });
export function clientServerConfig(client) { const config = { command: process.execPath, args: [bin, "serve"], env: {} }; return client === "vscode" ? { type: "stdio", ...config } : config; }
export async function run(args = []) {
  const clientsOption = args.indexOf("--clients");
  const requested = clientsOption >= 0 ? String(args[clientsOption + 1] || "").split(",").filter(Boolean) : args.filter((arg) => !arg.startsWith("--")); const clients = requested.length ? requested : [...supported];
  if (clients.some((client) => !supported.has(client))) throw new Error(`Unsupported client: ${clients.find((client) => !supported.has(client))}`);
  const results = [];
  for (const client of clients) { const target = targets()[client]; const current = await fs.readFile(target, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error));
    let next;
    if (client === "codex") next = `${mergeCodexDocument(current, clientServerConfig(client))}\n`;
    else { let document = {}; if (current) document = JSON.parse(current); const key = client === "vscode" ? "servers" : "mcpServers"; document[key] = { ...(document[key] || {}), "ai-dev": clientServerConfig(client) }; next = `${JSON.stringify(document, null, 2)}\n`; }
    if (current === next) { results.push({ client, target, status: "current" }); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true }); if (current) await fs.copyFile(target, `${target}.backup-${Date.now()}`); await fs.writeFile(target, next); results.push({ client, target, status: "updated" }); }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
