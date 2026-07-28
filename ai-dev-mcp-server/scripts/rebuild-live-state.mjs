import process from "node:process";
import { callTool, shutdownBgeWorkers } from "../src/mcp-stdio.mjs";

const flags = new Set(process.argv.slice(2));
const full = flags.has("--full");
const includeDense = full || flags.has("--dense");
const validateSkills = full || flags.has("--validate");

function toolPayload(result, name) {
  if (result.isError) {
    throw new Error(`${name}: ${result.content?.[0]?.text || "tool failed"}`);
  }
  return result.structuredContent?.result
    || JSON.parse(result.content?.find((item) => item.type === "text")?.text || "{}");
}

function conciseSummary(name, payload) {
  if (name === "sync_skill_overlays") {
    return {
      total_skills: payload.coverage?.total_skills,
      routing_priorities: payload.coverage?.routing_priorities
    };
  }
  if (name === "rebuild_skill_outcomes") {
    return {
      verification_attempts: payload.verification_attempts,
      terminal_outcomes: payload.terminal_outcomes,
      empirically_validated: payload.empirically_validated
    };
  }
  if (name === "validate_skill_library") {
    return {
      checked: payload.summary?.total,
      structure_passed: payload.summary?.structure_passed,
      empirical_passed: payload.summary?.empirical_passed
    };
  }
  if (name === "rebuild_search_index") {
    return {
      documents: payload.document_count,
      dense_vectors: payload.dense_vectors,
      dense_pending_documents: payload.dense_pending_documents
    };
  }
  if (name === "prepare_runtime_distribution") {
    return {
      ready_local: payload.status?.ready_local ?? payload.ready_local,
      transport: payload.status?.profile?.transport?.mode ?? payload.profile?.transport?.mode
    };
  }
  if (name === "rebuild_system_dashboard") {
    return {
      markdown_path: payload.markdown_path,
      generated_at: payload.generated_at,
      fresh: payload.fresh
    };
  }
  return payload;
}

const steps = [
  ["sync_skill_overlays", { rebuild_registry: true }],
  ["rebuild_skill_outcomes", {}]
];

if (validateSkills) {
  steps.push([
    "validate_skill_library",
    {
      include_duplicates: true,
      include_semantic_duplicates: false,
      write_report: true,
      refresh_registry: false
    }
  ]);
}

steps.push(
  ["prepare_runtime_distribution", {}],
  [
    "rebuild_search_index",
    {
      include_external_project_files: true,
      dense_embeddings: includeDense,
      preserve_dense: true
    }
  ],
  ["rebuild_system_dashboard", { rebuild_search: false }],
  [
    "rebuild_search_index",
    {
      include_external_project_files: true,
      dense_embeddings: includeDense,
      preserve_dense: true
    }
  ]
);

try {
  for (const [name, input] of steps) {
    const payload = toolPayload(await callTool(name, input), name);
    process.stdout.write(`${JSON.stringify({
      step: name,
      status: "passed",
      ...conciseSummary(name, payload)
    })}\n`);
  }
} finally {
  await shutdownBgeWorkers();
}
