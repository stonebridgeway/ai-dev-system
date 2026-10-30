/**
 * The calls AGENTS.md forbids, found by what the code does rather than how it
 * happens to be spelled.
 *
 * The static gate used to look for the usual spellings — `eval(`, `shell: true`,
 * `import { exec } from "node:child_process"` — and every equivalent spelling
 * passed it: `import * as cp` then `cp.exec(…)`, `execSync(…)`, `{ "shell": true }`,
 * `{ shell: "/bin/sh" }`, `globalThis["ev" + "al"](…)`.
 * So the source is read as tokens (code-tokens.mjs) — comments, strings,
 * template text and regular-expression literals set aside, every escape in
 * strings and names decoded, a template with no substitution read as the
 * string it is — and the rules are asked of those:
 *
 * - `eval` in any role but a key or a method of an object literal
 *   (`{ eval: true }` is a Worker option);
 * - the `Function` constructor, called — through `.call`, `.apply` or `.bind`
 *   too — or handed on, a global's `.Function`, and a call of a `.constructor`
 *   member (`({}).constructor.constructor("…")` is `Function`);
 * - a computed member of `globalThis`, `window`, `global` or `self` — or of a
 *   name one of them is bound to — unless the key is one plain string that
 *   names neither of the two, whether it is read (`globalThis[k]`) or taken
 *   out by a pattern (`const { [k]: f } = globalThis`);
 * - `exec` or `execSync` of `child_process`, through a named, default or
 *   namespace import, `require`, `import()` or `process.getBuiltinModule` —
 *   called by name, as a member or by a plain-string key, in parentheses, or
 *   through `.call` or `.apply` — its `default`, a `.then` callback, a rest
 *   element, and any name the module object is bound or plainly re-bound to
 *   (`const c2 = cp`, `const c3 = (0, c2)`, `a = b = cp`,
 *   `cp ??= await import(…)`), above or below; and the module object itself
 *   handed to another file — `export *`, `export { default }`, `export const`,
 *   a pattern it declares from the module itself
 *   (`export const { default: run } = …`), an exported `let` or `var` the
 *   module is assigned to, by name or by a pattern
 *   (`({ default: run } = await import(…))`), `module.exports =`,
 *   `exports["cp"] =`, `export default` — whose `exec` would come from here.
 * The module itself, a whole value: one a line
 *   break ends only where the next line cannot carry it on, so
 *   `cp⏎  !== undefined`, a value it takes part in, binds and hands on nothing;
 * - a `shell` option with any value but `false`, `null`, `undefined`, `0` or
 *   an empty string — as a key of an object literal, computed or not, or set
 *   on a member with `=`, `??=`, `||=` or `&&=` — and a `shell` shorthand,
 *   whose value nobody can see. A `shell` that is not an option is left alone:
 *   an import, a parameter, a destructuring pattern, an argument.
 *
 * A parameter list is told from a call's arguments by `function`, `catch`,
 * `=>`, a method's place — right in a class's body or an object literal, a `{`
 * after it, whatever the name — or a body begun on the line it ends on: a
 * call's arguments are values, a block or a class's body after them, and a name
 * in them declares nothing. A name is declared
 * again by `const`, `let` or `var` with a name, `{` or `[` after it — not a
 * key, a method or a class's member so named —, a parameter, or `function`,
 * `function*` or `class` naming no member. Nothing takes a template's `,` for a
 * list's or its name for a key, and a declaration's or argument list's walk
 * begun in one ends with it.
 *
 * It is a reader, not a parser. It follows the module object and the global objects
 * through plain re-binding and nothing else: a module name built from parts,
 * `createRequire`, `Reflect.get`, a loader bound to another name
 * (`const r = require`) or reached any other way — `.bind`, `Reflect.apply`, a
 * condition (`(ok ? require : null)(…)`), an array, `require["call"]`,
 * `module.constructor._load` — a key held in a variable, the module put in an
 * object or an array by name (`module.exports = { cp }`,
 * `export const [run] = [cp]`), set on `this` or a class's field, or on a head in
 * parentheses (`(module.exports).cp = cp`), handed to a function, or only part of a
 * value (`cp || fallback`), and a name bound to such a value; an exported `let` or
 * `var` that a pattern declares (`export let { run } = {}`), or whose name the file
 * declares again — a local of its own, a parameter, a function, a class — wherever
 * it is assigned; a global taken out by a pattern
 * (`{ globalThis: g } = globalThis`); `await`, `yield` or `let` written as a name
 * in a script, read as the keyword; and a class's member on the line after `n++` or
 * a word an operand follows (`in`), read as an assignment or, named `class` or
 * `function`, as declaring the name after it, and a `class` after one but `return`
 * or `yield` as waiting for a body, are past it. No accident writes such code;
 * the gate keeps honest code honest. A computed member of a global it cannot
 * read is refused rather than trusted, and so is a file it could not read to its
 * end — a template or a comment that never closes, leaving what follows unchecked.
 */

import { HEAD_KEYWORDS, KEYWORDS_BEFORE_EXPRESSION, closing, codeTokens, enclosing, endsOperand, isName, isPunct, opening } from "./code-tokens.mjs";

const MODULE_NAMES = new Set(["child_process", "node:child_process"]);
const FORBIDDEN_MEMBERS = new Set(["exec", "execSync"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);
const FALSY_LITERALS = new Set(["false", "null", "undefined", "0"]);
const DECLARATIONS = new Set(["const", "let", "var"]);
const isModuleString = (token) => token?.type === "string" && MODULE_NAMES.has(token.value);
/** The key in the brackets opened at `open` when it is one plain string, else null — asked without copying what they
 * hold, so brackets nested in brackets cost no more than their length. */
const plainKey = (tokens, open) => (closing(tokens, open) === open + 2 && tokens[open + 1].type === "string" ? tokens[open + 1].value : null);
// `=` that assigns: not `==`, `===` or `=>`.
const assigns = (tokens, index) => isPunct(tokens[index], "=") && !isPunct(tokens[index + 1], "=") && !isPunct(tokens[index + 1], ">")
  && !["=", "!", "<", ">"].some((value) => isPunct(tokens[index - 1], value));
// `??=`, `||=` and `&&=` end in the `=` at `index`.
const logicalAssignment = (tokens, index) => ["?", "|", "&"].some((value) => isPunct(tokens[index - 1], value) && isPunct(tokens[index - 2], value));
/** The `=` of an assignment operator that begins at `index` — `=`, `??=`, `||=`, `&&=` — or -1. */
const assignmentAt = (tokens, index) => {
  if (assigns(tokens, index)) return index;
  return assigns(tokens, index + 2) && logicalAssignment(tokens, index + 2) ? index + 2 : -1;
};
/** What an assignment whose `=` is at `index` assigns to: the index of its last token. */
const assignedAt = (tokens, index) => (logicalAssignment(tokens, index) ? index - 3 : index - 1);

/**
 * Whether the `(` at `open` begins a parameter list: a function's — `function f(run)`, `function* (run)` —, a `catch`'s
 * (no member's: `this.#catch(run)` is a call), an arrow's, or a method's — right in a class's body or an object literal,
 * a `(` a `{` follows, whatever names it (`with`, `#catch`) and wherever the `{` stands. A call's arguments never do:
 * elsewhere a block after them begins on a line of its own (`f(run)⏎{`), the `{` after a heritage's call is the class's
 * body, a statement keyword's parentheses hold none, and a `(` that never closes begins none.
 */
function parameterList(tokens, open) {
  const shut = closing(tokens, open);
  if (shut < 0) return false;
  if (isPunct(tokens[shut + 1], "=") && isPunct(tokens[shut + 2], ">")) return true;
  const member = (index) => isPunct(tokens[index - 1], ".") || (isPunct(tokens[index - 1], "#") && isPunct(tokens[index - 2], "."));
  let at = open - 1;
  if (isName(tokens[at], "catch")) return !member(at);
  if (isName(tokens[at]) && !isName(tokens[at], "function")) at -= 1;
  if (isPunct(tokens[at], "*")) at -= 1;
  if (isName(tokens[at], "function")) return !member(at);
  const body = tokens[shut + 1];
  if (!isPunct(body, "{") || body.literal === true || body.classBody === true) return false;
  const holder = tokens[enclosing(tokens, open)];
  if (holder?.classBody === true || holder?.literal === true) return true;
  const head = tokens[open - 1];
  return body.line === tokens[shut].line && (!isName(head) || !(HEAD_KEYWORDS.has(head.value) || head.value === "switch" || (head.value === "await" && isName(tokens[open - 2], "for"))));
}

/**
 * Whether the `{` or `[` at `open` begins a destructuring pattern: assigned to, iterated over, or a parameter — itself,
 * or as a whole entry of one, after `{`, `[`, `,`, `(`, `...` or a key's `:`. Anything else ends the climb, and nothing in
 * it is part of a pattern around it: a default value, behind an operator or not (`options = c ? { … } : {}`), what is
 * iterated, a member's index or computed name, a function's, a method's, an arrow's or a class's body. A bracket a member,
 * a call or an index follows is a value, and so is one in a call's arguments.
 */
// What isPattern answered for each bracket of a token array: a key deep in nested brackets climbs them once.
const PATTERNS = new WeakMap();
function isPattern(tokens, open) {
  if (!PATTERNS.has(tokens)) PATTERNS.set(tokens, new Map());
  const known = PATTERNS.get(tokens);
  // Each bracket the climb passes has the answer of the one it ends at.
  const climbed = [];
  let answer = false;
  for (let at = open; ;) {
    if (known.has(at)) {
      answer = known.get(at);
      break;
    }
    climbed.push(at);
    const end = closing(tokens, at);
    if (end < 0 || tokens[at].index === true || isPunct(tokens[end + 1], ".") || isPunct(tokens[end + 1], "(") || tokens[end + 1]?.index === true) break;
    if (assigns(tokens, end + 1) || (isName(tokens[end + 1], "of") && tokens[end + 1].keyword === true) || (isName(tokens[end + 1], "in") && tokens[at].forBinding === true)) {
      answer = true;
      break;
    }
    if (!(["{", "[", ",", "(", "..."].some((value) => isPunct(tokens[at - 1], value)) || (isPunct(tokens[at - 1], ":") && tokens[at - 2]?.templateEnd !== true && ["{", ","].some((value) => isPunct(["name", "string", "number"].includes(tokens[at - 2]?.type) ? tokens[at - 3] : tokens[opening(tokens, at - 2) - 1], value)))) || (isPunct(tokens[at], "[") && (isPunct(tokens[at - 1], "{") || isPunct(tokens[at - 1], ",")) && isPunct(tokens[end + 1], ":"))) break;
    const outer = enclosing(tokens, at);
    if (outer < 0 || tokens[outer].within !== tokens[at].within) break;
    if (isPunct(tokens[outer], "(")) {
      answer = parameterList(tokens, outer);
      break;
    }
    at = outer;
  }
  for (const at of climbed) known.set(at, answer);
  return answer;
}

/** Whether the token at `index` is a key or a shorthand of an object literal — not a block, a pattern, an import, or a template's code in it. */
function inObjectLiteral(tokens, index) {
  const open = enclosing(tokens, index);
  // After `)`, `=>`, `else`, a `;` or a label's `:` it is a block; after `import` or `const` a clause or a pattern.
  if (open < 0 || !isPunct(tokens[open], "{") || !tokens[open].literal || tokens[open].within !== tokens[index].within) return false;
  // `import React, { shell } from "electron"`, `export { shell } from …`.
  if (isName(tokens[closing(tokens, open) + 1], "from") && tokens[closing(tokens, open) + 2]?.type === "string") return false;
  return !isPattern(tokens, open);
}

/**
 * Whether a value is over before the token at `end`: the file's end, a `,`,
 * a `;` or a closing bracket, or a line the value cannot carry on into —
 * `cp⏎  !== undefined` and `false⏎ || "/bin/sh"` are one value each,
 * `cp⏎run()` is two statements.
 */
function valueEnds(tokens, end) {
  const after = tokens[end];
  if (!after || [",", ";", ")", "}", "]"].some((value) => isPunct(after, value))) return true;
  if (after.line === tokens[end - 1].line) return false;
  // What begins a line and only ever begins an expression: a `{`, a `!` but `!=`, a `~`, a `#`, a `++` or `--`.
  if ((isPunct(after, "!") && !isPunct(tokens[end + 1], "=")) || ["{", "~", "#"].some((value) => isPunct(after, value))) return true;
  if ((isPunct(after, "+") || isPunct(after, "-")) && tokens[end + 1]?.joined === true) return true;
  // A template there tags the value, `in` and `instanceof` take it as their operand.
  if (after.type === "template" || after.template === true || isName(after, "in") || isName(after, "instanceof")) return false;
  return after.type !== "punct";
}

/** Whether the value at `index` is plainly off: a falsy literal that the expression ends with. */
function plainlyOff(tokens, index) {
  const value = tokens[index];
  return valueEnds(tokens, index + 1)
    && (((value?.type === "name" || value?.type === "number") && FALSY_LITERALS.has(value.value)) || (value?.type === "string" && value.value === ""));
}

// Loaders that take a module's name: `require`, `import()`, `process.getBuiltinModule` (`require` by another name).
const LOADERS = new Set(["require", "import", "getBuiltinModule"]);

/** Whether the `(` at `open` calls what stands before it — `f(x)` — rather than holding a value: `(cp)`, `return (cp)`. */
const callsAt = (tokens, open) => {
  const before = tokens[open - 1];
  return before?.templateEnd === true || (isName(before) && (isPunct(tokens[open - 2], ".") || isPunct(tokens[open - 2], "#") || (before.value === "of" ? before.keyword !== true : !KEYWORDS_BEFORE_EXPRESSION.has(before.value) && !HEAD_KEYWORDS.has(before.value)))) || isPunct(before, ")") || isPunct(before, "]");
};

/** The first token of the member chain whose last token is at `last`: `module.require`, `globalThis.process["x"]`. */
function chainStart(tokens, last) {
  for (let at = last; ;) {
    if (isPunct(tokens[at], "]") && opening(tokens, at) > 0) at = opening(tokens, at) - 1;
    else if (isName(tokens[at]) && isPunct(tokens[at - 1], ".") && at >= 2) at -= 2;
    else return at;
  }
}

/**
 * Past the token at `at`: past its bracket pair if it opens one, past the
 * whole template literal if it begins one with substitutions — the commas of
 * their code are not a list's.
 */
function stepOver(tokens, at) {
  const shut = tokens[at]?.type === "template" && tokens[at].last > at ? tokens[at].last : closing(tokens, at);
  return shut > at ? shut + 1 : at + 1;
}

/** The index of the `,` that ends the argument at `start`, or -1 where the arguments, or the template they began in, end first. */
function argumentEnd(tokens, start) {
  for (let at = start; ; ) {
    const token = tokens[at];
    if (!token || token.within !== tokens[start].within || isPunct(token, ")") || isPunct(token, "]") || isPunct(token, "}")) return -1;
    if (isPunct(token, ",")) return at;
    at = stepOver(tokens, at);
  }
}

/** Whether the argument at `at` is the module's name, in as many parentheses as it is written in: `(("child_process"))`. */
function moduleArgument(tokens, at) {
  let depth = 0;
  for (; isPunct(tokens[at], "("); at += 1) depth += 1;
  if (!isModuleString(tokens[at])) return false;
  let end = at + 1;
  for (; depth > 0; depth -= 1, end += 1) if (!isPunct(tokens[end], ")")) return false;
  return isPunct(tokens[end], ")") || isPunct(tokens[end], ",") || isPunct(tokens[end], "]");
}

/**
 * A loader called with the child_process module's name at `index` — the
 * loader's name, or the plain-string key it is taken by, `process["getBuiltinModule"]`
 * — and the call's value, `[start, end)`; or null. The loader may be a member
 * (`module.require`, `process.getBuiltinModule`), stand in parentheses
 * (`(0, require)`), or be called through `.call` or `.apply`; each is the same
 * call.
 */
function loaderCall(tokens, index) {
  const token = tokens[index];
  const keyed = token?.type === "string" && isPunct(tokens[index - 1], "[") && isPunct(tokens[index + 1], "]");
  if (!(isName(token) || keyed) || !LOADERS.has(token.value)) return null;
  // `import(…)` is a keyword's, never a member's: `loader.import(…)` is a method of its own.
  if (token.value === "import" && (keyed || isPunct(tokens[index - 1], "."))) return null;
  // No call with the module's name after it, past any parentheses: no call — and no walk back along a chain of loader
  // names, which made `x.require.require…` cost its length squared.
  let end = keyed ? index + 2 : index + 1;
  let past = end;
  while (isPunct(tokens[past], ")")) past += 1;
  if (moduleCall(tokens, past) < 0) return null;
  let start = chainStart(tokens, keyed ? index + 1 : index);
  // `(0, require)`, `(process.getBuiltinModule)`: parentheses the loader ends, not a call's, in its own template.
  while (isPunct(tokens[end], ")")) {
    const open = opening(tokens, end);
    const last = (open === start - 1 || isPunct(tokens[start - 1], ",")) && enclosing(tokens, start) === open && tokens[end].within === tokens[start].within;
    if (open < 0 || !last || callsAt(tokens, open)) break;
    start = open;
    end += 1;
  }
  const open = moduleCall(tokens, end);
  const shut = open >= 0 ? closing(tokens, open) : -1;
  return shut < 0 ? null : { kind: token.value, start, end: shut + 1 };
}

/**
 * The `(` of the call at `end` whose argument is the module's name — `(…)`,
 * `.call(thisArg, …)` or `.apply(thisArg, […])` — or -1.
 */
function moduleCall(tokens, end) {
  if (isPunct(tokens[end], "(")) return moduleArgument(tokens, end + 1) ? end : -1;
  if (isPunct(tokens[end], ".") && (isName(tokens[end + 1], "call") || isName(tokens[end + 1], "apply")) && isPunct(tokens[end + 2], "(") && closing(tokens, end + 2) > 0) {
    // `.call(thisArg, "child_process")`, `.apply(thisArg, ["child_process"])`: the name is the second argument; and one
    // that never closes is not asked where its first argument ends, which would cost the rest of the file.
    const comma = argumentEnd(tokens, end + 3);
    const array = tokens[end + 1].value === "apply";
    const found = comma >= 0 && (array ? isPunct(tokens[comma + 1], "[") && moduleArgument(tokens, comma + 2) : moduleArgument(tokens, comma + 1));
    return found ? end + 2 : -1;
  }
  return -1;
}

/**
 * Where the child_process module is reached in these tokens: a loader's call
 * (`start`, `end`), or a static import's or export's clause.
 */
function moduleReaches(tokens) {
  const reaches = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const call = loaderCall(tokens, index);
    if (call) {
      reaches.push({ kind: call.kind, start: call.start, end: call.end, line: token.line });
      index = call.end - 1;
      continue;
    }
    if (isName(token, "from") && isModuleString(tokens[index + 1])) {
      // Back to the `import` or `export` its clause begins with, over names, `*`, `,`, `{ … }` and a string after `as`
      // (`export * as "cp" from …`): anything else there means this `from` begins no clause, and no search runs on to
      // the start of the file.
      let start = index - 1;
      for (;;) {
        const before = tokens[start];
        if (isPunct(before, "}") && opening(tokens, start) >= 0) start = opening(tokens, start) - 1;
        else if ((isName(before) && before.value !== "import" && before.value !== "export") || isPunct(before, ",") || isPunct(before, "*")
          || (before?.type === "string" && isName(tokens[start - 1], "as"))) start -= 1;
        else break;
      }
      if (isName(tokens[start], "import") || isName(tokens[start], "export")) {
        reaches.push({ kind: "static", start, end: index + 2, clause: [start + 1, index], line: token.line });
      }
    }
  }
  return reaches;
}

/**
 * The findings for one source file: `{ rule, line, message }`, in the order
 * they appear. `allowEval` lets a file use `eval` and the `Function`
 * constructor — the desktop tests do, to show the page's policy refuses them.
 *
 * @param {string} source
 * @param {{ allowEval?: boolean, script?: boolean }} [options] - `script`: the file is a script (`.cjs`), read with its
 *   HTML-like comments.
 * @returns {Array<{ rule: string, line: number, message: string }>}
 */
export function forbiddenCalls(source, { allowEval = false, script = false } = {}) {
  const tokens = codeTokens(source, { script });
  const findings = [];
  const say = (rule, line, message) => findings.push({ rule, line, message });
  const aliases = new Set();
  const globals = new Set(GLOBAL_OBJECTS);
  const childProcessFinding = (line, what) => say("child_process.exec", line, `child_process ${what} is forbidden; use argv-based execution (spawn, spawnSync, execFile, execFileSync).`);

  // Where a declaration goes on after one declarator — `run = cp`, `{ a } = b` — to the `,` before the next, or to where it ends:
  // a `;`, a bracket it did not open, the end of the template it began in, or a line that begins a statement: after a
  // value's end, one that begins with a word, a prefix `++` or `--` (`1⏎++b, c = cp`), `!`, `~`, a string or a number, after a postfix or a `yield` also with a `(`, `[` or template, after a `yield` with a `/`, `+` or `-`;
  // after an arrow's body at the declaration's own level, not in a template's code, which no call follows, any but a `:`. Each place it passes is marked: a word there is in its declaration and not walked again,
  // a script's `var a = let[0] + let[0]`; the place it ends at is not: `const a = 1⏎let run = cp` declares.
  const walked = new Uint8Array(tokens.length + 1);
  const declaratorEnd = (at) => {
    for (let next = at; next < tokens.length; ) {
      const token = tokens[next];
      if ([",", ";", ")", "]", "}"].some((value) => isPunct(token, value)) || token.within !== tokens[at].within) return next;
      const previous = tokens[next - 1];
      // A value ends where an operand does — a name `of` too, a member's name as any, `o.in`, a template's end — at a `}`, and at a postfix, `n++`, or a `yield` a line break ends, after which a line that begins with a template, `(` or `[` begins a statement too — but not one that ends a template's code: the template is the operand.
      const breaks = previous.templateEnd !== true && ((isName(previous, "yield") && !isPunct(tokens[next - 2], ".") && !isPunct(tokens[next - 2], "#")) || ((isPunct(previous, "+") || isPunct(previous, "-")) && previous.joined === true && (endsOperand(tokens[next - 3]) || isPunct(tokens[next - 4], ".") || isPunct(tokens[next - 4], "#"))));
      const endsValue = breaks || (endsOperand(previous) && !isName(previous, "extends")) || isPunct(previous, "}") || (isName(previous) && (isPunct(tokens[next - 2], ".") || isPunct(tokens[next - 2], "#")));
      if (next > at && token.line > previous.line && ((endsValue && ((isName(token) && token.value !== "in" && token.value !== "instanceof") || tokens[next + 1]?.joined === true || (isPunct(token, "!") && !isPunct(tokens[next + 1], "=")) || isPunct(token, "~") || token.type === "number" || (token.type === "string" && token.template !== true) || (breaks && (isPunct(token, "(") || isPunct(token, "[") || token.type === "template" || token.template === true || (isName(previous, "yield") && (token.type === "regex" || isPunct(token, "+") || isPunct(token, "-")))))))
        || (tokens[opening(tokens, next - 1)]?.arrowBody === true && previous.within === tokens[at].within && !isPunct(token, ":")))) return next;
      // `export` only ever begins a statement, and the walk stops there whatever came before.
      if (next > at && isName(token, "export") && !isPunct(previous, ".")) return next;
      walked[next] = 1;
      next = stepOver(tokens, next);
    }
    return tokens.length;
  };
  // A member's name is no binding: `target.run`, `this.#run`, and a class's field — a name right in its body, not in a
  // substitution there, after `{`, `;`, `}` or `static`, or on a line of its own after an operand (not after `n++` or
  // a word an operand follows): `class A { run = cp }`, but not `x =⏎ run = cp`, which assigns.
  const isMember = (index) => {
    if (isPunct(tokens[index - 1], ".") || isPunct(tokens[index - 1], "#")) return true;
    const before = tokens[index - 1];
    return tokens[index].substitution !== true && tokens[enclosing(tokens, index)]?.classBody === true && (isPunct(before, "{") || isPunct(before, ";")
      || isPunct(before, "}") || isName(before, "static") || (before.line < tokens[index].line && endsOperand(before)));
  };
  // What `export const`, `let` or `var` declares — a name, or a pattern's opening bracket — and the names an exported
  // `let` or `var` declares: a module object bound to one goes to other files — the `const` where it is declared, a `let`
  // or `var` wherever it is assigned, `export let run; run = cp`. What every other declaration
  // declares too: a pattern that declares names assigns none, and a name declared there is a local of its own.
  const exported = new Set();
  const exportedNames = new Set();
  const declared = new Set();
  tokens.forEach((token, index) => {
    if (!isName(token) || !DECLARATIONS.has(token.value) || walked[index] === 1 || token.substitution === true || isMember(index) || tokens[enclosing(tokens, index)]?.classBody === true) return;
    // What a declaration declares follows its word: `{ const: 1 }`, `let() {}`, `[let, let]` declare nothing; none
    // stands right in a template's substitution, nor right in a class's body, strict code where it names a member.
    if (!isName(tokens[index + 1]) && !isPunct(tokens[index + 1], "{") && !isPunct(tokens[index + 1], "[")) return;
    const out = isName(tokens[index - 1], "export");
    for (let at = index + 1; at < tokens.length; at += 1) {
      if (isName(tokens[at]) || isPunct(tokens[at], "{") || isPunct(tokens[at], "[")) (out ? exported : declared).add(at);
      if (out && isName(tokens[at]) && !isName(token, "const")) exportedNames.add(tokens[at].value);
      at = declaratorEnd(at);
      if (!isPunct(tokens[at], ",")) break;
    }
  });
  if (tokens.unterminated) {
    say("unread", tokens.unterminated, `this file could not be read past line ${tokens.unterminated}: a template literal, a substitution or a comment there never ends, so whatever follows would go unchecked.`);
  }

  const calls = (open) => callsAt(tokens, open);
  // The value from `start` up to `end`, widened over what leaves it the same value — parentheses around it or around a
  // list it ends (`(cp)`, `(0, globalThis)`) in its own template, and an `await` before it: `[start, end)` of the whole.
  const widen = (start, end) => {
    for (;;) {
      const open = opening(tokens, end);
      if (isPunct(tokens[end], ")") && open >= 0 && !calls(open) && (open === start - 1 || isPunct(tokens[start - 1], ",")) && enclosing(tokens, start) === open && tokens[end].within === tokens[start].within) {
        start = open;
        end += 1;
      } else if (isName(tokens[start - 1], "await")) start -= 1;
      else return [start, end];
    }
  };
  // Past the module's own `default`: `ns.default`, `ns["default"]`, as often as it is written.
  const pastDefault = (index) => {
    let at = index;
    for (;;) {
      if (isPunct(tokens[at], ".") && isName(tokens[at + 1], "default")) at += 2;
      else if (isPunct(tokens[at], "[") && tokens[at + 1]?.type === "string" && tokens[at + 1].value === "default" && isPunct(tokens[at + 2], "]")) at += 3;
      else return at;
    }
  };
  // `<module>.exec` / `<module>["exec"]` / a computed member that cannot be read.
  const execMember = (index) => {
    if (isPunct(tokens[index], ".") && isName(tokens[index + 1]) && FORBIDDEN_MEMBERS.has(tokens[index + 1].value)) return tokens[index + 1].value;
    if (isPunct(tokens[index], "[")) {
      const key = plainKey(tokens, index);
      if (key !== null) return FORBIDDEN_MEMBERS.has(key) ? key : null;
      return "a computed member";
    }
    return null;
  };
  const memberFinding = (index, name) => {
    const member = execMember(index);
    if (member) childProcessFinding(tokens[index].line, member === "a computed member" ? `${member}${name ? ` (of ${name})` : ""}` : `${member} (${name ? `${name}.${member}` : "a member of the module"})`);
  };
  // The first token of each entry of the pattern or literal opened at `open`.
  const entries = (open) => {
    const starts = [];
    const end = closing(tokens, open);
    for (let at = open + 1; at < end; at += 1) {
      starts.push(at);
      while (at < end && !isPunct(tokens[at], ",")) at = stepOver(tokens, at);
    }
    return starts;
  };
  // An exported `let` or `var` whose name the file declares again — a declaration of its own, in a pattern or not, a
  // parameter, a function or a class — is not told from that local by its name: no assignment of that name is read as
  // an export, `export let run; function f(run) { run = cp; }`.
  const shadowed = new Set();
  const arrow = (at) => isPunct(tokens[at], "=") && isPunct(tokens[at + 1], ">");
  // Where a pattern or a parameter list binds a name: each entry's name, the target past a key's `:`, a rest element's,
  // a nested pattern's — never a key, nor what a default value holds (`{ a = run }` binds `a`).
  const bindings = new Set();
  const bindingsOf = (open) => {
    for (const pending = [open]; pending.length; ) {
      const container = pending.pop();
      for (let at of entries(container)) {
        if (isPunct(tokens[at], "...")) at += 1;
        // A key — a name, a string, a computed `[…]` — is followed by its `:`; nothing in an array or a parameter list is.
        const key = isPunct(tokens[at], "[") ? closing(tokens, at) : at;
        if (isPunct(tokens[key + 1], ":")) at = key + 2;
        if (isName(tokens[at])) bindings.add(at);
        else if (isPunct(tokens[at], "{") || isPunct(tokens[at], "[")) pending.push(at);
      }
    }
  };
  tokens.forEach((token, open) => {
    if (declared.has(open)) bindingsOf(open);
    if (isPunct(token, "(") && parameterList(tokens, open)) bindingsOf(open);
  });
  tokens.forEach((token, index) => {
    if (!isName(token) || !exportedNames.has(token.value)) return;
    // A lone arrow parameter, `run =>`, and `function run`, `function* run`, `class run` declare it too — not a member
    // of that name, `o.class⏎run = cp`.
    const keyword = (at) => (isName(tokens[at], "function") || isName(tokens[at], "class")) && !isMember(at);
    if (bindings.has(index) || declared.has(index) || arrow(index + 1) || keyword(index - 1) || (isPunct(tokens[index - 1], "*") && keyword(index - 2))) {
      shadowed.add(token.value);
    }
  });
  // `{ exec, default: cp, ...rest, [key]: x } = <module>`: what each entry takes out of it, nested `default`s and all —
  // the names it binds to the module, and the exec members it takes out.
  const modulePattern = (open, bound = (name) => aliases.add(name), found = childProcessFinding) => {
    for (const pending = [open]; pending.length; ) {
      for (const index of entries(pending.pop())) {
        const first = tokens[index];
        if (isPunct(first, "...") && isName(tokens[index + 1])) bound(tokens[index + 1].value);
        else if (isPunct(first, "[")) {
          const key = plainKey(tokens, index);
          if (key === null || FORBIDDEN_MEMBERS.has(key)) found(first.line, key ?? "a computed member");
        } else if (first && (first.type === "name" || first.type === "string")) {
          if (FORBIDDEN_MEMBERS.has(first.value)) found(first.line, first.value);
          if (first.value === "default" && isPunct(tokens[index + 1], ":")) {
            const binding = tokens[index + 2];
            if (isName(binding)) bound(binding.value);
            else if (isPunct(binding, "{")) pending.push(index + 2);
          }
        }
      }
    }
  };
  // The parameter of `.then(…)` at `index` (just inside its parenthesis): what the callback calls the module.
  const thenParameter = (index) => {
    let at = index;
    if (isName(tokens[at], "async")) at += 1;
    if (isName(tokens[at], "function")) {
      at += 1;
      if (isName(tokens[at])) at += 1;
    }
    if (isPunct(tokens[at], "(")) at += 1;
    if (isPunct(tokens[at], "{")) modulePattern(at);
    else if (isName(tokens[at])) aliases.add(tokens[at].value);
  };
  // Where the module object standing at `start`, its value ending at `end`, goes: bound to a name, taken apart by a pattern,
  // or handed to another file — `module.exports = …`, `exports.x = …`, `export default …`, an exported declaration. To another
  // file it goes as the whole value only, one the module ends — at a `,`, a `;`, a closing bracket, a line the value cannot
  // carry on into, or a further `=`: `export const ok = cp !== undefined` exports a boolean.
  const handedOn = (start, what, end) => {
    if (isPunct(tokens[start - 1], "...")) {
      // A spread hands exec on with the rest; a rest element binds a name — a pattern's, `{ spawn, ...others } = cp`, or
      // a parameter list's, `function g(...run)`.
      const holder = enclosing(tokens, start);
      const pattern = (isPunct(tokens[holder], "{") || isPunct(tokens[holder], "[")) && isPattern(tokens, holder);
      if (!pattern && !bindings.has(start)) childProcessFinding(tokens[start].line, `${what} (spread: its exec goes with it)`);
      return;
    }
    const whole = valueEnds(tokens, end) || assigns(tokens, end);
    if (isName(tokens[start - 1], "default") && isName(tokens[start - 2], "export")) {
      if (whole) childProcessFinding(tokens[start].line, `${what} (exported as default)`);
      return;
    }
    if (!assigns(tokens, start - 1)) return;
    const target = assignedAt(tokens, start - 1);
    // The head of the chain assigned to: `module.exports.cp`, `exports["cp"]`, `module["exports"]`.
    const head = chainStart(tokens, target);
    const exportsNext = isPunct(tokens[head + 1], ".") ? isName(tokens[head + 2], "exports")
      : isPunct(tokens[head + 1], "[") && tokens[head + 2]?.type === "string" && tokens[head + 2].value === "exports" && isPunct(tokens[head + 3], "]");
    if (isName(tokens[head], "exports") || (isName(tokens[head], "module") && exportsNext)) {
      if (whole) childProcessFinding(tokens[target].line, `${what} (exported from this file)`);
    } else if (isName(tokens[target]) && !isMember(target)) {
      // A value the module only takes part in, `ok = cp !== undefined`, binds no name to it.
      if (!whole) return;
      const name = tokens[target].value;
      aliases.add(name);
      // `export const run = cp`, `export let run; run = cp`: the binding goes to other files, and the module with it.
      if (exported.has(target) || (exportedNames.has(name) && !shadowed.has(name))) childProcessFinding(tokens[target].line, `${what} (exported from this file)`);
    } else if (isPunct(tokens[target], "}") && whole) {
      // `export const { default: run, ...rest } = cp`, `({ default: run } = cp)` to an exported `let`: what the pattern
      // binds to the module goes to other files.
      const open = opening(tokens, target);
      modulePattern(open, (name) => {
        aliases.add(name);
        const out = exported.has(open) || (exportedNames.has(name) && !shadowed.has(name));
        if (out) childProcessFinding(tokens[open].line, `${what} (exported from this file as ${name})`);
      });
    }
  };

  for (const reach of moduleReaches(tokens)) {
    if (reach.kind === "static") {
      // import x, * as y, { a, b as c, default as d } from "child_process"; export { … }, export * from it.
      const exported = isName(tokens[reach.start], "export");
      const [from, to] = reach.clause;
      for (let index = from; index < to; index += 1) {
        const token = tokens[index];
        if (isPunct(token, "{")) {
          const end = closing(tokens, index);
          for (let inner = index + 1; inner < end; inner += 1) {
            const name = tokens[inner];
            const previous = tokens[inner - 1];
            if (!(name.type === "name" || name.type === "string") || !(isPunct(previous, "{") || isPunct(previous, ","))) continue;
            if (FORBIDDEN_MEMBERS.has(name.value)) childProcessFinding(name.line, `${name.value} (${exported ? "exported" : "imported"} by name)`);
            else if (name.value === "default" && exported) childProcessFinding(name.line, "default, the module itself (exported by name)");
            else if (name.value === "default" && isName(tokens[inner + 1], "as") && isName(tokens[inner + 2])) aliases.add(tokens[inner + 2].value);
          }
          index = end;
        } else if (isPunct(token, "*") && exported) {
          childProcessFinding(token.line, "as a whole (export * from it)");
          index = to;
        } else if (isPunct(token, "*") && isName(tokens[index + 1], "as") && isName(tokens[index + 2])) {
          aliases.add(tokens[index + 2].value);
          index += 2;
        } else if (!exported && isName(token) && token.value !== "type" && (isPunct(tokens[index + 1], ",") || index + 1 === to)) {
          aliases.add(token.value);
        }
      }
      continue;
    }
    // The module object as a value: in as many parentheses as it is written in, awaited or not, and past its `default`.
    let [start, end] = widen(reach.start, reach.end);
    end = pastDefault(end);
    memberFinding(end, "");
    if (isPunct(tokens[end], ".") && isName(tokens[end + 1], "then") && isPunct(tokens[end + 2], "(")) thenParameter(end + 3);
    else if (!isPunct(tokens[end], ".") && !isPunct(tokens[end], "[") && !isPunct(tokens[end], "(")) handedOn(start, "the module object", end);
  }

  // What follows a value and leaves it the same: `.default`, `["default"]`, a global's own names. The index past them.
  const sameValue = (end) => {
    for (;;) {
      const member = tokens[end + 1];
      if (isPunct(tokens[end], ".") && isName(member) && (member.value === "default" || GLOBAL_OBJECTS.has(member.value))) end += 2;
      else if (isPunct(tokens[end], "[") && member?.type === "string" && member.value === "default" && isPunct(tokens[end + 2], "]")) end += 3;
      else return end;
    }
  };
  // The name a plain value comes down to, from `at` on: past `await`, the parentheses around it and the lists it ends
  // (`(0, cp)` is `cp`), past an assignment it is the target of (`a = b = cp`, `(b = cp)`), on through what leaves it
  // the same, after its parentheses too (`(0, globalThis).globalThis`). `[name, end]`, where `end` is just past the
  // value, or null. Each start is worked out once: a chain of assignments, `a0 = (a1 = (… 0))`, asks it
  // of every link, and walked from each it cost its length squared.
  const plainValues = new Map();
  const plainValue = (from) => {
    // The way down — each step's start, and for parentheses where they close — to a start already known or a name.
    const steps = [];
    let at = from;
    let value = null;
    for (;;) {
      if (plainValues.has(at)) {
        value = plainValues.get(at);
        break;
      }
      if (isName(tokens[at], "await") || (isName(tokens[at]) && assigns(tokens, at + 1))) {
        steps.push([at, -1]);
        at += isName(tokens[at], "await") ? 1 : 2;
      } else if (isPunct(tokens[at], "(")) {
        const shut = closing(tokens, at);
        if (shut < 0) {
          plainValues.set(at, null);
          break;
        }
        steps.push([at, shut]);
        // The list's last item: back from the `)` to its last `,` — not a `,` of a template's code — over whole brackets.
        let item = shut;
        while (item - 1 > at && !(isPunct(tokens[item - 1], ",") && tokens[item - 1].within === tokens[at].within)) {
          const open = opening(tokens, item - 1);
          item = open > at ? open : item - 1;
        }
        at = item;
      } else {
        value = isName(tokens[at]) ? [at, sameValue(at + 1)] : null;
        plainValues.set(at, value);
        break;
      }
    }
    // Back up: each parenthesis closes right after what it holds — `(cp)`, `(0, cp)`, not `(cp.x)` or `(cp + 1)`.
    for (let step = steps.length - 1; step >= 0; step -= 1) {
      const [start, shut] = steps[step];
      if (value && shut >= 0) value = value[1] === shut ? [value[0], sameValue(shut + 1)] : null;
      plainValues.set(start, value);
    }
    return value;
  };
  // A plain re-binding hands the name on — `const c2 = cp`, `c2 ??= (cp)`, `const cp = ns.default`,
  // `const m = await loading`, `const g = (0, globalThis)`, `a = b = cp` — and a pattern takes the module out of one:
  // `const { default: c3, ...rest } = c2`. However long the chain, in any order.
  const boundTo = new Map();
  const takenFrom = new Map();
  const bind = (map, from, name) => {
    if (!map.has(from)) map.set(from, []);
    map.get(from).push(name);
  };
  for (let index = 2; index < tokens.length; index += 1) {
    if (!assigns(tokens, index)) continue;
    const value = plainValue(index + 1);
    if (!value) continue;
    const [at, end] = value;
    // `[a = cp] = []` too: a default in a pattern binds the name.
    if (!valueEnds(tokens, end)) continue;
    const target = assignedAt(tokens, index);
    if (isName(tokens[target]) && !isMember(target)) bind(boundTo, tokens[at].value, tokens[target].value);
    else if (isPunct(tokens[target], "}")) modulePattern(opening(tokens, target), (name) => bind(takenFrom, tokens[at].value, name), () => {});
  }
  for (const [known, maps] of [[aliases, [boundTo, takenFrom]], [globals, [boundTo]]]) {
    for (const queue = [...known]; queue.length; ) {
      const from = queue.pop();
      for (const map of maps) {
        for (const name of map.get(from) ?? []) {
          if (!known.has(name)) {
            known.add(name);
            queue.push(name);
          }
        }
      }
    }
  }
  // A global, or a global's own name for itself: `globalThis`, `global.globalThis`, `g` after `const g = globalThis` —
  // worked out once, front to back, so a long chain costs one step a link.
  const globalAt = new Uint8Array(tokens.length);
  tokens.forEach((token, index) => {
    globalAt[index] = isName(token) && globals.has(token.value) && (!isPunct(tokens[index - 1], ".") || globalAt[index - 2] === 1) ? 1 : 0;
  });
  const isGlobal = (index) => globalAt[index] === 1;
  // An object literal's own key or method — `{ eval: true }` (a Worker option), `{ eval() {} }` — which names nothing global.
  const ownKey = (index) => {
    const next = tokens[index + 1];
    const method = isPunct(next, "(") && isPunct(tokens[closing(tokens, index + 1) + 1], "{");
    return (isPunct(next, ":") || method) && (isPunct(tokens[index - 1], "{") || isPunct(tokens[index - 1], ",")) && inObjectLiteral(tokens, index);
  };
  // `.call`, `.apply` or `.bind` called on it straight away: `Function.call(null, "…")` — not `Function.call.bind(…)`.
  const throughCall = (index) => isPunct(tokens[index], ".") && ["call", "apply", "bind"].includes(tokens[index + 1]?.value) && isPunct(tokens[index + 2], "(");
  // What stands at `index` is called: `(…)`, a tagged template, or `.call`/`.apply`/`.bind`.
  const called = (index) => isPunct(tokens[index], "(") || tokens[index]?.type === "string" || tokens[index]?.type === "template" || throughCall(index);
  // `Function.constructor` and `Function.prototype.constructor` are `Function`: the index of that `constructor`, or -1.
  const functionConstructor = (index) => {
    const at = isPunct(tokens[index + 1], ".") && isName(tokens[index + 2], "prototype") ? index + 2 : index;
    return isPunct(tokens[at + 1], ".") && isName(tokens[at + 2], "constructor") ? at + 2 : -1;
  };
  // The key in the brackets at `open` of a global's member: refused unless one plain string that names neither of the two.
  const globalMember = (open, token, { named = true } = {}) => {
    const key = plainKey(tokens, open);
    if (key === null || (named && !allowEval && ["eval", "Function"].includes(key))) {
      say("global-member", token.line, `a computed member of ${token.value} is forbidden unless its key is one plain string: it can reach eval or Function under any spelling.`);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    // A name bound to the module: its exec members, its `.then`, a pattern taking them out, or the module handed on.
    if (isName(token) && aliases.has(token.value) && !isPunct(previous, ".")) {
      const [start, end] = widen(index, index + 1);
      const member = pastDefault(end);
      memberFinding(member, token.value);
      if (isPunct(tokens[member], ".") && isName(tokens[member + 1], "then") && isPunct(tokens[member + 2], "(")) thenParameter(member + 3);
      else if (!isPunct(tokens[member], ".") && !isPunct(tokens[member], "[") && !isPunct(tokens[member], "(")) {
        handedOn(start, token.value, member);
        const holder = enclosing(tokens, index);
        if (isName(tokens[holder - 1], "export") && (isPunct(previous, "{") || isPunct(previous, ","))) childProcessFinding(token.line, `${token.value} (exported by name)`);
      }
    }
    if (!allowEval && isName(token, "eval") && !ownKey(index)) say("eval", token.line, "eval is forbidden, called or handed on.");
    const viaConstructor = isName(token, "Function") ? functionConstructor(index) : -1;
    const reached = viaConstructor < 0 ? !isPunct(next, ".") || throughCall(index + 1) : !isPunct(tokens[viaConstructor + 1], ".") || throughCall(viaConstructor + 1);
    if (!allowEval && isName(token, "Function") && reached && !isName(previous, "instanceof")
      && (!isPunct(previous, ".") || isGlobal(index - 2)) && !ownKey(index)) {
      say("Function", token.line, "the Function constructor is forbidden, called or handed on.");
    }
    // `x.constructor(…)`, `x["constructor"](…)`, a tagged template on it: ({}).constructor.constructor is Function.
    const constructorKey = isPunct(token, "[") && tokens[index + 1]?.type === "string" && tokens[index + 1].value === "constructor" && isPunct(tokens[index + 2], "]");
    if (!allowEval && ((isName(token, "constructor") && isPunct(previous, ".") && called(index + 1)) || (constructorKey && called(index + 3)))) {
      say("Function", token.line, "calling a .constructor member is forbidden: ({}).constructor.constructor is the Function constructor.");
    }
    // A quoted or computed key that takes eval or Function out of something: `const { "eval": run } = globalThis`.
    if (!allowEval && token.type === "string" && (token.value === "eval" || token.value === "Function")) {
      const key = isPunct(previous, "[") && isPunct(next, "]") ? index - 1 : index;
      if (isPunct(tokens[key === index ? index + 1 : index + 2], ":") && (isPunct(tokens[key - 1], "{") || isPunct(tokens[key - 1], ",")) && !inObjectLiteral(tokens, key)) {
        say(token.value, token.line, `${token.value} is forbidden, called or handed on: this pattern takes it out by name.`);
      }
    }
    // A chain of globals is read at its last link, `global.globalThis[…]`, and `globalThis[globalThis.k]` at the first.
    if (isGlobal(index) && !(isPunct(next, ".") && isGlobal(index + 2))) {
      // `globalThis[…]`, `(globalThis)[…]`, `(global.globalThis)[…]`: the whole chain, in its parentheses.
      let head = index;
      while (isPunct(tokens[head - 1], ".") && isGlobal(head - 2)) head -= 2;
      const [start, widened] = widen(head, index + 1);
      // `(0, globalThis).globalThis[…]`: a global's own names after its parentheses are the global still.
      let end = widened;
      while (isPunct(tokens[end], ".") && isName(tokens[end + 1]) && GLOBAL_OBJECTS.has(tokens[end + 1].value)) end += 2;
      if (isPunct(tokens[end], "[")) globalMember(end, token);
      // `const { [key]: f } = globalThis`: a computed member taken out by a pattern.
      else if (assigns(tokens, start - 1) && isPunct(tokens[start - 2], "}") && !isPunct(tokens[end], ".") && !isPunct(tokens[end], "(")) {
        // A plain "eval" or "Function" key there is the quoted-key rule's above.
        for (const entry of entries(opening(tokens, start - 2))) if (isPunct(tokens[entry], "[")) globalMember(entry, token, { named: false });
      }
    }
    // shell: <value> / "shell": <value> / ["shell"]: <value> / { shell } in an object literal, and <member>.shell = <value>.
    const computedShell = isPunct(token, "[") && tokens[index + 1]?.type === "string" && tokens[index + 1].value === "shell" && isPunct(tokens[index + 2], "]");
    const shellName = (isName(token, "shell") || (token.type === "string" && token.value === "shell")) && !isPunct(previous, ".") && !isPunct(previous, "[");
    // `{ get shell() {…} }`, `{ async shell() {} }`: an accessor or a method gives the option a value nobody can read.
    const accessor = ["get", "set", "async"].some((word) => isName(previous, word)) && (isPunct(tokens[index - 2], "{") || isPunct(tokens[index - 2], ","));
    if ((shellName || computedShell) && (isPunct(previous, "{") || isPunct(previous, ",") || accessor) && inObjectLiteral(tokens, index)) {
      const colon = computedShell ? index + 3 : index + 1;
      if (isPunct(tokens[colon], ":") && !accessor) {
        if (!plainlyOff(tokens, colon + 1)) say("shell", token.line, "a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
      } else if (isPunct(tokens[colon], "(") || (isName(token) && (isPunct(next, ",") || isPunct(next, "}")))) {
        say("shell", token.line, "a shell option whose value cannot be read here is forbidden: write shell: false, or leave it out.");
      }
    }
    const member = isName(token, "shell") && isPunct(previous, ".") ? index + 1
      : computedShell && !isPunct(previous, "{") && !isPunct(previous, ",") ? index + 3 : -1;
    const set = member < 0 ? -1 : assignmentAt(tokens, member);
    if (set >= 0 && !plainlyOff(tokens, set + 1)) {
      say("shell", token.line, "setting a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
    }
  }
  return findings;
}
