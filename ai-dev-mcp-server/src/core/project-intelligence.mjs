import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", "node_modules", ".next", "dist",
  "build", "coverage", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".turbo", ".nx", "target", "vendor"
]);

const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock",
  "uv.lock", "go.mod", "Cargo.toml", "pubspec.yaml", "composer.json", "pom.xml",
  "build.gradle", "build.gradle.kts"
]);

async function readText(filePath, maxBytes = 1024 * 1024) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > maxBytes) return "";
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readText(filePath));
  } catch {
    return null;
  }
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function discoverManifests(root, maxDepth = 4) {
  const found = [];
  async function walk(directory, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && MANIFESTS.has(entry.name)) {
        found.push(path.join(directory, entry.name));
      }
    }
  }
  await walk(root, 0);
  return found.sort();
}

function addUnique(target, ...values) {
  for (const value of values.flat()) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function packageManagerFor(directory, root) {
  const candidates = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"]
  ];
  return Promise.all(candidates.map(async ([file, manager]) => ({
    manager,
    found: await exists(path.join(directory, file)) || (directory !== root && await exists(path.join(root, file)))
  }))).then((items) => items.find((item) => item.found)?.manager || "npm");
}

function packageCommand(manager, script) {
  if (!script) return "";
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return `${manager} run ${script}`;
}

function command(label, value, cwd, source) {
  return { label, command: value || "Not detected", cwd, source: value ? source : "missing" };
}

async function nodeComponent(root, directory, manifestPath, packageJson) {
  const relative = path.relative(root, directory).replaceAll("\\", "/") || ".";
  const dependencies = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {})
  };
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const manager = await packageManagerFor(directory, root);
  const stack = ["Node.js"];
  if (dependencies.typescript || await exists(path.join(directory, "tsconfig.json"))) addUnique(stack, "TypeScript");
  if (dependencies.next) addUnique(stack, "Next.js");
  if (dependencies.react) addUnique(stack, "React");
  if (dependencies.vue) addUnique(stack, "Vue");
  if (dependencies.svelte) addUnique(stack, "Svelte");
  if (dependencies.vite) addUnique(stack, "Vite");
  if (dependencies.tailwindcss) addUnique(stack, "Tailwind CSS");
  if (dependencies.express || dependencies.fastify || dependencies.koa || dependencies["@nestjs/core"]) addUnique(stack, "Node API");
  if (dependencies["react-native"] || dependencies.expo) addUnique(stack, "React Native/Expo");
  const types = [];
  if (stack.some((item) => ["Next.js", "React", "Vue", "Svelte", "Vite", "Tailwind CSS"].includes(item))) addUnique(types, "frontend");
  if (stack.includes("Node API") || dependencies.next) addUnique(types, "backend", "api");
  if (stack.includes("React Native/Expo")) addUnique(types, "mobile");
  const first = (...names) => names.find((name) => Object.hasOwn(scripts, name)) || "";
  const commands = [
    command("Dev", packageCommand(manager, first("dev", "start", "serve")), relative, "package script"),
    command("Test", packageCommand(manager, first("test", "test:unit", "test:e2e")), relative, "package script"),
    command("Lint", packageCommand(manager, first("lint", "lint:check")), relative, "package script"),
    command("Typecheck", packageCommand(manager, first("typecheck", "type-check", "check-types")), relative, "package script"),
    command("Build", packageCommand(manager, first("build", "compile")), relative, "package script")
  ];
  return {
    name: packageJson?.name || path.basename(directory),
    path: relative,
    manifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
    ecosystem: "node",
    package_manager: manager,
    stack,
    project_types: types,
    scripts,
    commands
  };
}

async function pythonComponent(root, directory, manifests) {
  const relative = path.relative(root, directory).replaceAll("\\", "/") || ".";
  const metadata = (await Promise.all(manifests.map((item) => readText(item)))).join("\n").toLowerCase();
  const stack = ["Python"];
  if (/fastapi/.test(metadata)) addUnique(stack, "FastAPI");
  if (/django/.test(metadata)) addUnique(stack, "Django");
  if (/flask/.test(metadata)) addUnique(stack, "Flask");
  if (/sqlalchemy/.test(metadata)) addUnique(stack, "SQLAlchemy");
  if (/alembic/.test(metadata)) addUnique(stack, "Alembic");
  if (/postgres|psycopg|asyncpg/.test(metadata)) addUnique(stack, "PostgreSQL");
  if (/redis/.test(metadata)) addUnique(stack, "Redis");
  if (/celery/.test(metadata)) addUnique(stack, "Celery");
  if (/pytest/.test(metadata)) addUnique(stack, "pytest");
  if (/aiogram|python-telegram-bot|discord\.py/.test(metadata)) addUnique(stack, "Bot framework");
  const types = [];
  if (stack.some((item) => ["FastAPI", "Django", "Flask", "SQLAlchemy", "Celery"].includes(item))) addUnique(types, "backend");
  if (stack.some((item) => ["FastAPI", "Django", "Flask"].includes(item))) addUnique(types, "api");
  if (stack.includes("Bot framework")) addUnique(types, "bot");
  const python = await exists(path.join(directory, ".venv", "Scripts", "python.exe"))
    ? ".\\.venv\\Scripts\\python.exe"
    : "python";
  const hasCheck = await exists(path.join(directory, "scripts", "check.py"));
  const commands = [
    command("Test", hasCheck ? `${python} scripts\\check.py` : "python -m pytest", relative, hasCheck ? "scripts/check.py" : "python fallback"),
    command("Lint", /ruff/.test(metadata) ? "python -m ruff check ." : "", relative, "pyproject"),
    command("Typecheck", /mypy/.test(metadata) ? "python -m mypy ." : "", relative, "pyproject")
  ];
  return {
    name: path.basename(directory),
    path: relative,
    manifest: manifests.map((item) => path.relative(root, item).replaceAll("\\", "/")).join(", "),
    ecosystem: "python",
    package_manager: await exists(path.join(directory, "uv.lock")) ? "uv" : "pip",
    stack,
    project_types: types,
    scripts: {},
    commands
  };
}

async function genericComponent(root, directory, manifestPath) {
  const relative = path.relative(root, directory).replaceAll("\\", "/") || ".";
  const name = path.basename(manifestPath);
  const mapping = {
    "go.mod": ["Go", ["backend", "api"], "go test ./...", "go build ./..."],
    "Cargo.toml": ["Rust", ["backend"], "cargo test", "cargo build"],
    "pubspec.yaml": ["Flutter/Dart", ["mobile", "frontend"], "flutter test", "flutter build"],
    "composer.json": ["PHP", ["backend"], "", ""],
    "pom.xml": ["Java/JVM", ["backend"], "", ""],
    "build.gradle": ["Java/JVM", ["backend"], "", ""],
    "build.gradle.kts": ["Java/JVM", ["backend"], "", ""]
  };
  const [stack, types, testCommand, buildCommand] = mapping[name] || [name, ["unknown"], "", ""];
  return {
    name: path.basename(directory),
    path: relative,
    manifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
    ecosystem: stack.toLowerCase(),
    package_manager: "Not detected",
    stack: [stack],
    project_types: types,
    scripts: {},
    commands: [
      command("Test", testCommand, relative, "ecosystem default"),
      command("Build", buildCommand, relative, "ecosystem default")
    ]
  };
}

async function architectureInventory(root, components, maxDepth = 4) {
  const sourceRoots = [];
  const testRoots = [];
  const entrypoints = [];
  const apiSurfaces = [];
  const dataPaths = [];
  const ci = [];
  const sourceNames = ["src", "app", "pages", "components", "lib", "server", "backend", "frontend"];
  const testNames = ["tests", "test", "__tests__", "e2e"];
  const entryNames = ["main.py", "manage.py", "app.py", "server.py", "index.ts", "index.js", "main.ts", "main.js"];
  const apiNames = ["routes", "controllers", "api", "openapi.yaml", "openapi.json", "schema.graphql"];
  const dataNames = ["migrations", "alembic", "models", "prisma", "schema.sql"];

  for (const component of components) {
    const base = component.path === "." ? root : path.join(root, component.path);
    for (const name of sourceNames) if (await exists(path.join(base, name))) addUnique(sourceRoots, path.relative(root, path.join(base, name)).replaceAll("\\", "/"));
    for (const name of testNames) if (await exists(path.join(base, name))) addUnique(testRoots, path.relative(root, path.join(base, name)).replaceAll("\\", "/"));
    for (const name of entryNames) {
      for (const prefix of ["", "src"]) {
        const target = path.join(base, prefix, name);
        if (await exists(target)) addUnique(entrypoints, path.relative(root, target).replaceAll("\\", "/"));
      }
    }
    for (const name of apiNames) if (await exists(path.join(base, name))) addUnique(apiSurfaces, path.relative(root, path.join(base, name)).replaceAll("\\", "/"));
    for (const name of dataNames) if (await exists(path.join(base, name))) addUnique(dataPaths, path.relative(root, path.join(base, name)).replaceAll("\\", "/"));
  }
  async function walk(directory, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replaceAll("\\", "/");
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (sourceNames.includes(lower)) addUnique(sourceRoots, relative);
        if (testNames.includes(lower)) addUnique(testRoots, relative);
        if (apiNames.includes(lower)) addUnique(apiSurfaces, relative);
        if (dataNames.includes(lower)) addUnique(dataPaths, relative);
        await walk(target, depth + 1);
      } else if (entry.isFile()) {
        if (entryNames.includes(entry.name)) addUnique(entrypoints, relative);
        if (apiNames.includes(lower) || lower === "urls.py") addUnique(apiSurfaces, relative);
        if (dataNames.includes(lower) || lower === "models.py") addUnique(dataPaths, relative);
      }
    }
  }
  await walk(root, 0);
  const workflowRoot = path.join(root, ".github", "workflows");
  if (await exists(workflowRoot)) {
    const files = await fs.readdir(workflowRoot).catch(() => []);
    addUnique(ci, files.map((item) => `.github/workflows/${item}`));
  }
  return { source_roots: sourceRoots, test_roots: testRoots, entrypoints, api_surfaces: apiSurfaces, data_paths: dataPaths, ci, max_depth: maxDepth };
}

/**
 * Statically analyse a repository: discover manifests up to `maxDepth`, group
 * them into per-directory components (Node, Python, generic), and derive stack,
 * command map, entrypoints, CI workflows, documentation status, risk signals,
 * and side-effectful scripts. Filesystem read-only; never runs project code.
 *
 * @param {string} projectRoot - Repository root.
 * @param {{ projectName?: string, maxDepth?: number }} [options]
 * @returns {Promise<object>} Structured project analysis.
 */
export async function analyzeProject(projectRoot, { projectName = "", maxDepth = 4 } = {}) {
  const root = path.resolve(projectRoot);
  const manifests = await discoverManifests(root, maxDepth);
  const byDirectory = new Map();
  for (const manifest of manifests) {
    const directory = path.dirname(manifest);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(manifest);
  }

  for (const [directory, files] of [...byDirectory.entries()]) {
    if (path.basename(directory).toLowerCase() !== "requirements") continue;
    const parent = path.dirname(directory);
    const parentFiles = byDirectory.get(parent) ?? [];
    parentFiles.push(...files);
    byDirectory.set(parent, parentFiles);
    byDirectory.delete(directory);
  }

  const components = [];
  for (const [directory, files] of byDirectory) {
    const packageManifest = files.find((item) => path.basename(item) === "package.json");
    if (packageManifest) {
      components.push(await nodeComponent(root, directory, packageManifest, await readJson(packageManifest)));
    }
    const pythonManifests = files.filter((item) => ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock"].includes(path.basename(item)));
    if (pythonManifests.length) components.push(await pythonComponent(root, directory, pythonManifests));
    for (const file of files) {
      if (packageManifest === file || pythonManifests.includes(file)) continue;
      components.push(await genericComponent(root, directory, file));
    }
  }

  const stack = [];
  const projectTypes = [];
  for (const component of components) {
    addUnique(stack, component.stack);
    addUnique(projectTypes, component.project_types);
  }
  if (await exists(path.join(root, "Dockerfile"))) addUnique(stack, "Docker");
  if (await exists(path.join(root, "docker-compose.yml")) || await exists(path.join(root, "compose.yml"))) addUnique(stack, "Docker Compose");
  if (await exists(path.join(root, ".github", "workflows"))) addUnique(stack, "GitHub Actions");

  const architecture = await architectureInventory(root, components, maxDepth);
  const commands = components.flatMap((component) => component.commands.map((item) => ({
    ...item,
    component: component.name
  })));
  const missingByComponent = components.map((component) => {
    const labels = new Set(component.commands.filter((item) => item.command !== "Not detected").map((item) => item.label));
    return {
      component: component.name,
      path: component.path,
      missing: ["Test", "Lint", "Typecheck", "Build"].filter((label) => !labels.has(label))
    };
  });
  const workspaceMarkers = [];
  for (const marker of ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"]) {
    if (await exists(path.join(root, marker))) workspaceMarkers.push(marker);
  }

  return {
    project_name: projectName || path.basename(root),
    project_path: root,
    stack,
    project_types: projectTypes.length ? projectTypes : ["unknown"],
    components,
    commands,
    architecture,
    workspace: {
      is_monorepo: components.length > 1 || workspaceMarkers.length > 0,
      markers: workspaceMarkers,
      component_count: components.length
    },
    quality: {
      components: missingByComponent,
      missing_gate_count: missingByComponent.reduce((sum, item) => sum + item.missing.length, 0)
    },
    is_frontend: projectTypes.includes("frontend"),
    is_backend: projectTypes.includes("backend"),
    is_mobile: projectTypes.includes("mobile"),
    is_bot: projectTypes.includes("bot"),
    is_api: projectTypes.includes("api")
  };
}
