/**
 * What a verification run proves.
 *
 * `verify_task` gathers checks by running things — the quality gate, Frontend
 * QA, change hygiene, Archify receipts — and then has two judgements to make:
 * whether the run passed, and which acceptance criteria that passing run is
 * evidence for. Both are decided here, over checks that have already run, so
 * the rules can be read and tested without running anything.
 */

/**
 * Whether every check in a run came back good.
 *
 * An empty run never passes: a verification that checked nothing proves
 * nothing. Each check type has its own idea of "good", and a type this does not
 * know about fails closed.
 *
 * @param {Array<{ type: string, result: object }>} checks
 * @returns {boolean}
 */
export function verificationPassed(checks) {
  if (!checks.length) return false;
  return checks.every(checkSucceeded);
}

/**
 * Whether one check came back good.
 *
 * @param {{ type: string, result: object }} item
 * @returns {boolean}
 */
function checkSucceeded(item) {
  if (item.type === "quality_gate") return item.result?.status === "passed";
  if (item.type === "frontend_qa") return item.result?.gate === "pass";
  if (item.type === "frontend_product") return item.result?.ok === true;
  if (item.type === "archify_deliver" || item.type === "archify_visual_check") return item.result?.ok === true;
  if (item.type === "change_hygiene") return item.result?.status !== "block";
  // Security scanners: a `block` is a critical or high dependency or secret
  // finding. A scanner that was missing, inapplicable or offline is `skipped`,
  // which cannot block — a run where none of them could run is `unchecked`,
  // which does not block either but never reads as "checked and clean".
  if (item.type === "security_scan") return item.result?.status !== "block";
  // A coverage floor only runs when a task asked for one, and a floor nobody
  // could measure is not a floor that was met.
  if (item.type === "coverage") return item.result?.status === "pass";
  return false;
}

/**
 * The acceptance criteria a passing verification marks met.
 *
 * Criteria are matched by the text `begin_task` wrote, which is why the
 * patterns look like prose. A criterion whose text matches two rules is
 * returned twice, exactly as the task store receives it.
 *
 * @param {object} input
 * @param {Array<{ id: string, text: string }>} input.acceptanceCriteria
 * @param {Array<{ type: string, result: object }>} input.checks - The run's checks.
 * @param {string} input.verificationId - Recorded as each criterion's evidence.
 * @param {boolean} [input.frontendChecked] - Whether this run included Frontend QA.
 * @returns {Array<{ id: string, status: string, evidence: string[] }>}
 */
export function metAcceptanceCriteria({ acceptanceCriteria, checks, verificationId, frontendChecked = false }) {
  const criteria = [];
  for (const item of acceptanceCriteria) {
    if (/automated checks pass/i.test(item.text)) {
      criteria.push({ id: item.id, status: "met", evidence: [verificationId] });
    }
    if (frontendChecked && /changed ui is checked/i.test(item.text)) {
      criteria.push({ id: item.id, status: "met", evidence: [verificationId] });
    }
    if (/design-first implementation gate|strict visual reference qa/i.test(item.text)) {
      criteria.push({ id: item.id, status: "met", evidence: [verificationId] });
    }
    if (/diagram is delivered via archify_deliver/i.test(item.text)) {
      const deliver = checks.find((check) => check.type === "archify_deliver");
      const visual = checks.find((check) => check.type === "archify_visual_check");
      const visualOk = !visual || visual.result?.ok === true;
      if (deliver?.result?.ok === true && visualOk) {
        criteria.push({ id: item.id, status: "met", evidence: [verificationId] });
      }
    }
  }
  return criteria;
}

/** Lines that are a runner announcing itself rather than saying anything. */
const OUTPUT_BOILERPLATE = /^(?:>|TAP version\b|\d+\.\.\d+$|(?:Subtest|tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b)/;

/** Lines that name what went wrong. */
const OUTPUT_PROBLEM = /\b(?:error|cannot find|not found|failed|failure|exception|traceback|assert\w*)\b/i;

/**
 * The one line of a command's output worth quoting in a verdict.
 *
 * The interesting line is rarely the first one: npm echoes the script it is
 * about to run and the test runner prints its TAP banner before anything has
 * gone wrong. So the line that names a problem wins, and the first line that is
 * not boilerplate is the fallback. TAP comment markers are stripped, because
 * `# Error: …` is the runner's framing of the error, not part of it.
 *
 * @param {string} output
 * @returns {string}
 */
export function firstMeaningfulLine(output, limit = 200) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s?/, "").trim())
    .filter((line) => line && !OUTPUT_BOILERPLATE.test(line));
  const line = lines.find((item) => OUTPUT_PROBLEM.test(item)) ?? lines[0] ?? "";
  return line.replace(/\s+/g, " ").slice(0, limit);
}

/**
 * Why one failed check failed, in the two things worth carrying: the line the
 * command printed, and the hint the gate could make of it.
 *
 * Without this a failed verification reads `quality_gate: failed` and nothing
 * more, and the cause stays in a command's stdout that no reader of the verdict
 * ever sees.
 *
 * A third thing rides along when the gate found one: the Node the project asks
 * for against the Node its commands ran on. That is a warning rather than a
 * cause — the gate ran everything it was asked to — but it is the difference
 * between "your test fails" and "your test fails on a Node you never chose".
 *
 * @param {{ type: string, result: object }} item
 * @returns {{ output?: string, hint?: string, engines_mismatch?: object } | null}
 */
export function verificationCheckDetail(item) {
  const result = item?.result ?? {};
  const failed = Array.isArray(result.results)
    ? result.results.find((entry) => entry.status === "failed" || entry.status === "timed_out")
    : null;
  const output = firstMeaningfulLine(failed ? `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` : "")
    || firstMeaningfulLine(result.error ?? result.reason ?? "");
  const hint = String(failed?.hint ?? result.hint ?? "").trim();
  const detail = {};
  if (output) detail.output = output;
  if (hint) detail.hint = hint;
  if (result.runtime?.engines_mismatch) detail.engines_mismatch = result.runtime.engines_mismatch;
  return Object.keys(detail).length ? detail : null;
}

/**
 * The one-line-per-check digest bound into a verification's evidence.
 *
 * A check that did not come back good also carries `detail`, so the record says
 * why and not only that.
 *
 * @param {Array<{ type: string, result: object }>} checks
 * @returns {Array<{ type: string, status: string, detail?: object }>}
 */
export function verificationCheckSummary(checks) {
  return checks.map((item) => {
    const entry = {
      type: item.type,
      status: item.result?.status || item.result?.gate || "unknown"
    };
    const detail = verificationCheckDetail(item);
    if (!checkSucceeded(item)) return detail ? { ...entry, detail } : entry;
    // A check that came back good says nothing further — except the one thing
    // that is a warning rather than a cause, and would otherwise be visible
    // only when something else had already failed.
    return detail?.engines_mismatch
      ? { ...entry, detail: { engines_mismatch: detail.engines_mismatch } }
      : entry;
  });
}
