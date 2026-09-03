import crypto from "node:crypto";
import fs from "node:fs/promises";

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate an `archify_deliver` evidence entry against the bar the acceptance
 * criterion actually states: a matching on-disk artifact, `showcase` quality,
 * zero composition errors and warnings, and every artifact check passing.
 *
 * Malformed input still throws (a bad tool call); a receipt that simply does
 * not clear the bar is returned as `{ ok: false, problems: [...] }` so the
 * caller records it as a failed check rather than aborting verification.
 */
export async function validateArchifyDeliveryReceipt(receipt, artifactPath) {
  if (!receipt || receipt.kind !== "archify_deliver") {
    throw new Error("Only archify_deliver evidence is supported.");
  }
  if (!isSha256(receipt.spec_sha256) || !isSha256(receipt.artifact_sha256)) {
    throw new Error("Archify delivery evidence requires SHA-256 values for spec_sha256 and artifact_sha256.");
  }

  const artifact = await fs.readFile(artifactPath);
  const artifactSha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  if (artifactSha256 !== receipt.artifact_sha256.toLowerCase()) {
    throw new Error(`Archify artifact SHA-256 does not match the delivered file: ${artifactPath}`);
  }

  const quality = String(receipt.quality || "");
  const errors = finiteNumber(receipt.errors);
  const warnings = finiteNumber(receipt.warnings);
  const checksPassed = finiteNumber(receipt.checks_passed);
  const checkCount = finiteNumber(receipt.check_count);

  const problems = [];
  if (quality !== "showcase") {
    problems.push(`quality profile is "${quality || "unknown"}", expected "showcase"`);
  }
  if (errors === null || errors > 0) {
    problems.push(`${receipt.errors ?? "unknown"} composition error(s)`);
  }
  if (warnings === null || warnings > 0) {
    problems.push(`${receipt.warnings ?? "unknown"} composition warning(s)`);
  }
  if (checkCount === null || checkCount < 9) {
    problems.push(`${receipt.check_count ?? "unknown"} artifact checks (showcase acceptance needs 9)`);
  }
  if (checksPassed === null || checkCount === null || checksPassed < checkCount) {
    problems.push(`${receipt.checks_passed ?? "unknown"}/${receipt.check_count ?? "unknown"} artifact checks passed`);
  }

  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? "passed" : "failed",
    kind: "archify_deliver",
    html_path: artifactPath,
    spec_sha256: receipt.spec_sha256.toLowerCase(),
    artifact_sha256: artifactSha256,
    quality,
    errors,
    warnings,
    checks_passed: checksPassed,
    check_count: checkCount,
    problems
  };
}

/**
 * Validate an `archify_visual_check` evidence entry. Passes only when the
 * browser containment check reported no overflow at every viewport.
 */
export function validateArchifyVisualCheckEvidence(entry, artifactPath) {
  if (!entry || entry.kind !== "archify_visual_check") {
    throw new Error("Only archify_visual_check evidence is supported.");
  }
  const containment = String(entry.containment_status || "");
  const overall = String(entry.status || "");
  const ok = containment === "pass" && (overall === "" || overall === "pass");
  return {
    ok,
    status: ok ? "passed" : "failed",
    kind: "archify_visual_check",
    html_path: artifactPath,
    containment_status: containment || "unknown",
    visual_check_status: overall || "unknown"
  };
}

export function archifyDeliveryReceiptMarkdown(receipts) {
  const lines = [
    "# Archify Diagram Deliveries",
    "",
    "| HTML | Quality | Errors | Warnings | Checks | Artifact SHA-256 |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const receipt of receipts) {
    lines.push(`| ${receipt.html_path} | ${receipt.quality || "—"} | ${receipt.errors ?? "—"} | ${receipt.warnings ?? "—"} | ${receipt.checks_passed ?? "—"}/${receipt.check_count ?? "—"} | ${receipt.artifact_sha256} |`);
  }
  return lines.join("\n");
}
