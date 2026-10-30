import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MODULE_LINE_EXCEPTIONS } from "../src/core/line-budget.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The gate is held by what it does, not by how its source reads: a test that matched its text stayed green with the
// call commented out, behind `if (false)`, or with the findings dropped before the verdict.
// So a finding of each rule and of each check is planted in each folder the gate walks, and exactly that set is what
// it must say: one folder left unwalked, or one rule's findings dropped, fails here.
test("the gate refuses each rule and each check planted in each folder it walks, and lets the app's tests call eval", {
  skip: process.platform === "win32" && "the fixture links to the real modules, and a symbolic link needs a privilege on Windows"
}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "static-quality-"));
  try {
    const server = path.join(fixture, "ai-dev-mcp-server");
    // The gate itself, copied: what it does to the tree beside it, it does here.
    await fs.mkdir(path.join(server, "scripts"), { recursive: true });
    await fs.copyFile(path.join(serverRoot, "scripts", "static-quality.mjs"), path.join(server, "scripts", "static-quality.mjs"));
    // `src/` links to the real modules, which the gate imports and its walk passes by; the modules pinned over the
    // line ceiling are copies, so the budget finds them.
    const pinned = new Set([...MODULE_LINE_EXCEPTIONS].map(([relative]) => relative));
    const realSource = path.join(serverRoot, "src");
    await fs.mkdir(path.join(server, "src", "core"), { recursive: true });
    for (const entry of await fs.readdir(realSource)) {
      if (entry !== "core") await fs.symlink(path.join(realSource, entry), path.join(server, "src", entry));
    }
    for (const entry of await fs.readdir(path.join(realSource, "core"))) {
      const [from, to] = [path.join(realSource, "core", entry), path.join(server, "src", "core", entry)];
      if (pinned.has(`src/core/${entry}`)) await fs.copyFile(from, to);
      else await fs.symlink(from, to);
    }
    const desktop = path.join(fixture, "desktop");
    for (const folder of ["src", "scripts", "test"]) await fs.mkdir(path.join(desktop, folder), { recursive: true });
    await fs.writeFile(path.join(desktop, "package.json"), "{}\n");
    for (const folder of ["bin", "hooks"]) await fs.mkdir(path.join(server, folder));
    const tooLong = `${Array.from({ length: 801 }, () => "// a line").join("\n")}`;
    const planted = {
      // Two findings below the first line: the whole file is read, and each finding is said.
      [path.join(server, "bin", "zz-planted.mjs")]: 'const ready = true;\nnew Function("return 1");\neval("1");\n',
      [path.join(server, "bin", "zz-syntax.mjs")]: "const = 1;\n",
      [path.join(server, "src", "core", "zz-planted.mjs")]: 'import { exec } from "node:child_process";\nexec("ls");\n',
      [path.join(server, "src", "core", "zz-long.mjs")]: tooLong,
      [path.join(server, "scripts", "zz-planted.mjs")]: 'spawn("x", [], { shell: true });\n',
      [path.join(server, "scripts", "zz-unread.mjs")]: "const t = `open\n",
      [path.join(server, "hooks", "zz-planted.mjs")]: "globalThis[key]();\n",
      [path.join(server, "hooks", "zz-planted.sh")]: "if then\n",
      // The desktop app beside it: its code, its scripts and its .cjs; eval is refused there and allowed in its tests,
      // where a shell is refused as anywhere.
      [path.join(desktop, "src", "zz-planted.js")]: 'eval("1");\n',
      // Read as the script it is: its HTML-like comment hides the backtick a module would open a template with.
      [path.join(desktop, "src", "zz-planted.cjs")]: 'const x = 1 <!-- `\neval("1");\nrequire("node:child_process").execSync("ls");\n// `\n',
      [path.join(desktop, "src", "zz-long.js")]: tooLong,
      [path.join(desktop, "scripts", "zz-planted.mjs")]: 'const { exec } = await import("node:child_process");\n',
      [path.join(desktop, "scripts", "zz-syntax.cjs")]: "const = 1;\n",
      [path.join(desktop, "test", "zz-planted.test.js")]: 'eval("1");\nspawn("x", [], { shell: true });\n'
    };
    for (const [file, source] of Object.entries(planted)) await fs.writeFile(file, source);

    const run = spawnSync(process.execPath, [path.join(server, "scripts", "static-quality.mjs")], { cwd: server, encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    // What a syntax check prints after its name is the parser's, and differs between versions.
    const findings = run.stderr.split("\n").filter((line) => line.startsWith("- "))
      .map((line) => line.replace(/: (syntax check failed|sh -n failed): .*$/, ": $1")).sort();
    const exec = "is forbidden; use argv-based execution (spawn, spawnSync, execFile, execFileSync).";
    const shell = "a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.";
    const ceiling = "801 lines exceeds the 800-line module ceiling. Split it, or pin it in MODULE_LINE_EXCEPTIONS with a reason.";
    assert.deepEqual(findings, [
      "- bin/zz-planted.mjs:2: the Function constructor is forbidden, called or handed on.",
      "- bin/zz-planted.mjs:3: eval is forbidden, called or handed on.",
      "- bin/zz-syntax.mjs: syntax check failed",
      `- desktop/scripts/zz-planted.mjs:1: child_process exec ${exec}`,
      "- desktop/scripts/zz-syntax.cjs: syntax check failed",
      `- desktop/src/zz-long.js: ${ceiling}`,
      "- desktop/src/zz-planted.cjs:2: eval is forbidden, called or handed on.",
      "- desktop/src/zz-planted.cjs:3: child_process execSync (a member of the module) " + exec,
      "- desktop/src/zz-planted.js:1: eval is forbidden, called or handed on.",
      `- desktop/test/zz-planted.test.js:2: ${shell}`,
      "- hooks/zz-planted.mjs:1: a computed member of globalThis is forbidden unless its key is one plain string: it can reach eval or Function under any spelling.",
      "- hooks/zz-planted.sh: sh -n failed",
      `- scripts/zz-planted.mjs:1: ${shell}`,
      "- scripts/zz-unread.mjs: syntax check failed",
      "- scripts/zz-unread.mjs:1: this file could not be read past line 1: a template literal, a substitution or a comment there never ends, so whatever follows would go unchecked.",
      `- src/core/zz-long.mjs: ${ceiling}`,
      `- src/core/zz-planted.mjs:1: child_process exec (imported by name) ${exec}`
    ].sort(), run.stderr);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
