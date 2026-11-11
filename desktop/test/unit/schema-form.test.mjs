import assert from "node:assert/strict";
import test from "node:test";
import { argumentsFrom, formFields, initialValue } from "../../src/renderer/schema-form.js";

// Schemas as the daemon lists them (record_decision, logs_tail, setup_run and
// decompose_task, cut down to what each case needs).
const RECORD_DECISION = {
  type: "object",
  properties: {
    project_path: { type: "string", description: "Absolute repository path." },
    title: { type: "string" },
    decision: { type: "string" },
    alternatives: { type: "array", items: { type: "string" }, default: [] },
    status: { type: "string", enum: ["proposed", "accepted", "superseded", "rejected"], default: "accepted" }
  },
  required: ["title", "decision"]
};
const LOGS_TAIL = {
  type: "object",
  properties: {
    log: { type: "string", default: "daemon" },
    lines: { type: "integer", minimum: 1, maximum: 1000, default: 200 }
  },
  required: [],
  additionalProperties: false
};
const SETUP_RUN = {
  type: "object",
  properties: {
    model: { type: "boolean", default: false },
    force: { type: "boolean", default: true },
    clients: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    subtasks: { type: "array", items: { type: "object", properties: { task: { type: "string" } } } }
  }
};

test("each property becomes the field its type calls for, in the schema's order", () => {
  const fields = formFields(RECORD_DECISION);
  assert.deepEqual(fields.map((field) => [field.name, field.kind, field.required]), [
    ["project_path", "text", false],
    ["title", "text", true],
    ["decision", "text", true],
    ["alternatives", "lines", false],
    ["status", "choice", false]
  ]);
  assert.deepEqual(fields[4].options, ["proposed", "accepted", "superseded", "rejected"]);
  assert.equal(fields[0].description, "Absolute repository path.");
  const tail = formFields(LOGS_TAIL);
  assert.deepEqual(tail.map((field) => [field.kind, field.minimum, field.maximum]), [["text", undefined, undefined], ["integer", 1, 1000]]);
  assert.deepEqual(formFields(SETUP_RUN).map((field) => field.kind), ["flag", "flag", "json", "json"]);
  assert.deepEqual(formFields({ type: "object" }), [], "a tool without arguments has an empty form");
  assert.deepEqual(formFields(null), []);
});

test("a field starts at the schema's default", () => {
  const [path, , , alternatives, status] = formFields(RECORD_DECISION);
  assert.equal(initialValue(path), "");
  assert.equal(initialValue(alternatives), "");
  assert.equal(initialValue(status), "accepted");
  const [log, lines] = formFields(LOGS_TAIL);
  assert.equal(initialValue(log), "daemon");
  assert.equal(initialValue(lines), "200");
  const [model, force, clients] = formFields(SETUP_RUN);
  assert.equal(initialValue(model), false);
  assert.equal(initialValue(force), true);
  assert.equal(initialValue(clients), "");
  assert.equal(initialValue({ kind: "json", default: { a: 1 } }), '{\n  "a": 1\n}');
  assert.equal(initialValue({ kind: "lines", default: ["a", "b"] }), "a\nb");
});

test("a filled form makes the arguments; empty fields are left to the tool's defaults", () => {
  const fields = formFields(RECORD_DECISION);
  const { args, errors } = argumentsFrom(fields, {
    project_path: "",
    title: "Use Stripe",
    decision: "Payments go through Stripe.",
    alternatives: "PayPal\n\n  Adyen  \n",
    status: "proposed"
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(args, { title: "Use Stripe", decision: "Payments go through Stripe.", alternatives: ["PayPal", "Adyen"], status: "proposed" });
  const flags = formFields(SETUP_RUN);
  assert.deepEqual(argumentsFrom(flags, { model: false, force: true, clients: "", subtasks: "" }).args, { force: true }, "an unchecked flag with a false default is left out");
  assert.deepEqual(argumentsFrom(flags, { model: true, force: false, clients: '["cursor"]', subtasks: '[{"task":"x"}]' }).args, {
    model: true,
    force: false,
    clients: ["cursor"],
    subtasks: [{ task: "x" }]
  });
});

test("what is wrong with a form is said per field, and nothing is sent for it", () => {
  const decision = argumentsFrom(formFields(RECORD_DECISION), { title: "  ", decision: "", status: "maybe" });
  assert.deepEqual(decision.errors, { title: { code: "required" }, decision: { code: "required" }, status: { code: "choice" } });
  const tail = formFields(LOGS_TAIL);
  assert.deepEqual(argumentsFrom(tail, { lines: "12.5" }).errors, { lines: { code: "integer" } });
  assert.deepEqual(argumentsFrom(tail, { lines: "0" }).errors, { lines: { code: "minimum", limit: 1 } });
  assert.deepEqual(argumentsFrom(tail, { lines: "1001" }).errors, { lines: { code: "maximum", limit: 1000 } });
  assert.deepEqual(argumentsFrom(tail, { lines: "many" }).errors, { lines: { code: "number" } });
  assert.deepEqual(argumentsFrom(tail, { lines: " 25 " }).args, { lines: 25 });
  const broken = argumentsFrom(formFields(SETUP_RUN), { clients: "[cursor" });
  assert.equal(broken.errors.clients.code, "json");
  assert.match(broken.errors.clients.message, /JSON/);
  assert.equal(Object.hasOwn(broken.args, "clients"), false);
});
