/**
 * How `recommend_skills` picks a minimal set of skills for one task.
 *
 * Three inputs decide everything: the task text, the skill registry, and the
 * project context the extension has already read from the vault. Reading those
 * is `src/extensions/skills.mjs`; ranking them is here, so the intent patterns
 * and the filtering rules can be tested against a handful of literal objects
 * instead of a vault.
 *
 * The shape of the answer: deterministic routing rules (`skill-router.mjs`)
 * seed the candidates at the top ranks, intent patterns add named skills below
 * them, the registry is then scored for anything else that matches, and
 * `prioritizeRoutedRecommendations` trims the result to the routed core plus
 * one reserved slot per reserved role — a capability add-on, and the imported
 * specialist {@link pickTaskSpecialist} finds.
 */
import { INTENT } from "./intent-patterns.mjs";
import {
  DIAGRAM_REQUEST_PATTERN,
  prioritizeRoutedRecommendations,
  routeSkills,
  taskRequiresFrontendProductWorkflow
} from "./skill-router.mjs";
import {
  findSkillItem,
  isDesignFirstSkill,
  isDesignSkill,
  isMembraneSkill,
  isVisualHeavySkill,
  skillKey
} from "./skill-catalog.mjs";
import { declaredStackTerms, expandTaskVocabulary, specialistMatchScore, stackAlignment } from "./task-vocabulary.mjs";
import { scoreText, toStringList } from "./text-format.mjs";
import { canonicalSkillGroup, inferTaskSkillGroups } from "../skill-taxonomy.mjs";
import { SKILL_SCHEMA_VERSION } from "../skill-quality.mjs";

/** Membrane policies `recommend_skills` accepts. */
export const MEMBRANE_POLICIES = Object.freeze(["auto", "include", "exclude"]);

/** Task asks for something a user will look at. */
export function taskLooksVisual(task) {
  return /(ui|ux|frontend|design|figma|responsive|landing|website|portfolio|mockup|image|visual|brand|logo|redesign|сайт|дизайн|интерфейс|лендинг|бренд|логотип|мокап)/i.test(task);
}

/** Task names an external application or connector, so app skills are useful. */
export function taskLooksMembraneIntegration(task) {
  return /(membrane|app skill|application skill|connector|oauth|webhook|crm|gmail|google sheets|google drive|notion|slack|discord|linear|jira|hubspot|salesforce|shopify|stripe|интеграц|вебхук|коннектор)/i.test(task);
}

/** Task is server-side: APIs, data stores, workers, bots, models. */
export function taskLooksBackend(task) {
  return /(api|backend|database|queue|worker|celery|fastapi|sqlalchemy|postgres|redis|bot|telegram|llm|vision|server|бэкенд|сервер|бот|очеред|база данных)/i.test(task);
}

/** Task is about proving quality rather than changing behaviour. */
export function taskLooksQuality(task) {
  return /(test|lint|typecheck|quality|gate|ci|coverage|security scan|ruff|pytest|провер|тест|качество|линт|тайпчек|безопасн)/i.test(task);
}

/** Task needs the design-first frontend product state machine. */
export function taskLooksFrontendProduct(task) {
  return taskRequiresFrontendProductWorkflow(task);
}

/** Frontend work on something that already exists and ships to users. */
export function taskLooksBetaFrontend(task) {
  const frontendSignal = /(frontend|front-end|ui|ux|react|next\.js|vue|svelte|vite|tailwind|layout|component|screen|css|button|form|modal|интерфейс|фронт|верстк|экран|компонент|кнопк|форм|модал)/i.test(task);
  const supportSignal = /(beta|staging|support|maintain|maintenance|existing app|admin panel|dashboard|responsive bug|layout bug|ui bug|frontend bug|small fix|polish ticket|бета|стейдж|поддерж|саппорт|админ|панел|дашборд|адаптив|поправ|почин|баг)/i.test(task);
  return frontendSignal && supportSignal;
}

/** Frontend work being checked before handoff. */
export function taskLooksFrontendGate(task) {
  const frontendSignal = /(frontend|front-end|ui|ux|browser|visual|responsive|accessibility|a11y|wcag|web vitals|layout|form|screen|component|интерфейс|фронт|верстк|дизайн|адаптив|доступн|браузер|форм|экран|компонент)/i.test(task);
  const gateSignal = /(quality gate|qa|check|verify|verification|review|test|lint|build|handoff|release|ship|провер|качество|гейт|тест|релиз|сдач|ревью)/i.test(task);
  return frontendSignal && gateSignal;
}

/** Task is a marketing surface judged on conversion, not just looks. */
export function taskLooksLandingConversion(task) {
  return /(landing|landing page|conversion|cro|cta|hero|pricing|marketing page|sales page|lead[- ]?gen|waitlist|signup|offer|funnel|copywriting|лендинг|ленд|конверс|оффер|продающ|заявк|герой|хиро|тариф|прайс|лид|вейтлист|подпис|регистрац)/i.test(task);
}

/** The project's declared stack is a frontend one. */
export function projectStackLooksFrontend(context) {
  return /(react|next\.js|vue|svelte|vite|tailwind|frontend|ui|ux)/i.test((context.stack ?? []).join(" "));
}

/** The project reads as server-side work. */
export function projectLooksBackend(context) {
  return /(python|fastapi|sqlalchemy|alembic|postgres|redis|celery|aiogram|docker|backend|api|worker|queue|bot)/i.test(context.context_text);
}

/** The project card asks for app/integration skills to be filtered out. */
export function projectFiltersMembrane(context) {
  return /membrane\/app skills.*noisy|filter.*membrane|membrane.*noisy/i.test(context.card_text);
}

/** Whether app/integration skills may be recommended for this task at all. */
export function membraneAllowed({ task, context, membranePolicy, includeMembrane }) {
  if (includeMembrane || membranePolicy === "include") return true;
  if (membranePolicy === "exclude") return false;
  if (context?.membrane_noisy) return false;
  return taskLooksMembraneIntegration(task);
}

/**
 * Why a candidate should not be recommended, or "" when it should.
 *
 * Workflow skills that only help in a narrow situation are filtered by intent
 * so a generic task does not collect five of them.
 */
export function shouldSkipRecommendedSkill(item, { task, context, membranePolicy, includeMembrane }) {
  if (item.routing_priority === "disabled") {
    return "Skill is disabled by the local normalization overlay.";
  }
  if (isMembraneSkill(item) && !membraneAllowed({ task, context, membranePolicy, includeMembrane })) {
    return "Membrane/app skills are filtered unless the task explicitly asks for app integrations or membrane_policy=include.";
  }
  if (item.name === "knowledge-curator" && !/(knowledge|obsidian|notes|vault|memory|handoff|brief|project-map|база знаний|заметк|памят|контекст)/i.test(task)) {
    return "Knowledge workflow filtered because the task is not a durable-knowledge update.";
  }
  if (item.name === "repo-onboarding" && !/(repo|repository|onboard|bootstrap|prepare|AGENTS|project map|подготов|оформ|проект|агент|ии|репозитор|изучи проект|изучить проект)/i.test(task)) {
    return "Repository onboarding workflow filtered because the task is not repository preparation or discovery.";
  }
  if (item.name === "frontend-polisher" && !taskLooksVisual(task) && !projectStackLooksFrontend(context)) {
    return "Frontend workflow filtered because neither task nor project is frontend/design oriented.";
  }
  if (isVisualHeavySkill(item) && !taskLooksVisual(task)) {
    return "Visual/image-heavy skill filtered because the task is not visual/design related.";
  }
  // Our own skills' categories are written by hand and mean what they say. An
  // imported catalogue's are produced by its auto-tagger: ECC files
  // `hexagonal-architecture` under design, frontend, ui and ux, and it is a
  // backend architecture skill. For those the veto reads `primary_group`, the
  // one value the taxonomy settled on — read through `categories` every such
  // skill was unreachable for any task that was not about design (Д-1).
  const designVeto = item.source === "custom" ? isDesignSkill(item) : isDesignFirstSkill(item);
  if (designVeto && !taskLooksVisual(task) && !projectStackLooksFrontend(context)) {
    return "Design/frontend skill filtered because neither task nor project is frontend/design oriented.";
  }
  return "";
}

/**
 * Rank a skill the project card recommends, judged against the current task.
 * A card recommendation that does not fit the task scores 0 and is dropped.
 */
export function projectRecommendedSkillRank(name, task, context) {
  const normalized = String(name ?? "").toLowerCase();
  const featureLike = /(new feature|implement|add|build|feature|созда|добав|реализ|фич)/i.test(task) || taskLooksBackend(task) || projectLooksBackend(context);
  const bugLike = /(bug|error|fail|fix|debug|regression|flaky|retry|слом|ошиб|почин|баг|\bci\b)/i.test(task);
  const reviewLike = /(review|\bpr\b|diff|pull request|patch|audit|проверь|ревью)/i.test(task) || taskLooksQuality(task);
  const repoLike = /(repo|repository|onboard|bootstrap|prepare|AGENTS|project map|подготов|оформ|проект|агент|ии|репозитор)/i.test(task);
  const knowledgeLike = /(knowledge|obsidian|notes|vault|memory|handoff|brief|project-map|база знаний|заметк|памят|контекст)/i.test(task);

  const betaFrontendLike = taskLooksBetaFrontend(task) || (projectStackLooksFrontend(context) && (featureLike || bugLike));
  const frontendGateLike = taskLooksFrontendGate(task) || (taskLooksQuality(task) && (taskLooksVisual(task) || projectStackLooksFrontend(context)));
  const landingConversionLike = taskLooksLandingConversion(task);
  const frontendProductLike = taskLooksFrontendProduct(task);

  if (normalized === "frontend-product-builder" && frontendProductLike) return 180;
  if (normalized === "feature-builder" && featureLike) return 108;
  if (normalized === "bugfix-investigator" && bugLike) return 108;
  if (normalized === "code-reviewer" && reviewLike) return 108;
  if (normalized === "repo-onboarding" && repoLike) return 108;
  if (normalized === "frontend-polisher" && (taskLooksVisual(task) || projectStackLooksFrontend(context))) return 108;
  if (normalized === "beta-frontend-maintainer" && betaFrontendLike) return 116;
  if (normalized === "frontend-quality-gate" && frontendGateLike) return 116;
  if (normalized === "landing-conversion-reviewer" && landingConversionLike) return 116;
  if (normalized === "knowledge-curator" && knowledgeLike) return 108;
  return 0;
}

/**
 * Registry quality nudged into the ranking: a validated, trusted, high-priority
 * skill outranks a draft one at the same textual match, and a deprecated or
 * disabled one is pushed out of reach.
 */
export function skillQualityRankAdjustment(item) {
  if (!item || item.skill_schema_version !== SKILL_SCHEMA_VERSION) return 0;
  if (item.maturity === "deprecated") return -100;
  if (item.quality_status === "fail") return -30;
  let adjustment = Math.max(-8, Math.min(8, Math.round((Number(item.quality_score || 0) - 75) / 3)));
  if (["validated", "production"].includes(item.maturity)) adjustment += 4;
  else if (item.maturity === "reviewed") adjustment += 2;
  if (["trusted-local", "pinned-upstream"].includes(item.trust_level)) adjustment += 2;
  if (item.routing_priority === "high") adjustment += 4;
  if (item.routing_priority === "low") adjustment -= 6;
  if (item.routing_priority === "disabled") adjustment -= 100;
  return adjustment;
}

/**
 * How much of the task's situation an imported skill has to answer before it is
 * offered. Three terms found in `use_when` / description is the floor: one is a
 * coincidence ("test" appears in half the catalogue), two is a theme, three is
 * the situation.
 */
export const SPECIALIST_MIN_SITUATION_HITS = 3;

/**
 * The score a specialist has to reach after the ecosystem penalty. Without a
 * floor the slot is always filled by whatever scraped three hits — a Laravel
 * security skill for "audit our dependencies" — and an offer nobody should take
 * is worse than an empty slot.
 */
export const SPECIALIST_MIN_SCORE = 18;

/** What an imported skill loses for naming ecosystems that never came up. */
export const SPECIALIST_FOREIGN_STACK_PENALTY = 8;

/**
 * What it loses on top when it names only one or two of them. A skill for nine
 * ecosystems is a general one that happens to list them; a skill for Laravel is
 * a Laravel skill, so being in the wrong ecosystem costs it more.
 */
export const SPECIALIST_NARROW_STACK_PENALTY = 2;

/**
 * The one imported skill that best answers this task, or `null`.
 *
 * This is the whole of the answer to Д-1. Our own skills are routed by name and
 * fill all three conventional slots, so an imported skill could never appear —
 * and it should not appear by displacing one, because the routed core carries
 * the verification contract. It gets a slot of its own instead, and earns it the
 * way a skill author intends: by its `use_when` answering the task's situation,
 * matched through the bilingual expansion in `task-vocabulary.mjs` rather than
 * by category, which is generated and shared by half the catalogue.
 *
 * Three things stop a bad offer. A name the task happens to contain is not
 * enough — the situation text has to match. An imported skill that duplicates
 * one of ours by name is never offered, so `import_skill_repo` cannot shadow a
 * custom skill. And a skill that names an ecosystem is penalised when neither
 * the task nor the project mentions it, and refused outright when the project
 * has a stack and this is not it: `python-testing` is not the answer to a
 * TypeScript repository's testing question.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {object[]} input.items - The skill registry.
 * @param {object} input.context - Project context.
 * @param {string[]} [input.exclude] - Names already routed.
 * @param {string} [input.membranePolicy]
 * @param {boolean} [input.includeMembrane]
 * @returns {{ item: object, score: number, concepts: string[], stack: string, matched_terms: string[] } | null}
 */
export function pickTaskSpecialist({ task, items, context, exclude = [], membranePolicy = "auto", includeMembrane = false }) {
  const projectStack = context?.stack ?? [];
  const { concepts, terms, own_terms: ownTerms } = expandTaskVocabulary(task, projectStack);
  if (!concepts.length) return null;
  const visualTask = taskLooksVisual(task);
  const frontendProject = projectStackLooksFrontend(context ?? {});
  const taken = new Set(exclude.map((name) => String(name ?? "")));
  const ours = new Set((items ?? []).filter((item) => item?.source === "custom").map((item) => String(item?.name ?? "")));
  let best = null;
  for (const item of items ?? []) {
    if (!item || item.source === "custom") continue;
    if (taken.has(String(item.name ?? "")) || ours.has(String(item.name ?? ""))) continue;
    if (item.maturity === "deprecated" || item.routing_priority === "disabled") continue;
    if (isMembraneSkill(item) && !membraneAllowed({ task, context, membranePolicy, includeMembrane })) continue;
    if (isVisualHeavySkill(item) && !visualTask) continue;
    if (isDesignFirstSkill(item) && !visualTask && !frontendProject) continue;
    const match = specialistMatchScore(item, terms);
    if (match.use_when_hits < SPECIALIST_MIN_SITUATION_HITS) continue;
    const stack = stackAlignment(item, ownTerms);
    if (stack === "foreign" && projectStack.length) continue;
    const narrow = declaredStackTerms(item).length <= 2;
    const penalty = stack === "foreign"
      ? SPECIALIST_FOREIGN_STACK_PENALTY + (narrow ? SPECIALIST_NARROW_STACK_PENALTY : 0)
      : 0;
    const score = match.score + skillQualityRankAdjustment(item) - penalty;
    if (score < SPECIALIST_MIN_SCORE) continue;
    const candidate = { item, score, concepts, stack, matched_terms: match.matched_terms };
    if (!best || candidate.score > best.score || (candidate.score === best.score && item.name.localeCompare(best.item.name) < 0)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Recommend skills for one task over an already-loaded registry.
 *
 * @param {object} input
 * @param {string} input.task - The task description to route.
 * @param {number} [input.limit] - Requested size, capped at three.
 * @param {object[]} input.items - The skill registry.
 * @param {object[]} [input.cards] - Skill card records, for `card_path`.
 * @param {object} input.context - Project context (see the extension).
 * @param {string} [input.membranePolicy] - auto | include | exclude.
 * @param {boolean} [input.includeMembrane]
 * @param {string[]|string} [input.preferredGroups]
 * @returns {object[]} Ranked recommendations.
 */
export function recommendSkillsFromRegistry({
  task,
  limit = 8,
  items,
  cards = [],
  context,
  membranePolicy = "auto",
  includeMembrane = false,
  preferredGroups = []
}) {
  const skillCardsByKey = new Map(cards.map((card) => [skillKey(card), card]));
  const inferredGroups = inferTaskSkillGroups(task, context.context_text);
  const requestedGroups = toStringList(preferredGroups)
    .map(canonicalSkillGroup)
    .filter(Boolean);
  const routedGroups = [...new Set([...requestedGroups, ...inferredGroups])];
  const routedGroupSet = new Set(routedGroups);
  const deterministicRoute = routeSkills({
    task,
    projectTypes: context.project_types ?? [],
    stack: context.stack ?? [],
    maxSkills: 3
  });
  const recommendations = new Map();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 3, 3));
  const visualTask = taskLooksVisual(task);
  const backendTask = taskLooksBackend(task);
  const qualityTask = taskLooksQuality(task);
  const betaFrontendTask = taskLooksBetaFrontend(task);
  const frontendGateTask = taskLooksFrontendGate(task);
  const landingConversionTask = taskLooksLandingConversion(task);
  const frontendProductTask = taskLooksFrontendProduct(task);
  const frontendProject = projectStackLooksFrontend(context);
  const backendProject = projectLooksBackend(context);

  const upsert = ({ name, source = "", reason, rank = 50, evidence = [], item }) => {
    const skill = item ?? findSkillItem(items, name, source);
    const candidate = skill ?? { name, source, categories: [], description: "", use_when: "" };
    const skipReason = skill ? shouldSkipRecommendedSkill(candidate, {
      task,
      context,
      membranePolicy,
      includeMembrane
    }) : "";
    if (skipReason) return;
    if (candidate.maturity === "deprecated") return;

    const key = skillKey(candidate);
    const entry = {
      name: candidate.name,
      source: candidate.source,
      type: candidate.type,
      categories: candidate.categories,
      primary_group: candidate.primary_group,
      primary_group_label: candidate.primary_group_label,
      subgroups: candidate.subgroups || [],
      task_types: candidate.task_types || [],
      platforms: candidate.platforms || [],
      related_skills: candidate.related_skills || [],
      frameworks: candidate.frameworks || [],
      languages: candidate.languages || [],
      conflicts: candidate.conflicts || [],
      maturity: candidate.maturity,
      trust_level: candidate.trust_level,
      instruction_policy: candidate.instruction_policy,
      quality_score: candidate.quality_score,
      quality_grade: candidate.quality_grade,
      quality_status: candidate.quality_status,
      routed_groups: routedGroups,
      reason,
      use_when: candidate.use_when || candidate.description || "",
      path: candidate.path,
      card_path: skillCardsByKey.get(key)?.card_path,
      score: rank + skillQualityRankAdjustment(candidate),
      project: context.available ? context.name : undefined,
      evidence
    };
    const existing = recommendations.get(key);
    if (!existing || existing.score < entry.score) {
      recommendations.set(key, entry);
    }
  };

  const addNamed = (name, source, reason, rank, evidence = []) => upsert({ name, source, reason, rank, evidence });

  deterministicRoute.skills.forEach((item, index) => {
    addNamed(
      item.name,
      item.source,
      item.reason,
      220 - index,
      [`routing:${item.role}`, `rule:${item.rule}`]
    );
  });

  if (frontendProductTask) {
    addNamed(
      "frontend-product-builder",
      "custom",
      "frontend product work must pass the design-first state machine",
      190,
      ["design-first", "visual approval", "independent review"]
    );
  }

  if (INTENT.repository.test(task)) {
    addNamed("repo-onboarding", "custom", "task asks to understand or prepare repository context", 145);
  }
  if (/(new feature|implement|add|build|feature|созда|добав|реализ|фич)/i.test(task)) {
    addNamed("feature-builder", "custom", "task changes product or developer behavior", 140);
  }
  if (/(bug|error|fail|fix|debug|regression|flaky|слом|ошиб|почин|баг|\bci\b)/i.test(task)) {
    addNamed("bugfix-investigator", "custom", "task requires root-cause investigation", 150);
  }
  if (/(review|\bpr\b|diff|pull request|patch|audit|проверь|ревью)/i.test(task)) {
    addNamed("code-reviewer", "custom", "task asks for review or risk assessment", 145);
  }
  if (betaFrontendTask || (frontendProject && /(support|maintain|small fix|bug|responsive|layout|component|screen|поддерж|поправ|почин|баг|адаптив|экран|компонент)/i.test(task))) {
    addNamed("beta-frontend-maintainer", "custom", "existing frontend task should use minimal safe diffs and browser-aware verification", 146);
  }
  if (frontendGateTask || (qualityTask && (visualTask || frontendProject))) {
    addNamed("frontend-quality-gate", "custom", "frontend changes need responsive, accessibility, browser, and handoff verification", 148);
  }
  if (landingConversionTask) {
    addNamed("landing-conversion-reviewer", "custom", "landing or marketing page should be checked for clarity, trust, CTA, and conversion flow", 150);
  }
  if (visualTask || frontendProject) {
    addNamed("frontend-polisher", "custom", frontendProject ? "project or task is frontend/UI oriented" : "task touches frontend quality or design", 128);
  }
  if (DIAGRAM_REQUEST_PATTERN.test(task)) {
    addNamed("archify", "external/archify", "task asks for a validated technical diagram or Mermaid conversion", 170, ["diagram intent"]);
  }
  if (/(website|landing|portfolio|marketing site|premium site|premium|сайт|лендинг|портфолио)/i.test(task)) {
    addNamed("design-taste-frontend", "design/taste-skill", "task asks for a visually important website or landing page", 132);
  }
  if (/(image.?to.?code|reference image|generate.*image|visual reference|mockup|референс|мокап)/i.test(task)) {
    addNamed("image-to-code", "design/taste-skill", "task benefits from image-first design analysis before coding", 132);
  }
  if (/(redesign|upgrade.*ui|улучш.*дизайн|редизайн)/i.test(task)) {
    addNamed("redesign-existing-projects", "design/taste-skill", "task is an existing UI redesign", 132);
  }
  if (/(brand|logo|identity|brand kit|бренд|логотип|айдентик)/i.test(task)) {
    addNamed("brandkit", "design/taste-skill", "task asks for brand identity or brand-kit generation", 132);
  }
  if (/(knowledge|obsidian|notes|vault|memory|handoff|brief|project-map|база знаний|заметк|памят|контекст)/i.test(task)) {
    addNamed("knowledge-curator", "custom", "task updates durable knowledge", 135);
  }
  if (qualityTask) {
    addNamed("code-reviewer", "custom", "quality-gate or verification work benefits from risk review", 134, ["quality gate"]);
  }
  if ((backendTask || backendProject) && !visualTask) {
    addNamed("backend-api-engineer", "custom", "backend or API work needs contract, data, failure, and operability checks", 146, context.stack);
    addNamed("feature-builder", "custom", "backend/project implementation should follow repository architecture and tests", 118, context.stack);
  }
  if (/(api contract|openapi|graphql|protobuf|webhook|endpoint|response schema|request schema|backward compatib|контракт.*api|эндпоинт|вебхук)/i.test(task)) {
    addNamed("api-contract-reviewer", "custom", "task changes or reviews a consumer-facing API contract", 152);
  }
  if (/(database migration|schema migration|alembic|migration|backfill|schema change|миграц|схем.*баз|бэкфил)/i.test(task)) {
    addNamed("database-migration-guardian", "custom", "schema or data evolution needs compatibility, lock, rollback, and recovery checks", 158);
  }
  if (/(ci\/cd|deployment|deploy|release|rollback|github actions|gitlab ci|pipeline|деплой|релиз|откат)/i.test(task)) {
    addNamed("devops-release-engineer", "custom", "task changes build, release, deployment, or rollback behavior", 152);
  }
  if (INTENT.container.test(task)) {
    addNamed("container-deployment-reviewer", "custom", "container build or runtime behavior needs reproducibility and safety review", 154);
  }
  if (/(application security|security review|threat model|authorization|authentication|permission|vulnerab|csrf|xss|ssrf|безопасн|авториз|уязвим)/i.test(task)) {
    addNamed("application-security-reviewer", "custom", "task touches an application security boundary or requests threat review", 156);
  }
  if (/(secret|credential|dependency audit|supply chain|lockfile|npm audit|pip-audit|snyk|sbom|секрет|зависимост|утечк.*ключ)/i.test(task)) {
    addNamed("secrets-dependencies-auditor", "custom", "task concerns credential exposure or dependency supply-chain risk", 156);
  }
  if (/(data pipeline|etl|elt|ingestion|streaming|backfill|lineage|data quality|пайплайн.*дан|импорт.*дан|качеств.*дан)/i.test(task)) {
    addNamed("data-pipeline-engineer", "custom", "task changes a data contract, pipeline, lineage, or recovery flow", 154);
  }
  if (/(llm|rag|embedding|vector search|prompt|tool calling|structured output|model provider|openai|anthropic|нейросет|эмбеддинг|промпт)/i.test(task)) {
    addNamed("llm-integration-engineer", "custom", "task integrates probabilistic model behavior and needs evaluation, safety, cost, and fallback controls", 156);
  }

  for (const recommended of context.recommended_skills ?? []) {
    const cleaned = recommended.replaceAll("`", "").split(/\s+-\s+|:/)[0].trim();
    if (!cleaned) continue;
    const rank = projectRecommendedSkillRank(cleaned, task, context);
    if (rank > 0) {
      addNamed(cleaned, "", "project card recommends this skill for this task/project", rank, ["project card"]);
    }
  }

  const rankingQuery = [
    task,
    context.stack?.length ? `Stack: ${context.stack.join(" ")}` : ""
  ].filter(Boolean).join("\n").slice(0, 4000);

  const groupFirstCandidates = routedGroups.length
    ? items.filter((item) => item.source === "custom" || routedGroupSet.has(item.primary_group) || String(task).toLowerCase().includes(String(item.name || "").toLowerCase()))
    : items;

  const automaticMatches = groupFirstCandidates
    .map((item) => {
      const scoringQuery = isMembraneSkill(item) ? task : rankingQuery;
      const membrane = isMembraneSkill(item);
      let score = scoreText(scoringQuery, [
        item.name,
        membrane ? "" : item.source,
        membrane ? "" : item.type,
        (item.subgroups ?? []).join(" "),
        (item.task_types ?? []).join(" "),
        (item.platforms ?? []).join(" "),
        (item.frameworks ?? []).join(" "),
        (item.languages ?? []).join(" "),
        membrane ? "" : (item.categories ?? []).join(" "),
        item.description ?? "",
        item.use_when ?? "",
        membrane ? "" : (item.requires ?? []).join(" ")
      ]);
      const exactName = String(item.name || "").length > 1 && String(task).toLowerCase().includes(String(item.name).toLowerCase());
      if (exactName) score += 24;
      if (item.source === "custom") score += 4;
      if (score > 0 && routedGroupSet.has(item.primary_group)) score += 6;
      score += skillQualityRankAdjustment(item);
      if (membrane && !exactName && score < 12) score = 0;
      if (item.source === "custom" && score < 10) score = 0;
      // A nudge, not a veto, so the looser `categories` signal is the right one here.
      if (isDesignSkill(item) && (visualTask || frontendProject)) score += 3;
      if (isMembraneSkill(item) && !membraneAllowed({ task, context, membranePolicy, includeMembrane })) score = 0;
      if (isVisualHeavySkill(item) && !visualTask) score = Math.max(0, score - 5);
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, Math.max(safeLimit * 6, 40));

  for (const { item, score } of automaticMatches) {
    upsert({
      item,
      reason: item.use_when || item.description || "registry match with project context",
      rank: 60 + score,
      evidence: context.available ? ["task", "project context"] : ["task"]
    });
  }

  // The reserved specialist slot (Д-1). It is picked from what is left after
  // the routed core, scored on `use_when` through the bilingual expansion, and
  // appended by `prioritizeRoutedRecommendations` outside the three-skill cap.
  const routedNames = deterministicRoute.skills.map((item) => item.name);
  const specialist = pickTaskSpecialist({ task, items, context, exclude: routedNames, membranePolicy, includeMembrane });
  if (specialist) {
    addNamed(
      specialist.item.name,
      specialist.item.source,
      specialist.item.use_when || specialist.item.description || "imported specialist matched by use_when",
      110,
      [`use_when match: ${specialist.concepts.join(", ")}`]
    );
  }

  const rankedRecommendations = [...recommendations.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((item) => {
      const cleaned = { ...item };
      if (!cleaned.project) delete cleaned.project;
      if (!cleaned.evidence?.length) delete cleaned.evidence;
      return cleaned;
    });
  const route = specialist
    ? {
      ...deterministicRoute,
      skills: [...deterministicRoute.skills, {
        name: specialist.item.name,
        source: specialist.item.source,
        role: "specialist",
        reason: specialist.item.use_when || specialist.item.description || "imported specialist matched by use_when",
        rule: `use-when:${specialist.concepts.join("/")}`
      }]
    }
    : deterministicRoute;
  return prioritizeRoutedRecommendations(rankedRecommendations, route, safeLimit);
}
