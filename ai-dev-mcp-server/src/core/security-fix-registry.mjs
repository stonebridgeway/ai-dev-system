/**
 * Which version to move a vulnerable package to, and how old it is.
 *
 * An advisory says what is affected; it does not say what to install. The
 * first published version outside every advisory's range is the answer, with
 * one more condition: it has to have been public long enough for a malicious
 * release to have been caught. The npm malware of 2026 — axios 1.14.1,
 * `@tanstack/*`, keyv — was pulled within hours, so a security fix that lands
 * on a day-old release can install the next one. The default quarantine is
 * seven days.
 *
 * Publish times are only in the registry's full package document, not in the
 * abbreviated one installs use, so that is what is fetched — with a size cap,
 * because a document like `typescript`'s is 15 MB.
 */
import { proxyFetch } from "./http-download.mjs";
import { compareVersions, isPrerelease, parseVersion, satisfies, upgradeKind } from "./semver-lite.mjs";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 7;
export const REGISTRY_TIMEOUT_MS = 20_000;
export const REGISTRY_MAX_BYTES = 40 * 1024 * 1024;

const DAY_MS = 86_400_000;

/**
 * The registry to ask: the caller's, then npm's own configuration, then npm's.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function registryUrl(env = process.env) {
  const configured = String(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? "").trim();
  return (configured || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

/**
 * The published versions of a package and when each was published.
 *
 * Never throws: a registry that cannot be reached, answers an error, or sends
 * more than the cap is `{ ok: false, reason }`, and the plan falls back to the
 * fixes the advisories themselves name.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.registry]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ ok: boolean, reason?: string, versions?: string[], time?: Record<string, string>, deprecated?: Record<string, string> }>}
 */
export async function fetchPackageMetadata(name, {
  // Through HTTPS_PROXY, which `fetch` ignores.
  fetchImpl = proxyFetch,
  registry = registryUrl(),
  timeoutMs = REGISTRY_TIMEOUT_MS
} = {}) {
  const url = `${registry}/${String(name).replace("/", "%2f")}`;
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `${url} answered ${response.status}` };
    const length = Number(response.headers?.get?.("content-length") ?? 0);
    if (length > REGISTRY_MAX_BYTES) return { ok: false, reason: `${url} is ${Math.round(length / 1048576)} MB, over the ${REGISTRY_MAX_BYTES / 1048576} MB cap` };
    const document = await response.json();
    const versions = Object.keys(document?.versions ?? {});
    const deprecated = Object.fromEntries(
      Object.entries(document?.versions ?? {}).filter(([, item]) => item?.deprecated).map(([version, item]) => [version, String(item.deprecated)])
    );
    return { ok: true, versions, time: document?.time ?? {}, deprecated };
  } catch (error) {
    return { ok: false, reason: `${url} could not be read: ${error?.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000}s` : error?.message ?? error}` };
  }
}

function ageDays(published, now) {
  const at = Date.parse(published ?? "");
  return Number.isFinite(at) ? Math.floor((now - at) / DAY_MS) : null;
}

/**
 * The version to move to.
 *
 * Candidates are the published, non-prerelease, non-deprecated versions above
 * the installed one that no advisory's range contains. Among those old enough,
 * the first that the declared range still accepts wins, then the first that is
 * not a breaking upgrade, then the first at all. When nothing is old enough
 * the youngest safe version is returned with `quarantined: false`, so the plan
 * can say that waiting is the other option.
 *
 * Without registry data, the target is the highest fix the advisories name —
 * when every one of them names one.
 *
 * @param {object} input
 * @param {string} input.installed - The highest installed version, or "".
 * @param {string[]} input.vulnerable - Advisory ranges.
 * @param {string[]} [input.fixedIn] - Fix versions the advisories named.
 * @param {{ ok: boolean, versions?: string[], time?: object, deprecated?: object } | null} [input.metadata]
 * @param {string} [input.preferRange] - The range the manifest declares.
 * @param {number} [input.minReleaseAgeDays]
 * @param {number} [input.now]
 * @returns {{ version: string, source: string, age_days: number | null, quarantined: boolean, upgrade: string, in_declared_range: boolean, reason: string }}
 */
export function chooseTarget({
  installed = "",
  vulnerable = [],
  fixedIn = [],
  metadata = null,
  preferRange = "",
  minReleaseAgeDays = DEFAULT_MIN_RELEASE_AGE_DAYS,
  now = Date.now()
}) {
  const ranges = vulnerable.filter(Boolean);
  const result = (version, source, extra = {}) => ({
    version,
    source,
    age_days: null,
    quarantined: false,
    upgrade: version && installed ? upgradeKind(installed, version) : version ? "unknown" : "none",
    in_declared_range: Boolean(version && preferRange && satisfies(version, preferRange)),
    reason: "",
    ...extra
  });
  if (metadata?.ok) {
    const candidates = metadata.versions
      .filter((version) => parseVersion(version) && !isPrerelease(version) && !metadata.deprecated?.[version])
      .filter((version) => !installed || compareVersions(version, installed) > 0)
      .filter((version) => !ranges.some((range) => satisfies(version, range)))
      .sort(compareVersions);
    if (!candidates.length) {
      return result("", "registry", { reason: "No published version above the installed one is outside every advisory's range." });
    }
    const aged = candidates.filter((version) => (ageDays(metadata.time?.[version], now) ?? -1) >= minReleaseAgeDays);
    const pool = aged.length ? aged : candidates;
    const pick = (preferRange ? pool.find((version) => satisfies(version, preferRange)) : undefined)
      ?? pool.find((version) => !installed || upgradeKind(installed, version) !== "major")
      ?? pool[0];
    const age = ageDays(metadata.time?.[pick], now);
    return result(pick, "registry", {
      age_days: age,
      quarantined: aged.length > 0,
      reason: aged.length
        ? ""
        : `Every safe version is younger than ${minReleaseAgeDays} days; ${pick} is ${age ?? "?"} day(s) old. Waiting is the other option.`
    });
  }
  const hints = fixedIn.filter((version) => parseVersion(version));
  if (hints.length && hints.length === fixedIn.length && hints.length >= ranges.length) {
    const highest = hints.sort(compareVersions).at(-1);
    return result(highest, "advisory", { reason: "Registry data was not available, so the fix is the one the advisories name and its age is unchecked." });
  }
  return result("", "none", { reason: metadata && !metadata.ok ? metadata.reason : "The advisories name no fixed version and the registry was not asked." });
}
