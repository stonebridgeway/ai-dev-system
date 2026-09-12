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
  return checks.every((item) => {
    if (item.type === "quality_gate") return item.result?.status === "passed";
    if (item.type === "frontend_qa") return item.result?.gate === "pass";
    if (item.type === "frontend_product") return item.result?.ok === true;
    if (item.type === "archify_deliver" || item.type === "archify_visual_check") return item.result?.ok === true;
    if (item.type === "change_hygiene") return item.result?.status !== "block";
    // Security scanners: a `block` is a critical or high dependency or secret
    // finding. A scanner that was missing, inapplicable or offline is
    // `skipped`, which cannot block — `summary.checked` is where a run that
    // proved nothing shows up.
    if (item.type === "security_scan") return item.result?.status !== "block";
    // A coverage floor only runs when a task asked for one, and a floor nobody
    // could measure is not a floor that was met.
    if (item.type === "coverage") return item.result?.status === "pass";
    return false;
  });
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

/**
 * The one-line-per-check digest bound into a verification's evidence.
 *
 * @param {Array<{ type: string, result: object }>} checks
 * @returns {Array<{ type: string, status: string }>}
 */
export function verificationCheckSummary(checks) {
  return checks.map((item) => ({
    type: item.type,
    status: item.result?.status || item.result?.gate || "unknown"
  }));
}
