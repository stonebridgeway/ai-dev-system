export const SKILL_OVERLAY_SCHEMA_VERSION = 1;

const ARRAY_FIELDS = new Set([
  "aliases", "categories", "subgroups", "task_types", "frameworks", "languages",
  "requires", "conflicts", "do_not_use_when"
]);
const TEXT_FIELDS = new Set([
  "display_name", "description", "use_when", "primary_group", "maturity", "trust_level",
  "routing_priority", "normalization_status", "notes", "reviewed_by", "reviewed_at"
]);

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean))];
}

/**
 * Canonical `"<source>:<name>"` key (both lower-cased and trimmed) used to index
 * skill-specific overlays.
 *
 * @param {string} source - Skill source (e.g. `custom`, `membrane/foo`).
 * @param {string} name - Skill name.
 * @returns {string}
 */
export function skillOverlayKey(source, name) {
  return `${text(source).toLowerCase()}:${text(name).toLowerCase()}`;
}

/**
 * Create an empty overlay document seeded with the default per-source routing
 * policies (custom = high priority, membrane/* = low + connector caveats, …).
 *
 * @param {string} [now] - ISO timestamp for `generated_at`.
 * @returns {object} Overlay document (schema {@link SKILL_OVERLAY_SCHEMA_VERSION}).
 */
export function createSkillOverlayDocument(now = new Date().toISOString()) {
  return {
    schema_version: SKILL_OVERLAY_SCHEMA_VERSION,
    generated_at: now,
    source_policies: {
      "custom": {
        routing_priority: "high",
        normalization_status: "curated-local"
      },
      "design/*": {
        routing_priority: "normal",
        normalization_status: "pinned-upstream"
      },
      "external/*": {
        routing_priority: "normal",
        normalization_status: "pinned-upstream"
      },
      "membrane/*": {
        routing_priority: "low",
        normalization_status: "connector-specific",
        do_not_use_when: [
          "The task does not require the named authenticated application connector.",
          "Repository-local code or documentation can solve the task without a remote app account."
        ]
      }
    },
    skills: {}
  };
}

function sanitizeOverlay(input = {}) {
  const result = {};
  for (const [field, value] of Object.entries(input ?? {})) {
    if (ARRAY_FIELDS.has(field)) result[field] = list(value);
    else if (TEXT_FIELDS.has(field)) result[field] = text(value);
  }
  return result;
}

/**
 * Validate an overlay document's schema, key format, field allowlist, and
 * (when provided) that `primary_group` / overlay targets exist in the registry.
 *
 * @param {object} document - Overlay document.
 * @param {{ knownGroups?: string[], knownSkills?: string[] }} [context]
 * @returns {string[]} Human-readable error messages (empty when valid).
 */
export function validateSkillOverlayDocument(document, {
  knownGroups = [],
  knownSkills = []
} = {}) {
  const errors = [];
  if (document?.schema_version !== SKILL_OVERLAY_SCHEMA_VERSION) {
    errors.push(`Expected skill overlay schema ${SKILL_OVERLAY_SCHEMA_VERSION}.`);
  }
  if (!document?.source_policies || typeof document.source_policies !== "object") {
    errors.push("Skill overlay source_policies must be an object.");
  }
  if (!document?.skills || typeof document.skills !== "object") {
    errors.push("Skill overlay skills must be an object.");
    return errors;
  }
  const groupSet = new Set(knownGroups);
  const skillSet = new Set(knownSkills);
  for (const [key, overlay] of Object.entries(document.skills)) {
    if (!key.includes(":")) errors.push(`Invalid skill overlay key: ${key}.`);
    const unknownFields = Object.keys(overlay ?? {}).filter((field) => (
      !ARRAY_FIELDS.has(field) && !TEXT_FIELDS.has(field)
    ));
    if (unknownFields.length) errors.push(`${key}: unknown overlay fields: ${unknownFields.join(", ")}.`);
    if (overlay?.primary_group && groupSet.size && !groupSet.has(overlay.primary_group)) {
      errors.push(`${key}: unknown primary_group "${overlay.primary_group}".`);
    }
    if (skillSet.size && !skillSet.has(key)) errors.push(`${key}: overlay target is not in the registry.`);
    if (overlay?.routing_priority && !["high", "normal", "low", "disabled"].includes(overlay.routing_priority)) {
      errors.push(`${key}: routing_priority must be high, normal, low, or disabled.`);
    }
  }
  return errors;
}

function sourcePolicy(document, source) {
  const exact = document?.source_policies?.[source];
  if (exact) return exact;
  const prefix = Object.entries(document?.source_policies ?? {})
    .filter(([pattern]) => pattern.endsWith("/*") && source.startsWith(pattern.slice(0, -1)))
    .sort((left, right) => right[0].length - left[0].length)[0];
  return prefix?.[1] ?? {};
}

/**
 * Apply the matching source policy and skill-specific overlay to a skill record:
 * array fields are merged (deduped), `do_not_use_when` is replaced, text fields
 * win when non-empty, and an `overlay` provenance block is attached.
 *
 * @param {{ source?: string, name?: string }} item - Skill record.
 * @param {object} document - Overlay document.
 * @returns {object} Overlaid record.
 */
export function applySkillOverlay(item, document) {
  const policy = sanitizeOverlay(sourcePolicy(document, text(item?.source)));
  const specific = sanitizeOverlay(document?.skills?.[skillOverlayKey(item?.source, item?.name)] ?? {});
  const overlay = { ...policy, ...specific };
  const result = { ...item };
  for (const [field, value] of Object.entries(overlay)) {
    if (ARRAY_FIELDS.has(field)) {
      if (field === "do_not_use_when") result[field] = list(value);
      else result[field] = list([...(result[field] ?? []), ...value]);
    } else if (field === "display_name") {
      result.display_name = value;
    } else if (value) {
      result[field] = value;
    }
  }
  result.overlay = {
    applied: Object.keys(overlay).length > 0,
    policy: Object.keys(policy).length > 0,
    specific: Object.keys(specific).length > 0,
    key: skillOverlayKey(item?.source, item?.name)
  };
  return result;
}

/**
 * Return a new overlay document with the overlay for `<source>:<name>` merged
 * in (stamping `reviewed_by` / `reviewed_at`). Throws if source/name are missing
 * or the overlay has no supported fields.
 *
 * @param {object} document - Existing overlay document.
 * @param {{ source: string, name: string, overlay: object, reviewer?: string, now?: string }} input
 * @returns {object} Updated overlay document.
 */
export function upsertSkillOverlay(document, {
  source,
  name,
  overlay,
  reviewer = "",
  now = new Date().toISOString()
}) {
  const key = skillOverlayKey(source, name);
  if (key === ":") throw new Error("Skill overlay requires source and name.");
  const sanitized = sanitizeOverlay(overlay);
  if (!Object.keys(sanitized).length) throw new Error("Skill overlay has no supported fields.");
  const next = {
    ...document,
    schema_version: SKILL_OVERLAY_SCHEMA_VERSION,
    generated_at: now,
    skills: {
      ...(document?.skills ?? {}),
      [key]: {
        ...(document?.skills?.[key] ?? {}),
        ...sanitized,
        reviewed_by: text(reviewer) || text(sanitized.reviewed_by),
        reviewed_at: now
      }
    }
  };
  return next;
}

/**
 * Report overlay coverage over a skill list: policy/specific counts, orphan
 * overlays (targets not in the list), and routing-priority distribution.
 *
 * @param {object} document - Overlay document.
 * @param {Array<{ source: string, name: string }>} [items] - Registry skills.
 * @returns {object} Summary.
 */
export function summarizeSkillOverlays(document, items = []) {
  const itemList = Array.isArray(items) ? items : [];
  const specificKeys = new Set(Object.keys(document?.skills ?? {}));
  const applied = itemList.map((item) => applySkillOverlay(item, document));
  return {
    schema_version: document?.schema_version,
    source_policies: Object.keys(document?.source_policies ?? {}).length,
    specific_overlays: specificKeys.size,
    orphan_overlays: [...specificKeys].filter((key) => (
      !itemList.some((item) => skillOverlayKey(item.source, item.name) === key)
    )),
    applied_policy: applied.filter((item) => item.overlay.policy).length,
    applied_specific: applied.filter((item) => item.overlay.specific).length,
    priorities: applied.reduce((counts, item) => {
      const priority = item.routing_priority || "normal";
      counts[priority] = (counts[priority] || 0) + 1;
      return counts;
    }, {})
  };
}
