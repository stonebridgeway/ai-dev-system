import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalRuntimeProfile,
  runtimeDistributionFingerprint,
  validateRuntimeProfile
} from "./runtime-distribution.mjs";

test("local runtime profile is valid and stores no secret", () => {
  const profile = createLocalRuntimeProfile();
  const validation = validateRuntimeProfile(profile);
  assert.equal(validation.ok, true);
  assert.equal(profile.transport.remote_enabled, false);
});

test("remote profile is blocked without TLS, allowlist, and environment-bound auth", () => {
  const profile = createLocalRuntimeProfile();
  profile.mode = "remote";
  profile.transport = { type: "http", remote_enabled: true };
  profile.remote_foundation.status = "enabled";
  profile.remote_foundation.tls.mode = "disabled";
  profile.remote_foundation.allowed_clients = [];
  profile.remote_foundation.authentication.token = "stored-token-is-forbidden";
  const validation = validateRuntimeProfile(profile);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /must reference secret environment variables/);
  assert.match(validation.errors.join("\n"), /requires native TLS/);
  assert.match(validation.errors.join("\n"), /allowed_clients/);
});

test("distribution fingerprint ignores generation time", () => {
  const first = { generated_at: "one", entrypoint: "server.mjs", profile: createLocalRuntimeProfile() };
  const second = { ...first, generated_at: "two" };
  assert.equal(runtimeDistributionFingerprint(first), runtimeDistributionFingerprint(second));
});
