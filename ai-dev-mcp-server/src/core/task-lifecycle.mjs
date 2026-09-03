import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";
import { taskRequestsDiagram, taskRequiresFrontendProductWorkflow } from "./skill-router.mjs";

const TASK_ID = /^task-\d{8}T\d{6}-[a-f0-9]{8}$/;

function now() {
  return new Date().toISOString();
}

function taskId(task, projectPath) {
  const stamp = now().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const suffix = crypto.createHash("sha256").update(`${task}\n${projectPath}\n${crypto.randomUUID()}`).digest("hex").slice(0, 8);
  return `task-${stamp}-${suffix}`;
}

function defaultCriteria(task, projectTypes) {
  const criteria = [
    `Requested behavior is implemented within the stated scope: ${task}`,
    "Relevant automated checks pass or every unavailable check has a recorded reason.",
    "No known regression, unresolved error, placeholder, or unrelated refactor remains."
  ];
  if (projectTypes.includes("frontend")) {
    criteria.push("Changed UI is checked on desktop and mobile with no critical console, overflow, accessibility, or visual issue.");
    if (taskRequiresFrontendProductWorkflow(task)) {
      criteria.push("The design-first implementation gate passed before frontend product code was changed.");
      criteria.push("Strict visual reference QA and an independent ten-dimension Product Design Scorecard pass before handoff.");
    }
  }
  if (projectTypes.includes("api")) {
    criteria.push("Changed API behavior preserves or explicitly documents request, response, error, and compatibility contracts.");
  }
  if (taskRequestsDiagram(task)) {
    criteria.push("The diagram is delivered via archify_deliver at showcase quality with zero composition errors and warnings; if archify_visual_check evidence is provided it reports no overflow at every checked viewport.");
  }
  return criteria;
}

function normalizeCriteria(task, projectTypes, provided = []) {
  const values = [...provided, ...defaultCriteria(task, projectTypes)]
    .map((item) => String(item).trim())
    .filter(Boolean);
  return [...new Set(values)].map((text, index) => ({
    id: `AC-${index + 1}`,
    text,
    status: "pending",
    evidence: [],
    note: ""
  }));
}

function riskFor(task, projectTypes) {
  const text = String(task).toLowerCase();
  if (/(payment|production|deploy|migration|database|security|auth|permission|удален|прод|депло|миграц|безопасн|платеж)/i.test(text)) return "high";
  if (projectTypes.some((item) => ["api", "backend", "mobile"].includes(item)) || /(shared|config|routing|dependency|api|сборк|маршрут|зависим)/i.test(text)) return "medium";
  return "low";
}

export class TaskStore {
  constructor({ stateRoot }) {
    this.stateRoot = path.resolve(stateRoot);
    this.tasksRoot = path.join(this.stateRoot, "tasks");
    this.locks = new Map();
  }

  taskPath(id) {
    if (!TASK_ID.test(String(id))) throw new Error(`Invalid task id: ${id}`);
    return path.join(this.tasksRoot, `${id}.json`);
  }

  async lock(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(id, current);
    return current.finally(() => {
      if (this.locks.get(id) === current) this.locks.delete(id);
    });
  }

  async begin({
    task,
    project,
    skills,
    acceptanceCriteria = [],
    baseline,
    context = {}
  }) {
    if (!String(task || "").trim()) throw new Error("task is required.");
    if (!project?.project_path) throw new Error("project.project_path is required.");
    const createdAt = now();
    const id = taskId(task, project.project_path);
    const record = {
      schema_version: 1,
      id,
      status: "active",
      created_at: createdAt,
      updated_at: createdAt,
      task: String(task).trim(),
      project: {
        id: project.project_id || null,
        repository_id: project.repository_id || null,
        name: project.project_name,
        path: project.canonical_project_path || project.project_path,
        aliases: project.project_aliases || [project.project_path],
        types: project.project_types || [],
        stack: project.stack || [],
        components: project.components || []
      },
      risk: riskFor(task, project.project_types || []),
      acceptance_criteria: normalizeCriteria(task, project.project_types || [], acceptanceCriteria),
      skills: skills || [],
      context,
      baseline,
      checkpoints: [],
      verifications: [],
      completion: null
    };
    await atomicWriteJson(this.taskPath(id), record);
    return record;
  }

  async read(id) {
    const text = await fs.readFile(this.taskPath(id), "utf8");
    return JSON.parse(text);
  }

  async list({ projectPath = "", status = "", limit = 20 } = {}) {
    let files = [];
    try {
      files = (await fs.readdir(this.tasksRoot)).filter((item) => item.endsWith(".json"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const file of files) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.tasksRoot, file), "utf8"));
        if (status && record.status !== status) continue;
        if (projectPath && path.resolve(record.project.path) !== path.resolve(projectPath)) continue;
        records.push(record);
      } catch {
        // Corrupt records are reported by system health and do not hide valid tasks.
      }
    }
    return records
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 5000)));
  }

  async update(id, mutate) {
    return this.lock(id, async () => {
      const record = await this.read(id);
      const next = await mutate(structuredClone(record));
      next.updated_at = now();
      await atomicWriteJson(this.taskPath(id), next);
      return next;
    });
  }

  async checkpoint(id, { summary, changedFiles = [], criteria = [], notes = "" }) {
    return this.update(id, (record) => {
      if (record.status === "complete") throw new Error("Completed task cannot be checkpointed.");
      for (const update of criteria) {
        const target = record.acceptance_criteria.find((item) => item.id === update.id);
        if (!target) throw new Error(`Unknown acceptance criterion: ${update.id}`);
        if (!["pending", "met", "blocked", "waived"].includes(update.status)) {
          throw new Error(`Invalid criterion status: ${update.status}`);
        }
        target.status = update.status;
        target.note = String(update.note || "");
        if (Array.isArray(update.evidence)) target.evidence = update.evidence;
      }
      record.checkpoints.push({
        at: now(),
        summary: String(summary || "").trim(),
        changed_files: [...new Set(changedFiles.map(String))],
        notes: String(notes || "")
      });
      return record;
    });
  }

  async addVerification(id, verification) {
    return this.update(id, (record) => {
      if (record.status === "complete") throw new Error("Completed task cannot be verified again.");
      record.status = verification.passed ? "verified" : "active";
      record.verifications.push(verification);
      return record;
    });
  }

  async complete(id, { summary, projectState, allowWaived = false }) {
    return this.update(id, (record) => {
      const unresolved = record.acceptance_criteria.filter((item) => (
        item.status !== "met" && !(allowWaived && item.status === "waived" && item.note)
      ));
      if (unresolved.length) {
        throw new Error(`Task has unresolved acceptance criteria: ${unresolved.map((item) => item.id).join(", ")}`);
      }
      const matching = record.verifications.filter((item) => (
        item.passed && item.evidence?.source_state_fingerprint === projectState.fingerprint
      ));
      if (!matching.length) {
        throw new Error("No passing verification is bound to the current project state.");
      }
      record.status = "complete";
      record.completion = {
        at: now(),
        summary: String(summary || "").trim(),
        project_state: projectState,
        verification_ids: matching.map((item) => item.id)
      };
      return record;
    });
  }
}
