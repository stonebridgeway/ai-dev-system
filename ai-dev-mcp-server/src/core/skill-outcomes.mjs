import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";

const STORE_SCHEMA_VERSION = 2;

function fallbackProjectId(projectPath) {
  return `legacy-project-${crypto
    .createHash("sha256")
    .update(path.resolve(projectPath || "."))
    .digest("hex")
    .slice(0, 20)}`;
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(4));
}

function emptyStore() {
  return {
    schema_version: STORE_SCHEMA_VERSION,
    updated_at: null,
    attempts: [],
    outcomes: []
  };
}

function customSkillNames(task) {
  return [...new Set(
    (task.skills || [])
      .filter((skill) => !skill.source || skill.source === "custom")
      .map((skill) => String(skill.name || "").trim())
      .filter(Boolean)
  )];
}

function projectIdFor(task, projectIdentity) {
  return projectIdentity?.project_id
    || task.project?.id
    || fallbackProjectId(task.project?.path);
}

function checkStatus(check) {
  return check.result?.status || check.result?.gate || "unknown";
}

export function classifyVerificationFailure(verification) {
  if (verification?.passed) return "none";
  const statuses = (verification?.checks || []).map(checkStatus);
  if (statuses.some((status) => [
    "unavailable",
    "not_frontend",
    "no_commands",
    "no_commands_run",
    "timed_out"
  ].includes(status))) {
    return "infrastructure";
  }
  if (statuses.some((status) => ["blocked", "block"].includes(status))) return "policy";
  return "product";
}

function normalizeTerminalOutcomes(outcomes) {
  const byTask = new Map();
  for (const [index, outcome] of outcomes.entries()) {
    if (!outcome || outcome.synthetic || outcome.eligible === false) continue;
    if (!["pass", "fail"].includes(outcome.status)) continue;
    const taskKey = outcome.task_id || `legacy-${index}-${outcome.project_id || outcome.project_key || ""}`;
    const existing = byTask.get(taskKey);
    if (!existing || String(outcome.at || "") >= String(existing.at || "")) {
      byTask.set(taskKey, outcome);
    }
  }
  return [...byTask.values()];
}

export function summarizeSkillOutcomes(outcomes, {
  minimumAttempts = 3,
  minimumProjects = 2,
  minimumPassRate = 0.8,
  minimumHumanReviews = 1
} = {}) {
  const terminal = normalizeTerminalOutcomes(outcomes);
  const bySkill = new Map();
  for (const outcome of terminal) {
    for (const skill of outcome.skills || []) {
      const name = String(skill || "").trim();
      if (!name) continue;
      if (!bySkill.has(name)) bySkill.set(name, []);
      bySkill.get(name).push(outcome);
    }
  }

  const summaries = {};
  for (const [name, skillOutcomes] of bySkill) {
    const passed = skillOutcomes.filter((outcome) => outcome.status === "pass").length;
    const failed = skillOutcomes.filter((outcome) => outcome.status === "fail").length;
    const attempts = passed + failed;
    const projects = new Set(
      skillOutcomes
        .map((outcome) => outcome.project_id || outcome.project_key)
        .filter(Boolean)
    );
    const humanReviewed = skillOutcomes.filter(
      (outcome) => outcome.human_review?.reviewer?.human_confirmed === true
    );
    const humanAccepted = humanReviewed.filter(
      (outcome) => outcome.human_review?.verdict === "accepted"
    );
    const humanScores = humanReviewed.flatMap((outcome) => (
      (outcome.human_review?.dimensions || [])
        .map((item) => item.score)
        .filter((score) => Number.isFinite(score))
    ));
    const passRate = attempts ? passed / attempts : 0;
    const empiricalPass = attempts >= minimumAttempts
      && projects.size >= minimumProjects
      && passRate >= minimumPassRate
      && humanReviewed.length >= minimumHumanReviews;
    summaries[name] = {
      attempts,
      terminal_tasks: attempts,
      verification_attempts: skillOutcomes.reduce(
        (sum, outcome) => sum + Math.max(1, Number(outcome.verification_attempts || 1)),
        0
      ),
      passed,
      failed,
      pass_rate: rounded(passRate),
      distinct_projects: projects.size,
      human_reviewed: humanReviewed.length,
      human_accepted: humanAccepted.length,
      average_human_score: humanScores.length
        ? rounded(humanScores.reduce((sum, score) => sum + score, 0) / humanScores.length)
        : null,
      empirical_score: Math.round(passRate * 100),
      empirical_status: empiricalPass ? "pass" : attempts ? "observed" : "not-measured",
      latest_at: skillOutcomes.map((outcome) => outcome.at).sort().at(-1) || null,
      thresholds: {
        minimum_attempts: minimumAttempts,
        minimum_projects: minimumProjects,
        minimum_pass_rate: minimumPassRate,
        minimum_human_reviews: minimumHumanReviews
      }
    };
  }
  return summaries;
}

export function applySkillOutcome(item, summary) {
  if (!summary) return item;
  const passed = summary.empirical_status === "pass";
  return {
    ...item,
    empirical_score: summary.empirical_score,
    empirical_status: summary.empirical_status,
    empirical_validation: {
      status: summary.empirical_status,
      ...summary
    },
    validation_status: passed ? "validated" : "provisional",
    validation_evidence: [{
      type: "terminal-task-outcomes",
      status: summary.empirical_status,
      attempts: summary.attempts,
      verification_attempts: summary.verification_attempts,
      passed: summary.passed,
      failed: summary.failed,
      distinct_projects: summary.distinct_projects,
      human_reviewed: summary.human_reviewed,
      human_accepted: summary.human_accepted,
      average_human_score: summary.average_human_score,
      latest_at: summary.latest_at
    }],
    maturity: passed && item.quality_status === "pass" ? "validated" : item.maturity,
    quality_basis: passed ? "structure-and-empirical" : "structure-only"
  };
}

function legacyAttempt(event) {
  return {
    ...event,
    classification: event.status === "pass" ? "none" : "legacy-unclassified",
    eligible: false,
    migrated_from_schema: 1
  };
}

function createAttempt({ task, verification, projectState, projectIdentity }) {
  return {
    id: `${task.id}:${verification.id}`,
    at: verification.at || new Date().toISOString(),
    task_id: task.id,
    verification_id: verification.id,
    status: verification.passed ? "pass" : "fail",
    classification: classifyVerificationFailure(verification),
    project_id: projectIdFor(task, projectIdentity),
    source_state_fingerprint: projectState.fingerprint,
    source_head: projectState.head || null,
    evidence_strength: projectState.strength || "unknown",
    synthetic: Boolean(task.context?.synthetic),
    eligible: false,
    skills: customSkillNames(task),
    checks: (verification.checks || []).map((check) => ({
      type: check.type,
      status: checkStatus(check)
    }))
  };
}

function createTerminalOutcome({ task, verification, projectState, projectIdentity }) {
  const skills = customSkillNames(task);
  if (!skills.length) return null;
  return {
    id: task.id,
    at: task.completion?.at || verification.at || new Date().toISOString(),
    task_id: task.id,
    final_verification_id: verification.id,
    status: verification.passed ? "pass" : "fail",
    classification: verification.passed ? "verified-completion" : classifyVerificationFailure(verification),
    project_id: projectIdFor(task, projectIdentity),
    repository_id: projectIdentity?.repository_id || task.project?.repository_id || null,
    source_state_fingerprint: projectState.fingerprint,
    source_head: projectState.head || null,
    evidence_strength: projectState.strength || "unknown",
    verification_attempts: Math.max(1, Number(task.verifications?.length || 1)),
    synthetic: Boolean(task.context?.synthetic),
    eligible: !task.context?.synthetic && projectState.strength === "strong",
    skills,
    human_review: null
  };
}

export class SkillOutcomeStore {
  constructor({ stateRoot }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "skill-outcomes.json");
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (Number(parsed.schema_version || 1) >= STORE_SCHEMA_VERSION) {
        return {
          schema_version: STORE_SCHEMA_VERSION,
          updated_at: parsed.updated_at || null,
          attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
          outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : []
        };
      }
      return {
        schema_version: STORE_SCHEMA_VERSION,
        updated_at: parsed.updated_at || null,
        attempts: (Array.isArray(parsed.events) ? parsed.events : []).map(legacyAttempt),
        outcomes: []
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
      next.schema_version = STORE_SCHEMA_VERSION;
      next.updated_at = new Date().toISOString();
      next.attempts = (next.attempts || []).slice(-10_000);
      next.outcomes = (next.outcomes || []).slice(-5_000);
      await fs.mkdir(this.stateRoot, { recursive: true });
      await atomicWriteJson(this.filePath, next);
      return next;
    });
    return this.queue;
  }

  async recordAttempt({ task, verification, projectState, projectIdentity = null }) {
    const attempt = createAttempt({ task, verification, projectState, projectIdentity });
    if (!attempt.skills.length) return { recorded: false, summaries: {} };
    const store = await this.update((current) => {
      const index = current.attempts.findIndex((item) => item.id === attempt.id);
      if (index >= 0) current.attempts[index] = attempt;
      else current.attempts.push(attempt);
      return current;
    });
    return {
      recorded: true,
      attempt,
      summaries: Object.fromEntries(
        attempt.skills.map((name) => [name, summarizeSkillOutcomes(store.outcomes)[name] || null])
      )
    };
  }

  async recordVerification(input) {
    return this.recordAttempt(input);
  }

  async recordCompletion({ task, verification, projectState, projectIdentity = null }) {
    const outcome = createTerminalOutcome({ task, verification, projectState, projectIdentity });
    if (!outcome) return { recorded: false, summaries: {} };
    const store = await this.update((current) => {
      const index = current.outcomes.findIndex((item) => item.task_id === outcome.task_id);
      if (index >= 0) current.outcomes[index] = outcome;
      else current.outcomes.push(outcome);
      return current;
    });
    const summaries = summarizeSkillOutcomes(store.outcomes);
    return {
      recorded: true,
      outcome,
      summaries: Object.fromEntries(outcome.skills.map((name) => [name, summaries[name]]))
    };
  }

  async rebuildFromCompletedTasks(entries) {
    const outcomes = entries
      .map((entry) => createTerminalOutcome(entry))
      .filter(Boolean);
    const store = await this.update((current) => ({
      ...current,
      outcomes
    }));
    return this.status(store);
  }

  async applyPilotReview(taskId, review) {
    let updatedOutcome = null;
    const store = await this.update((current) => {
      const outcome = current.outcomes.find((item) => item.task_id === taskId);
      if (!outcome) return current;
      outcome.human_review = structuredClone(review);
      if (review.verdict === "accepted") {
        outcome.status = "pass";
        outcome.classification = "human-accepted";
      } else if (review.verdict === "rejected") {
        outcome.status = "fail";
        outcome.classification = "human-rejected";
      } else {
        outcome.status = "fail";
        outcome.classification = "human-needs-revision";
      }
      updatedOutcome = structuredClone(outcome);
      return current;
    });
    return {
      updated: Boolean(updatedOutcome),
      outcome: updatedOutcome,
      summaries: summarizeSkillOutcomes(store.outcomes)
    };
  }

  async status(existingStore = null) {
    const store = existingStore || await this.read();
    const summaries = summarizeSkillOutcomes(store.outcomes);
    const terminal = normalizeTerminalOutcomes(store.outcomes);
    const classifications = {};
    for (const attempt of store.attempts) {
      const key = attempt.classification || "unknown";
      classifications[key] = (classifications[key] || 0) + 1;
    }
    return {
      schema_version: store.schema_version,
      updated_at: store.updated_at,
      events: terminal.length,
      verification_attempts: store.attempts.length,
      terminal_outcomes: terminal.length,
      excluded_outcomes: store.outcomes.length - terminal.length,
      skills_observed: Object.keys(summaries).length,
      empirically_validated: Object.values(summaries)
        .filter((item) => item.empirical_status === "pass")
        .length,
      attempt_classifications: classifications,
      summaries
    };
  }
}
