import crypto from "node:crypto";

export const RUNTIME_PROFILE_SCHEMA_VERSION = 1;

/**
 * Build the default local-first runtime profile: stdio transport, remote
 * foundation disabled, paths expressed as `${VAR}` placeholders.
 *
 * @param {{ vaultRoot?: string, nodeExecutable?: string }} [options]
 * @returns {object} Runtime profile (schema {@link RUNTIME_PROFILE_SCHEMA_VERSION}).
 */
export function createLocalRuntimeProfile({
  vaultRoot = "${AI_DEV_VAULT_ROOT}",
  nodeExecutable = "${AI_DEV_NODE}"
} = {}) {
  return {
    schema_version: RUNTIME_PROFILE_SCHEMA_VERSION,
    mode: "local-first",
    vault_root: vaultRoot,
    node_executable: nodeExecutable,
    transport: {
      type: "stdio",
      remote_enabled: false
    },
    state: {
      root: "${AI_DEV_HOME}/state",
      cache: "${AI_DEV_HOME}/cache",
      artifacts: "${AI_DEV_HOME}/artifacts"
    },
    remote_foundation: {
      status: "disabled",
      bind: "127.0.0.1",
      tls: { mode: "required-before-enable" },
      authentication: {
        mode: "bearer",
        token_env: "AI_DEV_MCP_BEARER_TOKEN"
      },
      allowed_clients: [],
      rate_limit_per_minute: 60,
      trust_proxy: false
    }
  };
}

function secretFieldPaths(value, current = "") {
  const paths = [];
  if (!value || typeof value !== "object") return paths;
  for (const [key, nested] of Object.entries(value)) {
    const fieldPath = current ? `${current}.${key}` : key;
    if (/^(token|password|secret|api_key|private_key)$/i.test(key) && typeof nested === "string" && nested) {
      paths.push(fieldPath);
    }
    paths.push(...secretFieldPaths(nested, fieldPath));
  }
  return paths;
}

/**
 * Validate a runtime profile. Always rejects stored secret values (only
 * `*_env` references are allowed) and, when `transport.remote_enabled`, enforces
 * HTTP + TLS + bearer `token_env` + explicit allowlist + trusted-proxy rules.
 *
 * @param {object} profile - Runtime profile.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateRuntimeProfile(profile) {
  const errors = [];
  const warnings = [];
  if (profile?.schema_version !== RUNTIME_PROFILE_SCHEMA_VERSION) {
    errors.push(`Expected runtime profile schema ${RUNTIME_PROFILE_SCHEMA_VERSION}.`);
  }
  if (!["local-first", "remote"].includes(profile?.mode)) {
    errors.push("Runtime mode must be local-first or remote.");
  }
  if (!["stdio", "http"].includes(profile?.transport?.type)) {
    errors.push("Transport type must be stdio or http.");
  }
  const rawSecrets = secretFieldPaths(profile);
  if (rawSecrets.length) {
    errors.push(`Runtime profile must reference secret environment variables, not store values: ${rawSecrets.join(", ")}.`);
  }

  const remoteEnabled = profile?.transport?.remote_enabled === true;
  if (remoteEnabled) {
    if (profile.transport.type !== "http") errors.push("Remote mode requires the HTTP transport.");
    if (profile?.remote_foundation?.status !== "enabled") {
      errors.push("Remote foundation status must be enabled explicitly.");
    }
    if (!["native", "reverse-proxy"].includes(profile?.remote_foundation?.tls?.mode)) {
      errors.push("Remote mode requires native TLS or a TLS reverse proxy.");
    }
    if (profile?.remote_foundation?.authentication?.mode !== "bearer") {
      errors.push("Remote mode requires bearer authentication.");
    }
    if (!profile?.remote_foundation?.authentication?.token_env) {
      errors.push("Remote bearer authentication requires token_env.");
    }
    if (!Array.isArray(profile?.remote_foundation?.allowed_clients) || !profile.remote_foundation.allowed_clients.length) {
      errors.push("Remote mode requires an explicit allowed_clients list.");
    }
    if (profile?.remote_foundation?.bind === "0.0.0.0" && !profile?.remote_foundation?.trust_proxy) {
      errors.push("Public bind requires a trusted reverse proxy configuration.");
    }
  } else {
    if (profile?.mode !== "local-first") warnings.push("Remote mode is selected but transport.remote_enabled is false.");
    if (profile?.transport?.type !== "stdio") warnings.push("Local-first mode normally uses stdio.");
  }
  return { ok: errors.length === 0, errors, warnings };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic SHA-256 of a distribution manifest, ignoring `generated_at` and
 * any existing `fingerprint`, so freshness can be compared across runs.
 *
 * @param {object} manifest - Distribution manifest.
 * @returns {string} Hex digest.
 */
export function runtimeDistributionFingerprint(manifest) {
  const copy = { ...manifest };
  delete copy.generated_at;
  delete copy.fingerprint;
  return crypto.createHash("sha256").update(stableJson(copy)).digest("hex");
}

/**
 * Render the human-readable `Runtime Distribution.md` from a manifest.
 *
 * @param {object} manifest - Distribution manifest (mode, transport, commands, recovery, …).
 * @returns {string} Markdown document.
 */
export function renderRuntimeDistribution(manifest) {
  return `# Runtime Distribution

Generated: ${manifest.generated_at}

## Current Mode

- Mode: \`${manifest.profile.mode}\`
- Transport: \`${manifest.profile.transport.type}\`
- Remote enabled: ${manifest.profile.transport.remote_enabled ? "yes" : "no"}
- Entry point: \`${manifest.entrypoint}\`
- MCP tools: ${manifest.tools}

## Local Commands

- Start: \`${manifest.commands.start}\`
- Doctor: \`${manifest.commands.doctor}\`
- Full acceptance: \`${manifest.commands.acceptance}\`
- Backup: \`${manifest.commands.backup}\`

## Local Data

- Vault content stays in the configured Obsidian vault.
- Runtime state, search cache, and QA artifacts stay under the AI Dev home (\`AI_DEV_HOME\`, default \`~/.ai-dev\`).
- Password notes are not exposed as fixed MCP Resources and are not copied into this manifest.

## Future VPS Boundary

Remote transport is deliberately disabled. Enabling it later requires all of the following:

1. official MCP HTTP transport;
2. TLS at the process or trusted reverse proxy;
3. bearer token supplied only through \`${manifest.profile.remote_foundation.authentication.token_env}\`;
4. explicit client allowlist;
5. rate limiting and audit logs;
6. a fresh threat review and remote acceptance run.

Do not expose the current stdio process directly to a public interface.

## Recovery

- Backup script: \`${manifest.recovery.backup_script}\`
- Restore script: \`${manifest.recovery.restore_script}\`
- Backups include a manifest and SHA-256 sidecar while excluding disposable runtimes and indexes.
`;
}
