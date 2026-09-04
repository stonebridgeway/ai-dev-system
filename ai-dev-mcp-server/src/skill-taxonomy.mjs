export const SKILL_TAXONOMY_SCHEMA_VERSION = 1;

export const SKILL_GROUPS = [
  {
    id: "frontend-ui",
    label: "Frontend & UI",
    description: "Web interfaces, component systems, accessibility, responsive behavior, and browser-facing product work.",
    related_groups: ["design-content", "testing-quality", "backend-api"]
  },
  {
    id: "backend-api",
    label: "Backend & API",
    description: "Server applications, APIs, databases, queues, workers, bots, and backend architecture.",
    related_groups: ["data-ai", "devops-infrastructure", "testing-quality", "security"]
  },
  {
    id: "mobile",
    label: "Mobile",
    description: "iOS, Android, React Native, Flutter, and mobile product interfaces.",
    related_groups: ["frontend-ui", "design-content", "testing-quality"]
  },
  {
    id: "data-ai",
    label: "Data & AI",
    description: "Machine learning, LLMs, embeddings, analytics, data pipelines, and data engineering.",
    related_groups: ["backend-api", "integrations-automation", "testing-quality"]
  },
  {
    id: "integrations-automation",
    label: "Integrations & Automation",
    description: "External applications, connectors, SaaS APIs, webhooks, and workflow automation.",
    related_groups: ["backend-api", "data-ai", "security", "knowledge-productivity"]
  },
  {
    id: "devops-infrastructure",
    label: "DevOps & Infrastructure",
    description: "CI/CD, cloud, containers, deployment, observability, and infrastructure operations.",
    related_groups: ["backend-api", "testing-quality", "security"]
  },
  {
    id: "testing-quality",
    label: "Testing & Quality",
    description: "Debugging, reviews, automated tests, QA, performance, reliability, and release gates.",
    related_groups: ["frontend-ui", "backend-api", "repository-workflows"]
  },
  {
    id: "security",
    label: "Security",
    description: "Authentication, identity, secrets, permissions, vulnerability review, and compliance.",
    related_groups: ["backend-api", "devops-infrastructure", "integrations-automation"]
  },
  {
    id: "design-content",
    label: "Design & Content",
    description: "Visual direction, brand systems, image generation, UX composition, and content presentation.",
    related_groups: ["frontend-ui", "mobile", "knowledge-productivity"]
  },
  {
    id: "repository-workflows",
    label: "Repository Workflows",
    description: "Repository onboarding, feature delivery, agent rules, codebase navigation, and development process.",
    related_groups: ["testing-quality", "knowledge-productivity", "devops-infrastructure"]
  },
  {
    id: "knowledge-productivity",
    label: "Knowledge & Productivity",
    description: "Knowledge bases, documentation, files, notes, handoffs, and personal or team productivity.",
    related_groups: ["repository-workflows", "integrations-automation", "design-content"]
  },
  {
    id: "unclassified",
    label: "Unclassified",
    description: "Skills that need manual taxonomy review or do not yet fit a stable domain.",
    related_groups: []
  }
];

export const INTEGRATION_SUBGROUPS = [
  { id: "communication-collaboration", label: "Communication & Collaboration", pattern: /(slack|discord|teams|telegram|whatsapp|twilio|zoom|meet|gmail|outlook|mail|email|sms|intercom|zendesk|freshdesk|helpscout|frontapp|ringcentral)/i },
  { id: "project-work-management", label: "Project & Work Management", pattern: /(linear|jira|asana|trello|clickup|monday|basecamp|wrike|smartsheet|teamwork|todoist|height|shortcut|clubhouse)/i },
  { id: "developer-tools", label: "Developer Tools", pattern: /(github|gitlab|bitbucket|sentry|datadog|appdynamics|newrelic|new-relic|vercel|netlify|circleci|jenkins|pagerduty|sonar|render|railway|heroku|cloudflare)/i },
  { id: "data-analytics", label: "Data & Analytics", pattern: /(snowflake|bigquery|airtable|tableau|looker|mixpanel|amplitude|segment|powerbi|power-bi|databricks|google-sheets|sheets|analytics|metabase|grafana|postgres|mysql|mongodb)/i },
  { id: "crm-sales", label: "CRM & Sales", pattern: /(hubspot|salesforce|pipedrive|closecrm|close|zoho-crm|dynamics-365|microsoft-dynamics|dynamicscrm|apollo|outreach|salesloft|freshsales|copper|insightly|1crm|sugarcrm)/i },
  { id: "marketing-content", label: "Marketing & Content", pattern: /(mailchimp|klaviyo|activecampaign|sendgrid|convertkit|buffer|hootsuite|wordpress|webflow|youtube|instagram|facebook|linkedin|tiktok|pinterest|contentful|sanity|ghost)/i },
  { id: "commerce-payments", label: "Commerce & Payments", pattern: /(stripe|paypal|shopify|woocommerce|square|adyen|chargebee|paddle|klarna|checkout|bigcommerce|magento|gumroad|lemonsqueezy|razorpay)/i },
  { id: "finance-accounting", label: "Finance & Accounting", pattern: /(quickbooks|xero|netsuite|sage|freshbooks|waveapps|plaid|wise|revolut|brex|ramp|expensify|bill-com|coinbase|binance)/i },
  { id: "documents-storage", label: "Documents & Storage", pattern: /(google-drive|dropbox|box|onedrive|sharepoint|docusign|adobe|google-docs|docs|pdf|egnyte|pcloud|signnow|pandadoc)/i },
  { id: "security-identity", label: "Security & Identity", pattern: /(1password|okta|auth0|onelogin|duo|lastpass|bitwarden|jumpcloud|cloudpassage|snyk|crowdstrike|virustotal|identity|blockid)/i },
  { id: "hr-people", label: "HR & People", pattern: /(workday|bamboohr|greenhouse|lever|gusto|personio|15five|deel|rippling|factorial|hibob|recruitee|teamtailor)/i },
  { id: "forms-scheduling", label: "Forms & Scheduling", pattern: /(calendly|typeform|jotform|google-forms|formbuilder|eventbrite|acuity|doodle|10to8|forms|scheduler|booking)/i },
  { id: "ai-automation", label: "AI & Automation", pattern: /(openai|anthropic|huggingface|hugging-face|replicate|zapier|make-com|n8n|automation|pinecone|weaviate|cohere|mistral|gemini)/i },
  { id: "support-service", label: "Support & Service", pattern: /(zendesk|freshdesk|helpscout|service-now|servicenow|gorgias|customerio|customer-io|support|ticketing)/i },
  { id: "general-integration", label: "General Integrations", pattern: /.*/ }
];

const EXPLICIT_GROUPS = new Map([
  ["frontend-product-builder", "frontend-ui"],
  ["beta-frontend-maintainer", "frontend-ui"],
  ["frontend-polisher", "frontend-ui"],
  ["landing-conversion-reviewer", "frontend-ui"],
  ["frontend-quality-gate", "testing-quality"],
  ["bugfix-investigator", "testing-quality"],
  ["code-reviewer", "testing-quality"],
  ["feature-builder", "repository-workflows"],
  ["repo-onboarding", "repository-workflows"],
  ["knowledge-curator", "knowledge-productivity"],
  ["backend-api-engineer", "backend-api"],
  ["api-contract-reviewer", "backend-api"],
  ["database-migration-guardian", "backend-api"],
  ["devops-release-engineer", "devops-infrastructure"],
  ["container-deployment-reviewer", "devops-infrastructure"],
  ["application-security-reviewer", "security"],
  ["secrets-dependencies-auditor", "security"],
  ["data-pipeline-engineer", "data-ai"],
  ["llm-integration-engineer", "data-ai"],
  ["full-output-enforcement", "testing-quality"],
  ["archify", "knowledge-productivity"],
  ["brandkit", "design-content"],
  ["imagegen-frontend-web", "design-content"],
  ["imagegen-frontend-mobile", "design-content"],
  ["image-to-code", "frontend-ui"],
  ["ui-ux-pro-max", "frontend-ui"]
]);

const RELATED_SKILLS = new Map([
  ["frontend-product-builder", ["frontend-quality-gate", "ui-ux-pro-max", "landing-conversion-reviewer", "beta-frontend-maintainer", "redesign-existing-projects"]],
  ["beta-frontend-maintainer", ["frontend-quality-gate", "frontend-polisher", "code-reviewer"]],
  ["frontend-polisher", ["frontend-quality-gate", "ui-ux-pro-max", "design-taste-frontend", "redesign-existing-projects"]],
  ["frontend-quality-gate", ["beta-frontend-maintainer", "frontend-polisher", "code-reviewer"]],
  ["landing-conversion-reviewer", ["ui-ux-pro-max", "design-taste-frontend", "frontend-quality-gate", "frontend-polisher"]],
  ["feature-builder", ["repo-onboarding", "code-reviewer", "bugfix-investigator"]],
  ["bugfix-investigator", ["code-reviewer", "feature-builder", "frontend-quality-gate"]],
  ["code-reviewer", ["bugfix-investigator", "frontend-quality-gate", "feature-builder"]],
  ["repo-onboarding", ["feature-builder", "knowledge-curator", "code-reviewer"]],
  ["knowledge-curator", ["repo-onboarding", "feature-builder"]],
  ["backend-api-engineer", ["api-contract-reviewer", "database-migration-guardian", "code-reviewer"]],
  ["api-contract-reviewer", ["backend-api-engineer", "application-security-reviewer", "code-reviewer"]],
  ["database-migration-guardian", ["backend-api-engineer", "devops-release-engineer", "application-security-reviewer"]],
  ["devops-release-engineer", ["container-deployment-reviewer", "secrets-dependencies-auditor", "code-reviewer"]],
  ["container-deployment-reviewer", ["devops-release-engineer", "application-security-reviewer", "secrets-dependencies-auditor"]],
  ["application-security-reviewer", ["secrets-dependencies-auditor", "api-contract-reviewer", "code-reviewer"]],
  ["secrets-dependencies-auditor", ["application-security-reviewer", "devops-release-engineer", "container-deployment-reviewer"]],
  ["data-pipeline-engineer", ["backend-api-engineer", "database-migration-guardian", "code-reviewer"]],
  ["llm-integration-engineer", ["data-pipeline-engineer", "backend-api-engineer", "application-security-reviewer"]],
  ["design-taste-frontend", ["frontend-polisher", "image-to-code", "frontend-quality-gate"]],
  ["image-to-code", ["design-taste-frontend", "imagegen-frontend-web", "frontend-polisher"]],
  ["redesign-existing-projects", ["frontend-polisher", "frontend-quality-gate", "design-taste-frontend"]],
  ["ui-ux-pro-max", ["frontend-polisher", "frontend-quality-gate", "landing-conversion-reviewer"]],
  ["github", ["slack", "linear", "sentry"]],
  ["slack", ["github", "linear", "jira"]],
  ["linear", ["github", "slack", "sentry"]],
  ["jira", ["github", "slack", "confluence"]],
  ["figma", ["frontend-polisher", "design-taste-frontend", "frontend-quality-gate"]]
]);

const GENERATED_CATEGORY_IDS = new Set([
  ...SKILL_GROUPS.map((group) => group.id),
  ...INTEGRATION_SUBGROUPS.map((group) => group.id),
  "accessibility",
  "landing-conversion",
  "interface-engineering",
  "frontend-qa",
  "code-review",
  "debugging",
  "visual-generation",
  "api-contracts",
  "backend-architecture",
  "database-migrations",
  "ci-cd-release",
  "containers-deployment",
  "application-security",
  "secrets-dependencies",
  "data-pipelines",
  "llm-integrations"
]);

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function textFor(item) {
  const sourceCategories = (item.categories || []).filter((category) => !GENERATED_CATEGORY_IDS.has(String(category)));
  return [item.name, item.type, item.description, item.use_when, ...sourceCategories].filter(Boolean).join(" ");
}

function inferNonIntegrationGroup(item) {
  const explicit = EXPLICIT_GROUPS.get(String(item.name || "").toLowerCase());
  if (explicit) return { id: explicit, confidence: 1, reason: "explicit skill rule" };

  const text = textFor(item);
  if (/(swiftui|swift|ios|android|react native|react-native|flutter|mobile|мобильн)/i.test(text)) return { id: "mobile", confidence: 0.9, reason: "mobile keywords" };
  if (/(security|auth|oauth|permission|secret|vulnerab|compliance|безопасн|аутентиф)/i.test(text)) return { id: "security", confidence: 0.82, reason: "security keywords" };
  if (/(devops|deploy|docker|kubernetes|terraform|ci\/cd|observability|monitoring|infrastructure|инфраструкт|деплой)/i.test(text)) return { id: "devops-infrastructure", confidence: 0.86, reason: "infrastructure keywords" };
  if (/(test|quality|review|debug|bug|coverage|lint|typecheck|qa|тест|качество|ревью|баг)/i.test(text)) return { id: "testing-quality", confidence: 0.82, reason: "quality keywords" };
  if (/(backend|api|database|server|worker|queue|fastapi|django|sql|redis|bot|бэкенд|сервер|база данных)/i.test(text)) return { id: "backend-api", confidence: 0.82, reason: "backend keywords" };
  if (/(llm|machine learning|embedding|vector|data pipeline|analytics|dataset|ai\b|искусственн|данн)/i.test(text)) return { id: "data-ai", confidence: 0.78, reason: "data or AI keywords" };
  if (/(image-generation|brand|logo|identity|visual reference|mockup|content|бренд|логотип|изображен)/i.test(text)) return { id: "design-content", confidence: 0.86, reason: "visual content keywords" };
  if (/(frontend|ui\b|ux\b|website|landing|responsive|css|design|интерфейс|фронт|сайт|дизайн)/i.test(text)) return { id: "frontend-ui", confidence: 0.86, reason: "frontend keywords" };
  if (/(knowledge|documentation|docs|notes|obsidian|memory|handoff|brief|знан|документ|заметк|памят)/i.test(text)) return { id: "knowledge-productivity", confidence: 0.82, reason: "knowledge keywords" };
  if (/(repository|workflow|feature|implementation|agent|codebase|репозитор|разработ|агент)/i.test(text)) return { id: "repository-workflows", confidence: 0.72, reason: "development workflow keywords" };
  if (String(item.type || "").includes("external")) return { id: "integrations-automation", confidence: 0.55, reason: "external source fallback" };
  return { id: "unclassified", confidence: 0.25, reason: "no stable taxonomy signal" };
}

function inferTaskTypes(item, primaryGroup) {
  const text = textFor(item);
  const result = [];
  if (/(build|create|implement|develop|feature|созда|реализ|разработ)/i.test(text)) result.push("build");
  if (/(debug|bug|fix|investigat|error|почин|ошиб|баг)/i.test(text)) result.push("debug");
  if (/(review|audit|inspect|ревью|провер)/i.test(text)) result.push("review");
  if (/(test|quality|qa|coverage|accessibility|тест|качество)/i.test(text)) result.push("qa");
  if (/(design|visual|brand|image|ui|ux|дизайн|визуал)/i.test(text)) result.push("design");
  if (/(integration|connector|webhook|interact with|интеграц)/i.test(text)) result.push("integrate");
  if (/(deploy|release|ci\/cd|infrastructure|деплой|релиз)/i.test(text)) result.push("deploy");
  if (/(knowledge|document|notes|handoff|документ|заметк)/i.test(text)) result.push("document");
  if (primaryGroup === "integrations-automation") result.push("automate");
  return unique(result.length ? result : ["assist"]);
}

function inferPlatforms(primaryGroup) {
  const mapping = {
    "frontend-ui": ["web", "browser"],
    "backend-api": ["server"],
    mobile: ["mobile"],
    "data-ai": ["data", "local-or-cloud"],
    "integrations-automation": ["external-app", "network"],
    "devops-infrastructure": ["cloud", "ci-cd"],
    security: ["local-or-cloud"],
    "design-content": ["visual"],
    "repository-workflows": ["local-repository"],
    "testing-quality": ["local-repository"],
    "knowledge-productivity": ["knowledge-base"]
  };
  return mapping[primaryGroup] || [];
}

export function classifySkill(item) {
  const isIntegration = String(item.type || "") === "app-integration" || String(item.source || "").includes("membrane");
  let primary;
  let subgroups = [];

  if (isIntegration) {
    const specificGroups = INTEGRATION_SUBGROUPS.filter((group) => group.id !== "general-integration");
    const integration = specificGroups.find((group) => group.pattern.test(String(item.name || "")))
      || specificGroups.find((group) => group.pattern.test(textFor(item)))
      || INTEGRATION_SUBGROUPS.at(-1);
    primary = { id: "integrations-automation", confidence: integration.id === "general-integration" ? 0.55 : 0.88, reason: `integration subgroup: ${integration.id}` };
    subgroups = [integration.id];
  } else {
    primary = inferNonIntegrationGroup(item);
    if (primary.id === "frontend-ui") {
      if (/(accessib|a11y|wcag)/i.test(textFor(item))) subgroups.push("accessibility");
      if (/(landing|conversion|marketing)/i.test(textFor(item))) subgroups.push("landing-conversion");
      if (/(responsive|component|design[- ]system)/i.test(textFor(item))) subgroups.push("interface-engineering");
    }
    if (primary.id === "testing-quality") {
      if (/(frontend|browser|accessib|responsive)/i.test(textFor(item))) subgroups.push("frontend-qa");
      if (/(review|audit)/i.test(textFor(item))) subgroups.push("code-review");
      if (/(bug|debug|investigat)/i.test(textFor(item))) subgroups.push("debugging");
    }
    if (primary.id === "backend-api") {
      if (/(api|contract|schema|openapi|graphql|endpoint)/i.test(textFor(item))) subgroups.push("api-contracts");
      if (/(architecture|service|worker|queue|backend)/i.test(textFor(item))) subgroups.push("backend-architecture");
      if (/(database|migration|schema change|alembic|sql)/i.test(textFor(item))) subgroups.push("database-migrations");
    }
    if (primary.id === "devops-infrastructure") {
      if (/(ci\/cd|pipeline|release|deployment|rollback)/i.test(textFor(item))) subgroups.push("ci-cd-release");
      if (/(container|docker|kubernetes|runtime image)/i.test(textFor(item))) subgroups.push("containers-deployment");
    }
    if (primary.id === "security") {
      if (/(application security|threat|auth|permission|vulnerab)/i.test(textFor(item))) subgroups.push("application-security");
      if (/(secret|credential|dependency|supply chain|sbom)/i.test(textFor(item))) subgroups.push("secrets-dependencies");
    }
    if (primary.id === "data-ai") {
      if (/(data pipeline|etl|elt|lineage|dataset|data contract)/i.test(textFor(item))) subgroups.push("data-pipelines");
      if (/(llm|model provider|prompt|embedding|retrieval|rag)/i.test(textFor(item))) subgroups.push("llm-integrations");
    }
    if (primary.id === "design-content") {
      if (/(image|brand|logo)/i.test(textFor(item))) subgroups.push("visual-generation");
    }
  }

  const group = SKILL_GROUPS.find((candidate) => candidate.id === primary.id) || SKILL_GROUPS.at(-1);
  const name = String(item.name || "").toLowerCase();
  return {
    ...item,
    categories: unique([...(item.categories || []), primary.id, ...subgroups]),
    primary_group: primary.id,
    primary_group_label: group.label,
    subgroups: unique(subgroups),
    task_types: inferTaskTypes(item, primary.id),
    platforms: inferPlatforms(primary.id),
    related_skills: unique([...(item.related_skills || []), ...(RELATED_SKILLS.get(name) || [])]),
    related_groups: group.related_groups,
    taxonomy_confidence: primary.confidence,
    taxonomy_reason: primary.reason,
    taxonomy_priority: isIntegration ? "catalog" : "core",
    taxonomy_schema_version: SKILL_TAXONOMY_SCHEMA_VERSION
  };
}

export function canonicalSkillGroup(value) {
  const normalized = String(value || "").toLowerCase().trim().replace(/[\s_&]+/g, "-").replace(/-+/g, "-");
  if (!normalized) return "";
  const aliases = new Map([
    ["frontend", "frontend-ui"], ["ui", "frontend-ui"], ["web", "frontend-ui"],
    ["backend", "backend-api"], ["api", "backend-api"],
    ["ai", "data-ai"], ["data", "data-ai"],
    ["integration", "integrations-automation"], ["integrations", "integrations-automation"], ["automation", "integrations-automation"],
    ["devops", "devops-infrastructure"], ["infrastructure", "devops-infrastructure"],
    ["testing", "testing-quality"], ["quality", "testing-quality"], ["qa", "testing-quality"],
    ["design", "design-content"], ["content", "design-content"],
    ["repository", "repository-workflows"], ["workflow", "repository-workflows"],
    ["knowledge", "knowledge-productivity"], ["productivity", "knowledge-productivity"]
  ]);
  const resolved = aliases.get(normalized) || normalized;
  return SKILL_GROUPS.some((group) => group.id === resolved) ? resolved : "";
}

export function inferTaskSkillGroups(task, context = "") {
  const text = `${task || ""}\n${context || ""}`;
  const groups = [];
  if (/(frontend|front-end|ui|ux|react|next\.js|vue|svelte|css|browser|responsive|landing|website|фронт|интерфейс|верстк|лендинг|сайт)/i.test(text)) groups.push("frontend-ui");
  if (/(backend|api|server|database|postgres|redis|queue|worker|fastapi|django|bot|бэкенд|сервер|база данных|очеред)/i.test(text)) groups.push("backend-api");
  if (/(ios|android|swiftui|swift|flutter|react native|mobile|мобильн)/i.test(text)) groups.push("mobile");
  if (/(llm|embedding|machine learning|dataset|analytics|data pipeline|openai|anthropic|ai\b|данн|нейросет)/i.test(text)) groups.push("data-ai");
  if (/(integration|connector|oauth|webhook|slack|github|jira|linear|crm|sheets|drive|интеграц|коннектор|вебхук)/i.test(text)) groups.push("integrations-automation");
  if (/(deploy|docker|kubernetes|terraform|ci\/cd|cloud|monitoring|observability|infrastructure|деплой|инфраструкт)/i.test(text)) groups.push("devops-infrastructure");
  if (/(test|quality|review|debug|bug|lint|typecheck|coverage|qa|провер|тест|качество|ревью|баг)/i.test(text)) groups.push("testing-quality");
  if (/(security|auth|permission|secret|vulnerab|compliance|безопасн|аутентиф|секрет)/i.test(text)) groups.push("security");
  if (/(design|brand|image|visual|figma|mockup|дизайн|бренд|изображен|визуал|мокап)/i.test(text)) groups.push("design-content");
  if (/(repo|repository|codebase|feature|implementation|agent|AGENTS|project map|репозитор|разработ|фич|агент)/i.test(text)) groups.push("repository-workflows");
  if (/(knowledge|documentation|docs|notes|obsidian|memory|handoff|brief|знан|документ|заметк|памят)/i.test(text)) groups.push("knowledge-productivity");
  return unique(groups);
}

export function summarizeSkillTaxonomy(items) {
  return SKILL_GROUPS.map((group) => {
    const members = items.filter((item) => item.primary_group === group.id);
    const qualityScores = members.map((item) => Number(item.quality_score)).filter(Number.isFinite);
    const qualityCounts = {};
    const maturityCounts = {};
    const subgroupCounts = {};
    for (const item of members) {
      for (const subgroup of item.subgroups || []) subgroupCounts[subgroup] = (subgroupCounts[subgroup] || 0) + 1;
      qualityCounts[item.quality_status || "missing"] = (qualityCounts[item.quality_status || "missing"] || 0) + 1;
      maturityCounts[item.maturity || "missing"] = (maturityCounts[item.maturity || "missing"] || 0) + 1;
    }
    const examples = [...members]
      .sort((a, b) => (a.taxonomy_priority === "core" ? -1 : 1) - (b.taxonomy_priority === "core" ? -1 : 1) || a.name.localeCompare(b.name))
      .slice(0, 20)
      .map((item) => ({ name: item.name, source: item.source, path: item.path }));
    return {
      ...group,
      count: members.length,
      core_count: members.filter((item) => item.taxonomy_priority === "core").length,
      catalog_count: members.filter((item) => item.taxonomy_priority === "catalog").length,
      average_quality_score: qualityScores.length
        ? Number((qualityScores.reduce((total, score) => total + score, 0) / qualityScores.length).toFixed(2))
        : null,
      quality_counts: qualityCounts,
      maturity_counts: maturityCounts,
      structure_ready_count: members.filter((item) => item.structure_status === "pass" || item.quality_status === "pass").length,
      local_structure_ready_count: members.filter((item) =>
        item.source === "custom" && (item.structure_status === "pass" || item.quality_status === "pass")
      ).length,
      empirical_validated_count: members.filter((item) => item.empirical_status === "pass").length,
      validated_count: members.filter((item) => ["validated", "production"].includes(item.maturity)).length,
      subgroups: Object.entries(subgroupCounts)
        .map(([id, count]) => ({
          id,
          label: INTEGRATION_SUBGROUPS.find((item) => item.id === id)?.label || id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
          count
        }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
      examples
    };
  });
}
