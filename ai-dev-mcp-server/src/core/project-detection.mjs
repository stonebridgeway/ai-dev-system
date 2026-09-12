/**
 * Project detection.
 *
 * `detectProject` is the server's shared answer to "what is this repository":
 * its stack, its commands, its documentation, its risks. It is not a tool —
 * `begin_task`, `compile_project_context`, the project card writers and four
 * extensions all call it — so it stays a service on the host rather than
 * moving behind one tool's handler.
 *
 * The filesystem arrives injected, which is what lets the whole detector be
 * tested against a fixture object instead of a repository on disk.
 */
import path from "node:path";
import { commandRiskReason } from "./command-policy.mjs";
import { commandsByStatus } from "./project-markdown.mjs";

/** How this package manager runs a named script. */
export function packageRunCommand(packageManager, scriptName) {
  if (!scriptName) return "";
  if (packageManager === "pnpm") return `pnpm ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

/** The first of these script names the project actually defines. */
export function firstScript(scripts, names) {
  return names.find((name) => Object.hasOwn(scripts, name)) ?? "";
}

/** One command row, marked `missing` when nothing was detected. */
export function commandRow(label, command, source = "") {
  return { label, command: command || "Not detected", source: source || (command ? "detected" : "missing") };
}

/** Package scripts that deploy, migrate, pay, notify or touch production. */
export function projectDangerousScripts(scripts) {
  return Object.entries(scripts || {})
    .map(([name, command]) => {
      const reason = projectCommandRiskReason(command, name);
      return reason ? { name, command: String(command), reason } : null;
    })
    .filter(Boolean);
}

/** Why a script is side-effectful, or `""` when it looks safe. */
export function projectCommandRiskReason(command, name = "") {
  const baseReason = commandRiskReason(command);
  if (baseReason) return baseReason;
  const combined = `${name} ${command}`.toLowerCase();
  const risky = [
    { pattern: /\bdeploy|publish|release\b/, reason: "deployment or release script" },
    { pattern: /\bmigrate|migration|rollback|seed\b/, reason: "database mutation script" },
    { pattern: /\bstripe|payment|charge|invoice\b/, reason: "payment side effects" },
    { pattern: /\btelegram|discord|slack|mail|email|send\b/, reason: "external notification side effects" },
    { pattern: /\bopenai|anthropic|llm|vision|api[_-]?call\b/, reason: "external API or paid model side effects" },
    { pattern: /\bprod|production\b/, reason: "production environment script" }
  ];
  return risky.find((item) => item.pattern.test(combined))?.reason || "";
}

/** Checks a project of this shape should have and does not. */
export function projectQualityGaps(detected) {
  const missing = commandsByStatus(detected.commands).missing
    .filter((item) => ["Test", "Lint", "Typecheck", "Build"].includes(item.label))
    .map((item) => `${item.label} command is not detected.`);
  if (detected.is_frontend && !commandsByStatus(detected.commands).detected.some((item) => item.label === "Build")) {
    missing.push("Frontend project has no detected build command.");
  }
  if (!detected.documentation?.has_readme) missing.push("README.md is not detected.");
  if (!detected.environment?.has_example && detected.environment?.local_secret_files?.length) {
    missing.push("Local env files exist but no env example file was detected.");
  }
  return [...new Set(missing)];
}

/** What could go wrong when an agent runs things here unattended. */
export function projectRiskSignals(detected) {
  const risks = [];
  if (!detected.has_git) risks.push("Git repository was not detected at this root.");
  for (const item of detected.dangerous_scripts || []) {
    risks.push(`Script \`${item.name}\` may be unsafe for automatic runs: ${item.reason}.`);
  }
  for (const file of detected.environment?.local_secret_files || []) {
    risks.push(`Local env file \`${file}\` exists; never copy secrets into Obsidian or chat.`);
  }
  if ((detected.is_bot || detected.is_api) && detected.environment?.local_secret_files?.length) {
    risks.push("Bot/API project likely depends on external credentials; smoke checks may call real services.");
  }
  if (!detected.quality_gaps?.length && !risks.length) return [];
  return [...new Set(risks)];
}

/** The natural-language commands worth offering for this project. */
export function projectRecommendedNextCommands(detected) {
  const commands = [
    "начни новую фичу: <описание>",
    "найди баг: <симптом или ошибка>",
    "сделай ревью",
    "обнови память проекта"
  ];
  if (detected.is_frontend) commands.splice(2, 0, "улучши frontend/design: <экран или компонент>");
  if (detected.quality_gaps?.length || detected.risk_signals?.length) commands.push("обнови базу знаний");
  if (detected.is_frontend) {
    commands.splice(
      2,
      0,
      "поддержи frontend/beta: <экран или компонент>",
      "проверь frontend quality gate",
      "проверь лендинг/конверсию: <страница>"
    );
  }
  return [...new Set(commands)];
}

/**
 * Build the detector over one filesystem.
 *
 * @param {object} io
 * @param {(target: string) => Promise<boolean>} io.pathExists
 * @param {(target: string) => Promise<object|null>} io.readJsonIfExists
 * @param {(projectRoot: string, relativePath: string) => Promise<string>} io.readProjectText
 * @param {(projectRoot: string, relativePath: string) => string} io.safeProjectFile - Path guard.
 * @param {(target: string) => Promise<object|null>} io.stat - `fs.stat`, or null when absent.
 * @param {(projectRoot: string, options: object) => Promise<object>} io.analyzeProject - The deep pass.
 * @returns {{ detectProject: Function, projectDocumentationSnapshot: Function, projectEnvironmentSnapshot: Function }}
 */
export function createProjectDetector({
  pathExists,
  readJsonIfExists,
  readProjectText,
  safeProjectFile,
  stat,
  analyzeProject,
  readDirectory = async () => []
}) {
  const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

  /** The package manager, taken from whichever lockfile is present. */
  function inferPackageManager(projectRoot, packageJson) {
    const candidates = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
      ["package-lock.json", "npm"]
    ];
    return Promise.all(candidates.map(([file]) => pathExists(path.join(projectRoot, file))))
      .then((matches) => {
        const matchIndex = matches.findIndex(Boolean);
        if (matchIndex >= 0) return candidates[matchIndex][1];
        return packageJson ? "npm" : "";
      });
  }

  /** Which of the usual documentation files and directories exist. */
  async function projectDocumentationSnapshot(projectRoot) {
    const candidates = [
      ["README.md", "README"],
      ["docs", "docs/"],
      ["CONTRIBUTING.md", "CONTRIBUTING"],
      ["CHANGELOG.md", "CHANGELOG"],
      [".github", ".github/"],
      [".github/workflows", "GitHub Actions"]
    ];
    const files = [];
    for (const [relativePath, label] of candidates) {
      const target = safeProjectFile(projectRoot, relativePath);
      const stats = await stat(target);
      files.push({
        path: relativePath,
        label,
        exists: Boolean(stats),
        type: stats?.isDirectory() ? "directory" : stats?.isFile() ? "file" : "missing"
      });
    }
    return {
      files,
      has_readme: files.some((item) => item.path.toLowerCase() === "readme.md" && item.exists),
      has_docs: files.some((item) => item.path.toLowerCase() === "docs" && item.exists),
      missing: files.filter((item) => !item.exists).map((item) => item.path)
    };
  }

  /** `.env*` files, split into examples and local secret-bearing ones. */
  async function projectEnvironmentSnapshot(projectRoot) {
    const candidates = [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.example",
      ".env.sample",
      "env.example",
      "example.env"
    ];
    const files = [];
    for (const relativePath of candidates) {
      const target = safeProjectFile(projectRoot, relativePath);
      const stats = await stat(target);
      if (!stats?.isFile()) continue;
      const isExample = /example|sample/i.test(relativePath);
      files.push({
        path: relativePath,
        type: isExample ? "example" : "local",
        risk: isExample ? "low" : "high"
      });
    }
    return {
      files,
      has_example: files.some((item) => item.type === "example"),
      local_secret_files: files.filter((item) => item.type === "local").map((item) => item.path)
    };
  }

  /** Everything the rest of the server knows about a project.

   * The shallow pass reads the manifests at the root and the deep pass
   * (`analyzeProject`) walks the tree for components; the deep result wins
   * where the two disagree, because a monorepo's real commands live in its
   * packages rather than its root. Quality gaps, risks and the suggested next
   * commands are derived last, from the merged picture. */
  async function detectProject(projectRoot, requestedName) {
    const exists = (relativePath) => pathExists(path.join(projectRoot, relativePath));
    const packageJsonPath = path.join(projectRoot, "package.json");
    const packageJson = await readJsonIfExists(packageJsonPath);
    const scripts = isPlainObject(packageJson?.scripts) ? packageJson.scripts : {};
    const dependencies = {
      ...(isPlainObject(packageJson?.dependencies) ? packageJson.dependencies : {}),
      ...(isPlainObject(packageJson?.devDependencies) ? packageJson.devDependencies : {})
    };
    const packageManager = await inferPackageManager(projectRoot, packageJson);
    const pyprojectText = await readProjectText(projectRoot, "pyproject.toml");
    const requirementsText = await readProjectText(projectRoot, "requirements.txt");
    const composerText = (await readProjectText(projectRoot, "composer.json")).toLowerCase();
    const gemfileText = (await readProjectText(projectRoot, "Gemfile")).toLowerCase();
    const pythonMetadataText = `${pyprojectText}\n${requirementsText}`.toLowerCase();
    const dependencyText = `${Object.keys(dependencies).join(" ")}\n${pythonMetadataText}`.toLowerCase();

    const stack = [];
    const markers = [];
    const addStack = (name) => {
      if (!stack.includes(name)) stack.push(name);
    };
    const addMarker = async (file, label = file) => {
      if (await exists(file)) markers.push(label);
    };

    if (packageJson) addStack("Node.js");
    if (dependencies.typescript || await exists("tsconfig.json")) addStack("TypeScript");
    if (dependencies.next) addStack("Next.js");
    if (dependencies.react) addStack("React");
    if (dependencies.vue) addStack("Vue");
    if (dependencies.nuxt || await exists("nuxt.config.ts") || await exists("nuxt.config.js") || await exists("nuxt.config.mjs")) addStack("Nuxt");
    if (dependencies["@angular/core"] || await exists("angular.json")) addStack("Angular");
    if (dependencies.svelte) addStack("Svelte");
    if (dependencies.vite) addStack("Vite");
    if (dependencies.tailwindcss || await exists("tailwind.config.js") || await exists("tailwind.config.ts")) addStack("Tailwind CSS");
    if (dependencies["react-native"] || dependencies.expo || await exists("app.json") || await exists("eas.json")) addStack("React Native/Expo");
    if (dependencies["@capacitor/core"] || dependencies.ionic) addStack("Capacitor/Ionic");
    if (await exists("pyproject.toml") || await exists("requirements.txt") || await exists("Pipfile") || await exists("poetry.lock") || await exists("uv.lock")) addStack("Python");
    if (/fastapi/.test(pythonMetadataText)) addStack("FastAPI");
    if (/flask/.test(pythonMetadataText)) addStack("Flask");
    if (/django/.test(pythonMetadataText)) addStack("Django");
    if (/sqlalchemy/.test(pythonMetadataText)) addStack("SQLAlchemy");
    if (/alembic/.test(pythonMetadataText)) addStack("Alembic");
    if (/postgres|psycopg|asyncpg/.test(pythonMetadataText)) addStack("PostgreSQL");
    if (/redis/.test(pythonMetadataText)) addStack("Redis");
    if (/celery/.test(pythonMetadataText)) addStack("Celery");
    if (/aiogram/.test(pythonMetadataText)) addStack("aiogram");
    if (/python-telegram-bot|pytelegrambotapi|telebot|discord.py/.test(pythonMetadataText)) addStack("Bot framework");
    if (/openai/.test(pythonMetadataText)) addStack("OpenAI-compatible LLM");
    if (/pytest/.test(pythonMetadataText)) addStack("pytest");
    if (/\b(express|koa|fastify|hapi|nestjs|@nestjs\/core)\b/.test(dependencyText)) addStack("Node API");
    if (/\b(telegraf|grammy|node-telegram-bot-api|discord.js|slack-bolt)\b/.test(dependencyText)) addStack("Bot framework");
    if (await exists("pubspec.yaml")) addStack("Flutter/Dart");
    if (await exists("go.mod")) addStack("Go");
    if (await exists("Cargo.toml")) addStack("Rust");
    if (await exists("composer.json")) addStack("PHP");
    if (await exists("artisan") || /laravel\/framework/.test(composerText)) addStack("Laravel");
    if (/symfony\/framework-bundle/.test(composerText)) addStack("Symfony");
    if (await exists("Gemfile") || await exists("Rakefile") || await exists(".ruby-version")) addStack("Ruby");
    if (/\brails\b/.test(gemfileText) || await exists("config/application.rb")) addStack("Rails");
    // Extensions of the root entries. A .NET, F#, Swift or Xcode project is
    // named after the product (`Atlas.csproj`), so checking paths cannot find
    // it — the directory has to be listed (docs/ecc-upgrades/DEBTS.md, Д-19).
    // `readDirectory` is injected so the detector still tests over a tree in
    // memory.
    const rootEntries = (await readDirectory(projectRoot).catch(() => [])) ?? [];
    const hasExtension = (...extensions) => rootEntries.some((entry) => (
      extensions.some((extension) => String(entry ?? "").toLowerCase().endsWith(extension))
    ));

    if (await exists("Package.swift") || hasExtension(".xcodeproj", ".xcworkspace")) addStack("Swift");
    if (
      await exists("global.json") || await exists("Directory.Build.props") || await exists("NuGet.config")
      || await exists("nuget.config") || await exists(".config/dotnet-tools.json")
      || hasExtension(".csproj", ".sln", ".slnx")
    ) addStack("C#/.NET");
    if (hasExtension(".fsproj") || await exists("paket.dependencies")) addStack("F#");
    // Perl: a cpanfile or the classic Makefile.PL / Build.PL / dist.ini.
    if (await exists("cpanfile") || await exists("Makefile.PL") || await exists("Build.PL") || await exists("dist.ini")) addStack("Perl");
    // ArkTS is HarmonyOS: the DevEco toolchain writes `oh-package.json5` beside
    // `build-profile.json5`, and `hvigorfile.ts` is its build entry.
    if (await exists("oh-package.json5") || await exists("build-profile.json5") || await exists("hvigorfile.ts")) addStack("ArkTS/HarmonyOS");
    if (await exists("CMakeLists.txt") || await exists("meson.build") || await exists("configure.ac") || await exists("conanfile.txt") || await exists("vcpkg.json")) addStack("C/C++");
    if (await exists("pom.xml") || await exists("build.gradle") || await exists("build.gradle.kts")) addStack("Java/JVM");
    if (await exists("build.gradle.kts") || await exists("settings.gradle.kts")) addStack("Kotlin");
    if (await exists("Dockerfile") || await exists("docker-compose.yml") || await exists("compose.yml")) addStack("Docker");
    if (await exists("docker-compose.yml") || await exists("compose.yml")) addStack("Docker Compose");
    if (await exists(".github/workflows")) addStack("GitHub Actions");

    await addMarker("README.md");
    await addMarker("docs", "docs/");
    await addMarker("CONTRIBUTING.md");
    await addMarker("CHANGELOG.md");
    await addMarker(".env.example");
    await addMarker("package.json");
    await addMarker("tsconfig.json");
    await addMarker("vite.config.ts");
    await addMarker("vite.config.js");
    await addMarker("next.config.js");
    await addMarker("next.config.mjs");
    await addMarker("tailwind.config.ts");
    await addMarker("tailwind.config.js");
    await addMarker("pyproject.toml");
    await addMarker("requirements.txt");
    await addMarker("pubspec.yaml");
    await addMarker("app.json");
    await addMarker("eas.json");
    await addMarker("android", "android/");
    await addMarker("ios", "ios/");
    await addMarker("go.mod");
    await addMarker("Cargo.toml");
    await addMarker("Dockerfile");
    await addMarker(".github/workflows", "GitHub Actions");
    await addMarker("src", "src/");
    await addMarker("app", "app/");
    await addMarker("pages", "pages/");
    await addMarker("components", "components/");
    await addMarker("tests", "tests/");

    const installCommand = packageJson
      ? `${packageManager || "npm"} install`
      : (await exists("uv.lock") ? "uv sync" : await exists("requirements.txt") ? "python -m pip install -r requirements.txt" : "");
    const devScript = firstScript(scripts, ["dev", "start", "serve"]);
    const testScript = firstScript(scripts, ["test", "test:unit", "test:e2e"]);
    const lintScript = firstScript(scripts, ["lint", "lint:fix"]);
    const typecheckScript = firstScript(scripts, ["typecheck", "type-check", "check-types", "tsc"]);
    const buildScript = firstScript(scripts, ["build", "compile"]);
    const pythonCheckCommand = await exists("scripts/check.py")
      ? (await exists(".venv/Scripts/python.exe") ? ".\\.venv\\Scripts\\python.exe scripts\\check.py" : "python scripts/check.py")
      : "";
    const pythonTestFallback = pythonCheckCommand || (await exists("pyproject.toml") || await exists("requirements.txt") ? "pytest" : "");

    const commands = [
      commandRow("Install", installCommand, installCommand ? "project files" : "missing"),
      commandRow("Dev", packageRunCommand(packageManager, devScript), devScript ? `package script: ${devScript}` : "missing"),
      commandRow("Test", packageRunCommand(packageManager, testScript) || pythonTestFallback || (await exists("Cargo.toml") ? "cargo test" : ""), testScript ? `package script: ${testScript}` : pythonCheckCommand ? "scripts/check.py" : "fallback/missing"),
      commandRow("Lint", packageRunCommand(packageManager, lintScript), lintScript ? `package script: ${lintScript}` : "missing"),
      commandRow("Typecheck", packageRunCommand(packageManager, typecheckScript), typecheckScript ? `package script: ${typecheckScript}` : "missing"),
      commandRow("Build", packageRunCommand(packageManager, buildScript) || (await exists("go.mod") ? "go build ./..." : await exists("Cargo.toml") ? "cargo build" : ""), buildScript ? `package script: ${buildScript}` : "fallback/missing")
    ];

    const frontendNames = new Set(["Next.js", "React", "Vue", "Svelte", "Vite", "Tailwind CSS"]);
    const backendNames = new Set(["FastAPI", "Flask", "Django", "SQLAlchemy", "Alembic", "PostgreSQL", "Redis", "Celery", "Node API", "Go", "Rust", "Java/JVM", "PHP"]);
    const mobileNames = new Set(["React Native/Expo", "Capacitor/Ionic", "Flutter/Dart"]);
    const botNames = new Set(["aiogram", "Bot framework"]);
    const apiNames = new Set(["FastAPI", "Flask", "Django", "Node API"]);
    const isFrontend = stack.some((item) => frontendNames.has(item));
    const isBackend = stack.some((item) => backendNames.has(item));
    const isMobile = stack.some((item) => mobileNames.has(item));
    const isBot = stack.some((item) => botNames.has(item));
    const isApi = stack.some((item) => apiNames.has(item)) || await exists("api") || await exists("routes") || await exists("controllers");
    const projectTypes = [
      isFrontend ? "frontend" : "",
      isBackend ? "backend" : "",
      isMobile ? "mobile" : "",
      isBot ? "bot" : "",
      isApi ? "api" : ""
    ].filter(Boolean);
    const documentation = await projectDocumentationSnapshot(projectRoot);
    const environment = await projectEnvironmentSnapshot(projectRoot);
    const dangerousScripts = projectDangerousScripts(scripts);
    const projectName = requestedName || packageJson?.name || path.basename(projectRoot);
    const intelligence = await analyzeProject(projectRoot, { projectName, maxDepth: 4 });
    for (const value of intelligence.stack) {
      if (!stack.includes(value)) stack.push(value);
    }
    const deepTypes = intelligence.project_types.filter((item) => item !== "unknown");
    for (const value of deepTypes) {
      if (!projectTypes.includes(value)) projectTypes.push(value);
    }
    const mergedCommands = intelligence.commands.length
      ? intelligence.commands
      : commands;
    const detected = {
      project_name: projectName,
      project_path: projectRoot,
      package_manager: packageManager || "Not detected",
      stack,
      project_types: projectTypes.length ? projectTypes : ["unknown"],
      scripts,
      commands: mergedCommands,
      markers: [...new Set([...markers, ...intelligence.components.map((item) => item.manifest)])],
      documentation,
      environment,
      dangerous_scripts: dangerousScripts,
      has_git: await exists(".git"),
      is_frontend: isFrontend || intelligence.is_frontend,
      is_backend: isBackend || intelligence.is_backend,
      is_mobile: isMobile || intelligence.is_mobile,
      is_bot: isBot || intelligence.is_bot,
      is_api: isApi || intelligence.is_api,
      components: intelligence.components,
      architecture: intelligence.architecture,
      workspace: intelligence.workspace,
      component_quality: intelligence.quality
    };
    detected.quality_gaps = projectQualityGaps(detected);
    detected.risk_signals = projectRiskSignals(detected);
    detected.recommended_next_commands = projectRecommendedNextCommands(detected);
    return {
      ...detected
    };
  }

  return { detectProject, projectDocumentationSnapshot, projectEnvironmentSnapshot };
}
