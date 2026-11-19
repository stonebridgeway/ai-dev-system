/**
 * Findings from several scanners, reconciled.
 */
import { SECURITY_SEVERITIES } from "./security-scan-parsers.mjs";

/**
 * The same advisory about the same package in the same lockfile, reported by
 * two scanners, as one finding.
 *
 * `pnpm audit` and `osv-scanner` both read a pnpm project, and both report a
 * lodash advisory: counted twice, one vulnerability reads as two and the
 * blocking count means nothing. A finding matches an earlier one when they
 * name the same package and lockfile, share an advisory id or alias, and do
 * not disagree about the installed version. The earlier finding — the package
 * manager's own, by catalogue order — is kept; the later one's tool goes into
 * `confirmed_by`, its aliases are added, and the worse severity and any
 * detail the first lacked are taken over. Findings without a package (secrets,
 * static analysis, trivy) are never merged.
 *
 * @param {object[]} findings
 * @returns {object[]}
 */
export function mergeDuplicateFindings(findings) {
  const merged = [];
  const index = new Map();
  const key = (item, id) => `${item.file}|${item.package}|${id}`;
  for (const item of findings) {
    if (!item?.package) {
      merged.push(item);
      continue;
    }
    const ids = [...new Set([item.rule, ...(item.aliases ?? [])].filter(Boolean))];
    const match = ids
      .flatMap((id) => index.get(key(item, id)) ?? [])
      .find((candidate) => !candidate.version || !item.version || candidate.version === item.version);
    const target = match ?? { ...item };
    if (match) {
      if (match.tool !== item.tool) match.confirmed_by = [...new Set([...(match.confirmed_by ?? []), item.tool])];
      if (SECURITY_SEVERITIES.indexOf(item.severity) < SECURITY_SEVERITIES.indexOf(match.severity)) match.severity = item.severity;
      if (item.kind === "malware") match.kind = "malware";
      for (const field of ["version", "vulnerable", "fixed_in"]) {
        if (!match[field] && item[field]) match[field] = item[field];
      }
      match.aliases = [...new Set([...(match.aliases ?? []), ...ids])].filter((id) => id !== match.rule);
    } else {
      merged.push(target);
    }
    for (const id of ids) {
      const list = index.get(key(item, id)) ?? [];
      if (!list.includes(target)) index.set(key(item, id), [...list, target]);
    }
  }
  return merged;
}
