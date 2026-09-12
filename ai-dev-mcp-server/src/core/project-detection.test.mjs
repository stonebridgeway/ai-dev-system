import assert from "node:assert/strict";
import test from "node:test";
import {
  commandRow,
  createProjectDetector,
  firstScript,
  packageRunCommand,
  projectCommandRiskReason,
  projectDangerousScripts,
  projectQualityGaps,
  projectRecommendedNextCommands,
  projectRiskSignals
} from "./project-detection.mjs";

/**
 * A detector over an in-memory tree: `files` maps a project-relative path to
 * its contents, and a path ending in `/` is a directory. Nothing touches disk.
 */
function detectorOver(files = {}, { analysis = {} } = {}) {
  const seen = new Set(Object.keys(files));
  const relative = (target) => target.replace(/^\/repo\/?/, "");
  const exists = (rel) => seen.has(rel) || seen.has(`${rel}/`);
  const analyzed = {
    stack: [], project_types: [], commands: [], components: [], architecture: {}, workspace: {},
    quality: {}, is_frontend: false, is_backend: false, is_mobile: false, is_bot: false, is_api: false,
    ...analysis
  };
  const calls = [];
  const detector = createProjectDetector({
    pathExists: async (target) => exists(relative(target)),
    readJsonIfExists: async (target) => {
      const raw = files[relative(target)];
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    readProjectText: async (_root, rel) => files[rel] ?? "",
    safeProjectFile: (root, rel) => `${root}/${rel}`,
    stat: async (target) => {
      const rel = relative(target);
      if (seen.has(`${rel}/`)) return { isDirectory: () => true, isFile: () => false };
      if (seen.has(rel)) return { isDirectory: () => false, isFile: () => true };
      return null;
    },
    analyzeProject: async (root, options) => {
      calls.push([root, options]);
      return analyzed;
    },
    // The real detector lists the root so it can see a project file named after
    // the product (`Atlas.csproj`); the fixture lists the in-memory tree.
    readDirectory: async (target) => {
      const prefix = relative(target) ? `${relative(target)}/` : "";
      return [...new Set(Object.keys(files)
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length).split("/")[0])
        .filter(Boolean))];
    }
  });
  return { ...detector, calls };
}

const PACKAGE_JSON = JSON.stringify({
  name: "atlas",
  scripts: { dev: "vite", test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "vite build", deploy: "./deploy.sh" },
  dependencies: { react: "18", next: "15" },
  devDependencies: { typescript: "5" }
});

test("a package manager is named by its lockfile, and npm when only a manifest exists", async () => {
  for (const [lockfile, expected] of [
    ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"]
  ]) {
    const { detectProject } = detectorOver({ "package.json": "{}", [lockfile]: "" });
    assert.equal((await detectProject("/repo")).package_manager, expected, lockfile);
  }
  assert.equal((await detectorOver({ "package.json": "{}" }).detectProject("/repo")).package_manager, "npm");
  assert.equal((await detectorOver({}).detectProject("/repo")).package_manager, "Not detected");
});

test("each package manager runs a script its own way", () => {
  assert.equal(packageRunCommand("pnpm", "test"), "pnpm test");
  assert.equal(packageRunCommand("yarn", "test"), "yarn test");
  assert.equal(packageRunCommand("bun", "test"), "bun run test");
  assert.equal(packageRunCommand("npm", "test"), "npm run test");
  assert.equal(packageRunCommand("", "test"), "npm run test");
  assert.equal(packageRunCommand("npm", ""), "");
});

test("the first script that exists wins, and a row marks a missing command", () => {
  assert.equal(firstScript({ start: "x", dev: "y" }, ["dev", "start"]), "dev");
  assert.equal(firstScript({}, ["dev"]), "");
  assert.deepEqual(commandRow("Test", "npm test"), { label: "Test", command: "npm test", source: "detected" });
  assert.deepEqual(commandRow("Test", ""), { label: "Test", command: "Not detected", source: "missing" });
  assert.deepEqual(commandRow("Test", "npm test", "package script"), { label: "Test", command: "npm test", source: "package script" });
});

test("a polyglot manifest set is read into one stack", async () => {
  const { detectProject } = detectorOver({
    "package.json": PACKAGE_JSON,
    "tsconfig.json": "{}",
    "pyproject.toml": "dependencies = [\"fastapi\", \"sqlalchemy\", \"alembic\", \"celery\", \"redis\", \"psycopg\", \"aiogram\", \"openai\", \"pytest\"]",
    "go.mod": "module atlas",
    "Cargo.toml": "[package]",
    "Dockerfile": "FROM node",
    "docker-compose.yml": "services: {}",
    ".github/workflows/": "",
    "README.md": "# Atlas",
    "src/": ""
  });
  const detected = await detectProject("/repo");
  for (const item of ["Node.js", "TypeScript", "Next.js", "React", "Python", "FastAPI", "SQLAlchemy", "Alembic",
    "PostgreSQL", "Redis", "Celery", "aiogram", "OpenAI-compatible LLM", "pytest", "Go", "Rust", "Docker",
    "Docker Compose", "GitHub Actions"]) {
    assert.ok(detected.stack.includes(item), `missing ${item}`);
  }
  assert.deepEqual(detected.project_types, ["frontend", "backend", "bot", "api"]);
  assert.deepEqual(detected.markers.filter((item) => item === "src/" || item === "README.md"), ["README.md", "src/"]);
  assert.equal(detected.has_git, false);
  assert.equal(detected.project_name, "atlas");
});

test("a bare tree detects nothing and is named after its directory", async () => {
  const detected = await detectorOver({ "notes.txt": "x" }).detectProject("/repo");
  assert.deepEqual(detected.stack, []);
  assert.deepEqual(detected.project_types, ["unknown"]);
  assert.deepEqual(detected.commands.map((item) => item.command), Array(6).fill("Not detected"));
  assert.equal(detected.project_name, "repo");
});

test("a requested name beats the manifest, which beats the directory", async () => {
  const files = { "package.json": PACKAGE_JSON };
  assert.equal((await detectorOver(files).detectProject("/repo", "Atlas")).project_name, "Atlas");
  assert.equal((await detectorOver(files).detectProject("/repo")).project_name, "atlas");
});

test("commands come from package scripts, then from the ecosystem's fallbacks", async () => {
  const scripted = await detectorOver({ "package.json": PACKAGE_JSON, "package-lock.json": "" }).detectProject("/repo");
  assert.deepEqual(scripted.commands.map((item) => [item.label, item.command]), [
    ["Install", "npm install"], ["Dev", "npm run dev"], ["Test", "npm run test"],
    ["Lint", "npm run lint"], ["Typecheck", "npm run typecheck"], ["Build", "npm run build"]
  ]);

  const fallbacks = await detectorOver({ "Cargo.toml": "[package]", "go.mod": "module x", "requirements.txt": "pytest" }).detectProject("/repo");
  const byLabel = Object.fromEntries(fallbacks.commands.map((item) => [item.label, item.command]));
  assert.equal(byLabel.Install, "python -m pip install -r requirements.txt");
  assert.equal(byLabel.Test, "pytest");
  assert.equal(byLabel.Build, "go build ./...");
});

test("a python check script is preferred over bare pytest, and uv over pip", async () => {
  const withCheck = await detectorOver({ "pyproject.toml": "", "scripts/check.py": "" }).detectProject("/repo");
  assert.equal(withCheck.commands.find((item) => item.label === "Test").command, "python scripts/check.py");
  assert.equal(withCheck.commands.find((item) => item.label === "Test").source, "scripts/check.py");

  const windows = await detectorOver({ "pyproject.toml": "", "scripts/check.py": "", ".venv/Scripts/python.exe": "" }).detectProject("/repo");
  assert.equal(windows.commands.find((item) => item.label === "Test").command, ".\\.venv\\Scripts\\python.exe scripts\\check.py");

  const uv = await detectorOver({ "uv.lock": "" }).detectProject("/repo");
  assert.equal(uv.commands.find((item) => item.label === "Install").command, "uv sync");
});

test("the deep pass wins where the two disagree, and only adds where they do not", async () => {
  const { detectProject, calls } = detectorOver({ "package.json": PACKAGE_JSON }, {
    analysis: {
      stack: ["React", "Kafka"],
      project_types: ["backend", "unknown"],
      commands: [{ label: "Test", command: "pnpm -r test" }],
      components: [{ name: "web", manifest: "apps/web/package.json" }],
      is_api: true
    }
  });
  const detected = await detectProject("/repo", "Atlas");
  assert.equal(detected.stack.filter((item) => item === "React").length, 1);
  assert.ok(detected.stack.includes("Kafka"));
  assert.equal(detected.project_types.includes("unknown"), false);
  assert.deepEqual(detected.commands, [{ label: "Test", command: "pnpm -r test" }]);
  assert.ok(detected.markers.includes("apps/web/package.json"));
  assert.equal(detected.is_api, true);
  assert.deepEqual(calls, [["/repo", { projectName: "Atlas", maxDepth: 4 }]]);
});

test("documentation and environment are scanned by file type", async () => {
  const detected = await detectorOver({
    "README.md": "# x", "docs/": "", ".env": "SECRET=1", ".env.example": "SECRET="
  }).detectProject("/repo");
  assert.equal(detected.documentation.has_readme, true);
  assert.equal(detected.documentation.has_docs, true);
  assert.deepEqual(detected.documentation.missing, ["CONTRIBUTING.md", "CHANGELOG.md", ".github", ".github/workflows"]);
  assert.deepEqual(detected.documentation.files.find((item) => item.path === "docs").type, "directory");

  assert.deepEqual(detected.environment.files, [
    { path: ".env", type: "local", risk: "high" },
    { path: ".env.example", type: "example", risk: "low" }
  ]);
  assert.deepEqual(detected.environment.local_secret_files, [".env"]);
  assert.equal(detected.environment.has_example, true);
});

test("a script is flagged by what it does, not only by the policy", () => {
  assert.equal(projectCommandRiskReason("vitest run"), "");
  assert.equal(projectCommandRiskReason("./x.sh", "deploy"), "deployment or release script");
  // The command policy speaks first: it already knows what `alembic upgrade` is.
  assert.equal(projectCommandRiskReason("alembic upgrade head", "migrate"), "deployment, migration, or infrastructure mutation");
  assert.equal(projectCommandRiskReason("node load.js", "seed"), "database mutation script");
  assert.equal(projectCommandRiskReason("node pay.js", "stripe"), "payment side effects");
  assert.equal(projectCommandRiskReason("node notify.js", "telegram"), "external notification side effects");
  assert.equal(projectCommandRiskReason("node ask.js", "openai"), "external API or paid model side effects");
  assert.equal(projectCommandRiskReason("node serve.js", "prod"), "production environment script");
  assert.match(projectCommandRiskReason("rm -rf /"), /\S/);

  assert.deepEqual(projectDangerousScripts({ test: "vitest", deploy: "./deploy.sh --prod" }), [
    { name: "deploy", command: "./deploy.sh --prod", reason: "deployment or release script" }
  ]);
  assert.deepEqual(projectDangerousScripts(null), []);
});

test("quality gaps name the checks a project of this shape should have", () => {
  const gaps = projectQualityGaps({
    commands: [
      { label: "Test", command: "npm test" }, { label: "Lint", command: "Not detected" },
      { label: "Typecheck", command: "" }, { label: "Build", command: "Not detected" },
      { label: "Dev", command: "Not detected" }
    ],
    is_frontend: true,
    documentation: { has_readme: false },
    environment: { has_example: false, local_secret_files: [".env"] }
  });
  assert.deepEqual(gaps, [
    "Lint command is not detected.",
    "Typecheck command is not detected.",
    "Build command is not detected.",
    "Frontend project has no detected build command.",
    "README.md is not detected.",
    "Local env files exist but no env example file was detected."
  ]);
  assert.deepEqual(projectQualityGaps({ commands: [{ label: "Test", command: "npm test" }], documentation: { has_readme: true }, environment: {} }), []);
});

test("risk signals cover git, scripts, secrets and credential-hungry projects", () => {
  const risks = projectRiskSignals({
    has_git: false,
    dangerous_scripts: [{ name: "deploy", reason: "deployment or release script" }],
    environment: { local_secret_files: [".env"] },
    is_bot: true,
    quality_gaps: []
  });
  assert.deepEqual(risks, [
    "Git repository was not detected at this root.",
    "Script `deploy` may be unsafe for automatic runs: deployment or release script.",
    "Local env file `.env` exists; never copy secrets into Obsidian or chat.",
    "Bot/API project likely depends on external credentials; smoke checks may call real services."
  ]);
  assert.deepEqual(projectRiskSignals({ has_git: true, environment: {}, quality_gaps: [] }), []);
});

test("the suggested commands grow for a frontend project and for a flawed one", () => {
  assert.deepEqual(projectRecommendedNextCommands({}), [
    "начни новую фичу: <описание>", "найди баг: <симптом или ошибка>", "сделай ревью", "обнови память проекта"
  ]);
  const frontend = projectRecommendedNextCommands({ is_frontend: true, quality_gaps: ["x"] });
  assert.ok(frontend.includes("улучши frontend/design: <экран или компонент>"));
  assert.ok(frontend.includes("проверь frontend quality gate"));
  assert.equal(frontend.at(-1), "обнови базу знаний");
});

test("a malformed package.json is treated as no manifest at all", async () => {
  const detected = await detectorOver({ "package.json": "{ not json" }).detectProject("/repo");
  assert.deepEqual(detected.scripts, {});
  assert.equal(detected.package_manager, "Not detected");
  assert.equal(detected.stack.includes("Node.js"), false);
});

test("the stacks the newer rule packs are chosen by are detected from root files", async () => {
  const nuxt = detectorOver({ "package.json": JSON.stringify({ dependencies: { vue: "3", nuxt: "3" } }) });
  const nuxtStack = (await nuxt.detectProject("/repo")).stack;
  assert.ok(nuxtStack.includes("Vue") && nuxtStack.includes("Nuxt"));

  const angular = detectorOver({ "package.json": "{}", "angular.json": "{}" });
  assert.ok((await angular.detectProject("/repo")).stack.includes("Angular"));

  const kotlin = detectorOver({ "build.gradle.kts": "plugins { kotlin(\"jvm\") }" });
  const kotlinStack = (await kotlin.detectProject("/repo")).stack;
  assert.ok(kotlinStack.includes("Kotlin") && kotlinStack.includes("Java/JVM"), "a Kotlin JVM project is both");

  const swift = detectorOver({ "Package.swift": "// swift-tools-version:5.9" });
  assert.ok((await swift.detectProject("/repo")).stack.includes("Swift"));

  const dotnet = detectorOver({ "global.json": "{}" });
  assert.ok((await dotnet.detectProject("/repo")).stack.includes("C#/.NET"));

  const cpp = detectorOver({ "CMakeLists.txt": "project(atlas)" });
  assert.ok((await cpp.detectProject("/repo")).stack.includes("C/C++"));

  const rails = detectorOver({ "Gemfile": "gem \"rails\", \"~> 7.1\"" });
  const railsStack = (await rails.detectProject("/repo")).stack;
  assert.ok(railsStack.includes("Ruby") && railsStack.includes("Rails"));

  const laravel = detectorOver({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }) });
  const laravelStack = (await laravel.detectProject("/repo")).stack;
  assert.ok(laravelStack.includes("PHP") && laravelStack.includes("Laravel"));

  // A plain Ruby script directory is Ruby without being Rails.
  const ruby = detectorOver({ "Rakefile": "task :default" });
  const rubyStack = (await ruby.detectProject("/repo")).stack;
  assert.ok(rubyStack.includes("Ruby") && !rubyStack.includes("Rails"));
});


// Д-19 and Д-18. A .NET, F#, Swift or Xcode project file is named after the
// product, so no list of paths can find it: the root has to be listed.
test("a project file named after the product is found by listing the root", async () => {
  const dotnet = detectorOver({ "Atlas.csproj": "<Project/>", "src/": "" });
  assert.deepEqual((await dotnet.detectProject("/repo")).stack, ["C#/.NET"]);
  assert.deepEqual((await detectorOver({ "Atlas.sln": "" }).detectProject("/repo")).stack, ["C#/.NET"]);
  assert.deepEqual((await detectorOver({ "Atlas.slnx": "" }).detectProject("/repo")).stack, ["C#/.NET"]);
  assert.deepEqual((await detectorOver({ "Atlas.fsproj": "" }).detectProject("/repo")).stack, ["F#"]);
  assert.deepEqual((await detectorOver({ "paket.dependencies": "" }).detectProject("/repo")).stack, ["F#"]);
  assert.deepEqual((await detectorOver({ "Atlas.xcodeproj/": "" }).detectProject("/repo")).stack, ["Swift"]);
  // The five conventional root files still work, and a repository with both
  // gets the label once.
  assert.deepEqual((await detectorOver({ "global.json": "{}", "Atlas.csproj": "" }).detectProject("/repo")).stack, ["C#/.NET"]);
  // A file that merely mentions the extension somewhere else is not a project.
  assert.deepEqual((await detectorOver({ "docs/csproj-notes.md": "" }).detectProject("/repo")).stack, []);
});

test("Perl and ArkTS are labelled from their own manifests", async () => {
  for (const marker of ["cpanfile", "Makefile.PL", "Build.PL", "dist.ini"]) {
    assert.deepEqual((await detectorOver({ [marker]: "" }).detectProject("/repo")).stack, ["Perl"], marker);
  }
  for (const marker of ["oh-package.json5", "build-profile.json5", "hvigorfile.ts"]) {
    assert.deepEqual((await detectorOver({ [marker]: "" }).detectProject("/repo")).stack, ["ArkTS/HarmonyOS"], marker);
  }
  // A directory listing that fails is not a detection failure.
  const detector = createProjectDetector({
    pathExists: async () => false,
    readJsonIfExists: async () => null,
    readProjectText: async () => "",
    safeProjectFile: (root, rel) => `${root}/${rel}`,
    stat: async () => null,
    analyzeProject: async () => ({ stack: [], project_types: [], commands: [], components: [], architecture: {}, workspace: {}, quality: {} }),
    readDirectory: async () => { throw new Error("EACCES"); }
  });
  assert.deepEqual((await detector.detectProject("/repo")).stack, []);
});
