import { pullModel } from "../../scripts/models.mjs";
import { run as installClient } from "./install-client.mjs";
import { ensureDaemon } from "../serve.mjs";
export async function run(args = []) {
  const noModel = args.includes("--no-model"); const noClients = args.includes("--no-clients");
  const result = { node: process.versions.node, model: noModel ? "skipped" : "pending", clients: noClients ? "skipped" : "pending", daemon: "pending" };
  if (!noModel) { const status = await pullModel(); result.model = status.ready ? status.dir : "failed"; }
  if (!noClients) { const selected = args.indexOf("--clients"); await installClient(selected >= 0 ? ["--clients", args[selected + 1]] : []); result.clients = "installed"; }
  if (!args.includes("--no-daemon")) { const socket = await ensureDaemon(); socket.end(); result.daemon = "started"; }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
