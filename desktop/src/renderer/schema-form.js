// The tool console's form, read from a tool's `inputSchema`: the field each
// property becomes, what the field shows at first, and the arguments a filled
// form makes. No DOM here — console.js draws the fields — so a unit test runs
// it under Node.
//
// A property becomes one of these fields:
//   text     a string
//   choice   a string from an enum
//   number   a number, integer an integer (with the schema's minimum and maximum)
//   flag     a boolean
//   lines    an array of strings, one per line
//   json     anything else — an object, an array of objects, a union — as JSON

/** The fields of a tool's form, in the order the schema lists its properties. */
export function formFields(schema) {
  const properties = schema && typeof schema.properties === "object" && schema.properties ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, property]) => fieldOf(name, property && typeof property === "object" ? property : {}, required.has(name)));
}

function typeOf(property) {
  if (Array.isArray(property.type)) {
    const types = property.type.filter((type) => type !== "null");
    return types.length === 1 ? types[0] : "union";
  }
  if (property.anyOf || property.oneOf) return "union";
  return property.type;
}

function fieldOf(name, property, required) {
  const base = { name, required, description: String(property.description ?? ""), default: property.default };
  const type = typeOf(property);
  if (Array.isArray(property.enum) && property.enum.length && property.enum.every((value) => typeof value === "string")) {
    return { ...base, kind: "choice", options: [...property.enum] };
  }
  if (type === "string") return { ...base, kind: "text" };
  if (type === "integer" || type === "number") {
    return { ...base, kind: type, minimum: finite(property.minimum), maximum: finite(property.maximum) };
  }
  if (type === "boolean") return { ...base, kind: "flag" };
  if (type === "array" && property.items?.type === "string" && !property.items.enum) return { ...base, kind: "lines" };
  return { ...base, kind: "json" };
}

function finite(value) {
  return Number.isFinite(value) ? value : undefined;
}

/** What a field shows before anyone types: its default, in the field's own form. */
export function initialValue(field) {
  const value = field.default;
  switch (field.kind) {
    case "flag":
      return value === true;
    case "lines":
      return Array.isArray(value) ? value.map(String).join("\n") : "";
    case "json":
      return value === undefined ? "" : JSON.stringify(value, null, 2);
    default:
      return value === undefined || value === null ? "" : String(value);
  }
}

/**
 * The arguments a filled form makes, and what is wrong with it. A field left
 * empty is left out, so the tool applies its own default; an unchecked flag is
 * left out unless its default is true or it is required.
 *
 * @param {ReturnType<typeof formFields>} fields
 * @param {Record<string, string | boolean>} values - What each field holds, by name.
 * @returns {{ args: Record<string, unknown>, errors: Record<string, { code: string, limit?: number, message?: string }> }}
 */
export function argumentsFrom(fields, values) {
  const args = {};
  const errors = {};
  for (const field of fields) {
    const raw = values?.[field.name];
    if (field.kind === "flag") {
      const checked = raw === true;
      if (checked || field.required || field.default === true) args[field.name] = checked;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    const empty = field.kind === "lines" ? !text.split("\n").some((line) => line.trim()) : !text.trim();
    if (empty) {
      if (field.required) errors[field.name] = { code: "required" };
      continue;
    }
    const parsed = parseField(field, text);
    if (parsed.error) errors[field.name] = parsed.error;
    else args[field.name] = parsed.value;
  }
  return { args, errors };
}

function parseField(field, text) {
  switch (field.kind) {
    case "number":
    case "integer": {
      const value = Number(text.trim());
      if (!Number.isFinite(value)) return { error: { code: "number" } };
      if (field.kind === "integer" && !Number.isInteger(value)) return { error: { code: "integer" } };
      if (field.minimum !== undefined && value < field.minimum) return { error: { code: "minimum", limit: field.minimum } };
      if (field.maximum !== undefined && value > field.maximum) return { error: { code: "maximum", limit: field.maximum } };
      return { value };
    }
    case "lines":
      return { value: text.split("\n").map((line) => line.trim()).filter(Boolean) };
    case "json":
      try {
        return { value: JSON.parse(text) };
      } catch (error) {
        return { error: { code: "json", message: String(error?.message ?? error) } };
      }
    case "choice":
      return field.options.includes(text) ? { value: text } : { error: { code: "choice" } };
    default:
      return { value: text };
  }
}
