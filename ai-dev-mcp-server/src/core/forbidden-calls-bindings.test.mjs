import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { forbiddenCalls } from "./forbidden-calls.mjs";

// What the static gate reads as declaring a name, binding one or holding a pattern: a parameter list, a declaration, a
// class's field. Its own file since forbidden-calls.test.mjs would have passed the 800 lines a module keeps.

const rules = (source, options) => forbiddenCalls(source, options).map((finding) => finding.rule);
const BT = "`";
const CP = 'import * as cp from "node:child_process";\n';

test("a call's arguments bind no name and hold no pattern, a block after them or not; a function's, a catch's, an arrow's and a method's parameters do", () => {
  // Read as parameters, these hid an exported let named in them, or a spread of the module into the call.
  const refused = {
    "f(run)⏎{⏎}": `${CP}export let run;\nf(run)\n{\n}\nrun = cp;\nfunction f() {}`,
    "f(run) /*⏎*/ {": `${CP}export let run;\nf(run) /*\n*/ {\n}\nrun = cp;\nfunction f() {}`,
    "f(run)⏎{⏎} in a method's body": `${CP}export let run;\nexport class A {\n  m() {\n    f(run)\n    {\n    }\n  }\n}\nrun = cp;\nfunction f() {}`,
    "g(...cp)⏎{⏎}": `${CP}g(...cp)\n{\n}\nfunction g() {}`,
    "extends ns.g(run) {}": `${CP}export let run;\nconst ns = { g: () => Object };\nclass A extends ns.g(run) {}\nrun = cp;`,
    "extends ns.g(...cp) {}": `${CP}const ns = { g: () => Object };\nexport class A extends ns.g(...cp) {}`,
    "extends g(g(run)) {}": `${CP}export let run;\nconst g = () => Object;\nclass A extends g(g(run)) {}\nrun = cp;`,
    "extends g(run).h() {}": `${CP}export let run;\nconst g = () => ({ h: () => Object });\nclass A extends g(run).h() {}\nrun = cp;`,
    "a class expression's heritage in an object": `${CP}export let run;\nconst ns = { g: () => Object };\nexport const o = {\n  A: class extends ns.g(run) {},\n};\nrun = cp;`,
    "for await (run of …) {}": `${CP}export let run;\nfor await (run of []) {}\nrun = cp;`,
    "for (run of …) {}": `${CP}export let run;\nfor (run of []) {}\nrun = cp;`,
    "while (run) {}": `${CP}export let run;\nwhile (run) {}\nrun = cp;`,
    "do {} while (run) {}": `${CP}export let run;\ndo {} while (run) {}\nrun = cp;`,
    "`${f(run)}${{}}`": `${CP}export let run;\nconst t = ${BT}\${f(run)}\${{}}${BT};\nrun = cp;\nfunction f() {}`,
    "p.catch(run)⏎{⏎}": `${CP}export let run;\nPromise.resolve().catch(run)\n{\n}\nrun = cp;`,
    "catch { run = cp }": `${CP}export let run;\ntry {\n  f();\n} catch {\n  run = cp;\n}\nfunction f() {}`,
    "x.function⏎g(run)⏎{⏎}": `${CP}export let run;\nconst x = {};\nx.function\ng(run)\n{\n}\nrun = cp;\nfunction g() {}`
  };
  for (const [name, source] of Object.entries(refused)) assert.deepEqual(rules(source), ["child_process.exec"], `${name}: ${source}`);
  // Each binds the name: the exported let is not what is assigned.
  const honest = {
    "function f(run)⏎{": `${CP}export let run;\nexport function f(run)\n{\n  run = cp;\n}`,
    "function (run)⏎{": `${CP}export let run;\nexport const f = function (run)\n{\n  run = cp;\n};`,
    "function* g(run)⏎{": `${CP}export let run;\nexport function* g(run)\n{\n  run = cp;\n}`,
    "function* (run)⏎{": `${CP}export let run;\nexport const g = function* (run)\n{\n  run = cp;\n};`,
    "catch (run)⏎{": `${CP}export let run;\ntry {\n  f();\n} catch (run)\n{\n  run = cp;\n}\nfunction f() {}`,
    "async function f(run) {": `${CP}export let run;\nexport async function f(run) {\n  run = cp;\n}`,
    "async (run) => {": `${CP}export let run;\nexport const f = async (run) => {\n  run = cp;\n};`,
    "a class's method": `${CP}export let run;\nexport class A {\n  m(run) {\n    run = cp;\n  }\n}`,
    "a constructor": `${CP}export let run;\nexport class A {\n  constructor(run) {\n    run = cp;\n  }\n}`,
    "static async *m(run) {": `${CP}export let run;\nexport class A {\n  static async *m(run) {\n    run = cp;\n  }\n}`,
    "#m(run) {": `${CP}export let run;\nexport class A {\n  #m(run) {\n    run = cp;\n  }\n}`,
    "[k](run) {": `${CP}export let run;\nconst k = "m";\nexport class A {\n  [k](run) {\n    run = cp;\n  }\n}`,
    '"if"(run) {': `${CP}export let run;\nexport class A {\n  "if"(run) {\n    run = cp;\n  }\n}`,
    "set v(run) {": `${CP}export let run;\nexport class A {\n  set v(run) {\n    run = cp;\n  }\n}`,
    "an object's method after a property": `${CP}export let run;\nexport const o = {\n  a: 1,\n  m(run) {\n    run = cp;\n  },\n};`,
    "an object's method named catch": `${CP}export let run;\nexport const o = {\n  catch(run) {\n    run = cp;\n  },\n};`,
    "an object's async method named function": `${CP}export let run;\nexport const o = {\n  async function(run) {\n    run = cp;\n  },\n};`,
    "a class expression's method": `${CP}export let run;\nexport const C = class {\n  m(run) {\n    run = cp;\n  }\n};`
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // An object in a call's arguments is an object, not a parameter's pattern: its shell option is refused.
  assert.deepEqual(rules("const o = f({ shell: true })\n{\n}\nfunction f(x) { return x; }"), ["shell"]);
  assert.deepEqual(rules("const ns = { make: (o) => Object };\nexport class A extends ns.make({ shell: true }) {}"), ["shell"]);
  for (const source of ["export function f({ shell = false } = {}) {\n  return shell;\n}", "export function f({ shell })\n{\n  return shell;\n}",
    "export const f = ({ shell }) => shell;", "export class A {\n  m({ shell }) {\n    return shell;\n  }\n}"]) {
    assert.deepEqual(rules(source), [], source);
  }
});

test("a word that is no declaration declares nothing, a member's `class` or `function` names nothing, and a template's commas are not a declaration's or a list's", () => {
  // Each assigns the module to the exported let where nothing declares its name again: caught.
  const refused = {
    "a key named const before it": `${CP}export let run;\nconst schema = { const: "x", run: 1 };\nrun = cp;`,
    "a key named var": `${CP}export let run;\nconst o = { var: 1, run: 2 };\nrun = cp;`,
    "a key named let, export var": `${CP}export var run;\nconst o = { let: 1, run: 2 };\nrun = cp;`,
    "a JSON Schema's const": `${CP}export let description = null;\nexport const schema = { type: "string", const: "fixed", description: "a field" };\ndescription = cp;`,
    "o.class⏎run = cp": `${CP}export let run;\nconst o = {};\no.class\nrun = cp;`,
    "o.function⏎run = cp": `${CP}export let run;\nconst o = {};\no.function\nrun = cp;`,
    "a comma in a parameter default's substitution": `${CP}export let run;\nconst x = 1;\nexport const f = (a = ${BT}\${x, run}${BT}) => a;\nrun = cp;`,
    "a comma in a declarator's substitution": `${CP}export let run;\nconst b = 1;\nlet a = ${BT}\${b, run}${BT};\nrun = cp;`,
    "a field's initializer over a line": `${CP}export let run;\nexport class A {\n  x =\n    run = cp;\n}`,
    "a method named class": `${CP}export let run;\nexport const o = {\n  class() {\n    run = cp;\n  },\n};`,
    "a field named class, then a method": `${CP}export let run;\nexport class A {\n  class;\n  m() {\n    run = cp;\n  }\n}`,
    "a field named class over a line, then a method": `${CP}export let run;\nexport class A {\n  class\n  m() {\n    run = cp;\n  }\n}`,
    "a field named class, then a static block": `${CP}export let run;\nexport class A {\n  class;\n  static {\n    run = cp;\n  }\n}`,
    // A value that ends in a name the line rule takes for a keyword: `export` stops the walk, and the next declaration is read.
    "export let a = of⏎export let run": `${CP}let of = 1;\nexport let a = of\nexport let run;\nrun = cp;`
  };
  for (const [name, source] of Object.entries(refused)) assert.deepEqual(rules(source), ["child_process.exec"], `${name}: ${source}`);
  // Each declares the name, or is a member: the exported let, or the alias, is not what is assigned.
  const honest = {
    "function* run": `${CP}export let run = null;\nexport function f() {\n  function* run() {}\n  run = cp;\n  return run;\n}`,
    "a field named like an exported let": `${CP}export let childProcess = null;\nexport class A {\n  childProcess = cp;\n}`,
    "a field named like a local": `${CP}export class A {\n  proc = cp;\n}\nconst proc = { exec() {} };\nproc.exec("x");`,
    "a static field": `${CP}export class A {\n  static proc = cp;\n}\nconst proc = { exec() {} };\nproc.exec("x");`,
    "a field after a method": `${CP}export let run;\nexport class A {\n  m() {}\n  run = cp;\n}`,
    "a field after a field on its own line": `${CP}export let run;\nexport class A {\n  x = 1\n  run = cp\n}`,
    "a field after ; on its line": `${CP}export let run;\nexport class A { x = 1; run = cp; }`,
    "static on a line of its own": `${CP}export let run;\nexport class A {\n  static\n  run = cp;\n}`,
    "a field of a class with a heritage call": `${CP}export let run;\nconst f = () => Object;\nexport class A extends f(1) {\n  run = cp;\n}`,
    "a field named let, then one named like the exported let": `${CP}export let run;\nexport class A {\n  let\n  run = cp\n}`,
    "let over a line declares": `${CP}export let run;\nexport function f() {\n  let\n  run = cp;\n  return run;\n}`,
    "const in a block": `${CP}export let run;\n{\n  const run = cp;\n  run.spawn("x");\n}`
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // A word `class` that is a field's name or an export's waits for no body: the `{` after it is a literal, or a block.
  assert.deepEqual(rules("export class A {\n  class = { shell: true };\n}"), ["shell"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport * as class from "node:fs"\n{\n  run = cp;\n}`), ["child_process.exec"]);
});

test("the declaration pass stays linear on words that declare nothing", () => {
  const timed = (source, options) => {
    const started = performance.now();
    forbiddenCalls(source, options);
    return performance.now() - started;
  };
  // Before, at n = 8 000, each took 7 to 23 s: every key, method or name walked on to its bracket's end.
  const n = 16000;
  assert.ok(timed(`export const o = { ${"const: 1, ".repeat(n)}z: 1 };\n`) < 4000, "keys named const");
  assert.ok(timed(`export class A { ${"let() {} ".repeat(n)}}\n`) < 4000, "methods named let");
  assert.ok(timed(`var a = [${"let, ".repeat(n)}1];\n`, { script: true }) < 4000, "a script's let in an array");
  assert.ok(timed(`var a = ${"let[0] + ".repeat(n)}1;\n`, { script: true }) < 4000, "a script's let indexed");
  // A declaration word right in a substitution walked past the template's end and on through every later one.
  assert.ok(timed(`var a = ${`${BT}\${let[0]}${BT} + `.repeat(n)}1;\n`, { script: true }) < 4000, "a script's let in a substitution");
  assert.ok(timed(`var a = ${`${BT}\${0}\${let[0]}${BT} + `.repeat(n)}1;\n`, { script: true }) < 4000, "a script's let in a later substitution");
});

test("a line that begins with an operator carries the value on: a name bound to it is not the module's", () => {
  for (const line of ["/ 2", "(0)", '["spawn"]', ".spawn", "* 2", "< 2", "=== undefined", "== null"]) {
    const source = `${CP}const c2 = cp\n${line}\nc2.exec("ls");`;
    assert.deepEqual(rules(source), [], source);
  }
  assert.deepEqual(rules("const g = globalThis\n/ 2\ng[0];"), []);
  assert.deepEqual(rules(`${CP}export const ok = cp\n  === undefined;`), []);
  assert.deepEqual(rules('const k = "x";\nconst g = globalThis\n  === undefined;\ng[k];'), []);
  // A shell option whose value goes on past its line is not `false`.
  assert.deepEqual(rules('spawn("x", [], { shell: false\n  === mode });\nfunction spawn() {}\nconst mode = 1;'), ["shell"]);
});

test("a declaration a line ends declares as any other, and so does the one after it with no `;` between", () => {
  const local = (...lines) => `${CP}export let run = null;\nexport function f(o) {\n${lines.map((line) => `  ${line}\n`).join("")}  return run;\n}`;
  for (const lines of [["const a = 1", "let run = cp"], ["const a = String(1)", "const run = cp"], ["let a = 0", "let run", "run = cp"], ["const a = 1", "const { default: run } = cp"]]) {
    assert.deepEqual(rules(local(...lines)), [], lines.join("⏎"));
  }
  assert.deepEqual(rules(`${CP}export var run = null;\nexport function f(o) {\n  var a = 1\n  var { run } = o\n  run = cp\n  return run\n}`), []);
  // Four in a row: each of them declares the name in turn.
  for (let at = 0; at < 4; at += 1) {
    const lines = ["const a = 1", "const b = 2", "const c = 3", "const d = 4"].map((line, index) => (index === at ? "let run = cp" : line));
    assert.deepEqual(rules(local(...lines)), [], lines.join("⏎"));
  }
});

test("a method's parameters are a list whatever names the method and wherever its body begins; a call stays a call", () => {
  const methods = {
    "#catch({ shell }) {": "export class A {\n  #catch({ shell }) {\n    return shell;\n  }\n}",
    "#function({ shell }) {": "export class A {\n  #function({ shell }) {\n    return shell;\n  }\n}",
    "with({ shell }) {": "export class Builder {\n  with({ shell }) {\n    return shell;\n  }\n}",
    "if, for, while, switch": "export class A {\n  if({ shell }) {}\n  for({ shell }) {}\n  while({ shell }) {}\n  switch({ shell }) {}\n}",
    "an object's with({ shell }) {": "export const b = {\n  with({ shell }) {\n    return shell;\n  }\n};",
    "get with() {, set with(value) {": "export const z = {\n  get with() { return 1; },\n  set with({ shell }) {}\n};",
    "m({ shell })⏎{": "export class A {\n  m({ shell })\n  {\n    return shell;\n  }\n}",
    "m({ shell: useShell = false })⏎{": "export class A {\n  m({ shell: useShell = false })\n  {\n    return useShell;\n  }\n}"
  };
  for (const [name, source] of Object.entries(methods)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // Each names the exported let it binds: not the module's.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #catch(run) {\n    run = cp;\n  }\n}`), []);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  m(run)\n  {\n    run = cp;\n  }\n}`), []);
  // A member's `#catch` is a call, and a call in a property's value or a field's initializer holds an option, not a list.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #catch(x) { return x; }\n  m() {\n    this.#catch(run)\n    {\n    }\n  }\n}\nrun = cp;`), ["child_process.exec"]);
  assert.deepEqual(rules('import { spawn } from "node:child_process";\nexport const o = { child: spawn("x", [], { shell: true }) };'), ["shell"]);
  assert.deepEqual(rules('import { spawn } from "node:child_process";\nexport class A {\n  child = spawn("x", [], { shell: true });\n}'), ["shell"]);
});

test("a field named class before a static block, a list that never closes, and the conditions no test held", () => {
  // No class is named `static`: the block's code is code, not the class's fields. A sloppy script's function may be,
  // and its body stays its own: a `/` after the function expression divides.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  class\n  static {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  assert.deepEqual(rules('var x = function static() {} / 2 + "/"; eval("1");\n', { script: true }), ["eval"]);
  assert.doesNotThrow(() => forbiddenCalls("{\nf("));
  assert.doesNotThrow(() => forbiddenCalls("{\n  const x = f(1,\n"));
  // Only a word right in a substitution walks nothing: a declaration in a function there declares.
  assert.deepEqual(rules(`${CP}export let run;\nexport const t = ${BT}\${(() => {\n  let run = cp;\n  return run;\n})()}${BT};`), []);
  // A statement `with`'s parentheses hold its object; a template's commas are not the arguments'; a template's end is
  // where it ends; `extends` in a computed key is no heritage; an arrow needs its `>`; `class` after a newline is a
  // field's name, and the method after it names nothing the file declares.
  assert.deepEqual(rules("with ({ shell: true }) {}\n", { script: true }), ["shell"]);
  assert.deepEqual(rules(`const a = 1, b = 2;\nrequire.call(${BT}\${a, b}${BT}, "child_process").exec("x");`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport const f = (a = ${BT}\${a}${BT}, run) => {\n  run = cp;\n};`), []);
  assert.deepEqual(rules(`${CP}export let run;\nconst o = {};\nexport class A {\n  class\n  [o.extends](x) {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nif ((run) === 1) {}\nrun = cp;`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  class\n  run() {}\n}\nrun = cp;`), ["child_process.exec"]);
  // A field on the line after one that ends in a call or an index is a field too.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  x = String(1)\n  run = cp\n  y = [1][0]\n  z = run\n}`), []);
});

test("a member named class or function opens no wait for a class's body, whatever member follows it", () => {
  const block = (members) => `${CP}export let run;\nexport class A {\n${members.map((m) => `  ${m}\n`).join("")}  static {\n    run = cp;\n  }\n}`;
  for (const members of [["class", "x"], ["class", "#x"], ["class", "[k]"], ["class", "class"], ["class", "extends"], ["class", "function", "static {}"]]) {
    assert.deepEqual(rules(`const k = "k";\n${block(members)}`), ["child_process.exec"], members.join("⏎"));
  }
  // Read as a class's body, the static block's statements were fields: the alias it binds, and the call through it, hid.
  assert.deepEqual(rules(`${CP}let run;\nexport class A {\n  class\n  x\n  static {\n    run = cp;\n  }\n}\nrun.exec("ls");`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  class\n  extends() {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  assert.deepEqual(rules("export class A {\n  class\n  extends({ shell }) {\n    return shell;\n  }\n}"), []);
  assert.deepEqual(rules('import { spawn } from "node:child_process";\nexport class A {\n  class\n  x\n  static {\n    spawn("x", [], { shell: true })\n    {\n    }\n  }\n}'), ["shell"]);
  // After a field named in, or a member `this.in`, `static {` right after class is still a static block.
  for (const members of [["in", "class"], ["x = this.in", "class"]]) assert.deepEqual(rules(block(members)), ["child_process.exec"], members.join("⏎"));
  // What ends a member before a field named class: `static`, a member's name, `x++` — and a member between it and the block.
  for (const members of [["static class", "x"], ["x = this.in", "class", "y"], ["y = a++", "class", "x"]]) {
    assert.deepEqual(rules(`let a = 0;\n${block(members)}`), ["child_process.exec"], members.join("⏎"));
  }
  // A class expression after => in a field is still a class: its method's body on its own line, its list a list.
  assert.deepEqual(rules("export class A {\n  x = () => class {\n    m({ shell })\n    {\n      return shell;\n    }\n  };\n}"), []);
});

test("conditions no other test holds: a method named by a string, a computed one, a private one named function, what ends a wait", () => {
  // A method named by a string in a literal read after `>`: no statement keyword's parentheses.
  assert.deepEqual(rules('const a = 1;\nexport const x = a > { "if"({ shell }) { return shell; } };'), []);
  // A computed method whose body begins on its own line: its place, not its head.
  assert.deepEqual(rules(`${CP}export let run;\nconst k = "m";\nexport class A {\n  [k](run)\n  {\n    run = cp;\n  }\n}`), []);
  // A declarator after a template in the same declaration still declares: the walk ends with its own template only.
  assert.deepEqual(rules(`${CP}export let run;\nexport function f(x) {\n  const a = ${BT}\${x}${BT}, run = cp;\n  return [a, run];\n}`), []);
  // A private method named function, called, a block after it: a call.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #function(x) { return x; }\n  m() {\n    this.#function(run)\n    {\n    }\n  }\n}\nrun = cp;`), ["child_process.exec"]);
  // Where a field named class still waits for a body — after one named in —, a ; or an = ends the wait, an extends
  // deeper than it marks no heritage; a static ends a wait at its own depth only, so the class whose
  // heritage holds such a field keeps its body.
  const after = (members) => `${CP}export let run;\nconst o = { extends: "k" };\nexport class A {\n  in\n${members}\n}`;
  assert.deepEqual(rules(after("  class;\n  static {\n    run = cp;\n  }")), ["child_process.exec"]);
  assert.deepEqual(rules(after("  class = { run = cp } = {};")), ["child_process.exec"]);
  assert.deepEqual(rules(after("  class\n  [o.extends]() {\n    run = cp;\n  }")), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport const B = class extends (class {\n  class\n  static {}\n}) {\n  run = cp;\n};`), []);
  // A script's `let` right in a substitution — the first, a later one, one in a template within another's parentheses —
  // is a name and declares nothing: the spread after it is the module's.
  for (const code of ["${let}${{ ...cp }}", "${0}${let}${{ ...cp }}", "${f(`${let}${{ ...cp }}`)}"]) {
    const source = `const cp = require("node:child_process");\nconst f = (s) => s;\nvar let = 1;\nmodule.exports = ${BT}${code}${BT};\n`;
    assert.deepEqual(rules(source, { script: true }), ["child_process.exec"], code);
  }
});

test("a file mid-edit costs what its length does: a bracket left open in each substitution, a .call( that never closes", () => {
  const timed = (source, options) => {
    const started = performance.now();
    forbiddenCalls(source, options);
    return performance.now() - started;
  };
  const n = 16000;
  assert.ok(timed(`var a = ${`${BT}\${(let[0]}${BT} + `.repeat(n)}1;\n`, { script: true }) < 4000, "a let in an open parenthesis in each substitution");
  assert.ok(timed(`x = ${"require.call(a + ".repeat(n)}1;\n`) < 4000, "a .call( that never closes");
  // A loader's .call( opened in each substitution and closed after all the templates: its argument's walk ends with its own.
  assert.ok(timed(`x = ${`${BT}\${require.call(a + 1}${BT} + `.repeat(n)}1${")".repeat(n)};\n`) < 4000, "a .call( in each substitution");
});

test("a substitution of a field's template is an expression's place, a ?. is in its template, a member named like a keyword ends an operand, an object literal after an operator is one", () => {
  // A class or function expression in a later substitution of a field's template is an expression: its body is a body.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  t = ${BT}\${{}}\${class { run = cp }}${BT};\n}`), []);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  t = ${BT}\${1}\${\n    class { run = cp }}${BT};\n}`), []);
  assert.deepEqual(rules(`export class A {\n  t = ${BT}\${{}}\${class {\n    m({ shell })\n    {\n      return shell;\n    }\n  }}${BT};\n}`), []);
  assert.deepEqual(rules(`export class A {\n  t = ${BT}\${{}}\${function () {} / 2}${BT} + eval / 3;\n}`), ["eval"]);
  assert.deepEqual(rules(`export class A {\n  t = ${BT}\${{}}\${function () {} / eval("1") / 2}${BT};\n}`), ["eval"]);
  // The . a ?. leaves is in its template: the declarators after it in a substitution still declare.
  assert.deepEqual(rules(`${CP}export let run;\nexport const label = (o) => ${BT}\${(() => { const a = o?.name, run = cp; return a + run; })()}${BT};`), []);
  // An assignment in a later substitution of a field's template assigns.
  assert.deepEqual(rules(`${CP}let run;\nexport class A {\n  t = ${BT}\${{}}\${run = cp}${BT};\n}\nrun.exec("x");`), ["child_process.exec"]);
  // A member named like a keyword ends a value at its line's end, and with a postfix ++ or -- ends its operand.
  assert.deepEqual(rules(`${CP}export let run;\nexport function f(o) {\n  const p = o.default\n  const run = cp\n  return [p, run]\n}`), []);
  assert.deepEqual(rules("export function f(stats, total) {\n  const share = stats.new++ / total; // Function of the new count\n  return share;\n}"), []);
  assert.deepEqual(rules("export function f(counts, n) {\n  const r = counts.default-- / n; const g = eval; return g / 2;\n}"), ["eval"]);
  for (const value of ["o.new++", "this.#in", "this.#new++"]) {
    const body = `  m(o) {\n    const p = ${value}\n    let run = cp\n    return [p, run]\n  }`;
    assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #in = 1;\n  #new = 0;\n${body}\n}`), [], value);
  }
  // After o.new++ at a line's end a statement begins: a block, a call before it, a class's member.
  const after = (code) => `${CP}export let run;\nconst o = { new: 0 };\n${code}\nfunction f(x) { return x; }\nrun = cp;`;
  assert.deepEqual(rules(after("o.new++\n{\n  f(run)\n  {\n  }\n}")), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  x = this.in++\n  class\n  y\n  static {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  // An object literal after /, <, a > that ends no arrow, a for head's of, or right after extends is a literal.
  const spawn = 'import { spawn } from "node:child_process";\nconst a = 1;\n';
  for (const before of ["a /", "a <", "a >", "a >>"]) assert.deepEqual(rules(`${spawn}export const x = ${before} { shell: true };`), ["shell"], before);
  assert.deepEqual(rules(`${spawn}for (const k of { shell: true }) spawn(k);`), ["shell"]);
  assert.deepEqual(rules(`${spawn}export class B extends { shell: true }.constructor {}`), ["shell"]);
  for (const before of ["a /", "a >"]) {
    assert.deepEqual(rules(`const a = 1;\nexport const x = ${before} {\n  m({ shell })\n  {\n    return shell;\n  }\n};`), [], before);
  }
  assert.deepEqual(rules("export function f() {\n  for (const k of {\n    m({ shell })\n    {\n      return shell;\n    }\n  }) return k;\n}"), []);
  assert.deepEqual(rules("export const g = (a) => {\n  m({ shell: true })\n};\nfunction m(o) { return o; }"), ["shell"]);
  // An arrow's body and a block after a name of are blocks: a call there is a call.
  assert.deepEqual(rules(after("export const g = (a) => {\n  f(run)\n  {\n  }\n};")), ["child_process.exec"]);
  assert.deepEqual(rules(after("const of = 1;\nlet y = of\n{\n  f(run)\n  {\n  }\n}")), ["child_process.exec"]);
  // A member named let right in a class's body declares nothing, after a field named in too.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  in\n  let\n  run = 1\n}\nrun = cp;`), ["child_process.exec"]);
  // What ends a member before a field named class: a ;, a method's }, a field on the line before.
  for (const lead of ["x = 1; class", "m() {}\n  class", "x\n  class"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  ${lead}\n  y\n  static {\n    run = cp;\n  }\n}`), ["child_process.exec"], lead);
  }
  // A declarator after a template and an operator still declares; new, typeof, void before a class expression in a field.
  assert.deepEqual(rules(`${CP}export let run;\nexport function f(x) {\n  const a = ${BT}\${x}${BT} + "", run = cp;\n  return [a, run];\n}`), []);
  for (const value of ["new class", "new\n  class", "typeof\n  class", "void class"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  x = ${value} { run = cp }\n}`), [], value);
  }
});

test("a ++ or -- after a line break is a prefix: a regular expression or a literal after it is its operand, and a declaration whose value has ended ends before it", () => {
  // `a⏎++/re/.lastIndex` is `a; ++/re/.lastIndex`: the `/` begins a regular expression, and what it holds is not code.
  assert.deepEqual(rules(`const a = 1;\nlet b = a\n++/${BT}/g.lastIndex;\nexport const g = () => eval;\n// ${BT}\n`), ["eval"]);
  assert.deepEqual(rules(`const o = { x: 0 };\no.x\n++/${BT}/g.lastIndex;\nexport const g = () => eval;\n// ${BT}\n`), ["eval"]);
  assert.deepEqual(rules("let n = 0;\nn\n++/eval(?:)/.lastIndex;\nexport { n };\n"), []);
  assert.deepEqual(rules(`let n = 0;\nn\n--/${BT}/.lastIndex;\nexport { n };\n`), []);
  assert.deepEqual(rules("let n = 0;\nn /*\n*/ ++/eval(?:)/.lastIndex;\nexport { n };\n"), []);
  // An object literal after it is its operand, and the statement before it is over.
  assert.deepEqual(rules("let a = 1;\na\n++\n{ shell: true }.shell;\n"), ["shell"]);
  assert.deepEqual(rules("let a = 1;\nexport const k = a\n++\n{ shell: true }.shell;\n"), ["shell"]);
  assert.deepEqual(rules(`${CP}export let c;\nlet b = 0;\nconst r = 1\n++b, c = cp;\nexport { r };\n`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let c;\nlet b = 0;\nlet r = b\n--b, c = cp;\nexport { r };\n`), ["child_process.exec"]);
  // On its operand's line it is a postfix: it divides, a block follows it, and the declaration goes on after it.
  assert.deepEqual(rules("let n = 0;\nexport const r = n++ / 2 / 1; // eval(\n"), []);
  assert.deepEqual(rules("let a = 1;\nexport const k = a++\n{ shell: true }\n"), []);
  for (const value of ["b++", "++b", "a +\n++b", "a\n+ +b"]) {
    assert.deepEqual(rules(`${CP}let a = 1, b = 0;\nexport const r = ${value}, c = cp;\n`), ["child_process.exec"], value);
  }
});

test("a member named extends before a body, the name of, a word as on the line before, a template's code, an arrow's concise body, [ ] in o, a for head's test, update and iterable, U+2028 or U+2029 in a string, a # member's postfix, an alias after export *, a template's end after yield", () => {
  const o = "const o = { extends: Object, as: 1 };\n";
  const allman = "  m({ shell })\n  {\n    return shell;\n  }\n";
  // After a member named extends the { is the class's body, and no wait is left open.
  assert.deepEqual(rules(`${o}export class A extends o.extends {\n${allman}}\n`), []);
  assert.deepEqual(rules(`${CP}export let run;\n${o}export class A extends o.extends {\n  run = cp;\n}\n`), []);
  assert.deepEqual(rules(`${CP}export let run;\n${o}export class A extends o.extends {}\nif (o) {\n  run = cp;\n}\n`), ["child_process.exec"]);
  assert.deepEqual(rules("export class B {\n  #extends = Object;\n  m() {\n    return class extends this.#extends {\n      n({ shell })\n      {\n        return shell;\n      }\n    };\n  }\n}\n"), []);
  assert.deepEqual(rules("export class A extends ({ shell: true }, Object) {\n  m() {}\n}\n"), ["shell"]);
  // The name of is an operand but the keyword a for head marks.
  for (const value of ["of", `${BT}\${of}${BT}`, "new of"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport function f(of) {\n  const x = ${value}\n  let run = cp\n  return [x, run]\n}\n`), [], value);
  }
  assert.deepEqual(rules(`${CP}export let c;\nlet b = 0, of = 1;\nconst r = of\n++b, c = cp;\nexport { r };\n`), ["child_process.exec"]);
  assert.deepEqual(rules("let of = 0;\nexport const r = of++ / 2; // eval( of the count\n"), []);
  assert.deepEqual(rules("let of = 0;\nof--\n{ shell: true }\n"), []);
  assert.deepEqual(rules("export function f() {\n  for (const k of [{ shell: true }]) return k;\n}\n"), ["shell"]);
  assert.deepEqual(rules("export function f() {\n  for (const k of ++/\"/.lastIndex) eval(k);\n}\n"), ["eval"]);
  assert.deepEqual(rules("export function f(of) {\n  for (const k of of++ / 2) eval(k); // n\n}\n"), ["eval"]);
  // After a word as on the line before, class declares; an alias's as stands on class's line, after export * or in an
  // export list, whose } ends the wait.
  for (const value of ["o.as", "as"]) {
    assert.deepEqual(rules(`${o}const as = 1;\nlet v = ${value}\nclass Foo {\n${allman}}\nexport { v, Foo };\n`), [], value);
  }
  assert.deepEqual(rules(`${CP}export let run;\n${o}let v = o.as\nclass Foo {\n  run = cp;\n}\nexport { v, Foo };\n`), []);
  for (const alias of ["export { x as class }", "export { x as\nclass }", "export * as\nclass from \"./m.mjs\""]) {
    assert.deepEqual(rules(`${CP}export let run;\nconst x = 1;\n${alias}\nif (x) {\n  run = cp;\n}\n`), ["child_process.exec"], alias);
  }
  for (const alias of ["export * as\nclass from \"./m.mjs\"", "export *\nas\nclass from \"./m.mjs\"", "export * as\nfunction from \"./m.mjs\"", "export { x as\nclass }"]) {
    assert.deepEqual(rules(`${CP}export let run;\nconst x = 1;\n${alias}\n{\n  run = cp;\n}\n`), ["child_process.exec"], alias);
  }
  // A template's code stands in the template: its , is no list's, its name no literal's key.
  for (const value of [`(0, ${BT}\${a, cp}${BT})`, `(${BT}\${a, cp}${BT})`]) {
    assert.deepEqual(rules(`${CP}const a = 1;\nexport const x = ${value};\n`), [], value);
  }
  assert.deepEqual(rules(`${CP}const a = 1;\nconst x = (0, ${BT}\${a, cp}${BT});\nx.exec("ls");\n`), []);
  assert.deepEqual(rules(`const cp = require("node:child_process");\nconst a = 1;\nmodule.exports = (0, ${BT}\${a, cp}${BT});\n`, { script: true }), []);
  assert.deepEqual(rules(`const a = 1, k = "x";\nconst g = (0, ${BT}\${a, globalThis}${BT});\nexport const v = g[k];\n`), []);
  assert.deepEqual(rules(`const a = 1;\nexport const m = (0, ${BT}\${a, require}${BT})("child_process");\n`), []);
  assert.deepEqual(rules(`const a = 1, shell = "x";\nexport const o = { x: ${BT}\${a, shell}${BT}, y: 2 };\n`), []);
  assert.deepEqual(rules(`${CP}export const x = ${BT}\${(0, cp).exec("ls")}${BT};\n`), ["child_process.exec"]);
  assert.deepEqual(rules(`const a = 1, shell = "x";\nexport const o = { x: ${BT}\${a}${BT}, shell };\n`), ["shell"]);
  // An arrow's concise body is an expression, and a template's end an operand's, whatever its last substitution ends
  // with: the / after them divides.
  for (const value of ["(b) => function () {}", "(b) => class {}", `${BT}\${(a) => {}}${BT}`]) {
    assert.deepEqual(rules(`export const v = ${value} / 2; // Function( of b\n`), [], value);
  }
  for (const value of [`${BT}\${yield}${BT}`, `${BT}\${${BT}\${yield}${BT}}${BT}`]) {
    assert.deepEqual(rules(`export function* g() {\n  const v = ${value} / 2; // Function( of n\n  return v;\n}\n`), [], value);
  }
  assert.deepEqual(rules(`export function* g(x) {\n  const v = ${BT}\${yield}${BT} / 2, w = eval(x) / 3;\n  return [v, w];\n}\n`), ["eval"]);
  assert.deepEqual(rules("export const v = ({ shell: true }, (y) => class {} / 2) / 2;\n"), ["shell"]);
  assert.deepEqual(rules("export const f = (b) => {}\n/eval(?:)/.test(\"x\");\n"), []);
  // A pattern before in is one only as a for head's binding; after an arrow's body at its declaration's level a new line
  // begins a statement unless it begins with a :.
  assert.deepEqual(rules("const o = {};\nexport const has = [{ shell: true }] in o;\n"), ["shell"]);
  assert.deepEqual(rules("export function f(o) {\n  for (const [k, { shell }] in o) return shell;\n}\n"), []);
  for (const head of ["{ shell }", "const { shell }", "[k, { shell }]", "var [{ shell }]"]) {
    assert.deepEqual(rules(`const o = {};\nexport let k, shell;\nfor (${head} in o) break;\n`), [], head);
  }
  assert.deepEqual(rules("const o = {}, x = {}, f = (v) => v;\nfor (x[{ shell: true }] in o) break;\nexport const has = f([{ shell: true }] in o);\n"), ["shell", "shell"]);
  for (const head of ["; [{ shell: true }] in o; ", ";; [{ shell: true }] in o", "const k of { shell: true } in o", "let i = 0; [{ shell }] in o; i++"]) {
    assert.deepEqual(rules(`export function f(o, shell) {\n  for (${head}) return 1;\n}\n`), ["shell"], head);
  }
  assert.deepEqual(rules(`${CP}export let run;\nconst handler = () => {}\n(function () {})(), run = cp;\nexport { handler };\n`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}const ok = true;\nexport const pick = ok ? () => {}\n  : () => {}, c2 = cp;\n`), ["child_process.exec"]);
  for (const value of ["a > {}\n    + 1", "{}\n    .toString()", "class {}\n    .name", "function () {}\n    .call(null)"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport function f(a) {\n  const x = ${value}, run = cp;\n  return [x, run];\n}\n`), [], value);
  }
  // After a ; in a for head a value begins: a { is an object literal, a class or function an expression.
  for (const head of ["; { shell: true } in o; ", "; { shell: true }; ", "let i = 0; i < 1; { shell: true }"]) {
    assert.deepEqual(rules(`export function f(o) {\n  for (${head}) return 1;\n}\n`), ["shell"], head);
  }
  for (const value of ["class {}", "function () {}"]) {
    assert.deepEqual(rules(`export function f() {\n  for (; ${value} / 2; ) { const g = eval; return g / 2; }\n}\n`), ["eval"], value);
  }
  assert.deepEqual(rules("for (;;) break;\n{ shell: true }\nfor (;;) { shell: true }\n"), []);
  assert.deepEqual(rules("export function f(s) {\n  for (;;) { class C {}\n    /x/.test(s); break; }\n}\n"), []);
  assert.deepEqual(rules("export function f(a) {\n  a; { shell: true }\n}\n"), []);
  assert.deepEqual(rules("export function f(s) {\n  s; class C {}\n  /\"/.test(s); eval(s);\n}\n"), ["eval"]);
  // A U+2028 or U+2029 in a string is a line break: the finding after it names V8's line.
  const at = (source) => forbiddenCalls(source).map((finding) => `${finding.rule}@${finding.line}`);
  for (const code of [0x2028, 0x2029]) {
    assert.deepEqual(at(`const s = "a${String.fromCharCode(code)}b";\nexport const g = eval;\n`), ["eval@3"], code.toString(16));
  }
  // A postfix on a # member ends its operand: the / after it divides, and what follows is code.
  assert.deepEqual(rules("export class T {\n  #new = 0;\n  share(t) {\n    return this.#new++ / t; // Function of the new count\n  }\n}\n"), []);
  assert.deepEqual(rules("export class T {\n  #in = 0;\n  share(n) {\n    const r = this.#in-- / n; const g = eval; return g / 2 + r;\n  }\n}\n"), ["eval"]);
});

test("an alias after export * before a default, an arrow's body ending a template's code, a bracket before the name of, a template's end as an operand's, a nested template's comma, and the gate's other edge cases", () => {
  // An alias's as after export *, the clause followed by a default; a * that multiplies and an export default that names a
  // value are no such clause, and a class after them on the next line declares.
  for (const word of ["class", "function"]) {
    assert.deepEqual(rules(`export * as\n${word} from "./m.mjs"\nexport default { shell: true }\n`), ["shell"], word);
  }
  assert.deepEqual(rules("const as = 2, x = 3;\nlet v = x * as\nclass Foo {\n  m({ shell })\n  {\n    return shell;\n  }\n}\nexport { v, Foo };\n"), []);
  assert.deepEqual(rules(`${CP}export let run;\nconst as = 1;\nexport default as\nclass Foo {\n  run = cp;\n}\nexport { Foo };\n`), []);
  // A template's end ends an operand: a declaration after `${yield}` ends at the line, and a member after a field whose
  // template ends with this.in or n++ is a member.
  assert.deepEqual(rules(`${CP}export let run;\nexport function* g() {\n  const x = ${BT}\${yield}${BT}\n  let run = cp\n  return [x, run]\n}\n`), []);
  for (const value of ["n++", "this.in"]) {
    assert.deepEqual(rules(`${CP}let n = 0;\nexport let run;\nexport class A {\n  in = 1;\n  x = ${BT}\${${value}}${BT}\n  run = cp\n}\n`), [], value);
  }
  // An arrow's body that ends a template's last substitution ends no declaration: the template goes on.
  assert.deepEqual(rules(`${CP}export const a = ${BT}\${() => {}}${BT}\n  .trim(), run = cp;\n`), ["child_process.exec"]);
  for (const after of [".trim()", "[0]", `${BT}x${BT}`]) {
    assert.deepEqual(rules(`${CP}export let run;\nconst tag = () => () => "";\nexport function f() {\n  const a = tag${BT}\${() => {}}${BT}\n    ${after}, run = cp;\n  return [a, run];\n}\n`), [], after);
  }
  // A bracket before the name of is no pattern: only a for head's keyword makes one.
  assert.deepEqual(rules(`import { of } from "./rx.mjs";\nexport function options() {\n  return { shell: true };\n}\nof(options()).subscribe(() => {});\n`), ["shell"]);
  assert.deepEqual(rules(`import { of } from "./rx.mjs";\nexport function workerOptions() {\n  return { eval: true };\n}\nof(workerOptions()).subscribe(() => {});\n`), []);
  assert.deepEqual(rules("let of = 0\nexport default { shell: true }\nof++\n"), ["shell"]);
  assert.deepEqual(rules(`const of = 1;\nexport const s = ${BT}\${{ shell: true }}\${of}${BT};\n`), ["shell"]);
  assert.deepEqual(rules("const x = [];\nexport let shell;\nfor (const { shell } of x) break;\n"), []);
  // A nested template's , is its own template's; then conditions no other test holds.
  assert.deepEqual(rules(`${CP}const a = 1;\nexport const x = ${BT}\${(0, ${BT}\${a, cp}${BT}).exec}${BT};\n`), []);
  assert.deepEqual(rules(`const a = 1, shell = 2;\nexport const x = ${BT}\${JSON.stringify({ x: ${BT}\${a, shell}${BT} })}${BT};\n`), []);
  assert.deepEqual(rules(`const a = 1, k = "x";\nlet g;\nexport const x = ${BT}\${g = (0, ${BT}\${a, globalThis}${BT})}${BT};\nexport const v = g[k];\n`), []);
  assert.deepEqual(rules("export const v = (b) => async function () {} / 2; // Function( of b\n"), []);
  assert.deepEqual(rules(`let g;\nconst k = "x";\nexport const s = ${BT}\${g = (0, globalThis)}${BT};\nexport const v = g[k];\n`), ["global-member"]);
  assert.deepEqual(rules('export const s = "a eval(1)";\n'), []);
  assert.deepEqual(rules(`${CP}export let run;\nconst handler = () =>\n{}\n(function () {})(), run = cp;\nexport { handler };\n`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nlet a;\nconst handler = () => {}\n[a] = [1], run = cp;\nexport { handler };\n`), ["child_process.exec"]);
  assert.deepEqual(rules("const o = {};\nexport function f() {\n  for (const\n    [k, { shell }] in o) return [k, shell];\n}\n"), []);
  assert.deepEqual(rules("export function f() {\n  for (;\n    { shell: true };) return 1;\n}\n"), ["shell"]);
  // A literal in a template is no pattern of the parameter or the declaration
  // around it; a call of a name of or of a member named like a keyword is a call; from after a literal is a call too; a
  // / after an import's module begins a regular expression; a yield and a postfix that end a line end the declaration.
  assert.deepEqual(rules("export function f(a = `${{ shell: true }}`) { return a; }\n"), ["shell"]);
  assert.deepEqual(rules("const o = {};\nexport const { a = `${{ shell: true }}` } = o;\n"), ["shell"]);
  assert.deepEqual(rules(`${CP}const x = { default: (m) => m };\nx.default(cp).exec("ls");\n`), []);
  assert.deepEqual(rules(`${CP}const of = (m) => m;\nof(cp).exec("ls");\n`), []);
  assert.deepEqual(rules("const k = \"x\";\nconst m = new Map();\nexport const v = m.delete(globalThis)[k];\n"), []);
  assert.deepEqual(rules("import { from } from \"./rx.mjs\"\nconst list = []\nexport const opts = { shell: true }\nfrom(list).subscribe(() => {})\n"), ["shell"]);
  assert.deepEqual(rules("import x from \"./m.mjs\"\n/eval(?:)/.test(x);\n"), []);
  assert.deepEqual(rules(`import "./m.mjs"\n/${BT}/.test("x");\n`), []);
  assert.deepEqual(rules(`${CP}export let c2;\nexport function* g() {\n  let r = yield\n  const c2 = cp\n  return [r, c2];\n}\n`), []);
  for (const value of [`${BT}x${BT}`, "(a)", "[a]"]) {
    assert.deepEqual(rules(`${CP}export let run;\nlet n = 0, a = 1;\nconst r = n++\n${value}, run = cp;\nexport { r };\n`), ["child_process.exec"], value);
  }
  // Conditions no other test holds: a function after o.as on the line before declares, and its parameters are a
  // pattern; a member named yield goes on to its call; a name from that ends a statement before a string is no import's.
  assert.deepEqual(rules("const o = { as: 1 };\nlet v = o.as\nfunction f({ shell }) {\n  return shell;\n}\nexport { v, f };\n"), []);
  assert.deepEqual(rules(`${CP}export let run;\nconst o = { yield: (v) => v }, a = 1;\nexport function f() {\n  const r = o.yield\n  (a), run = cp;\n  return [r, run];\n}\n`), []);
  assert.deepEqual(rules("const from = 4;\nexport const v = from\n\"x\"\n/ 2; // eval( of the quotient\n"), []);
});

test("a member's index is no pattern, nor what is in it, a line break before its [ or not; nor is a bracket a member, a call or an index follows", () => {
  // No ; is inserted before a [: f()⏎[k] = v is f()[k] = v, and a literal in the index is a value, its keys a literal's.
  assert.deepEqual(rules("const o = {};\no[{ shell: true }] = 1;\n"), ["shell"]);
  for (const head of ["const f = () => ({});\nf()", "const o = {};\no", "const s = \"ab\"", `export const t = ${BT}x${BT}`]) {
    assert.deepEqual(rules(`${head}\n[{ shell: true }] = [1];\n`), ["shell"], head);
  }
  assert.deepEqual(rules("const f = () => ({});\nf()\n[{ eval: 1 }] = [1];\n"), []);
  // In a pattern a literal whose member is assigned to — after a ., an index or a call — is a value: [{ … }.x] = v.
  assert.deepEqual(rules("const f = () => ({});\nf();\n[{ shell: true }.x] = [1];\n"), ["shell"]);
  assert.deepEqual(rules("const k = \"x\";\n[{ shell: true }[k]] = [1];\n"), ["shell"]);
  assert.deepEqual(rules("[[{ shell: true }](0).x] = [1];\n"), ["shell"]);
  assert.deepEqual(rules("export function g() {\n  [{ shell: true, f() { return {}; } }.f().x] = [1];\n}\n"), ["shell"]);
  assert.deepEqual(rules("const a = {}, shell = 1;\n[a[{ shell }]] = [1];\n"), ["shell"]);
  // A [ that begins a statement, a declaration's pattern or a substitution's code is a pattern still: after ;, a
  // postfix, a head, a block, a class, debugger, yield, let, const, var, ${.
  for (const before of [";", "x++", "if (o)", "{}", "class A {}", "debugger"]) {
    assert.deepEqual(rules(`let shell, x = 0;\nconst o = [{}];\n${before}\n[{ shell }] = o;\nexport { shell };\n`), [], before);
  }
  assert.deepEqual(rules("let shell;\nconst o = [{}];\nexport function* g() {\n  yield\n  [{ shell }] = o;\n}\nexport { shell };\n"), []);
  for (const word of ["let", "const", "var"]) {
    assert.deepEqual(rules(`const o = [{}];\n${word}\n[{ shell }] = o;\nexport { shell };\n`), [], word);
  }
  assert.deepEqual(rules(`let shell;\nconst o = [{}];\nexport const s = ${BT}\${[{ shell }] = o}${BT};\nexport { shell };\n`), []);
});

test("a function's, a method's, an arrow's or a class's body or a computed key ends the climb to a pattern; a module's string is one only after import or a clause's from; a template's end ends no line, and a ( after it calls it; an alias's export no member; the index after members named let, const or var; what begins a statement after a value or a yield; a class member's computed name; and conditions no other test holds", () => {
  // A literal a default value's body returns is a value: the climb stops at the body, an arrow's, a function's, a
  // method's or a class's, and at a computed key; an arrow whose body is a pattern assigned keeps it one.
  const bodies = {
    "(c) => { return { shell } }": "export function run(cmd, toOptions = (c) => {\n  return { shell: true, cwd: c };\n}) {\n  return toOptions(cmd);\n}\n",
    "function (c) { … }": "export function run(cmd, toOptions = function (c) {\n  return { shell: true };\n}) {\n  return toOptions(cmd);\n}\n",
    "a declaration's pattern": "const config = {};\nexport const { makeOptions = () => {\n  return { shell: true };\n} } = config;\n",
    "a condition in the body": "export function run(cmd, toOptions = (c) => {\n  const o = c ? { shell: true } : {};\n  return o;\n}) {\n  return toOptions(cmd);\n}\n",
    "a method's parameter": "export class R {\n  run(cmd, toOptions = () => {\n    return { shell: true };\n  }) {\n    return toOptions(cmd);\n  }\n}\n",
    "a pattern assigned": "let make;\nconst o = {};\n({ make = () => { return { shell: true }; } } = o);\nexport { make };\n",
    "an arrow's concise body": "const o = [];\nlet a;\n[a = () => [{ shell: true }]] = o;\nexport { a };\n",
    "a computed key": "const o = {};\nlet b;\n({ [{ shell: true }]: b } = o);\nexport { b };\n",
    "a declaration's computed key": "const o = {};\nexport const { a: { [{ shell: true }]: b } } = o;\n",
    "a for head's computed key": "const o = {};\nfor (const { [{ shell: true }]: b } of [o]) break;\n",
    "a parameter's computed key": "export function f({ [{ shell: true }]: b }) {\n  return b;\n}\n"
  };
  for (const [name, source] of Object.entries(bodies)) assert.deepEqual(rules(source), ["shell"], name);
  assert.deepEqual(rules(`${CP}export function f(g = () => {\n  return { ...cp };\n}) {\n  return g;\n}\n`), ["child_process.exec"]);
  assert.deepEqual(rules("export function start(file, toOptions = () => {\n  return { eval: true };\n}) {\n  return [file, toOptions()];\n}\n"), []);
  assert.deepEqual(rules("let shell;\nconst o = [{}];\nexport const f = () => [{ shell }] = o;\n"), []);
  assert.deepEqual(rules("const o = {};\nlet { [{ eval: 1 }]: b } = o;\nexport { b };\n"), []);
  // A [ after a , whose ] no : follows is a pattern's element, not a computed key: the climb goes on; one whose ]
  // a : follows is a key after a , too; a class expression's static block in a parameter's default is a body's statement.
  for (const source of ["const o = [];\nexport const [a, [{ shell }]] = o;\n", "export function f(a, [{ shell }]) {\n  return [a, shell];\n}\n"]) {
    assert.deepEqual(rules(source), [], source);
  }
  assert.deepEqual(rules("const o = {};\nexport const { a, [{ shell: true }]: b } = o;\n"), ["shell"]);
  assert.deepEqual(rules("export function f(C = class {\n  static {\n    [{ shell: true }];\n  }\n}) {\n  return C;\n}\n"), ["shell"]);
  // A string after from is a module's only after a clause; a template, a member named import, a from that ends nothing
  // are not, and a / after them divides; an alias's string is a clause's end.
  for (const source of [
    "export function f(from) {\n  return from\n  \"x\" / 2; // eval( of the quotient\n}\n",
    "export async function f(from) {\n  const v = await from\n  \"x\" / 2; // eval( of it\n  return v;\n}\n",
    "let a = 1, from = 2;\na\nfrom\n\"x\" / 2; // eval( of it\nexport { a };\n",
    "const o = { import: 1 };\no.import\n\"x\" / 2; // eval( of it\n",
    "export function f(from) {\n  return from`x` / 2; // eval( of the quotient\n}\n",
    `const loader = { import: () => 1 };\nexport const v = loader.import${BT}x${BT} / 2; // eval( of it\n`,
    "export function f(from) {\n  return from\n  \"x\" / `a/b`.length;\n}\n",
    "export * as \"x y\" from \"./m.mjs\"\n/eval(?:)/.test(\"s\");\n",
    "import { a } from \"./m.mjs\"\n/eval(?:)/.test(a);\n",
    "export * from \"./m.mjs\"\n/eval(?:)/.test(\"s\");\n",
    "let shell;\nexport * as \"s t\" from \"./m.mjs\"\n[{ shell }] = [{}];\nexport { shell };\n"
  ]) assert.deepEqual(rules(source), [], source);
  assert.deepEqual(rules("export function f(from, s) {\n  return from\n  \"x\" / 2, eval(s) / 3;\n}\n"), ["eval"]);
  assert.deepEqual(rules("export async function f(from, s) {\n  const v = await from`x` / 2 + eval(s) / 3;\n  return v;\n}\n"), ["eval"]);
  // Nor is a template a clause's end stands before, nor a string after a string that is no alias's; the name after as is
  // a clause's end.
  assert.deepEqual(rules("const from = (s) => s.length, a = 2, s = \"1\";\nexport const v = a * from`x` / 2 + eval(s) / 3;\n"), ["eval"]);
  assert.deepEqual(rules("const from = 1, s = \"1\";\nlet x = \"a\"\nfrom\n\"y\" / 2 + eval(s) / 3;\nexport { x };\n"), ["eval"]);
  for (const clause of ["export * as ns", "import * as ns"]) {
    assert.deepEqual(rules(`${clause} from "./m.mjs"\n/eval(?:)/.test("s");\n`), [], clause);
  }
  // A template's end is an operand's, whatever ends its code: the line after it goes on, a [ there indexes, a ( calls.
  for (const [inner, after] of [["n++", "(a)"], ["n++", "[0]"], ["n++", "`x`"], ["yield", "[0]"], ["yield", "(a)"]]) {
    const head = inner === "yield" ? "export function* f() {" : "export function f() {";
    assert.deepEqual(rules(`${CP}export let run;\nlet n = 0, a = 1;\n${head}\n  const r = ${BT}\${${inner}}${BT}\n  ${after}, run = cp;\n  return [r, run];\n}\n`), [], `${inner} ${after}`);
  }
  assert.deepEqual(rules(`${CP}let n = 0;\nexport const r = ${BT}\${n++}${BT}\n  [0], c2 = cp;\n`), ["child_process.exec"]);
  assert.deepEqual(rules(`let n = 0;\nexport const t = ${BT}\${n++}${BT}\n[{ shell: true }] = [1];\n`), ["shell"]);
  assert.deepEqual(rules(`${CP}export function* g() {\n  return ${BT}\${yield}${BT}(cp).exec("ls");\n}\n`), []);
  // A member named export is no re-export's: o.export * as⏎class is a product and a class.
  assert.deepEqual(rules("const o = { export: 2 }, as = 3;\nlet v = o.export * as\nclass Foo {\n  m({ shell })\n  {\n    return shell;\n  }\n}\nexport { v, Foo };\n"), []);
  assert.deepEqual(rules(`${CP}export let run;\nconst o = { export: 2 }, as = 3;\nlet v = o.export * as\nclass Foo {\n  run = cp;\n}\nexport { v, Foo };\n`), []);
  // Members named let, const or var index as any member's name.
  for (const word of ["let", "const"]) assert.deepEqual(rules(`const o = { ${word}: {} };\no.${word}[{ shell: true }] = 1;\n`), ["shell"], word);
  assert.deepEqual(rules("const o = { var: {} };\no.var[{ eval: 1 }] = 1;\n"), []);
  // After a value's end a line that begins with !, ~, a string or a number begins a statement, and after a yield one
  // that begins with a regular expression, !, a string or -.
  for (const line of ["!function () {}()", "~a", "\"x\"", "2"]) {
    assert.deepEqual(rules(`${CP}export let run;\nconst a = 1\n${line}, run = cp;\nexport { a };\n`), ["child_process.exec"], line);
  }
  // A line that begins with != or !==, or with + or - after a postfix, goes on: run is the declaration's.
  for (const [end, op] of [["b", "!="], ["b", "!=="], ["n++", "+"], ["n--", "-"]]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport function f(b, c, n) {\n  const a = ${end}\n    ${op} c, run = cp;\n  return [a, run];\n}\n`), [], op);
  }
  for (const line of ["/x/g.test(s)", "!s", "\"x\"", "-s"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport function* g(s) {\n  const r = yield\n  ${line}, run = cp;\n  return r;\n}\n`), ["child_process.exec"], line);
  }
  // Conditions no other test holds, and an of in a for head's substitution, a name.
  assert.deepEqual(rules(`${CP}export class A {\n  #delete(m) { return m; }\n  run() {\n    return this.#delete(cp).exec("ls");\n  }\n}\n`), []);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #yield = (v) => v;\n  m(a) {\n    const r = this.#yield\n    (a), run = cp;\n    return [r, run];\n  }\n}\n`), []);
  assert.deepEqual(rules(`const o = {};\nexport const s = ${BT}\${({ a = ${BT}\${{ shell: true }}${BT} } = o)}${BT};\n`), ["shell"]);
  assert.deepEqual(rules("const from = 1, list = 2;\nexport const opts = { shell: true }\nfrom\nlist\n"), ["shell"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport const s = ${BT}\${(() => {\n  const h = () => {}\n  (function () {})(), run = cp;\n  return h;\n})()}${BT};\n`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}for (const k of (cp).exec("ls")) break;\n`), ["child_process.exec"]);
  assert.deepEqual(rules("import \"./m.mjs\"\nlet shell;\nconst o = [{}];\n[{ shell }] = o\nexport { shell };\n"), []);
  assert.deepEqual(rules(`const a = 1;\nexport const t = ${BT}\${a}${BT}\n[{ shell: true }] = [1];\n`), ["shell"]);
  assert.deepEqual(rules("const o = [], x = {};\nfor (x[{ shell: true }] of o) break;\n"), ["shell"]);
  assert.deepEqual(rules(`const of = 1;\nfor (const k of ${BT}\${{ shell: true }}\${of}${BT}) break;\n`), ["shell"]);
  // A [ that begins a class's member is its computed name, a value; one after a field's = may begin a pattern.
  for (const before of ["m() {}", "x = 1;", "static {}", ""]) {
    assert.deepEqual(rules(`export class A {\n  ${before}\n  [{ shell: true }] = 1;\n}\n`), ["shell"], before);
  }
  assert.deepEqual(rules("export class A {\n  m() {}\n  [{ eval: 1 }] = 1;\n}\n"), []);
  assert.deepEqual(rules("let shell;\nconst o = [{}];\nexport class A {\n  x = [{ shell }] = o;\n}\nexport { shell };\n"), []);
});

test("a literal in a default value behind an operator, a condition or ! is a value; a } or * ends a clause only an import's or an export's, and no member's import, export or as begins one; extends at a line's end goes on", () => {
  // A bracket climbs on to a pattern only as a whole entry of the bracket around it: after {, [, ,, (, ... or a key's :.
  // A shell option behind a condition is the usual way to write one for Windows alone.
  const behind = {
    "a parameter's condition": "import { spawn } from \"node:child_process\";\nexport function run(cmd, args, options = process.platform === \"win32\" ? { shell: true } : {}) {\n  return spawn(cmd, args, options);\n}\n",
    "||": "export function f(a = x || { shell: true }) { return a; }\nvar x;\n",
    "??": "const defaults = null;\nexport const { options = defaults ?? { shell: true } } = {};\n",
    "a condition after a :": "let o = {}, c, b, x;\n({ x = c ? b : { shell: true } } = o);\n",
    "&&": "let c, x, o = [];\n[x = c && { shell: \"/bin/sh\" }] = o;\n",
    "a for head": "let b;\nfor (const { a = b || { shell: true } } of []) break;\n",
    "a catch": "let c;\ntry {} catch ({ a = c ? { shell: true } : 0 }) {}\n",
    "a shorthand": "const shell = true;\nlet c;\nexport function f(o = c ? { shell } : {}) { return o; }\n",
    "after {}": "let c;\nexport const h = (p = c ? {} : { shell: true }) => p;\n",
    "!": "export function f(a = !{ shell: true }) { return a; }\n"
  };
  for (const [name, source] of Object.entries(behind)) assert.deepEqual(rules(source), ["shell"], name);
  assert.deepEqual(rules(`${CP}let c;\nexport function f(o = c ? { ...cp } : {}) { return o; }\n`), ["child_process.exec"]);
  assert.deepEqual(rules("import { Worker } from \"node:worker_threads\";\nexport function start(code, options = inline ? { eval: true } : {}) {\n  return new Worker(code, options);\n}\nvar inline;\n"), []);
  // A key's value, a computed key's, a rest's and a parameter's pattern with a default after it stay patterns.
  for (const source of [
    "let o = {}, shell;\n({ a: { shell } } = o);\nexport { shell };\n",
    "let o = {}, shell;\n({ [\"k\"]: { shell } } = o);\nexport { shell };\n",
    "let o = [], a, shell;\n[a, ...[{ shell }]] = o;\nexport { a, shell };\n",
    "export function f({ shell } = {}, [{ shell: s }] = []) { return [shell, s]; }\n",
    "let o = {}, shell, s2;\n({ 0: { shell }, \"k\": [{ shell: s2 }] } = o);\nexport { shell, s2 };\n"
  ]) {
    assert.deepEqual(rules(source), [], source);
  }
  // A } or * before a from that stands alone is no clause's end: the / after the string divides.
  for (const source of ["let from, s;\nif (s) {}\nfrom\n\"x\" / eval(s) / 1;\n", "let from, s, b;\nconst a = b *\nfrom\n\"x\" / eval(s) / 1;\nexport { a };\n"]) {
    assert.deepEqual(rules(source), ["eval"], source);
  }
  // Nor does a member named import, export or as begin a clause: the block or the name after it is the code's.
  for (const before of ["o.export\n{}", "o.import\n{}", "this.#export\n{}", "o.import\nb, {}", "o.import\nx", "o.as\nx"]) {
    const source = `let from, s, o = {}, b, x;\nexport class C {\n  #export;\n  m() {\n    ${before.replace("\n", "\n    ")}\n    from\n    "x" / eval(s) / 1;\n  }\n}\n`;
    assert.deepEqual(rules(source), ["eval"], before);
  }
  for (const head of ["import x, { y } from \"./m.mjs\"", "export {\n  a\n}\nfrom \"./m.mjs\"", "export * from \"./m.mjs\"", "import {} from \"./m.mjs\"", "export * as ns from \"./m.mjs\""]) {
    assert.deepEqual(rules(`${head}\n/eval(?:)/.test("s");\n`), [], head);
  }
  // extends at a line's end: the heritage on the next line is the class's, and the declaration goes on.
  for (const heritage of ["\"x\"", "1", "Base"]) {
    assert.deepEqual(rules(`${CP}let Base;\nexport const C = class extends\n  ${heritage} {}, run = cp;\n`), ["child_process.exec"], heritage);
  }
});
