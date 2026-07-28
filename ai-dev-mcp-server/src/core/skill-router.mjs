function normalized(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

const FRONTEND_PRODUCT_PATTERN = /(frontend product|product interface|design[- ]first|anti[- ]?slop|visual direction|design system|landing page|(?:build|create|implement|design|redesign|improve|upgrade).{0,48}(?:front.?end|ui\b|ux\b|interface|landing|website|page)|\u0438\u0438[- ]?\u0441\u043b\u043e\u043f|\u0441\u0434\u0435\u043b\u0430\u0439.{0,48}(?:\u0434\u0438\u0437\u0430\u0439\u043d|\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441|\u0441\u0430\u0439\u0442|\u043b\u0435\u043d\u0434\u0438\u043d\u0433)|(?:\u0441\u043e\u0437\u0434\u0430\u0439|\u0441\u043e\u0437\u0434\u0430\u0442\u044c|\u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u0430\u0439|\u0441\u0432\u0435\u0440\u0441\u0442\u0430\u0439).{0,48}(?:\u0434\u0438\u0437\u0430\u0439\u043d|\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441|\u0444\u0440\u043e\u043d\u0442\u0435\u043d\u0434|\u0441\u0430\u0439\u0442|\u043b\u0435\u043d\u0434\u0438\u043d\u0433)|\u0443\u043b\u0443\u0447\u0448\u0438.{0,48}(?:\u0434\u0438\u0437\u0430\u0439\u043d|\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441|\u0444\u0440\u043e\u043d\u0442\u0435\u043d\u0434)|\u0440\u0435\u0434\u0438\u0437\u0430\u0439\u043d)/i;
const FRONTEND_REFERENCE_PATTERN = /(reference factory|generate.{0,32}(?:frontend|visual|design|interface|website).{0,24}reference|create.{0,32}(?:visual|interface).{0,24}reference|no reference|without reference|\u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u0443\u0439.{0,48}\u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441|\u0441\u043e\u0437\u0434\u0430\u0439.{0,48}\u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441|\u0441\u0434\u0435\u043b\u0430\u0439.{0,48}\u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441|\u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441[^\n]{0,24}\u043d\u0435\u0442)/i;

export function taskRequiresFrontendProductWorkflow(value) {
  const valueNormalized = normalized(value);
  return FRONTEND_PRODUCT_PATTERN.test(valueNormalized) ||
    FRONTEND_REFERENCE_PATTERN.test(valueNormalized);
}

export function taskRequiresGeneratedFrontendReferences(value) {
  return FRONTEND_REFERENCE_PATTERN.test(normalized(value));
}

const RULES = [
  {
    id: "task-lifecycle",
    pattern: /(begin_task|checkpoint_task|verify_task|complete_task|task lifecycle|acceptance criteria|verification evidence|инженерн[а-я]*\s+задач|критери[а-я]*\s+приемк|чекпоинт|завершен[а-я]*\s+задач)/i,
    workflow: "ai-dev-orchestrator",
    verification: "code-reviewer"
  },
  {
    id: "knowledge",
    pattern: /(obsidian|knowledge|баз[а-я]*\s+знан|заметк|памят[а-я]*\s+проект|project[- ]?(brief|map)|handoff)/i,
    workflow: "knowledge-curator"
  },
  {
    id: "repository",
    pattern: /(agents\.md|repo(?:sitory)?|bootstrap|onboard|оформ[а-я]*\s+проект|подготов[а-я]*\s+(проект|репозитор)|репозитор|проект[а-я]*\s+для\s+ии)/i,
    workflow: "repo-onboarding",
    verification: "code-reviewer"
  },
  {
    id: "database-migration",
    pattern: /(database|баз[а-я]*\s+данн|миграц|schema|схем[а-я]*\s+(баз|данн)|alembic|prisma|backfill|индекс[а-я]*\s+таблиц)/i,
    domain: "database-migration-guardian"
  },
  {
    id: "secrets-dependencies",
    pattern: /(secret|credential|token|api key|dependency|dependencies|supply chain|npm audit|pip audit|snyk|секрет|учетн[а-я]*\s+данн|токен|ключ[а-я]*\s+api|зависимост)/i,
    domain: "secrets-dependencies-auditor"
  },
  {
    id: "security",
    pattern: /(security|безопасност|уязвим|auth(?:entication|orization)?|авторизац|аутентификац|permission|csrf|xss|ssrf|threat)/i,
    domain: "application-security-reviewer",
    verification: "secrets-dependencies-auditor"
  },
  {
    id: "llm",
    pattern: /(\bllm\b|\brag\b|embedding|vector search|prompt|tool calling|openai|anthropic|нейросет|эмбеддинг|векторн[а-я]*\s+поиск|промпт)/i,
    domain: "llm-integration-engineer"
  },
  {
    id: "data",
    pattern: /(data pipeline|\betl\b|\belt\b|ingestion|lineage|streaming|пайплайн[а-я]*\s+данн|импорт[а-я]*\s+данн|качество\s+данн)/i,
    domain: "data-pipeline-engineer"
  },
  {
    id: "container",
    pattern: /(docker|compose|container|kubernetes|\bk8s\b|helm|контейнер|кубер)/i,
    domain: "container-deployment-reviewer",
    verification: "devops-release-engineer"
  },
  {
    id: "frontend-product",
    pattern: FRONTEND_PRODUCT_PATTERN,
    workflow: "frontend-product-builder",
    verification: "frontend-quality-gate"
  },
  {
    id: "landing",
    pattern: /(landing|лендинг|conversion|конверси|marketing page|cta|hero section)/i,
    domain: "landing-conversion-reviewer",
    verification: "frontend-quality-gate"
  },
  {
    id: "frontend-polish",
    pattern: /(polish|refine|redesign|visual quality|pixel perfect|premium ui|улучш[а-я]*\s+(дизайн|интерфейс|ui)|редизайн|довед[а-я]*\s+(дизайн|интерфейс)|визуальн[а-я]*\s+качество)/i,
    domain: "frontend-polisher",
    verification: "frontend-quality-gate"
  },
  {
    id: "frontend",
    pattern: /(front.?end|фронтенд|интерфейс|ui\b|ux\b|верст|компонент|экран|форма|адаптив|responsive|layout|react|next\.?js|vue|svelte|css|accessibility|a11y|wcag|доступност|клавиатур[а-я]*\s+навигац|скринридер)/i,
    domain: "beta-frontend-maintainer",
    verification: "frontend-quality-gate"
  },
  {
    id: "api",
    pattern: /(\bapi\b|endpoint|webhook|openapi|graphql|rest\b|эндпоинт|вебхук|контракт[а-я]*\s+апи|бекенд|backend)/i,
    domain: "backend-api-engineer",
    verification: "api-contract-reviewer"
  },
  {
    id: "devops",
    pattern: /(deploy|deployment|release|rollback|ci\/cd|github actions|gitlab ci|депло|релиз|откат|сборочн[а-я]*\s+пайплайн)/i,
    domain: "devops-release-engineer"
  }
];

const RULE_PRIORITY = Object.freeze({
  "task-lifecycle": 100,
  repository: 90,
  "frontend-product": 85,
  knowledge: 10
});

function workflowFor(text) {
  if (/(\bfix\b|bug|debug|error|failure|regression|баг|ошиб|слом|почин|исправ)/i.test(text)) {
    return { name: "bugfix-investigator", role: "workflow", reason: "root-cause and regression workflow" };
  }
  if (/(review|audit|\bpr\b|diff|ревью|аудит|проверь|проанализир)/i.test(text)) {
    return { name: "code-reviewer", role: "workflow", reason: "review and risk-first workflow" };
  }
  if (/(knowledge|obsidian|баз[а-я]*\s+знан|заметк|памят)/i.test(text)) {
    return { name: "knowledge-curator", role: "workflow", reason: "durable knowledge workflow" };
  }
  if (/(repo|bootstrap|onboard|оформ[а-я]*\s+проект|подготов[а-я]*\s+проект|репозитор)/i.test(text)) {
    return { name: "repo-onboarding", role: "workflow", reason: "repository onboarding workflow" };
  }
  return { name: "feature-builder", role: "workflow", reason: "scoped implementation workflow" };
}

export function routeSkills({ task, projectTypes = [], stack = [], maxSkills = 3 }) {
  const text = normalized([task, ...projectTypes, ...stack].join(" "));
  const selected = [];
  const add = (name, role, reason, rule, source = "custom") => {
    if (!name || selected.some((item) => item.name === name)) return;
    selected.push({ name, source, role, reason, rule });
  };

  if (FRONTEND_REFERENCE_PATTERN.test(text)) {
    add(
      "frontend-product-builder",
      "workflow",
      "Reference Factory design-first workflow",
      "frontend-reference-factory"
    );
    add(
      /(mobile|ios|android|\u043c\u043e\u0431\u0438\u043b)/i.test(text)
        ? "imagegen-frontend-mobile"
        : "imagegen-frontend-web",
      "domain",
      "surface-specific visual reference generation",
      "frontend-reference-factory",
      "design/taste-skill"
    );
    add(
      "frontend-quality-gate",
      "verification",
      "independent reference and implementation verification",
      "frontend-reference-factory"
    );
    return {
      normalized_intent: text,
      matched_rules: ["frontend-reference-factory"],
      skills: selected.slice(0, Math.max(1, Math.min(Number(maxSkills) || 3, 3)))
    };
  }

  const workflow = workflowFor(text);
  add(workflow.name, workflow.role, workflow.reason, "workflow");

  const matched = RULES
    .filter((rule) => rule.pattern.test(text))
    .sort((left, right) => (RULE_PRIORITY[right.id] || 50) - (RULE_PRIORITY[left.id] || 50));
  const primary = matched[0];
  if (primary?.workflow) {
    selected.splice(0, selected.length);
    add(primary.workflow, "workflow", `${primary.id} workflow`, primary.id);
  }
  if (primary?.domain) add(primary.domain, "domain", `${primary.id} domain`, primary.id);
  if (primary?.verification) add(primary.verification, "verification", `${primary.id} verification`, primary.id);

  for (const rule of matched.slice(1)) {
    if (selected.length >= maxSkills) break;
    add(rule.domain, "domain", `${rule.id} domain`, rule.id);
    if (selected.length >= maxSkills) break;
    add(rule.verification, "verification", `${rule.id} verification`, rule.id);
  }

  if (selected.length === 1 && /frontend/.test(projectTypes.join(" "))) {
    add("beta-frontend-maintainer", "domain", "frontend project context", "project");
    add("frontend-quality-gate", "verification", "frontend verification", "project");
  } else if (selected.length === 1 && /(backend|api)/.test(projectTypes.join(" "))) {
    add("backend-api-engineer", "domain", "backend project context", "project");
    add("api-contract-reviewer", "verification", "API contract verification", "project");
  } else if (selected.length === 1 && selected[0].name !== "knowledge-curator") {
    add("code-reviewer", "verification", "general change-risk verification", "fallback");
  }

  return {
    normalized_intent: text,
    matched_rules: matched.map((item) => item.id),
    skills: selected.slice(0, Math.max(1, Math.min(Number(maxSkills) || 3, 3)))
  };
}

export function prioritizeRoutedRecommendations(recommendations, route, maxSkills = 3) {
  const byName = new Map(recommendations.map((item) => [item.name, item]));
  const output = [];
  for (const routed of route.skills) {
    const existing = byName.get(routed.name);
    output.push(existing
      ? { ...existing, routing_role: routed.role, routing_rule: routed.rule, reason: routed.reason }
      : { ...routed, type: "custom-skill", score: 200 });
  }
  return output.slice(0, Math.max(1, Math.min(Number(maxSkills) || 3, 3)));
}
