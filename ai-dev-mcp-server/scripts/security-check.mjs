import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));

if (Number(lock.lockfileVersion) < 3) findings.push("package-lock.json must use lockfileVersion 3 or newer.");
for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(range))) {
    findings.push(`Direct dependency "${name}" must use an exact version, found "${range}".`);
  }
  const locked = lock.packages?.[`node_modules/${name}`];
  if (!locked?.version) findings.push(`Direct dependency "${name}" is missing from package-lock.json.`);
  if (locked?.version && locked.version !== range) {
    findings.push(`Direct dependency "${name}" lock mismatch: ${locked.version} != ${range}.`);
  }
}
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath) continue;
  if (metadata.resolved && !String(metadata.resolved).startsWith("https://registry.npmjs.org/")) {
    findings.push(`${packagePath}: dependency is not pinned to the npm HTTPS registry.`);
  }
  if (metadata.resolved && !metadata.integrity) {
    findings.push(`${packagePath}: resolved dependency has no integrity hash.`);
  }
}

const scanRoots = ["src", "scripts"];
const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  {
    name: "hard-coded credential",
    pattern: /\b(?:password|passwd|api_key|secret_key|access_token)\s*[:=]\s*["'][^"'${}\s]{12,}["']/i
  }
];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(target);
    } else if (entry.isFile() && /\.(?:mjs|js|json|md)$/i.test(entry.name)) {
      const source = await fs.readFile(target, "utf8");
      for (const rule of secretPatterns) {
        if (rule.pattern.test(source)) {
          findings.push(`${path.relative(root, target).replaceAll("\\", "/")}: possible ${rule.name}.`);
        }
      }
    }
  }
}
for (const scanRoot of scanRoots) await walk(path.join(root, scanRoot));

if (findings.length) {
  console.error(["Security gate failed:", ...findings.map((item) => `- ${item}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "passed",
    direct_dependencies: Object.keys(manifest.dependencies ?? {}).length,
    locked_packages: Math.max(0, Object.keys(lock.packages ?? {}).length - 1),
    checks: ["exact versions", "lock integrity", "HTTPS registry", "source secret patterns"]
  }, null, 2));
}
