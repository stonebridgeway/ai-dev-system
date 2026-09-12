import { POLICY_RELATIVE_PATH } from "./agent-hooks.mjs";

/**
 * Completion-statement linter: the deterministic half of "did the agent prove
 * it, or talk its way past it".
 *
 * Everything Claude Code catches rationalizations in an agent's own report from
 * a Stop hook (`skills/delivery-gate/hooks/quality-gate.py`, `RATIONALIZE`) and
 * scores hedging language before the agent declares victory
 * (`skills/agent-self-evaluation/scripts/evaluate.py`, `danger_patterns`). Here
 * the same idea binds to evidence the server already holds: a phrase such as
 * "pre-existing issue", "skipping tests for now" or "should work" is only a
 * problem when the check that would have settled it did not pass. A red or
 * never-run gate turns the phrase into the thing that replaced the check, and
 * `checkpoint_task` / `complete_task` refuse the report.
 *
 * Three ways past a block, in this order: make the check pass, rewrite the
 * report to say what actually happened, or — when the reason is real — write
 * the reason into the report and waive that one rule in `.ai-dev/policy.json`.
 *
 * The rule table below is data: a project extends nothing and edits nothing to
 * turn a rule off, and this module never reads the filesystem.
 */

/** Key under which `.ai-dev/policy.json` configures this linter. */
export const COMPLETION_CLAIM_POLICY_KEY = "completion_claims";

/**
 * Shortest reason accepted, both for a policy waiver and for the reason the
 * report itself has to state. Short enough not to be busywork, long enough that
 * "n/a" and "later" do not qualify.
 */
export const MINIMUM_REASON_LENGTH = 20;

/** What each gate is called in a message, keyed by the signal it reads. */
export const CLAIM_GATES = Object.freeze({
  quality_gate: "the project quality gate (verify_task with run_quality)",
  change_hygiene: "the change-hygiene scan (verify_task with run_hygiene)",
  frontend_qa: "Frontend QA (verify_task with run_frontend)",
  verification: "the latest verify_task run"
});

/**
 * The rationalizations, as data.
 *
 * `gate` names the signal that would settle the claim, `claim` names the move
 * in one phrase, and `proof` says what to do instead. Patterns are deliberately
 * narrow: an honest report of a red check ("3 tests fail in auth.test.ts, fixing
 * now") must pass, only the excuse must not. None of them carry the `g` flag,
 * so `exec` stays stateless.
 *
 * `exempt` is the other half of that narrowness: a wording that contains the
 * excuse and says the opposite of it. It is tested against the sentence the
 * match sits in, not the whole report, so an honest sentence cannot cover for
 * an excuse three paragraphs later. Where the exemption is one short phrase it
 * stays a lookahead inside the pattern ("works on my machine **and in CI**");
 * where it is two independent facts, it is written out here.
 *
 * Both halves of a pattern carry the same rules in English and in Russian —
 * agents report in both, and a rule that only exists in one language is a rule
 * that can be walked around by switching keyboard layout (Д-26).
 */
export const RATIONALIZATION_PATTERNS = Object.freeze([
  {
    id: "pre_existing_failure",
    gate: "verification",
    claim: "The report calls a failure pre-existing",
    proof: "Show it on the base ref and record a passing verify_task for this change.",
    pattern: /(?:pre[-\s]?existing|already\s+(?:broken|failing|red))[^.\n]{0,40}\b(?:issue|failure|failing|error|bug|test|problem|breakage)|\b(?:issue|failure|error|bug|test|problem)s?\b[^.\n]{0,20}\b(?:is|are|was|were)\s+(?:pre[-\s]?existing|already\s+(?:broken|failing|red))\b|\bnot\s+(?:caused|introduced)\s+by\s+(?:my|this|these|the)\s+chang|(?:сломано|падал[аои]?|падени[яей]|не\s+работал[аои]?)[^.\n]{0,30}(?:ещ[её]\s+)?(?:и\s+)?до\s+(?:меня|мо[иеё]|этих|этой)/i,
    // Where it failed, plus the fix carried over from where it was fixed. That
    // is a report with two facts in it, and it is what this rule asks a report
    // to do — refusing it taught the opposite lesson (Д-26).
    exempt: /\b(?:on|in)\s+(?:main|master|trunk|develop|the\s+base(?:\s+branch)?|origin\/[\w./-]+)\b[^.\n]{0,120}\b(?:ported|cherry[-\s]?picked|back[-\s]?ported|brought\s+(?:in|over)|pulled\s+in|applied)\b|\b(?:ported|cherry[-\s]?picked|back[-\s]?ported|brought\s+(?:in|over)|pulled\s+in|applied)\b[^.\n]{0,120}\b(?:from|on|in)\s+(?:main|master|trunk|develop|the\s+base(?:\s+branch)?|pr\s*#?\d+|#\d+|origin\/[\w./-]+)\b|(?:на|в)\s+(?:main|master|мастере)[^.\n]{0,120}(?:перен[её]с|портировал|применил)|(?:перен[её]с|портировал|применил)[^.\n]{0,120}(?:из|с)\s+(?:pr|мастера|main|master)/i
  },
  {
    id: "tests_deferred",
    gate: "quality_gate",
    claim: "The report defers writing or running tests",
    proof: "Run the gate now, or record the missing coverage as a blocked acceptance criterion with its evidence.",
    pattern: /\bskip(?:ping|ped)?\s+(?:the\s+|running\s+)?tests?\b[^.\n]{0,30}\b(?:for\s+now|for\s+the\s+moment|temporarily|this\s+time)|\b(?:add|write|fix|run)\s+(?:the\s+|more\s+)?tests?\s+(?:later|afterwards?|next\s+time|in\s+a\s+follow[-\s]?up)|\btests?\s+(?:will\s+)?(?:come|follow)\s+later|\bno\s+tests?\s+for\s+now\b|пока\s+без\s+тестов|тесты\s+(?:добавлю|напишу|прогоню|починю)\s+(?:потом|позже|следующ)/i
  },
  {
    id: "tests_failing_deferred",
    gate: "quality_gate",
    claim: "The report leaves a red test for later",
    proof: "Make the suite green before the report claims the change is done.",
    pattern: /\b(?:tests?|(?:test\s+)?suite|build|ci)\s+(?:are\s+|is\s+)?(?:still\s+)?(?:failing|red|broken)\b[^.\n]{0,60}\b(?:but|however|though|anyway|still)\b[^.\n]{0,60}\b(?:later|next|follow[-\s]?up|afterwards?|ship|merge|fine|ok(?:ay)?|proceed|continue|complete|done)|\b(?:i(?:'| a)?ll|we(?:'| wi)?ll|will)\s+fix\s+(?:the\s+|those\s+|them\s+)?(?:tests?|failures?|later|afterwards?)\b[^.\n]{0,30}(?:later|afterwards?|next|follow[-\s]?up|$)|тесты\s+(?:падают|красные)[^.\n]{0,40}(?:но|зато|потом|позже)/i
  },
  {
    id: "works_on_my_machine",
    gate: "verification",
    claim: "The report offers a local run instead of a recorded one",
    proof: "Re-run the checks through verify_task so the evidence is bound to the current Git state.",
    // "It works on my machine and in CI" is a person explaining that the two
    // environments agree, which is the opposite of the excuse. Both halves of
    // the pattern carry the same exemption (docs/ecc-upgrades/DEBTS.md, Д-10).
    pattern: /\bworks?\s+(?:fine\s+|ok(?:ay)?\s+)?on\s+my\s+(?:machine|box|laptop|side|end)\b(?![^.\n]{0,40}\band\s+(?:in|on)\s+ci\b)|\bworks?\s+(?:fine\s+|ok(?:ay)?\s+)?locally\b(?![^.\n]{0,40}\band\s+(?:in|on)\s+ci\b)|у\s+меня\s+(?:вс[её]\s+)?работает|локально\s+(?:вс[её]\s+)?(?:работает|проходит|зелен)/i
  },
  {
    id: "unverified_claim",
    gate: "verification",
    claim: "The report hedges instead of reporting a result",
    proof: "Run the change and report what it did, not what it ought to do.",
    pattern: /\b(?:should|ought\s+to)\s+(?:just\s+|now\s+)?(?:work\b|be\s+(?:fine|ok(?:ay)?|correct|enough)\b)|\bi\s+(?:think|believe|assume|expect)\s+(?:that\s+)?(?:it|this|they)\s+(?:works?|is\s+(?:fine|correct|ok(?:ay)?)|are\s+(?:fine|correct|ok(?:ay)?))|\bprobably\s+(?:works?|fine|correct|ok(?:ay)?)|\b(?:presumably|likely)\s+(?:works?|fine|correct)|должно\s+(?:бы\s+)?(?:работать|заработать)|скорее\s+всего\s+(?:работает|вс[её]\s+хорошо)|(?:наверное|видимо|похоже|думаю)[^.\n]{0,20}(?:вс[её]\s+)?(?:в\s+порядке|работает|хорошо|нормально|ок)/i
  },
  {
    id: "inspection_only",
    gate: "verification",
    claim: "The report marks something met from reading the code",
    proof: "Run it. A criterion is met by a recorded verify_task run; reading the diff is how the run is chosen, not a substitute for it.",
    pattern: /\b(?:based\s+on|by|from|after)\s+(?:a\s+)?(?:code[-\s]?|visual\s+|manual\s+|static\s+)?(?:inspection|reading|review|analysis)\s+(?:alone|only)\b|\b(?:inspect(?:ing|ed)|read(?:ing)?|review(?:ing|ed))\s+the\s+(?:code|diff|source)\s+(?:alone|only)\b|\bwithout\s+(?:actually\s+)?running\s+(?:it|them|anything|the\s+code)\b|\b(?:verified|confirmed|marked[^.\n]{0,40}\bmet)\s+by\s+(?:just\s+)?read(?:ing)?\b|по\s+коду\s+видно|(?:просто\s+)?прочитал\s+код|по\s+чтени[июя]\s+кода|(?:отметил|поставил|засчитал|пометил)[^.\n]{0,40}по\s+(?:чтению\s+кода|коду|диффу)|(?:убедился|проверил)[^.\n]{0,20}глазами/i
  },
  {
    id: "untested_change",
    gate: "quality_gate",
    claim: "The report says the change was not tested",
    proof: "Run the project's tests through verify_task, or name the blocker as an unmet criterion.",
    pattern: /\buntested\b|\b(?:not|never)\s+tested\b|\b(?:did\s*n[o']?t|have\s*n[o']?t|has\s*n[o']?t|could\s*n[o']?t|was\s+unable\s+to|unable\s+to)\s+(?:actually\s+)?(?:run\s+(?:the\s+)?(?:tests?|build|suite|checks?|gate|linter|type\s?check(?:er)?)|test\s+(?:it|this|the)|verify\s+(?:it|this))|\bwithout\s+running\s+(?:the\s+)?(?:tests?|build|suite|checks?)\b|не\s+(?:стал\s+)?(?:проверял|проверять|тестировал|запускал\s+(?:тесты|сборку|проверки))|(?:тесты|сборку|проверки|линтер|гейт|чек)\s+(?:так\s+)?и?\s*не\s+(?:запускал|прогонял|гонял|стал\s+запускать)/i
  },
  {
    id: "unrelated_or_flaky",
    gate: "verification",
    claim: "The report writes a failure off as unrelated or flaky",
    proof: "Prove it: re-run the check and record the passing run, or fix the flake.",
    pattern: /\b(?:un|not\s+)related\s+to\s+(?:my|this|these|the|our)\s+(?:chang|task|work|patch|diff|pr\b|commit|ticket|featur|fix\b)|\bflak(?:y|e|es|iness)\b|\brandom(?:ly)?\s+fail(?:s|ing|ure)|\bjust\s+(?:a\s+)?(?:ci|infra(?:structure)?)\s+(?:issue|problem|noise)|не\s+связан[оаы]?\s+с\s+(?:мо[иё]|эт[иоа])|(?<![а-яё])флак(?:ует|и|овый)?(?![а-яё])/i
  },
  {
    id: "suppressed_check",
    gate: "change_hygiene",
    claim: "The report silences a check instead of satisfying it",
    proof: "Fix the code the check pointed at; a narrowed suppression needs a reason on the line itself.",
    pattern: /\b(?:disabled?|turn(?:ed|ing)?\s+off|silenc(?:ed|ing)|suppress(?:ed|ing)|ignor(?:ed|ing))\s+(?:the\s+|a\s+|that\s+)?(?:lint(?:er|ing|s)?|type\s?check(?:er)?|rule|warning|test|check)|--no-verify\b|\badded?\s+(?:an?\s+)?(?:eslint-disable|@ts-ignore|@ts-nocheck|#\s*noqa|#\s*type:\s*ignore|#\s*nosec)|отключил\s+(?:линтер|проверку|тест)/i
  },
  {
    id: "leftover_marker",
    gate: "change_hygiene",
    claim: "The report leaves an untracked TODO behind",
    proof: "Finish it, or file it and quote the issue key in the report.",
    pattern: /\b(?:TODO|FIXME|HACK|XXX)\b(?![^\n]{0,60}(?:#\d+|[A-Z][A-Z0-9]{1,9}-\d+|issue|ticket))/
  },
  {
    id: "good_enough",
    gate: "verification",
    claim: "The report settles for good enough",
    proof: "Finish the stated scope, or record what is left as an unmet acceptance criterion.",
    pattern: /\bgood\s+enough\s+for\s+now\b|\bship\s+it\s+(?:now\s+)?and\s+(?:fix|improve|clean)|\bquick\s+(?:and\s+dirty|hack)\b|\btemporary\s+(?:hack|workaround|fix)\b(?![^.\n]{0,60}(?:#\d+|[A-Z][A-Z0-9]{1,9}-\d+|tracked|issue|ticket))|\bfor\s+now\s+(?:this\s+)?(?:will\s+do|is\s+fine)|пока\s+сойд[её]т|временный\s+костыл/i
  },
  {
    id: "ui_unchecked",
    gate: "frontend_qa",
    claim: "The report ships a UI change nobody looked at",
    proof: "Run verify_task with run_frontend=true and look at the screenshots it produced.",
    pattern: /\b(?:did\s*n[o']?t|have\s*n[o']?t|could\s*n[o']?t|unable\s+to)\s+(?:check|open|verify|look\s+at|render)\s+(?:the\s+)?(?:ui|browser|page|screen|frontend|layout)|\b(?:ui|frontend|layout|page)\s+(?:probably|should)\s+(?:be\s+|still\s+)?(?:fine|ok(?:ay)?|work|render)|не\s+смотрел\s+(?:в\s+)?браузер|в[её]рстку\s+не\s+проверял/i
  },
  {
    id: "manual_only",
    gate: "quality_gate",
    claim: "The report offers a manual check in place of the gate",
    proof: "A manual check is a supplement: run the automated gate and record it too.",
    pattern: /\b(?:tested|verified|checked|validated)\s+(?:it\s+|this\s+)?(?:only\s+)?manually\b|\bmanual(?:ly)?\s+(?:testing|verification|check(?:ing)?)\s+only\b|\bonly\s+(?:a\s+)?manual\s+(?:test|check|verification)|проверил\s+(?:только\s+)?вручную/i
  }
].map((rule) => Object.freeze(rule)));

const RULE_IDS = new Set(RATIONALIZATION_PATTERNS.map((rule) => rule.id));

/**
 * Markers that introduce a stated reason. The reason has to be written out:
 * the marker alone, or a marker followed by a few words, does not count.
 */
const REASON_MARKER = /(?:^|[\s(])(?:reason|rationale|waiver|waived because|because|blocked by|причина|обоснование|потому что)(?![\p{L}\p{N}])\s*[:–—-]?\s*(\S[^\n]*)/iu;

/**
 * The reason a report states for itself, or "" when it states none.
 *
 * @param {string} text
 * @returns {string}
 */
export function statedReason(text) {
  const match = REASON_MARKER.exec(String(text || ""));
  if (!match) return "";
  const reason = match[1].trim();
  return reason.length >= MINIMUM_REASON_LENGTH ? reason : "";
}

/**
 * Read the gate signals a report has to live up to out of the task record.
 *
 * `true` the check passed, `false` it ran and did not, `null` it never ran —
 * and only `true` backs a claim, because a check nobody ran settles nothing.
 *
 * @param {object} record - Task record from the task store.
 * @param {{ projectState?: { fingerprint?: string } }} [options] - Current
 *   project state; when given, a verification bound to a different fingerprint
 *   counts as failed rather than passed.
 * @returns {{ verification: boolean|null, quality_gate: boolean|null, change_hygiene: boolean|null, frontend_qa: boolean|null }}
 */
export function completionClaimSignals(record, { projectState = null } = {}) {
  const verifications = Array.isArray(record?.verifications) ? record.verifications : [];
  const latest = verifications.length ? verifications[verifications.length - 1] : null;
  const checks = Array.isArray(latest?.checks) ? latest.checks : [];
  const signal = (type, passed) => {
    const check = checks.find((item) => item?.type === type);
    return check ? Boolean(passed(check.result || {})) : null;
  };
  const stale = Boolean(projectState)
    && latest?.evidence?.source_state_fingerprint !== projectState.fingerprint;
  return {
    verification: latest ? latest.passed === true && !stale : null,
    quality_gate: signal("quality_gate", (result) => result.status === "passed"),
    change_hygiene: signal("change_hygiene", (result) => result.status !== "block"),
    frontend_qa: signal("frontend_qa", (result) => result.gate === "pass")
  };
}

/**
 * Read the `completion_claims` block out of a `.ai-dev/policy.json` document.
 *
 * Accepts the file's text, the parsed document, or nothing. Unparseable JSON,
 * an unknown rule id and a waiver without a real reason are reported as
 * warnings and leave the linter on: a project turns a rule off on purpose or
 * not at all.
 *
 * @param {string|object|null} source
 * @returns {{ enabled: boolean, waivers: Array<{ rule: string, reason: string, expires: string }>, warnings: string[] }}
 */
export function parseCompletionClaimPolicy(source) {
  const policy = { enabled: true, waivers: [], warnings: [] };
  let document = source;
  if (typeof source === "string") {
    if (!source.trim()) return policy;
    try {
      document = JSON.parse(source);
    } catch {
      policy.warnings.push(`${POLICY_RELATIVE_PATH} is not valid JSON; the completion-statement linter ran with no waivers.`);
      return policy;
    }
  }
  if (!document || typeof document !== "object") return policy;
  const block = document[COMPLETION_CLAIM_POLICY_KEY];
  if (block === false) {
    policy.enabled = false;
    return policy;
  }
  if (!block || typeof block !== "object") return policy;
  if (block.enabled === false) {
    policy.enabled = false;
    return policy;
  }
  for (const entry of Array.isArray(block.waivers) ? block.waivers : []) {
    const rule = String(entry?.rule || "").trim();
    const reason = String(entry?.reason || "").trim();
    const expires = String(entry?.expires || "").trim();
    if (rule !== "*" && !RULE_IDS.has(rule)) {
      policy.warnings.push(`${POLICY_RELATIVE_PATH}: ${COMPLETION_CLAIM_POLICY_KEY} waives unknown rule "${rule}"; it was ignored.`);
      continue;
    }
    if (reason.length < MINIMUM_REASON_LENGTH) {
      policy.warnings.push(`${POLICY_RELATIVE_PATH}: the waiver for "${rule}" has no reason of at least ${MINIMUM_REASON_LENGTH} characters; it was ignored.`);
      continue;
    }
    if (expires && Number.isNaN(Date.parse(expires))) {
      policy.warnings.push(`${POLICY_RELATIVE_PATH}: the waiver for "${rule}" has an unreadable expires value "${expires}"; it was ignored.`);
      continue;
    }
    policy.waivers.push({ rule, reason, expires });
  }
  return policy;
}

/**
 * @param {{ waivers: Array<{ rule: string, reason: string, expires: string }> }} policy
 * @param {string} ruleId
 * @param {Date} now
 * @returns {{ rule: string, reason: string, expires: string }|null}
 */
function activeWaiver(policy, ruleId, now) {
  for (const waiver of policy.waivers) {
    if (waiver.rule !== ruleId && waiver.rule !== "*") continue;
    if (waiver.expires && Date.parse(waiver.expires) < now.getTime()) continue;
    return waiver;
  }
  return null;
}

/** @param {boolean|null} value @returns {string} */
function gateState(value) {
  if (value === true) return "passed";
  if (value === false) return "did not pass";
  return "never ran";
}

/**
 * The sentence a match sits in: from the line or sentence boundary before it to
 * the one after. An exemption is read here rather than over the whole report,
 * so one honest sentence cannot cover for an excuse in the next paragraph.
 *
 * @param {string} text
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function sentenceAround(text, match) {
  const before = text.slice(0, match.index);
  const start = Math.max(before.lastIndexOf("\n"), before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? ")) + 1;
  const from = match.index + match[0].length;
  const rest = text.slice(from);
  const ends = [rest.indexOf("\n"), rest.indexOf(". "), rest.indexOf("! "), rest.indexOf("? ")].filter((index) => index >= 0);
  const end = ends.length ? from + Math.min(...ends) + 1 : text.length;
  return text.slice(start, end);
}

/**
 * @param {string} text
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function excerptAround(text, match) {
  const start = Math.max(0, match.index - 30);
  const end = Math.min(text.length, match.index + match[0].length + 60);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`.slice(0, 200);
}

/**
 * Lint a report against the gate signals behind it.
 *
 * A rationalization whose gate passed is a `warn`: the evidence exists, the
 * wording undersells it. A rationalization whose gate did not pass is a `block`
 * unless the project waived that rule and the report states its reason.
 *
 * @param {object} input
 * @param {string} [input.summary] - `summary` as passed to the tool.
 * @param {string} [input.notes] - `notes` as passed to the tool.
 * @param {object} [input.signals] - From `completionClaimSignals`.
 * @param {object} [input.policy] - From `parseCompletionClaimPolicy`.
 * @param {Date} [input.now] - Clock, for waiver expiry.
 * @returns {{ status: "ok"|"blocked"|"off", findings: object[], blocked: number, waived: number, warnings: string[], signals: object, stated_reason: string }}
 */
export function lintCompletionClaims({
  summary = "",
  notes = "",
  signals = {},
  policy = null,
  now = new Date()
} = {}) {
  const resolved = policy || { enabled: true, waivers: [], warnings: [] };
  const warnings = [...(resolved.warnings || [])];
  const base = {
    warnings,
    signals,
    blocked: 0,
    waived: 0,
    stated_reason: ""
  };
  if (resolved.enabled === false) {
    return {
      ...base,
      status: "off",
      findings: [],
      reason: `${COMPLETION_CLAIM_POLICY_KEY} is disabled in ${POLICY_RELATIVE_PATH}.`
    };
  }
  const reason = statedReason(`${summary}\n${notes}`);
  const findings = [];
  for (const [field, value] of [["summary", String(summary || "")], ["notes", String(notes || "")]]) {
    if (!value.trim()) continue;
    for (const rule of RATIONALIZATION_PATTERNS) {
      const match = rule.pattern.exec(value);
      if (!match) continue;
      // A wording that carries the excuse and says the opposite of it.
      if (rule.exempt?.test(sentenceAround(value, match))) continue;
      const satisfied = signals?.[rule.gate] === true;
      const waiver = satisfied ? null : activeWaiver(resolved, rule.id, now);
      const waived = Boolean(waiver) && Boolean(reason);
      const finding = {
        rule: rule.id,
        severity: satisfied || waived ? "warn" : "block",
        field,
        gate: rule.gate,
        gate_status: gateState(signals?.[rule.gate] ?? null),
        excerpt: excerptAround(value, match),
        message: ""
      };
      if (satisfied) {
        finding.message = `${rule.claim}, but ${CLAIM_GATES[rule.gate]} passed. Say what the check proved instead.`;
      } else if (waived) {
        finding.waiver = { rule: waiver.rule, reason: waiver.reason, ...(waiver.expires ? { expires: waiver.expires } : {}) };
        finding.stated_reason = reason;
        finding.message = `${rule.claim}; ${CLAIM_GATES[rule.gate]} ${gateState(signals?.[rule.gate] ?? null)}, and ${POLICY_RELATIVE_PATH} waives this rule: ${waiver.reason}`;
      } else {
        if (waiver) {
          finding.message = `${rule.claim}; ${CLAIM_GATES[rule.gate]} ${gateState(signals?.[rule.gate] ?? null)}. ${POLICY_RELATIVE_PATH} waives this rule, but the report has to state the reason itself in at least ${MINIMUM_REASON_LENGTH} characters ("reason: …", "because …"). ${rule.proof}`;
        } else {
          finding.message = `${rule.claim}; ${CLAIM_GATES[rule.gate]} ${gateState(signals?.[rule.gate] ?? null)}. ${rule.proof}`;
        }
      }
      findings.push(finding);
    }
  }
  const blocked = findings.filter((item) => item.severity === "block").length;
  return {
    ...base,
    status: blocked ? "blocked" : "ok",
    findings,
    blocked,
    waived: findings.filter((item) => item.waiver && item.severity === "warn").length,
    stated_reason: reason
  };
}

/**
 * The refusal text `checkpoint_task` and `complete_task` throw: what was
 * claimed, which check does not back it, and the three ways forward.
 *
 * @param {{ findings: object[] }} result - From `lintCompletionClaims`.
 * @returns {string}
 */
export function completionClaimFailure(result) {
  const blocked = (result?.findings || []).filter((item) => item.severity === "block");
  const first = blocked[0]?.rule || RATIONALIZATION_PATTERNS[0].id;
  const waiver = JSON.stringify({ [COMPLETION_CLAIM_POLICY_KEY]: { waivers: [{ rule: first, reason: "…" }] } });
  return [
    `The report claims more than the evidence shows: ${blocked.length} rationalization${blocked.length === 1 ? "" : "s"} ${blocked.length === 1 ? "is" : "are"} not backed by a passing check.`,
    ...blocked.map((item) => `- ${item.rule} in ${item.field}: ${item.message} Quoted: "${item.excerpt}"`),
    `Fix the check and run verify_task again, or rewrite the report to say what actually happened. If the reason is real, state it in the report ("reason: …") and waive the rule in ${POLICY_RELATIVE_PATH}: ${waiver}`
  ].join("\n");
}
