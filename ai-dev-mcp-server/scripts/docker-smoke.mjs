#!/usr/bin/env node
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const imageIndex = process.argv.indexOf("--image");
const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : "ai-dev-system:local";
if (!image) throw new Error("--image requires a value.");

const containerName = `ai-dev-mcp-smoke-${process.pid}`;
const transport = new StdioClientTransport({
  command: "docker",
  args: [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=512m",
    "--tmpfs",
    "/data:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700",
    "--shm-size",
    "1g",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    image
  ],
  stderr: "pipe"
});
const client = new Client(
  { name: "ai-dev-docker-smoke", version: "1.0.0" },
  { capabilities: {} }
);
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(chunk));

try {
  await client.connect(transport);
  const [tools, resources, templates, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts()
  ]);
  const recommendation = await client.callTool({
    name: "recommend_skills",
    arguments: {
      task: "Review a containerized Node.js service for secrets and deployment risks",
      limit: 3
    }
  });
  if (recommendation.isError) throw new Error("recommend_skills failed in the container.");
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    image,
    transport: "docker-stdio",
    tools: tools.tools.length,
    resources: resources.resources.length,
    resource_templates: templates.resourceTemplates.length,
    prompts: prompts.prompts.length,
    skill_routing: true
  }, null, 2)}\n`);
} catch (error) {
  const serverStderr = Buffer.concat(stderr).toString("utf8").trim();
  if (serverStderr) process.stderr.write(`${serverStderr}\n`);
  throw error;
} finally {
  await client.close().catch(() => {});
}
