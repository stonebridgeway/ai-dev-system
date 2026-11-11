import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { closing, codeTokens } from "./code-tokens.mjs";
import { forbiddenCalls } from "./forbidden-calls.mjs";

const rules = (source, options) => forbiddenCalls(source, options).map((finding) => finding.rule);

test("the six spellings the gate let through are each refused", () => {
  const cases = [
    ['import * as childProcess from "node:child_process";\nchildProcess.exec(command);', ["child_process.exec"]],
    ['import cp from "node:child_process";\ncp.exec(command);', ["child_process.exec"]],
    ['import { execSync } from "node:child_process";\nexecSync(command);', ["child_process.exec"]],
    ['import { spawn } from "node:child_process";\nspawn(command, [], { "shell": true });', ["shell"]],
    ['import { spawn } from "node:child_process";\nspawn(command, [], { shell: "/bin/sh" });', ["shell"]],
    ['globalThis["ev" + "al"](command);', ["global-member"]]
  ];
  for (const [source, expected] of cases) assert.deepEqual(rules(source), expected, source);
});

test("the spellings the gate always knew are still refused", () => {
  assert.deepEqual(rules("eval(source);"), ["eval"]);
  assert.deepEqual(rules('const make = new Function("return 1");'), ["Function"]);
  assert.deepEqual(rules('spawn("x", [], { shell: true });'), ["shell"]);
  assert.deepEqual(rules('import { exec } from "node:child_process";'), ["child_process.exec"]);
  assert.deepEqual(rules('const { exec } = require("child_process");'), ["child_process.exec"]);
  assert.deepEqual(rules('require("child_process").exec("ls");'), ["child_process.exec"]);
});

test("every way of reaching exec through the module is refused", () => {
  const refused = [
    'import { exec as run } from "child_process";',
    'import cp, { spawn } from "node:child_process";\ncp.execSync("x");',
    'import * as cp from "node:child_process";\ncp?.exec("x");',
    'import * as cp from "node:child_process";\ncp["exec"]("x");',
    'import * as cp from "node:child_process";\nconst name = "exec";\ncp[name]("x");',
    'import * as cp from "node:child_process";\nconst { execSync: run } = cp;',
    'const cp = require("node:child_process");\ncp.exec("x");',
    'const { "execSync": run } = require("child_process");',
    'const cp = await import("node:child_process");\ncp.exec("x");',
    'const { exec } = await import("node:child_process");',
    '(await import("node:child_process")).execSync("x");',
    'import("node:child_process").then(({ exec }) => exec("x"));',
    'import("node:child_process").then((cp) => cp.exec("x"));',
    'export { exec } from "node:child_process";'
  ];
  for (const source of refused) assert.ok(rules(source).includes("child_process.exec"), source);
});

test("eval and the Function constructor are refused however they are reached, and allowed where a test needs them", () => {
  for (const source of [
    "(0, eval)(source);",
    "const run = eval;",
    "globalThis.eval(source);",
    'window["eval"](source);',
    "Function(\"return this\")();",
    "const Make = Function;",
    '({}).constructor.constructor("return 1")();'
  ]) {
    assert.ok(rules(source).length > 0, source);
  }
  assert.deepEqual(rules("window[key]();"), ["global-member"], "a computed member of a global cannot be read");
  assert.deepEqual(rules('window["Function"]("x");'), ["global-member"]);
  // The desktop tests show the page's policy refuses these, so they may write them.
  assert.deepEqual(rules('eval("1"); new Function("return 1");', { allowEval: true }), []);
  assert.deepEqual(rules('window["eval"]("1");', { allowEval: true }), []);
  assert.deepEqual(rules('spawn("x", [], { shell: true });', { allowEval: true }), ["shell"], "the shell rule holds in tests too");
});

test("a shell option is refused unless it is plainly off", () => {
  for (const value of ["true", '"/bin/sh"', "'cmd.exe'", "1", "process.env.SHELL", 'process.platform === "win32"', "!1"]) {
    assert.deepEqual(rules(`spawn("x", [], { shell: ${value} });`), ["shell"], value);
  }
  assert.deepEqual(rules('spawn("x", [], { cwd, shell });'), ["shell"], "a shorthand nobody can read");
  for (const value of ["false", "null", "undefined", "0", '""', "''"]) {
    assert.deepEqual(rules(`spawn("x", [], { shell: ${value} });`), [], value);
  }
  assert.deepEqual(rules('spawn("x", [], { windowsHide: true, shell: false, });'), []);
  assert.deepEqual(rules("const { shell } = options;"), [], "reading the option is not setting it");
  // Set on an options object afterwards it is the same option.
  assert.deepEqual(rules("options.shell = true;"), ["shell"]);
  assert.deepEqual(rules('options["shell"] = "/bin/sh";'), ["shell"]);
  assert.deepEqual(rules("options.shell = false;\nif (options.shell === true) {}"), [], "off, and compared");
  assert.deepEqual(rules('spawn("x", [], { ["shell"]: true });'), ["shell"], "a computed key that is one plain string");
  assert.deepEqual(rules('spawn("x", [], { "sh\\u0065ll": true });'), ["shell"], "escaped");
});

test("what only looks like a forbidden call passes: strings, comments, templates, regular expressions, other objects' exec", () => {
  const honest = [
    'const text = "eval(x) and shell: true and import { exec } from \\"child_process\\"";',
    "// eval(x); shell: true; new Function()",
    "/* import * as cp from 'node:child_process'; cp.exec() */",
    "const help = `Use eval( with care; { shell: true } is refused; ${name} is fine`;",
    "const pattern = /\\beval\\s*\\(/; const other = /shell\\s*:\\s*true/g;",
    "const match = /x/.exec(line); const again = PATTERN.exec(text);",
    'new Worker(source, { eval: true, workerData: {} });',
    'import { spawn, spawnSync, execFile, execFileSync } from "node:child_process";\nexecFile("git", ["status"]);',
    'const { spawnSync } = await import("node:child_process");',
    "class Box { constructor(value) { this.value = value; } }",
    "if (value instanceof Function) {}",
    "const source = Function.prototype.toString.call(handler);",
    'const page = await browser.$eval("body", (node) => node.textContent);'
  ];
  for (const source of honest) assert.deepEqual(rules(source), [], source);
});

test("the reader keeps lines, reads template substitutions as code, and survives what it does not understand", () => {
  const findings = forbiddenCalls("const a = 1;\n\n/* two\nlines */\nconst b = `x ${eval(y)} z`;\n");
  assert.deepEqual(findings.map((finding) => [finding.rule, finding.line]), [["eval", 5]]);
  assert.deepEqual(rules("const nested = `a ${`b ${eval(c)}`}`;"), ["eval"]);
  assert.deepEqual(rules("#!/usr/bin/env node\neval(x);"), ["eval"]);
  assert.deepEqual(codeTokens('a?.b "s" 1.5').map((token) => [token.type, token.value]), [["name", "a"], ["punct", "."], ["name", "b"], ["string", "s"], ["number", "1.5"]]);
  // Unterminated strings, comments and templates end the file rather than the reader.
  for (const broken of ['const a = "open', "/* never closed", "const t = `open ${", "const r = /never closed"]) {
    assert.doesNotThrow(() => forbiddenCalls(broken), broken);
  }
});

// Spellings the gate once let through, and honest lines it once refused.
test("spellings the gate once let through are each refused", () => {
  const BT = "`";
  const refused = {
    "optional computed member": 'import * as cp from "node:child_process";\ncp?.["exec"]("ls");',
    "namespace .default.exec": 'import * as ns from "node:child_process";\nns.default.exec("ls");',
    "default destructured": 'const { default: cp } = await import("node:child_process");\ncp.exec("ls");',
    "(await import()).default": 'const cp = (await import("node:child_process")).default;\ncp.exec("ls");',
    "import { default as cp }": 'import { default as cp } from "node:child_process";\ncp.execSync("ls");',
    "template module name": `const cp = require(${BT}child_process${BT});\ncp.exec("ls");`,
    "plain re-binding": 'const cp = require("child_process");\nconst c2 = cp;\nc2.exec("ls");',
    "rest element": 'const { ...all } = require("child_process");\nall.exec("ls");',
    "then(async (cp) =>)": 'import("child_process").then(async (cp) => cp.exec("ls"));',
    "then(function (cp))": 'import("child_process").then(function (cp) { cp.exec("ls"); });',
    "then(function named(cp))": 'import("child_process").then(function named(cp) { cp.exec("ls"); });',
    "hex escape in a key": 'const cp = require("child_process");\ncp["\\x65xec"]("ls");',
    "unicode escape in a key": 'const cp = require("child_process");\ncp["\\u0065xec"]("ls");',
    "unicode escape in the module name": 'const cp = require("child\\u005fprocess");\ncp.exec("ls");',
    "escaped eval": '\\u0065val("1+1");',
    "escaped member name": 'const cp = require("child_process");\ncp.\\u0065xec("ls");',
    "paren-wrapped require": 'const cp = (require("child_process"));\ncp.exec("ls");',
    "globalThis.Function": 'globalThis.Function("return 1")();',
    "globalThis?.[]": 'globalThis?.["ev" + "al"]("1");',
    "(globalThis)[]": '(globalThis)["ev" + "al"]("1");',
    "global.globalThis[]": 'global.globalThis["ev" + "al"]("1");',
    "a global re-bound": 'const g = globalThis;\ng["ev" + "al"]("1");',
    "eval in a ternary": 'const f = x ? eval : null;\nf("1");',
    "eval destructured from a global": 'const { eval: run } = globalThis;\nrun("1");'
  };
  for (const [name, source] of Object.entries(refused)) assert.ok(rules(source).length > 0, `${name}: ${source}`);
});

test("honest code the gate once refused passes now", () => {
  const honest = {
    "electron's shell": 'import { app, shell } from "electron";\nshell.openExternal("https://example.invalid");',
    "a default import beside it": 'import electron, { shell } from "electron";\nshell.beep();',
    "a parameter pattern": "function run({ cmd, shell }) { return shell ? 1 : 0; }",
    "an arrow's parameter pattern": "const pick = ({ shell }) => shell;",
    "an async arrow's": "const pick = async ({ shell, cwd }) => [shell, cwd];",
    "a method's": "const o = { run({ shell }) { return shell; } };",
    "a for-of pattern": "for (const { shell } of list) console.log(shell);",
    "a nested pattern": "const { options: { shell } } = config;",
    "an argument": "describe(name, shell, rest);",
    "an array": "const names = [bash, shell, zsh];",
    "a re-export": 'export { shell } from "electron";',
    "an object key on a worker": "new Worker(source, { eval: true });",
    "a regular expression after a block": "function f() {}\n/`/.test(s);\nconst y = 1;"
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
});

test("a regular expression that begins a line after a block does not hide what follows it, and an unclosed template refuses the file", () => {
  const BT = "`";
  // The backtick in the expression used to open a template that ran to the end of the file.
  const source = `function f() {}\n/${BT}/.test(s);\nconst cp = require("child_process");\ncp.exec("ls");\nconst t = ${BT}x${BT};`;
  assert.deepEqual(forbiddenCalls(source).map((finding) => [finding.rule, finding.line]), [["child_process.exec", 4]]);
  // A file read past its end is refused, not passed: whatever followed went unchecked.
  for (const broken of [`const t = ${BT}open`, `const t = ${BT}a \${b`, "/* never closed\neval(x);"]) {
    assert.deepEqual(rules(broken), ["unread"], broken);
  }
  assert.equal(codeTokens(`const t = ${BT}open`).unterminated, 1);
  // A substitution that begins with a regular expression: its slash is not a division.
  const regexInside = `lines.push(${BT}### \${/^phase\\s+\\d+/i.test(title) ? title : ${BT}Phase \${n}${BT}}${BT});\nconst note = ${BT}a ${BT};\neval(x);`;
  assert.deepEqual(forbiddenCalls(regexInside).map((finding) => [finding.rule, finding.line]), [["eval", 3]]);
  assert.equal(codeTokens(`const t = ${BT}a${BT};`).unterminated, undefined);
  assert.deepEqual(codeTokens(`a?.[b] ${BT}plain${BT}`).map((token) => [token.type, token.value]), [["name", "a"], ["punct", "["], ["name", "b"], ["punct", "]"], ["string", "plain"]]);
});

// Spellings inside the contract that still passed, three of them after an earlier fix, and what the reader got wrong.
test("spellings inside the contract the gate let through are each refused", () => {
  const LS = String.fromCharCode(0x2028);
  const refused = {
    "shell in a parameter's default": "function run(cmd, options = { shell: true }) {\n  return spawnSync(cmd, [], options);\n}",
    "shell in an arrow's default": "const run = (cmd, opts = { shell: true }) => spawnSync(cmd, [], opts);",
    "shell in what for-of iterates": "for (const options of [{ shell: true }]) {\n  spawnSync(cmd, [], options);\n}",
    "shell in a default inside a pattern": "const { options = { shell: true } } = config;",
    "shell in a heritage call": "class Runner extends make({ shell: true }) {}",
    "eval by a quoted key": 'const { "eval": run } = globalThis;\nrun("1");',
    "eval by a computed key": 'const { ["eval"]: run } = globalThis;',
    "Function by a quoted key": 'const { "Function": F } = globalThis;',
    "a computed key out of a global": "const { [key]: f } = globalThis;",
    "Function.call": 'Function.call(null, "return 1")();',
    "Function.apply": 'Function.apply(null, ["return 1"])();',
    "globalThis.Function.call": 'globalThis.Function.call(null, "return 1")();',
    ".constructor.constructor.call": '({}).constructor.constructor.call(null, "return 1")();',
    "computed constructor": '({})["constructor"]["constructor"]("return 1")();',
    "tagged constructor": "({}).constructor.constructor`return 1`();",
    "Function.prototype.constructor": 'const F = Function.prototype.constructor;\nF("return 1")();',
    "shell ??=": "options.shell ??= true;",
    "shell ||=": 'options.shell ||= "/bin/sh";',
    "shell getter": 'spawn("x", [], { get shell() { return true; } });',
    "shell method": 'spawn("x", [], { shell() {} });',
    "lazy module ??=": 'let cp;\nasync function load() {\n  cp ??= await import("node:child_process");\n  return cp.exec("ls");\n}',
    "lazy module ||=": 'let cp;\ncp ||= require("node:child_process");\ncp.execSync("ls");',
    "module in parentheses": 'import * as cp from "node:child_process";\n(cp).exec("ls");',
    "module last in a list": 'import * as cp from "node:child_process";\n(0, cp)["execSync"]("ls");',
    "global last in a list": '(0, globalThis)["ev" + "al"]("1");',
    "?. then a comment": 'import * as cp from "node:child_process";\ncp?./* x */["exec"]("ls");',
    "?. then a line break": 'globalThis?.\n  ["ev" + "al"]("1");',
    "export *": 'export * from "node:child_process";',
    "export * as": 'export * as cp from "node:child_process";',
    "export { default }": 'export { default } from "node:child_process";',
    "module.exports =": 'module.exports = require("node:child_process");',
    "exports.x =": 'exports.cp = require("node:child_process");',
    "module.exports spread": 'module.exports = { ...require("child_process") };',
    "export default an alias": 'import * as cp from "node:child_process";\nexport default cp;',
    "export { alias }": 'import * as cp from "node:child_process";\nexport { cp };',
    "module.require": 'const cp = module.require("child_process");\ncp.exec("ls");',
    "a trailing comma": 'const cp = require("child_process",);\ncp.exec("ls");',
    "import() with options": 'const cp = await import("node:child_process", {});\ncp.exec("ls");',
    "await (import())": 'const { exec } = await (import("child_process"));',
    "ns.default re-bound": 'import * as ns from "child_process";\nconst cp = ns.default;\ncp.exec("ls");',
    "(cp) re-bound": 'const cp = require("child_process");\nconst c2 = (cp);\nc2.exec("ls");',
    ".then on a bound import()": 'const loading = import("child_process");\nloading.then((cp) => cp.exec("ls"));',
    "an awaited bound import() taken apart": 'const loading = import("child_process");\nconst { exec } = await loading;',
    "((globalThis))[]": '((globalThis))["ev" + "al"]("1");',
    "global.globalThis re-bound": 'const g = global.globalThis;\ng["ev" + "al"]("1");',
    "false, then || on the next line": 'spawn("x", [], { shell: false\n  || "/bin/sh" });',
    "a long \\u{} escape in a name": "\\u{0000065}val(\"1\");",
    "a long \\u{} escape in the module name": 'const cp = require("child\\u{000005f}process");\ncp.exec("ls");',
    "an octal escape in the module name": 'const cp = require("child\\137process");\ncp.exec("ls");',
    "an octal escape in a key": 'spawn("x", [], { "sh\\145ll": true });',
    "a line continuation in the module name": 'const cp = require("child_\\\nprocess");\ncp.exec("ls");'
  };
  for (const [name, source] of Object.entries(refused)) assert.ok(rules(source).length > 0, `${name}: ${source}`);
  // A division the reader took for a regular expression used to swallow the next line; a // comment, a file of CRs.
  const lines = (source) => forbiddenCalls(source).map((finding) => [finding.rule, finding.line]);
  assert.deepEqual(lines('import * as cp from "node:child_process";\nconst kb = stats.in / 1024\ncp.exec("ls")'), [["child_process.exec", 3]]);
  assert.deepEqual(lines('const half = count++ / 2\neval("1")'), [["eval", 2]]);
  // `of` is a name as well as a keyword: a slash after it that does not close on its line divides.
  assert.deepEqual(lines('const of = 10;\nconst half = of / 2\neval("1");'), [["eval", 3]]);
  // After a postfix `++` the slash divides even where a closing one follows on the line.
  assert.deepEqual(lines('const x = n++ / 2, y = `/`;\neval("1");'), [["eval", 2]]);
  assert.deepEqual(lines('const total = {\n  a: 1\n}\n/ 2; eval("1");'), [["eval", 4]]);
  assert.deepEqual(lines('// note\reval("1");'), [["eval", 2]]);
  assert.deepEqual(lines(`// note${LS}eval("1");`), [["eval", 2]]);
  assert.deepEqual(lines('const a = 1;\r\nconst b = 2;\r\neval("1");'), [["eval", 3]], "CRLF counts once");
});

test("valid code the reader took for an unclosed template or comment passes, and honest look-alikes stay honest", () => {
  const BT = "`";
  const honest = {
    "a regular expression after if (…)": `if (ready) /${BT}/.test(line);\nconst a = 1;`,
    "after while (…)": "while (more()) /[/*]/.test(next());\nconst a = 1;",
    "after for (…)": `for (const line of lines) /${BT}/.test(line);\nconst t = ${BT}x${BT};`,
    "after export default": `export default /${BT}/;\nconst t = ${BT}x${BT};`,
    "after a block on the same line": `function f() {} /${BT}/.test(s);\nconst t = 1;`,
    "a division after a property named in": `const r = traffic.in / total, unit = ${BT}/s${BT};\nconst t = ${BT}x${BT};`,
    "a division after an object literal": `const r = {}.size / 2, unit = ${BT}/s${BT};`,
    "a division after a call": `const r = f(x) / 2, unit = ${BT}/s${BT};`,
    "a method named eval": "const o = { eval() { return 1; } };",
    "an object key named Function": "const types = { Function: describeFunction, String: describeString };",
    "uncurrying this": "const call = Function.call.bind(Function.call);",
    "a constructor's name": "const name = this.constructor.name;",
    "a constructor handed on": "const Kind = value.constructor;",
    "a call of what f returns": 'const page = f(globalThis)["innerWidth"];',
    "a shell option plainly off with a line break": 'spawn("x", [], {\n  shell: false\n});',
    "options.shell ??= false": "options.shell ??= false;",
    "reading the option": "const useShell = options.shell ?? false;",
    "spawn re-exported by name": 'export { spawn } from "node:child_process";'
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
});

test("the reader stays linear where its questions used to search: one minified line, long chains", () => {
  const timed = (source) => {
    const started = performance.now();
    forbiddenCalls(source);
    return performance.now() - started;
  };
  // Before, 448 kB of `x={}/1;` on one line took 10 s and 166 kB of re-bindings in reverse order 8.6 s.
  assert.ok(timed("x={}/1;".repeat(64000)) < 4000, "one line");
  const reverse = [];
  for (let index = 8000; index >= 1; index -= 1) reverse.push(`const c${index + 1} = c${index};`);
  const chain = `${reverse.join("\n")}\nconst c1 = require("child_process");\nc8001.exec("ls");`;
  assert.ok(timed(chain) < 4000, "re-bindings in reverse order");
  assert.deepEqual(rules(chain), ["child_process.exec"], "and the chain is still followed to its end");
  assert.ok(timed(`x = globalThis${".globalThis".repeat(20000)}["a"];`) < 4000, "a chain of globals");
});

// A space JavaScript ends a name at, a label's or a case's block taken for an object literal, a comma list around a
// re-bound value, and three ways to the module the gate did not know.
test("a space that ends a name, a label's or a case's block, a comma list and other ways to the module are each refused", () => {
  const NBSP = String.fromCharCode(0xa0);
  const IDEOGRAPHIC = String.fromCharCode(0x3000);
  const lines = (source) => forbiddenCalls(source).map((finding) => [finding.rule, finding.line]);
  const refused = {
    "eval before a no-break space": [`eval${NBSP}("1");`, [["eval", 1]]],
    "Function before an ideographic space": [`Function${IDEOGRAPHIC}("return 1")();`, [["Function", 1]]],
    "the module's exec past a no-break space": [`import * as cp from "node:child_process";\ncp${NBSP}.exec("ls");`, [["child_process.exec", 2]]],
    "require before a no-break space": [`const cp = require${NBSP}("child_process");\ncp.exec("ls");`, [["child_process.exec", 2]]],
    "a shell key before a no-break space": [`spawn("x", [], { shell${NBSP}: true });`, [["shell", 1]]],
    "a label's block": ['run: {\n  eval("1")\n  {}\n}', [["eval", 2]]],
    "a case's block": ["switch (k) {\n  case 1: {\n    Function(code)\n    {}\n  }\n}", [["Function", 3]]],
    "a default's block": ['switch (k) {\n  default: {\n    eval("1")\n    {}\n  }\n}', [["eval", 3]]],
    "a case after a conditional": ['switch (k) {\n  case a ? b : c: {\n    eval("1")\n    {}\n  }\n}', [["eval", 3]]],
    "a label's block, then a regular expression": ['run: {}\n/`/.test(s);\neval("1");', [["eval", 3]]],
    "a global in a comma list": ['const g = (0, globalThis);\nnew g.Function("x");', [["Function", 2]]],
    "a global in a comma list, its member": ["let g;\ng = (0, window);\ng[k];", [["global-member", 3]]],
    "the module in a comma list, used above": ['import * as cp from "node:child_process";\nexport function run() { return proc.exec("ls"); }\nconst proc = (0, cp);', [["child_process.exec", 2]]],
    "its default taken out below its use": ['import * as cp from "node:child_process";\nfunction run() { return y.exec("ls"); }\nconst { default: y } = cp;', [["child_process.exec", 2]]],
    "process.getBuiltinModule": ['process.getBuiltinModule("node:child_process").exec("ls");', [["child_process.exec", 1]]],
    "getBuiltinModule bound": ['const cp = globalThis.process.getBuiltinModule("child_process");\ncp.execSync("ls");', [["child_process.exec", 2]]],
    "getBuiltinModule taken apart": ['const { exec } = process.getBuiltinModule("child_process");', [["child_process.exec", 1]]],
    'module.exports["cp"] =': ['module.exports["cp"] = require("node:child_process");', [["child_process.exec", 1]]],
    'exports["cp"] =': ['exports["cp"] = require("child_process");', [["child_process.exec", 1]]],
    'module["exports"] =': ['module["exports"] = require("child_process");', [["child_process.exec", 1]]],
    "a division after a class expression": ['const C = class {} / 2; eval("1"); const r = 1 / 1;', [["eval", 1]]],
    "a division after a function expression": ['const f = function () {} / 2; eval("1"); const r = 1 / 1;', [["eval", 1]]],
    "a regular expression after a class declaration": ['class A {}\n/`/.test(s);\neval("1");', [["eval", 3]]],
    "after export default class": ['export default class {}\n/`/.test(s);\neval("1");', [["eval", 3]]],
    "a key named class, then a literal": ["const o = { class: 1, options: { shell: true } };", [["shell", 1]]],
    "a label after ??": ['const a = b ?? c;\nrun: {\n  eval("1")\n  {}\n}', [["eval", 3]]],
    "a literal opening a substitution": ["const t = `${{ shell: true }.shell}`;", [["shell", 1]]]
  };
  for (const [name, [source, expected]] of Object.entries(refused)) assert.deepEqual(lines(source), expected, `${name}: ${source}`);
});

test("honest code stays honest past the fixes for spaces, blocks and comma lists", () => {
  const MATH_X = String.fromCodePoint(0x1d465);
  const honest = {
    "a name that only begins with another": `const ${MATH_X}eval = 1;`,
    "a method in a literal after a key": "const o = { a: { eval() { return 1; } } };",
    "a method in a literal after a conditional": "const o = x ? { eval() {} } : null;",
    "a literal after a conditional's colon, where statements stand": "ready ? run() : { eval() {} };",
    "a key named case": "const o = { case: { eval() {} } };",
    "a rest element beside spawn": 'const cp = require("child_process");\nconst { spawn, ...others } = cp;\nspawn("x");',
    "another module through getBuiltinModule": 'const { DatabaseSync } = process.getBuiltinModule("node:sqlite");',
    "a member of the module in a comma list": 'import * as cp from "node:child_process";\nconst start = (0, cp.spawn);\nstart("x");',
    "spawn put in a table": 'const cp = require("child_process");\nconst table = {};\ntable["spawn"] = cp.spawn;',
    "from as a property": 'x.from\n"child_process"'
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // A name ends where JavaScript ends it, and a letter outside the basic plane is one letter.
  const NBSP = String.fromCharCode(0xa0);
  assert.deepEqual(codeTokens(`eval${NBSP}("1")`).map((token) => [token.type, token.value]), [["name", "eval"], ["punct", "("], ["string", "1"], ["punct", ")"]]);
  assert.deepEqual(codeTokens(`${MATH_X}1 + y`).filter((token) => token.type === "name").map((token) => token.value), [`${MATH_X}1`, "y"]);
  // A middle dot goes on a name and cannot begin one; what can neither is read as a sign, and the reader moves on.
  const MIDDLE_DOT = String.fromCharCode(0xb7);
  const GUILLEMET = String.fromCharCode(0xab);
  assert.deepEqual(codeTokens(`a${MIDDLE_DOT}b ${GUILLEMET}c`).map((token) => [token.type, token.value]), [["name", `a${MIDDLE_DOT}b`], ["punct", GUILLEMET], ["name", "c"]]);
  // Each `{` says whether it opens an object literal: not a label's, a case's or a class's.
  const opens = (source) => codeTokens(source).filter((token) => token.value === "{").map((token) => token.literal);
  // In a block `a: {` is one more label's: JavaScript reads `run: { a: { b: 1 } }` as blocks, and so does the reader.
  assert.deepEqual(opens("run: { a: { b: 1 } }"), [false, false]);
  assert.deepEqual(opens("run: { x = { b: 1 }; }"), [false, true]);
  assert.deepEqual(opens("switch (k) { case 1: { x = c ? { d: 1 } : { e: 2 }; } default: {} }"), [false, false, true, true, false]);
  assert.deepEqual(opens("const C = class { m() { return { a: 1 }; } };"), [false, false, true]);
});

test("the reader stays linear on brackets left open and on a from in every line", () => {
  const timed = (source) => {
    const started = performance.now();
    forbiddenCalls(source);
    return performance.now() - started;
  };
  // Before, 128 kB of code a case's block made it misread took 84 s, and 384 kB of `x.from` before a module name 12 s.
  assert.ok(timed(`${"[".repeat(64000)}${")".repeat(64000)}`) < 4000, "closing brackets of another kind");
  assert.ok(timed('x.from\n"child_process"\n'.repeat(16000)) < 4000, "a from that begins no clause");
  assert.ok(timed('a, b\nfrom\n"child_process"\n'.repeat(16000)) < 4000, "nor after a list");
  // Before, 552 kB of keys in arrays nested 4000 deep took 12.8 s: each key climbed every bracket around it.
  assert.ok(timed(`const all = ${"[".repeat(4000)}${"{ shell: false },".repeat(32000)}${"]".repeat(4000)};`) < 4000, "keys deep in brackets");
  // Before, 63 kB of the module's computed members nested 16 000 deep took 2.6 s: each level copied what it held.
  assert.ok(timed(`import * as cp from "node:child_process";\n${"cp[".repeat(16000)}0${"]".repeat(16000)};`) < 4000, "computed members nested");
  assert.ok(timed(`${"globalThis[".repeat(16000)}0${"]".repeat(16000)};`) < 4000, "a global's members nested");
  // A closing bracket finds its own kind under a few left open, and looks no deeper than that.
  assert.equal(closing(codeTokens(`(${"[".repeat(3)})`), 0), 4);
  assert.equal(closing(codeTokens(`(${"[".repeat(100)})`), 0), -1);
});

// Two spellings an earlier change let through, and what the gate's own texts promised but it did not keep.
test("spellings the gate's own texts promised to refuse are each refused", () => {
  const BT = "`";
  const lines = (source, options) => forbiddenCalls(source, options).map((finding) => [finding.rule, finding.line]);
  const refused = {
    // A string after `as` in an export's clause.
    'export * as "cp" from': ['export * as "cp" from "node:child_process";', [["child_process.exec", 1]]],
    'export * as "default" from': ['export * as "default" from "node:child_process";', [["child_process.exec", 1]]],
    // What follows `return`, `yield`, a postfix `++` or `async` at a line break begins a statement.
    "a declaration after return⏎": [`function outer(ready) {\n  if (ready) return\n  function inner() {}\n  /${BT}/.test(s); eval("1"); const t = /${BT}/;\n}`, [["eval", 4]]],
    "a declaration after yield⏎": [`function* outer() {\n  yield\n  function inner() {}\n  /${BT}/.test(s); eval("1"); const t = /${BT}/;\n}`, [["eval", 4]]],
    "a class after n++⏎": [`let n = 0\nn++\nclass A {}\n/${BT}/.test(s); eval("1"); const t = /${BT}/;`, [["eval", 4]]],
    "a declaration after async⏎": [`let x, async = 1;\nx = async\nfunction f() {}\n/${BT}/.test(s); eval("1"); const t = /${BT}/;`, [["eval", 4]]],
    "a block after x++⏎": ['let x = 0\nx++\n{\n  eval("1")\n  {}\n}', [["eval", 4]]],
    "a block after yield⏎": ['function* g() {\n  yield\n  {\n    eval("1")\n    {}\n  }\n}', [["eval", 4]]],
    // Chains of assignments, above the use too.
    "let a = b = cp, used above": ['import * as cp from "node:child_process";\nlet b;\nexport function run() { return a.exec("ls"); }\nlet a = b = cp;', [["child_process.exec", 3]]],
    "const a = (b = cp)": ['import * as cp from "node:child_process";\nlet b;\nconst a = (b = cp);\na.exec("ls");', [["child_process.exec", 4]]],
    "const g = h = globalThis": ['let h;\nconst g = h = globalThis;\ng["ev" + "al"]("1");', [["global-member", 3]]],
    "[a = cp] = [], used above": ['import * as cp from "node:child_process";\nexport function run() { return a.exec("ls"); }\nconst [a = cp] = [];', [["child_process.exec", 2]]],
    // The module exported by a declaration.
    "export const run = cp": ['import * as cp from "node:child_process";\nexport const run = cp;', [["child_process.exec", 2]]],
    "export let run = require(…)": ['export let run = require("node:child_process");', [["child_process.exec", 1]]],
    "export const a = 1, run = (0, cp)": ['import * as cp from "node:child_process";\nexport const a = 1, run = (0, cp);', [["child_process.exec", 2]]],
    // A global's member keyed by a global's member; what follows a global's parentheses.
    "globalThis[globalThis.k]": ['globalThis.k = "ev" + "al";\nglobalThis[globalThis.k]("1");', [["global-member", 2]]],
    "globalThis[self.k]": ['globalThis[self.k]("1");', [["global-member", 1]]],
    "(0, globalThis).globalThis re-bound": ["const g = (0, globalThis).globalThis;\ng[k];", [["global-member", 2]]],
    // A body inside another's heritage or parameters.
    "class extends f(function () {}) {} / 2": ['const C = class extends f(function () {}) {} / 2; eval("1"); const r = 1 / 1;', [["eval", 1]]],
    "function (a = function () {}) {} / 2": ['const F = function (a = function () {}) {} / 2; eval("1"); const r = 1 / 1;', [["eval", 1]]],
    // `+ +` is a plus and a unary plus; `of` is a name outside a `for` head.
    "a + + /re/": [`const n = a + + /${BT}/.test(s);\neval("1");\nconst m = /${BT}/.test(s);`, [["eval", 2]]],
    "of / 2": ['const of = 10;\nconst half = of / 2; eval("1"); const r = 1 / 1;', [["eval", 2]]],
    // The loaders by other spellings.
    'process["getBuiltinModule"](…)': ['process["getBuiltinModule"]("child_process").exec("ls");', [["child_process.exec", 1]]],
    "(0, process.getBuiltinModule)(…)": ['(0, process.getBuiltinModule)("child_process").exec("ls");', [["child_process.exec", 1]]],
    "getBuiltinModule.call": ['process.getBuiltinModule.call(process, "child_process").exec("ls");', [["child_process.exec", 1]]],
    'module["require"](…)': ['module["require"]("child_process").exec("ls");', [["child_process.exec", 1]]],
    "(0, require)(…) bound": ['const cp = (0, require)("child_process");\ncp.exec("ls");', [["child_process.exec", 2]]],
    "require.apply": ['require.apply(null, ["child_process"]).execSync("ls");', [["child_process.exec", 1]]],
    'require(("child_process"))': ['require(("child_process")).exec("ls");', [["child_process.exec", 1]]]
  };
  for (const [name, [source, expected]] of Object.entries(refused)) assert.deepEqual(lines(source), expected, `${name}: ${source}`);
  // A script's HTML-like comment, read as the script reads it — and in a module, `<!--` is `< ! --`.
  const html = `const x = 1 <!-- ${BT}\neval("1")\n// ${BT}`;
  assert.deepEqual(lines(html, { script: true }), [["eval", 2]]);
  assert.deepEqual(lines(html), [], "in a module the backtick opens a template that holds the call");
  assert.deepEqual(lines(`const y = 2\n--> ${BT} a comment to the end of the line\neval("1")\n// ${BT}`, { script: true }), [["eval", 3]]);
  // `await` is a name in a script: a slash after it that does not close on its line divides, and the lines stay counted.
  assert.deepEqual(lines('let await = 4;\nconst h = await / 2\neval("1");'), [["eval", 3]]);
});

test("honest code stays honest past the fixes for statements, exports and loaders, and every new branch is held", () => {
  const BT = "`";
  const honest = {
    "return⏎, then a declaration and a regular expression": `export function quoted(s) {\n  if (!s) return\n  function inner() { return 1 }\n  /${BT}/.test(s) && inner()\n}`,
    "of in a for head": "for (const line of /x/.exec(s) ?? []) console.log(line);",
    "x++ / 2 divides": `const half = n++ / 2, unit = ${BT}/s${BT};`,
    "a declaration not exported": 'export const a = 1\nconst run = require("child_process");\nrun.spawn("x");',
    "spawn exported": 'import { spawn } from "node:child_process";\nexport const start = spawn;',
    "another module through a loader's other spelling": 'const { DatabaseSync } = process["getBuiltinModule"]("node:sqlite");',
    "a method named import": 'loader.import("child_process").exec("x");',
    "require handed to a function": 'foo(require)("child_process");',
    "a member of the module in parentheses": 'import * as cp from "node:child_process";\nconst start = (cp.spawn);\nstart.exec("x");',
    "a member of the module in parentheses, across a line": 'import * as cp from "node:child_process";\nconst start = (cp.\n  spawn);\nstart.exec("x");',
    "a global's member by a plain key": 'const page = globalThis["innerWidth"];'
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // Each branch of the class and function bodies: an async function expression, a class opening a
  // substitution, a key named class, parameters that hold a literal, `export { a as class }` then a literal at that depth.
  const refused = {
    "an async function expression divides": ['const f = async function () {} / 2; eval("1"); const r = 1 / 1;', ["eval"]],
    "a class opening a substitution": [`const t = ${BT}\${class {} / 2}${BT}; eval("1"); const r = 1 / 1;`, ["eval"]],
    "a key named class": ["const o = { class: { shell: true } };", ["shell"]],
    "a literal in a function's parameters": ['const f = function (o = { shell: true }) {} / 2; eval("1");', ["shell", "eval"]],
    "export { a as class }, then a literal": ["export { a as class };\nconst list = [{ shell: true }];", ["shell"]],
    "export * as class from, then a literal": ['export * as class from "x";\nconst o = { shell: true };', ["shell"]],
    "export * as class from with no semicolon, then a literal": ['export * as class from "x"\nconst o = { shell: true }', ["shell"]],
    "import { class as k }, then a literal": ['import { class as k } from "x";\nconst list = [{ shell: true }];', ["shell"]],
    "an awaited module last in a list, used above": ['import * as cp from "node:child_process";\nexport function run() { return x.exec("ls"); }\nconst x = (0, await cp);', ["child_process.exec"]]
  };
  for (const [name, [source, expected]] of Object.entries(refused)) assert.deepEqual(rules(source), expected, `${name}: ${source}`);
});

// What the texts promised of exports and patterns, two regressions — a member named like a keyword, a body's wait
// past a field of that name — a script's HTML-like comments, and the words after which a value or a statement begins.
test("spellings of exports, patterns, keyword-named members and HTML-like comments are each refused", () => {
  const BT = "`";
  const lines = (source, options) => forbiddenCalls(source, options).map((finding) => [finding.rule, finding.line]);
  const refused = {
    // An exported let or var the module is assigned to below.
    "export let run; run = cp": ['import * as cp from "node:child_process";\nexport let run;\nrun = cp;', [["child_process.exec", 3]]],
    "export var run; run = require(…)": ['export var run;\nrun = require("node:child_process");', [["child_process.exec", 2]]],
    // A pattern an export declares.
    "export const { default: run } = await import(…)": ['export const { default: run } = await import("node:child_process");', [["child_process.exec", 1]]],
    "export const { spawn, ...rest } = cp": ['import * as cp from "node:child_process";\nexport const { spawn, ...rest } = cp;', [["child_process.exec", 2]]],
    // A member named like a keyword at a line's end, and the statement is over.
    "o.default⏎function": [`const v = o.default\nfunction h(a = function () {}) {}\n/${BT}/.test(s); eval("1"); const t = /${BT}/;`, [["eval", 3]]],
    "it.return⏎{ }": [`const done = it.return\n{\n}\n/${BT}/.test(s); eval("1"); const t = /${BT}/;`, [["eval", 4]]],
    // A field named class or function, and #class, end the wait for a body.
    "a field named class": ["export class A {\n  class = 1;\n  static options = { shell: true };\n}", [["shell", 3]]],
    "a static field named function": ["export class A {\n  static function = 1;\n  options = { shell: true };\n}", [["shell", 3]]],
    "#class read": ["export class A {\n  #class = 1;\n  run() {\n    const n = this.#class;\n    const o = { shell: true };\n    return [n, o];\n  }\n}", [["shell", 5]]],
    "#class in a substitution": [`export class A {\n  #class = 1;\n  run() {\n    const t = ${BT}\${this.#class}${BT};\n    const o = { shell: true };\n    return [t, o];\n  }\n}`, [["shell", 5]]],
    // A global's own name after its parentheses.
    "(0, globalThis).globalThis[k]": ['(0, globalThis).globalThis[k]("1");', [["global-member", 1]]],
    "(globalThis).window[k]": ['(globalThis).window[k]("1");', [["global-member", 1]]],
    // After delete, in and instanceof a value begins; after break, continue and debugger a statement.
    "delete class {} / 2": ['x = delete class A {} / 2; eval("1"); const r = 1 / 1;', [["eval", 1]]],
    "in { } / 2": ['x = "a" in { a: 1 } / 2; eval("1"); const r = 1 / 1;', [["eval", 1]]],
    "debugger⏎/r/": ['debugger\n/r/ / 2; eval("1"); const r = 1 / 1;', [["eval", 2]]],
    "break outer⏎/r/": ['outer: for (;;) {\n  break outer\n  /r/ / 2; eval("1"); const r = 1 / 1;\n}', [["eval", 3]]]
  };
  for (const [name, [source, expected]] of Object.entries(refused)) assert.deepEqual(lines(source), expected, `${name}: ${source}`);
  // A script's `-->` begins a comment where no token stands before it on its line — after a comment that spans
  // a line too — and nowhere else.
  const comment = `${BT} a comment to the end of the line\neval("1")\n// ${BT}`;
  assert.deepEqual(lines(`let y = 2 /*\n*/ --> ${comment}`, { script: true }), [["eval", 3]], "after a comment that spans lines");
  assert.deepEqual(lines(`let y = 2\n/* c */ --> ${comment}`, { script: true }), [["eval", 3]], "after a one-line comment that begins its line");
  assert.deepEqual(lines(`let n = 2, m = 0, k = n${" ".repeat(300)}--> m; eval("1");`, { script: true }), [["eval", 1]], "after a token on its line, however far");
  assert.deepEqual(lines('let n = 2;\nwhile (n --> 0) eval("1");', { script: true }), [["eval", 2]], "mid-line it is a decrement and a comparison");
});

test("honest code stays honest past the fixes for exports, patterns and keyword-named members, and every branch is held", () => {
  const BT = "`";
  const honest = {
    // A value the module only takes part in is not the module.
    "cp !== undefined": 'import * as cp from "node:child_process";\nexport const available = cp !== undefined;',
    "cp ? … : …": 'import * as cp from "node:child_process";\nexport const kind = cp ? "real" : "none";',
    "cp === other": 'import * as cp from "node:child_process";\nimport other from "x";\nexport const same = cp === other;',
    'cp && "fork" in cp': 'const cp = require("node:child_process");\nexport let hasFork = cp && "fork" in cp;',
    "cp instanceof Object": 'import * as cp from "node:child_process";\nexport const keys = cp instanceof Object;',
    "cp ?? null, no plain value": 'import * as cp from "node:child_process";\nexport const run = cp ?? null;',
    "module.exports.ok = cp !== undefined": 'const cp = require("node:child_process");\nmodule.exports.ok = cp !== undefined;',
    "export default cp !== undefined": 'import * as cp from "node:child_process";\nexport default cp !== undefined;',
    "export const a = n++⏎, then a declaration": 'let n = 0\nexport const a = n++\nlet b = 1, run = require("node:child_process")\nrun.spawn("x")',
    "export, then a declaration without semicolons": 'export const a = 1\nconst b = 2, run = require("child_process")\nrun.spawn("x")',
    // Members named like keywords, and #class.
    "mod.default⏎{ block }": `const lib = mod.default\n{\n  console.log(lib)\n}\n/${BT}/.test(s) && console.log("tick")`,
    "it.return⏎class": `const r = it.return\nclass K extends mix(function () {}) {}\n/${BT}/.test(s) && console.log(r, K)`,
    "#class, then a literal divided": `export class A {\n  #class = 1;\n  run() {\n    this.#class;\n    const n = { valueOf() { return 4 } } / 2, s = ${BT}/${BT};\n    return [n, s];\n  }\n}`,
    // `of` in a for head's initialiser is a name.
    "of / 2 in an initialiser": `let of = 4, n = 0;\nfor (let i = of / 2, s = ${BT}/${BT}; i < 3; i++) n += i;`,
    "of / 2 past an empty initialiser": `let of = 4, s = "";\nfor (; of / 2 > 1; of -= 1) s += ${BT}/${BT};`
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // Each branch no other test holds.
  const held = {
    "for await (… of /re/)": [`async function f(s) {\n  for await (const m of /${BT}/.exec(s) ?? []) console.log(m);\n  eval("1");\n  const t = /${BT}/;\n}`, ["eval"]],
    "a keyed loader bound to a name": ['const cp = process["getBuiltinModule"]("child_process");\ncp.exec("ls");', ["child_process.exec"]],
    "a + +⏎{ … }": ['const n = a + +\n{ valueOf() { return 1 }, shell: true };\nspawn("x", [], n);', ["shell"]],
    "require.call(f(a, b), …)": ['require.call(f(a, b), "child_process").exec("ls");', ["child_process.exec"]],
    "export const a = b ||⏎ c, run = cp": ['import * as cp from "node:child_process";\nexport const a = b ||\n  c, run = cp;', ["child_process.exec"]],
    "a + ++⏎{ … }.shell": ["let x = a + ++\n{ shell: true }.shell;", ["shell"]],
    // And more: a chain of globals in parentheses, #class in a statement head's parentheses, `-->` first in a
    // file, a member named if, a prefix ++ at a line's end, a member named export, the ways a value ends.
    "(global.globalThis)[k]": ['(global.globalThis)[k]("1");', ["global-member"]],
    "if (this.#class) {}, then a literal": ["export class A {\n  #class = 1;\n  run(f) {\n    if (this.#class) {}\n    f({ shell: true });\n  }\n}", ["shell"]],
    "export * as class from, then a literal after ?": ['export * as class from "x";\nready ? { shell: true } : null;', ["shell"]],
    "this.#function in a call, then a literal in another": ["export class A {\n  #function = 1;\n  run(f, g) {\n    f(this.#function);\n    g({ shell: true });\n  }\n}", ["shell"]],
    "instanceof class {} / 2": ['x = a instanceof class A {} / 2; eval("1"); const r = 1 / 1;', ["eval"]],
    "o.if(x) / 2": ['const n = o.if(x) / 2; eval("1"); const r = 1 / 1;', ["eval"]],
    "this.#if(x) / 2": ['class A { #if(x) { return x } run(x) { const n = this.#if(x) / 2; eval("1"); const r = 1 / 1; } }', ["eval"]],
    "export const a = ++⏎b, run = cp": ['import * as cp from "node:child_process";\nlet b = 1;\nexport const a = ++\nb, run = cp;', ["child_process.exec"]],
    "export const a = o.export, run = cp": ['import * as cp from "node:child_process";\nexport const a = o.export, run = cp;', ["child_process.exec"]],
    "export let run = cp⏎, used": ['import * as cp from "node:child_process";\nexport let run = cp\nrun.spawn("x")', ["child_process.exec"]],
    "export const run = b = cp": ['import * as cp from "node:child_process";\nlet b;\nexport const run = b = cp;', ["child_process.exec"]],
    "export const run = cp, other = 1": ['import * as cp from "node:child_process";\nexport const run = cp, other = 1;', ["child_process.exec"]]
  };
  for (const [name, [source, expected]] of Object.entries(held)) assert.deepEqual(rules(source), expected, `${name}: ${source}`);
  assert.deepEqual(rules(`--> ${BT} a comment\neval("1")\n// ${BT}`, { script: true }), ["eval"], "a script's first line begins a line");
  // A value the module only takes part in is past the gate, a pattern's too; a global's own names only are passed.
  assert.deepEqual(rules('import * as cp from "node:child_process";\nexport const { default: run } = cp || fallback;'), []);
  assert.deepEqual(rules("const v = (0, globalThis).foo[k];"), []);
});

test("the reader stays linear on declarations without semicolons, chains of assignments and of loader names", () => {
  const timed = (source) => {
    const started = performance.now();
    forbiddenCalls(source);
    return performance.now() - started;
  };
  // Before, 364 kB of `export let aI = n++` with no semicolons took 110.9 s, assignments nested 16 000 deep in
  // parentheses 38.2 s, a chain of 16 000 assignments 7.8 s, and 172 kB of `["require"]` links 9.2 s.
  const n = 16000;
  const names = Array.from({ length: n }, (_, index) => `a${index}`);
  assert.ok(timed(`let n = 0\n${names.map((name) => `export let ${name} = n++\n`).join("")}`) < 4000, "exports with no semicolons");
  assert.ok(timed(names.map((name) => `export const ${name} = 1 `).join("")) < 4000, "exports on one line");
  assert.ok(timed(`let ${names.join(", ")};\n${names.map((name) => `${name} = `).join("")}0;`) < 4000, "a chain of assignments");
  assert.ok(timed(`let ${names.join(", ")};\n${names.map((name) => `${name} = (`).join("")}0${")".repeat(n)};`) < 4000, "assignments nested in parentheses");
  assert.ok(timed(`x${".require".repeat(n)};`) < 4000, "a chain of loader names");
  assert.ok(timed(`x${'["require"]'.repeat(n)};`) < 4000, "and keyed");
});

test("a heritage's substitutions, of as a name and a pattern assigned to an export are each refused, and each condition is held", () => {
  const BT = "`";
  const CP = 'import * as cp from "node:child_process";\n';
  const lines = (source, options) => forbiddenCalls(source, options).map((finding) => [finding.rule, finding.line]);
  const refused = {
    // A substitution in a class's heritage is a level of its own — an `=`, `=>`, `:` or `,` there ends no wait.
    "${a = 1} in a heritage": [`let a, x;\nconst f = () => Object;\nx = class extends f${BT}\${a = 1}${BT} {} / 2; eval("1"); const r = 1 / 1;`, [["eval", 3]]],
    "${(a) => 1} in a heritage": [`let x;\nconst f = () => Object;\nx = class extends f${BT}\${(a) => 1}${BT} {} / 2; eval("1"); const r = 1 / 1;`, [["eval", 3]]],
    "${a ? 1 : 2} in a heritage": [`let a, x;\nconst f = () => Object;\nx = class extends f${BT}\${a ? 1 : 2}${BT} {} / 2; eval("1"); const r = 1 / 1;`, [["eval", 3]]],
    "${a, b} in a heritage": [`let a, b, x;\nconst f = () => Object;\nx = class extends f${BT}\${a, b}${BT} {} / 2; eval("1"); const r = 1 / 1;`, [["eval", 3]]],
    // `of` past `in` and past the keyword is a name, and so is a member named for; a pattern assigned to an
    // exported let.
    "for (k in of / 2)": ['let of = 4, n = 0, k;\nfor (k in of / 2) n += k; eval("1"); n = n / 2;', [["eval", 2]]],
    "for (const k of of / 2 ? of : of)": ['let of = [4];\nfor (const k of of / 2 ? of : of) console.log(k); eval("1"); const r = 1 / 1;', [["eval", 2]]],
    "o.for(of / 2)": ['let of = 4;\nconst o = { for() {} };\no.for(of / 2); eval("1"); const r = 1 / 1;', [["eval", 3]]],
    "a⏎of / 2": ['let a = 1, of = 4;\na\nof / 2; eval("1"); const r = 1 / 1;', [["eval", 3]]],
    "({ default: run } = await import(…))": ['export let run;\n({ default: run } = await import("node:child_process"));', [["child_process.exec", 2]]],
    "({ default: run } = cp)": [`${CP}export let run;\n({ default: run } = cp);`, [["child_process.exec", 3]]],
    // Conditions no other test holds — a body's waits ended together, a label only on its own line,
    // break and continue ending a statement, the ways a whole value ends, an alias's value past its `.default`.
    "import { class as c, function as f }, then a literal": ['import { class as c, function as f } from "x";\nconst list = [{ shell: true }];', [["shell", 2]]],
    "break⏎n / 2": ['let n = 4;\nfor (;;) {\n  break\n  n / 2; eval("1"); const r = 1 / 1;\n}', [["eval", 4]]],
    "continue outer⏎/r/": ['outer: for (;;) {\n  continue outer\n  /r/ / 2; eval("1"); const r = 1 / 1;\n}', [["eval", 3]]],
    "break⏎/r/": ['for (;;) {\n  break\n  /r/ / 2; eval("1"); const r = 1 / 1;\n}', [["eval", 3]]],
    "continue⏎/r/": ['for (;;) {\n  continue\n  /r/ / 2; eval("1"); const r = 1 / 1;\n}', [["eval", 3]]],
    "export default cp at the file's end": [`${CP}export default cp`, [["child_process.exec", 2]]],
    "console.log(run = cp)": [`${CP}export let run;\nconsole.log(run = cp);`, [["child_process.exec", 3]]],
    "{ run = cp }": [`${CP}export let run;\n{ run = cp }`, [["child_process.exec", 3]]],
    "[run = cp]": [`${CP}export let run;\n[run = cp];`, [["child_process.exec", 3]]],
    "export const run = cp.default": [`${CP}export const run = cp.default;`, [["child_process.exec", 2]]],
    "export default cp.default": [`${CP}export default cp.default;`, [["child_process.exec", 2]]]
  };
  for (const [name, [source, expected]] of Object.entries(refused)) assert.deepEqual(lines(source), expected, `${name}: ${source}`);
  // What a `for` head binds before its `of` — a pattern, a parenthesis, a member of any name, `of` itself — and a regular
  // expression after that `of`.
  const iterated = (binding, script = false) => lines(`var of, x = {}, s = "";\nfor (${binding} of /${BT}/.exec(s) ?? []) console.log(of);\neval("1");\nconst t = /${BT}/;`, { script });
  for (const binding of ["const [m]", "const { m }", "(x)", "x.in", "x.of", "let of", "of"]) assert.deepEqual(iterated(binding, binding === "of"), [["eval", 3]], binding);
  // A regular expression's reading that failed tells a later one only where both stand in the same state: in a class of
  // characters or out of one.
  assert.deepEqual(lines(`var await = 2, s = "";\nvar r = await / "[" + /${BT}/.test(s);\neval("1");\nconst t = /${BT}/;`, { script: true }), [["eval", 3]]);
  assert.deepEqual(lines('var await = 2;\nvar r = await / "[" + await / "[/" + eval("1");', { script: true }), [["eval", 2]]);
  // A loader that is only part of a value is past the gate, as its header says: only the last item of a list is passed.
  // This holds the boundary its texts name; a gate that moved it would move them too.
  assert.deepEqual(lines('(null || require)("child_process").exec("ls");', { script: true }), []);
  // And a loader that is not the list's last item is called by no one: `(require, 0)(…)` calls 0.
  assert.deepEqual(lines('(require, 0)("child_process").exec("ls");', { script: true }), []);
});

test("honest code the gate once refused passes, and a value ends where the next line cannot carry it on", () => {
  const BT = "`";
  const CP = 'import * as cp from "node:child_process";\n';
  const honest = {
    // A value the module only takes part in, carried over lines, and a name bound to such a value.
    "cp⏎!== undefined": `${CP}export const available = cp\n  !== undefined;`,
    "cp⏎&& typeof cp.spawn": `${CP}export const canSpawn = cp\n  && typeof cp.spawn === "function";`,
    "cp⏎? … : …": `${CP}export const kind = cp\n  ? "real"\n  : "none";`,
    "export default cp⏎!== undefined": `${CP}export default cp\n  !== undefined;`,
    "module.exports.ok = cp⏎!== undefined": 'const cp = require("node:child_process");\nmodule.exports.ok = cp\n  !== undefined;',
    "cp⏎instanceof Object": `${CP}export const ok = cp\n  instanceof Object;`,
    "cp⏎!= null": `${CP}export const ok = cp\n  != null;`,
    "cp⏎`tag`": `${CP}export const t = cp\n  ${BT}x${BT};`,
    "cp⏎`${…}`": `${CP}export const t = cp\n  ${BT}\${1}${BT};`,
    'cp⏎+ ""': `${CP}export const s = cp\n  + "";`,
    "cp⏎in globalThis": `${CP}export const has = cp\n  in globalThis;`,
    "cp++": 'let cp = require("node:child_process");\nexport const n = cp++;',
    "a name bound to cp⏎? …, then indexed": `${CP}const parts = cp\n  ? ["x"]\n  : [];\nconsole.log(parts[0]);`,
    "a private field named like a local": `${CP}export class A {\n  #proc = cp;\n}\nconst proc = { exec() {} };\nproc.exec("x");`,
    "const ok = cp !== undefined; export { ok }": `${CP}const ok = cp !== undefined;\nexport { ok };`,
    "const ok = cp !== undefined; export default ok": `${CP}const ok = cp !== undefined;\nexport default ok;`,
    "let ok; ok = cp⏎!== undefined; export { ok }": `${CP}let ok;\nok = cp\n  !== undefined;\nexport { ok };`,
    // A local, a member, a parameter, a function or a class named like an exported let or var.
    "a local const": 'export let cp = null;\nexport function f() {\n  const cp = require("node:child_process");\n  return cp.spawn("x");\n}',
    "a local let, assigned below": 'import * as childProcess from "node:child_process";\nexport let runner = null;\nexport function f() {\n  let runner;\n  runner = childProcess;\n  return runner.spawn("x");\n}',
    "a second declarator": `${CP}export let run = null;\nexport function g() {\n  let a = 1, run = cp;\n  return [a, run];\n}`,
    "a declared pattern's name": `${CP}export let run = null;\nexport function g(o) {\n  let { x: run } = o;\n  run = cp;\n  return run;\n}`,
    "a declared array pattern": `${CP}export let run = null;\nexport function g(o) {\n  let [run] = o;\n  run = cp;\n  return run;\n}`,
    "a declared pattern's rest element": `${CP}export let run = null;\nexport function g(o) {\n  let { a, ...run } = o;\n  run = cp;\n  return [a, run];\n}`,
    "a rest parameter": `${CP}export let run = null;\nexport function g(...run) {\n  run = cp;\n  return run;\n}`,
    // A rest parameter binds a name; it spreads nothing.
    "a rest parameter, the module assigned to it": `${CP}export function g(...run) {\n  run = cp;\n  return run;\n}`,
    "an arrow's rest parameter named like an alias": `${CP}const run = cp;\nrun.spawn("x");\nexport const f = (...run) => run.length;`,
    "a method's rest parameter named like an alias": `${CP}const proc = cp;\nproc.spawn("x");\nexport class A {\n  m(...proc) {\n    return proc.length;\n  }\n}`,
    "a computed key's target": `${CP}export let run = null;\nexport function g(o, k) {\n  let { [k]: run } = o;\n  run = cp;\n  return run;\n}`,
    "an array pattern in an object pattern": `${CP}export let run = null;\nexport function g(o) {\n  let { a: [run] } = o;\n  run = cp;\n  return run;\n}`,
    "a declared pattern taking the module out": `${CP}export let run = null;\nexport function g() {\n  const { default: run } = cp;\n  return run.spawn("x");\n}`,
    "a member": `${CP}export let childProcess = null;\nexport function inject(target) {\n  target.childProcess = cp;\n}`,
    "a private member": `${CP}export let childProcess = null;\nexport class A {\n  #childProcess;\n  inject() {\n    this.#childProcess = cp;\n  }\n}`,
    "a parameter": `${CP}export var proc = null;\nexport function f(proc) {\n  proc = cp;\n  return proc.spawn("x");\n}`,
    "a parameter's pattern": `${CP}export let run = null;\nexport function g({ run }) {\n  run = cp;\n  return run;\n}`,
    "an arrow's parameter": `${CP}export let run = null;\nexport const f = (run) => {\n  run = cp;\n  return run;\n};`,
    "a lone arrow parameter": `${CP}export let run = null;\nexport const f = run => {\n  run = cp;\n  return run;\n};`,
    "a catch parameter": `${CP}export let run = null;\ntry {\n  run = 1;\n} catch (run) {\n  run = cp;\n}`,
    "a function": `${CP}export let run = null;\nexport function g() {\n  function run() {}\n  run = cp;\n  return run;\n}`,
    "a class": `${CP}export let run = null;\nexport function g() {\n  class run {}\n  return run;\n}\nrun = cp;`,
    // A const is never assigned: the assignment throws, and nothing goes out with it.
    "an exported const assigned": `${CP}export const run = 1;\nexport function swap() {\n  run = cp;\n}`,
    // A substitution's arrow in a heritage, `of` after typeof.
    "!class extends f`${(a) => a}` {} / 2": `const f = () => Object;\nconst n = !class extends f${BT}\${(a) => a}${BT} {} / 2 + "/${BT}".length;`,
    "for (typeof of / 2;;)": `let of = 4, s = "";\nfor (typeof of / 2; s.length < 1; ) s += ${BT}/${BT};`
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // What only begins an expression ends the value above it: the module is bound, or handed on, whole.
  const whole = {
    "cp⏎run.spawn": [`${CP}export const run = cp\nrun.spawn("x")`, ["child_process.exec"]],
    "cp⏎++n": [`${CP}let n = 0;\nexport default cp\n++n;`, ["child_process.exec"]],
    "cp⏎!n": [`${CP}let n = 0;\nexport const run = cp\n!n;`, ["child_process.exec"]],
    "cp⏎~n": [`${CP}let n = 0;\nexport const run = cp\n~n;`, ["child_process.exec"]],
    "cp⏎{ }": [`${CP}export const run = cp\n{ }`, ["child_process.exec"]],
    'cp⏎"x"': [`${CP}export const t = cp\n  "x";`, ["child_process.exec"]],
    "cp⏎#x in o, then run.exec": [`${CP}class A { #x = 1; m(o) { const run = cp\n#x in o; run.exec("ls"); } }\nexport default A;`, ["child_process.exec"]],
    "cp⏎!n, then c2.exec": [`${CP}let n = 0;\nconst c2 = cp\n!n;\nc2.exec("ls");`, ["child_process.exec"]],
    // An exported let assigned where no declaration names it again: a statement's head, a call, a key and a label
    // declare nothing.
    "assigned in a function": [`${CP}export let run;\nexport function init() {\n  run = cp;\n}`, ["child_process.exec"]],
    "assigned by import()": ['export let run;\nexport async function load() {\n  run = await import("node:child_process");\n}', ["child_process.exec"]],
    "switch (run) {}": [`${CP}export let run;\nswitch (run) {\n  default:\n}\nrun = cp;`, ["child_process.exec"]],
    "if (run) {}": [`${CP}export let run;\nif (run) {}\nrun = cp;`, ["child_process.exec"]],
    "a block after a body": [`${CP}export let run;\nexport function f() {\n  run;\n}\n{\n}\nrun = cp;`, ["child_process.exec"]],
    "a spread of an alias into a call": [`${CP}const run = cp;\nexport const f = (g) => g(...run);`, ["child_process.exec"]],
    "a computed key of an object": [`${CP}export let run;\nconst o = { [run]: 1 };\nrun = cp;`, ["child_process.exec"]],
    "while (f(run)) {}": [`${CP}export let run;\nwhile (f(run)) {}\nrun = cp;`, ["child_process.exec"]],
    "{ run: 1 }": [`${CP}export let run;\nconst o = { run: 1 };\nrun = cp;`, ["child_process.exec"]],
    "const { run: x } = o": [`${CP}export let run;\nconst { run: x } = o;\nrun = cp;`, ["child_process.exec"]],
    "run: for (;;)": [`${CP}export let run;\nrun: for (;;) break run;\nrun = cp;`, ["child_process.exec"]],
    "a member named let": [`${CP}export let run;\nconst config = {};\nconfig.let\nrun = cp;`, ["child_process.exec"]],
    "o.run in a pattern's default": [`${CP}export let run;\nconst o = {};\nconst { a = o.run } = o;\nrun = cp;`, ["child_process.exec"]],
    "run in a pattern's default": [`${CP}export let run;\nconst o = {};\nconst { a = run } = o;\nrun = cp;`, ["child_process.exec"]],
    "run in a parameter's default": [`${CP}export let run;\nexport function f(a = run, { b = run } = {}) {\n  return [a, b];\n}\nrun = cp;`, ["child_process.exec"]],
    "class A extends mix(run) {}": [`${CP}export let run;\nconst mix = (base) => class extends Object {};\nexport class A extends mix(run) {}\nrun = cp;`, ["child_process.exec"]]
  };
  for (const [name, [source, expected]] of Object.entries(whole)) assert.deepEqual(rules(source), expected, `${name}: ${source}`);
  // A name bound to a value the module only takes part in is past the gate, as its header says.
  assert.deepEqual(rules(`${CP}const x = cp || null;\nx.exec("ls");`), []);
  // A pattern under `export let` declares names the gate does not follow, as its header says.
  assert.deepEqual(rules(`${CP}export let { run } = {};\nrun = cp;`), []);
});

test("the reader stays linear on a heritage's substitutions and on a line of regular expressions that never close", () => {
  const BT = "`";
  const timed = (source, options) => {
    const started = performance.now();
    forbiddenCalls(source, options);
    return performance.now() - started;
  };
  // Before, at n = 8 000, the first took 10–12 s and the second 3.5 s; 32 000 pairs of "/[" took 8.8 s.
  const n = 16000;
  assert.ok(timed(`const x = ${`class extends f${BT}\${a = 1}${BT} {} / "[" + `.repeat(n)}1;`) < 4000, "a class extends a tagged template, divided");
  assert.ok(timed(`var x = ${'await / "[" + '.repeat(n)}1;`, { script: true }) < 4000, "await divided in a script");
  assert.ok(timed("/[".repeat(2 * n)) < 4000, "slashes that open classes");
});
