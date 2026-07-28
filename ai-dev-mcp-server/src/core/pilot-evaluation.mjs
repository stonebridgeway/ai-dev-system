import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";

const PILOT_SCHEMA_VERSION = 1;

export const PILOT_TASK_TYPES = [
  "feature",
  "bugfix",
  "review",
  "frontend",
  "backend",
  "integration",
  "maintenance",
  "other"
];

export const PILOT_DIMENSIONS = [
  "task_success",
  "correctness",
  "maintainability",
  "test_quality",
  "usability",
  "visual_quality",
  "efficiency",
  "reviewer_confidence"
];

function now() {
  return new Date().toISOString();
}

function pilotId() {
  const stamp = now().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `pilot-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function emptyStore() {
  return {
    schema_version: PILOT_SCHEMA_VERSION,
    updated_at: null,
    pilots: []
  };
}

function normalizeBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("baseline must be an object.");
  }
  const kind = String(baseline.kind || "").trim();
  if (!["existing-product", "previous-result", "manual", "none-available"].includes(kind)) {
    throw new Error("baseline.kind must be existing-product, previous-result, manual, or none-available.");
  }
  const notes = String(baseline.notes || "").trim();
  const evidence = [...new Set((baseline.evidence || []).map(String).map((item) => item.trim()).filter(Boolean))];
  if (kind !== "none-available" && !notes && !evidence.length) {
    throw new Error("baseline requires notes or evidence.");
  }
  if (kind === "none-available" && notes.length < 12) {
    throw new Error("Explain why no baseline is available.");
  }
  return { kind, notes, evidence };
}

function normalizeReviewer(reviewer) {
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) {
    throw new Error("reviewer must be an object.");
  }
  const kind = String(reviewer.kind || "").trim();
  if (!["human", "independent-agent"].includes(kind)) {
    throw new Error("reviewer.kind must be human or independent-agent.");
  }
  const name = String(reviewer.name || "").trim();
  if (!name) throw new Error("reviewer.name is required.");
  return {
    kind,
    name,
    independent_from_implementer: reviewer.independent_from_implementer === true,
    human_confirmed: kind === "human" && reviewer.human_confirmed === true
  };
}

function normalizeDimensions(dimensions) {
  if (!Array.isArray(dimensions)) throw new Error("dimensions must be an array.");
  const byName = new Map();
  for (const item of dimensions) {
    const name = String(item?.name || "").trim();
    if (!PILOT_DIMENSIONS.includes(name)) throw new Error(`Unknown pilot dimension: ${name}`);
    if (byName.has(name)) throw new Error(`Duplicate pilot dimension: ${name}`);
    const status = String(item.status || "").trim();
    if (!["pass", "warn", "fail", "not_applicable"].includes(status)) {
      throw new Error(`Invalid status for ${name}.`);
    }
    const score = status === "not_applicable" ? null : Number(item.score);
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) {
      throw new Error(`Score for ${name} must be an integer from 1 to 5.`);
    }
    const evidence = [...new Set(
      (item.evidence || []).map(String).map((value) => value.trim()).filter(Boolean)
    )];
    if (status !== "not_applicable" && !evidence.length) {
      throw new Error(`Evidence is required for ${name}.`);
    }
    byName.set(name, {
      name,
      status,
      score,
      evidence,
      findings: [...new Set(
        (item.findings || []).map(String).map((value) => value.trim()).filter(Boolean)
      )]
    });
  }
  const missing = PILOT_DIMENSIONS.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`Missing pilot dimensions: ${missing.join(", ")}`);
  return PILOT_DIMENSIONS.map((name) => byName.get(name));
}

export function validatePilotReview(input) {
  const verdict = String(input.verdict || "").trim();
  if (!["accepted", "needs_revision", "rejected"].includes(verdict)) {
    throw new Error("verdict must be accepted, needs_revision, or rejected.");
  }
  const revisionCount = Number(input.revision_count);
  const durationMinutes = Number(input.duration_minutes);
  if (!Number.isInteger(revisionCount) || revisionCount < 0 || revisionCount > 1000) {
    throw new Error("revision_count must be an integer from 0 to 1000.");
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1_000_000) {
    throw new Error("duration_minutes must be greater than zero.");
  }
  const reviewer = normalizeReviewer(input.reviewer);
  if (!reviewer.independent_from_implementer) {
    throw new Error("Pilot reviewer must be independent from the implementer.");
  }
  const dimensions = normalizeDimensions(input.dimensions);
  if (verdict === "accepted" && dimensions.some((item) => item.status === "fail")) {
    throw new Error("An accepted pilot cannot contain a failing dimension.");
  }
  return {
    at: now(),
    verdict,
    reviewer,
    revision_count: revisionCount,
    duration_minutes: durationMinutes,
    first_pass_accepted: verdict === "accepted" && revisionCount === 0,
    dimensions,
    notes: String(input.notes || "").trim()
  };
}

export class PilotStore {
  constructor({ stateRoot }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "pilots.json");
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return {
        schema_version: PILOT_SCHEMA_VERSION,
        updated_at: parsed.updated_at || null,
        pilots: Array.isArray(parsed.pilots) ? parsed.pilots : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyStore();
      throw error;
    }
  }

  async update(mutator) {
    this.queue = this.queue.then(async () => {
      const store = await this.read();
      const next = await mutator(store);
      next.schema_version = PILOT_SCHEMA_VERSION;
      next.updated_at = now();
      next.pilots = (next.pilots || []).slice(-5000);
      await fs.mkdir(this.stateRoot, { recursive: true });
      await atomicWriteJson(this.filePath, next);
      return next;
    });
    return this.queue;
  }

  async start({
    projectIdentity,
    title,
    taskType,
    taskId = "",
    baseline,
    implementer = ""
  }) {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) throw new Error("title is required.");
    if (!PILOT_TASK_TYPES.includes(taskType)) throw new Error(`Unknown pilot task type: ${taskType}`);
    const record = {
      id: pilotId(),
      schema_version: PILOT_SCHEMA_VERSION,
      status: "active",
      created_at: now(),
      updated_at: now(),
      project_id: projectIdentity.project_id,
      project_path: projectIdentity.canonical_path,
      repository_id: projectIdentity.repository_id || null,
      title: normalizedTitle,
      task_type: taskType,
      task_id: String(taskId || "").trim() || null,
      implementer: String(implementer || "").trim(),
      baseline: normalizeBaseline(baseline),
      review: null
    };
    await this.update((store) => {
      store.pilots.push(record);
      return store;
    });
    return record;
  }

  async review(id, input) {
    const review = validatePilotReview(input);
    let updated = null;
    await this.update((store) => {
      const pilot = store.pilots.find((item) => item.id === id);
      if (!pilot) throw new Error(`Pilot not found: ${id}`);
      pilot.review = review;
      pilot.status = review.verdict === "accepted"
        ? "accepted"
        : review.verdict === "rejected"
          ? "rejected"
          : "needs_revision";
      pilot.updated_at = now();
      updated = structuredClone(pilot);
      return store;
    });
    return updated;
  }

  async status({ id = "", projectId = "" } = {}) {
    const store = await this.read();
    const pilots = store.pilots.filter((pilot) => (
      (!id || pilot.id === id)
      && (!projectId || pilot.project_id === projectId)
    ));
    const reviewed = pilots.filter((pilot) => pilot.review);
    const accepted = reviewed.filter((pilot) => pilot.status === "accepted");
    const scoredDimensions = accepted.flatMap((pilot) => (
      pilot.review.dimensions.filter((item) => item.score !== null)
    ));
    return {
      schema_version: store.schema_version,
      updated_at: store.updated_at,
      summary: {
        total: pilots.length,
        active: pilots.filter((pilot) => pilot.status === "active").length,
        accepted: accepted.length,
        needs_revision: pilots.filter((pilot) => pilot.status === "needs_revision").length,
        rejected: pilots.filter((pilot) => pilot.status === "rejected").length,
        human_confirmed: reviewed.filter((pilot) => pilot.review.reviewer.human_confirmed).length,
        first_pass_accepted: accepted.filter((pilot) => pilot.review.first_pass_accepted).length,
        average_dimension_score: scoredDimensions.length
          ? Number((scoredDimensions.reduce((sum, item) => sum + item.score, 0) / scoredDimensions.length).toFixed(2))
          : null
      },
      pilots
    };
  }
}
