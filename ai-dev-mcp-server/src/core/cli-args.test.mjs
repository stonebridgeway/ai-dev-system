import assert from "node:assert/strict";
import test from "node:test";
import { CliUsageError, EXIT, closest, parseCommandLine } from "./cli-args.mjs";

const SETUP = {
  command: "setup",
  options: {
    yes: { type: "boolean", short: "y" },
    clients: { type: "string" },
    force: { type: "boolean" },
    health: { type: "boolean", default: true }
  }
};

function refusal(argv, spec = SETUP) {
  try {
    parseCommandLine(argv, spec);
  } catch (error) {
    assert.ok(error instanceof CliUsageError);
    assert.equal(error.exitCode, EXIT.usage);
    return error.message;
  }
  return assert.fail(`accepted: ${argv.join(" ")}`);
}

test("exit codes are the four the CLI documents", () => {
  assert.deepEqual(EXIT, { ok: 0, failed: 1, usage: 2, interrupted: 130 });
});

test("flags in every spelling: --flag, --no-flag, --name=value, --name value, -y, and --no- on a valued option", () => {
  assert.deepEqual(parseCommandLine([], SETUP).values, { health: true });
  assert.deepEqual(parseCommandLine(["-y", "--clients=all", "--no-health"], SETUP).values, { yes: true, clients: "all", health: false });
  assert.deepEqual(parseCommandLine(["--clients", "cursor,vscode"], SETUP).values, { clients: "cursor,vscode", health: true });
  assert.deepEqual(parseCommandLine(["--no-clients"], SETUP).values, { clients: false, health: true });
  assert.deepEqual(parseCommandLine(["--clients=x", "--no-clients"], SETUP).values.clients, false);
  assert.deepEqual(parseCommandLine(["-h"], SETUP).values.help, true);
});

test("plain arguments are counted, and what follows -- is never an option", () => {
  const spec = { command: "model", positionals: { max: 2, names: "arguments" } };
  assert.deepEqual(parseCommandLine(["import", "/tmp/m.zip"], spec).positionals, ["import", "/tmp/m.zip"]);
  assert.deepEqual(parseCommandLine(["--", "--no-clients"], { command: "galaxy", options: { clients: { type: "string" } }, positionals: { max: 5 } }).positionals, ["--no-clients"]);
  assert.match(refusal(["a", "b", "c"], spec), /^`ai-dev model` takes at most 2 arguments, and was given "c" as well\./);
  assert.match(refusal(["x"], { command: "doctor" }), /^`ai-dev doctor` takes no argument, and was given "x" as well\. See `ai-dev help doctor`\.$/);
  assert.match(refusal([], { command: "import", positionals: { min: 1, max: 1, names: "path" } }), /^`ai-dev import` needs a path\./);
  assert.deepEqual(parseCommandLine(["--help", "x", "y"], { command: "doctor" }).values.help, true, "help wins over a count");
});

test("every mistake is one sentence naming the command, with the nearest option when there is one", () => {
  assert.equal(refusal(["--forse"]), "`ai-dev setup` has no option --forse. Did you mean --force? See `ai-dev help setup`.");
  assert.equal(refusal(["--colour"]), "`ai-dev setup` has no option --colour. See `ai-dev help setup`.");
  assert.equal(refusal(["-x"]), "`ai-dev setup` has no option -x. See `ai-dev help setup`.");
  assert.equal(refusal(["--clients"]), "`ai-dev setup`: --clients needs a value, as --clients=<value>.");
  assert.equal(refusal(["--clients", "--yes"]), "`ai-dev setup`: --clients needs a value, as --clients=<value>.");
  assert.equal(refusal(["--yes=1"]), "`ai-dev setup`: --yes is a switch and takes no value.");
  // `-y=1` is a group of short flags to parseArgs: -y, -= and -1.
  assert.equal(refusal(["-y=1"]), "`ai-dev setup` has no option -=. See `ai-dev help setup`.");
});

test("closest finds a typo and nothing that only looks alike", () => {
  assert.equal(closest("instal", ["install", "import", "status"]), "install");
  assert.equal(closest("dcotor", ["doctor", "setup"]), "doctor");
  assert.equal(closest("statsu", ["status"]), "status");
  assert.equal(closest("zzz", ["install", "doctor"]), "");
  assert.equal(closest("x", ["mcp"]), "");
});
