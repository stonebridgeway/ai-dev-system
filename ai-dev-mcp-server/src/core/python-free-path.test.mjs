import assert from "node:assert/strict";
import test from "node:test";
import { environmentWithoutPython, isPythonExecutable, isPythonShebang, planPythonFreePath } from "./python-free-path.mjs";

test("interpreters are recognised by name, and only interpreters", () => {
  for (const name of ["python", "python3", "python3.13", "python2.7"]) {
    assert.ok(isPythonExecutable(name, "linux"), name);
    assert.ok(isPythonExecutable(name, "darwin"), name);
  }
  for (const name of ["python3-config", "python3.13-config", "pythonista", "py", "Python3", "node", "pip3", "pydoc3"]) {
    assert.ok(!isPythonExecutable(name, "linux"), name);
  }
  for (const name of ["python.exe", "PYTHON.EXE", "python3.exe", "pythonw.exe", "py.exe", "pyw.exe", "python.bat", "python3.cmd", "python3.13.exe"]) {
    assert.ok(isPythonExecutable(name, "win32"), name);
  }
  // The bare name is not what Windows runs, and the POSIX names do not count there.
  for (const name of ["python", "python3", "pythonista.exe", "pip.exe", "node.exe", "python.exe.bak"]) {
    assert.ok(!isPythonExecutable(name, "win32"), name);
  }
});

test("a script's first line names Python, or it does not", () => {
  for (const head of ["#!/usr/bin/python3\nimport sys", "#!/usr/bin/env python3 -I", "#! /usr/bin/python3.12", "#!/usr/bin/env python\r\n", "#!/opt/venv/bin/python"]) {
    assert.ok(isPythonShebang(head), head);
  }
  for (const head of ["#!/bin/sh\nexec python3 \"$@\"", "#!/usr/bin/env node", "\u007fELF", "", "#!/usr/bin/env pythonista", "# python script, no shebang"]) {
    assert.ok(!isPythonShebang(head), head);
  }
});

test("off Windows a folder with an interpreter or a Python script is mirrored without them; an unlistable one goes", () => {
  const listings = {
    "/usr/local/bin": ["node", "npm"],
    "/usr/bin": ["env", "git", "python3", "python3.12", "python3-config", "sh", "pip3", "lsb_release"],
    "/home/me/.pyenv/shims": ["python", "pip"],
    "/opt/tools": ["pydoc3"],
    "/opt/scanners": ["semgrep", "trivy"]
  };
  const scripts = new Set(["/usr/bin/pip3", "/usr/bin/lsb_release", "/opt/scanners/semgrep"]);
  const plan = planPythonFreePath({
    pathValue: "/usr/local/bin::/usr/bin:/home/me/.pyenv/shims:/opt/tools:/opt/scanners:/gone",
    platform: "linux",
    listDirectory: (directory) => {
      if (!(directory in listings)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return listings[directory];
    },
    isPythonScript: (directory, name) => scripts.has(`${directory}/${name}`)
  });
  assert.deepEqual(plan, [
    { directory: "/usr/local/bin", action: "keep" },
    { directory: "/usr/bin", action: "mirror", names: ["env", "git", "python3-config", "sh"] },
    { directory: "/home/me/.pyenv/shims", action: "mirror", names: ["pip"] },
    { directory: "/opt/tools", action: "keep" },
    { directory: "/opt/scanners", action: "mirror", names: ["trivy"] },
    { directory: "/gone", action: "drop", reason: "cannot be listed" }
  ]);
});

test("Windows: semicolons, any case, the Store alias, pyenv-win's batch shims and pip launchers — dropped, not mirrored", () => {
  const listings = {
    "C:\\hostedtoolcache\\windows\\node\\24.10.0\\x64": ["node.exe", "npm.cmd", "npx.cmd"],
    "C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64": ["Python.exe", "pythonw.exe"],
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps": ["python.exe", "python3.exe", "winget.exe"],
    "C:\\Users\\me\\.pyenv\\pyenv-win\\shims": ["python.bat", "pip.bat"],
    "C:\\Windows": ["py.exe", "explorer.exe"],
    "C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\Scripts": ["pip.exe", "pip3.12.exe", "wheel.exe"],
    "C:\\Windows\\System32": ["cmd.exe", "where.exe"]
  };
  const plan = planPythonFreePath({
    pathValue: Object.keys(listings).join(";"),
    platform: "win32",
    listDirectory: (directory) => listings[directory]
  });
  assert.deepEqual(plan.filter((step) => step.action === "keep").map((step) => step.directory), [
    "C:\\hostedtoolcache\\windows\\node\\24.10.0\\x64",
    "C:\\Windows\\System32"
  ]);
  assert.deepEqual(plan.filter((step) => step.action === "drop").map((step) => step.reason), [
    "holds Python.exe, pythonw.exe",
    "holds python.exe, python3.exe",
    "holds python.bat",
    "holds py.exe",
    "holds pip.exe, pip3.12.exe"
  ]);
  assert.ok(!plan.some((step) => step.action === "mirror"));
});

test("the child environment has one PATH, in one spelling, and no interpreter variables", () => {
  const env = environmentWithoutPython({
    Path: "C:\\old",
    PATH: "/old",
    path: "/older",
    AI_DEV_PYTHON: "python3",
    ai_dev_python: "python",
    BGE_M3_PYTHON: "/venv/bin/python",
    AI_DEV_EMBEDDINGS_PYTHON: "/venv/bin/python",
    AI_DEV_PYTHON_BASE: "/usr/bin/python3",
    HOME: "/home/me",
    AI_DEV_HOME: "/data/.ai-dev"
  }, "/usr/local/bin");
  assert.deepEqual(env, { HOME: "/home/me", AI_DEV_HOME: "/data/.ai-dev", PATH: "/usr/local/bin" });
});
