import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createLocalRuntimeProfile,
  distributionExpectations,
  distributionFilePlan,
  renderRuntimeDistribution,
  runtimeDistributionFingerprint,
  runtimeFlavor,
  summarizeDistributionFiles,
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

test("runtime flavor follows the platform unless the image marks itself", () => {
  assert.equal(runtimeFlavor({ platform: "win32", env: {} }), "windows");
  assert.equal(runtimeFlavor({ platform: "linux", env: {} }), "posix");
  assert.equal(runtimeFlavor({ platform: "darwin", env: {} }), "posix");
  // docker/Dockerfile sets AI_DEV_RUNTIME; the container reports linux otherwise.
  assert.equal(runtimeFlavor({ platform: "linux", env: { AI_DEV_RUNTIME: "docker" } }), "docker");
  assert.equal(runtimeFlavor({ platform: "linux", env: { AI_DEV_RUNTIME: " Docker " } }), "docker");
  assert.equal(runtimeFlavor({ platform: "win32", env: { AI_DEV_RUNTIME: "docker" } }), "docker");
  assert.equal(runtimeFlavor({ platform: "linux", env: { AI_DEV_RUNTIME: "podman" } }), "posix");
  assert.equal(runtimeFlavor(), "posix");
});

test("the Windows layout is the one that shipped", () => {
  const expectations = distributionExpectations("windows");
  assert.deepEqual(expectations.commands, {
    start: "node bin/ai-dev.mjs mcp",
    doctor: "node bin/ai-dev.mjs doctor",
    acceptance: "node bin/ai-dev.mjs acceptance",
    backup: "node bin/ai-dev.mjs backup <label>",
    restore: "node bin/ai-dev.mjs restore <archive.zip> --confirm"
  });
  assert.deepEqual(expectations.recovery, {
    backup_command: "node bin/ai-dev.mjs backup <label>",
    restore_command: "node bin/ai-dev.mjs restore <archive.zip> --confirm"
  });
  const plan = distributionFilePlan("windows", { serverRoot: "/srv", vaultRoot: "/vault" });
  assert.deepEqual(plan, {
    entrypoint: { applicable: true, path: path.join("/srv", "src", "server.mjs") },
    local_launcher: { applicable: true, path: path.join("/srv", "scripts", "start-local.ps1") },
    cli: { applicable: true, path: path.join("/srv", "bin", "ai-dev.mjs") },
    config_example: { applicable: true, path: path.join("/srv", "config", "runtime.example.json") },
    acceptance: { applicable: true, path: path.join("/srv", "scripts", "acceptance.mjs") },
    backup: { applicable: true, path: path.join("/srv", "src", "cli", "backup.mjs") },
    restore: { applicable: true, path: path.join("/srv", "src", "cli", "backup.mjs") }
  });
});

test("POSIX expects the cross-platform runner and claims no PowerShell", () => {
  const expectations = distributionExpectations("posix");
  assert.equal(expectations.commands.start, "node bin/ai-dev.mjs mcp");
  assert.equal(expectations.commands.acceptance, "node scripts/acceptance.mjs");
  assert.equal(expectations.commands.backup, "node bin/ai-dev.mjs backup <label>", "backup is a command on every system");
  const plan = distributionFilePlan("posix", { serverRoot: "/srv", vaultRoot: "/vault" });
  assert.equal(plan.acceptance.path, path.join("/srv", "scripts", "acceptance.mjs"));
  assert.equal(plan.backup.path, path.join("/srv", "src", "cli", "backup.mjs"));
  assert.equal(plan.local_launcher.applicable, false);
  assert.match(plan.local_launcher.reason, /\S/);
  // The reasons name PowerShell on purpose — that is why those files do not
  // apply here. What must be free of it is anything a caller would run.
  const runnable = JSON.stringify([
    expectations.commands,
    Object.values(plan).filter((entry) => entry.applicable).map((entry) => entry.path)
  ]);
  assert.doesNotMatch(runnable, /powershell|\.ps1/i);
});

test("Docker expects neither a host launcher nor in-image acceptance or backup", () => {
  const expectations = distributionExpectations("docker");
  assert.equal(expectations.commands.start, "sh docker/run-mcp.sh");
  assert.match(expectations.commands.doctor, /ai-dev\.mjs doctor$/);
  const plan = distributionFilePlan("docker", { serverRoot: "/opt/ai-dev/app", vaultRoot: "/data/ai-dev-system" });
  assert.equal(plan.entrypoint.path, path.join("/opt/ai-dev/app", "src", "server.mjs"));
  assert.equal(plan.cli.path, path.join("/opt/ai-dev/app", "bin", "ai-dev.mjs"));
  for (const key of ["local_launcher", "acceptance", "backup", "restore"]) {
    assert.equal(plan[key].applicable, false, key);
  }
  assert.match(plan.backup.reason, /\/data/);
  assert.doesNotMatch(JSON.stringify([expectations.commands, expectations.recovery]), /powershell|\.ps1/i);
});

test("an unknown flavor falls back to POSIX rather than to the Windows layout", () => {
  assert.deepEqual(distributionExpectations("haiku"), distributionExpectations("posix"));
});

test("readiness counts applicable files only", () => {
  const summary = summarizeDistributionFiles({
    entrypoint: { applicable: true, path: "/srv/src/server.mjs", exists: true },
    backup: { applicable: false, reason: "the /data volume is the backup unit" },
    restore: { applicable: false, reason: "the /data volume is the backup unit" }
  });
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.missing, []);
  assert.deepEqual(summary.not_applicable.map((item) => item.key), ["backup", "restore"]);

  const incomplete = summarizeDistributionFiles({
    cli: { applicable: true, path: "/srv/bin/ai-dev.mjs", exists: false },
    backup: { applicable: false, reason: "not here" }
  });
  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.missing, [{ key: "cli", path: "/srv/bin/ai-dev.mjs" }]);
  assert.equal(incomplete.missing.some((item) => item.key === "backup"), false);
});

test("the rendered document names no script the flavor does not have", () => {
  const base = {
    generated_at: "1970-01-01T00:00:00.000Z",
    profile: createLocalRuntimeProfile(),
    entrypoint: "src/server.mjs",
    tools: 133
  };
  const windows = renderRuntimeDistribution({
    ...base,
    runtime_flavor: "windows",
    ...distributionExpectations("windows")
  });
  assert.match(windows, /- Start: `node bin\/ai-dev\.mjs mcp`/);
  assert.match(windows, /- Backup: `node bin\/ai-dev\.mjs backup <label>`/);
  assert.match(windows, /- Restore: `node bin\/ai-dev\.mjs restore <archive\.zip> --confirm`/);
  assert.doesNotMatch(windows, /\.ps1`/, "no PowerShell script is a way to back up any more");
  // A 2.x manifest read back still renders.
  assert.match(renderRuntimeDistribution({ ...base, runtime_flavor: "windows", ...distributionExpectations("windows"),
    recovery: { backup_script: "09-mcp/scripts/backup-ai-dev-system.ps1", restore_script: "09-mcp/scripts/restore-ai-dev-system.ps1" } }),
  /- Backup script: `09-mcp\/scripts\/backup-ai-dev-system\.ps1`/);

  for (const flavor of ["posix", "docker"]) {
    const markdown = renderRuntimeDistribution({
      ...base,
      runtime_flavor: flavor,
      ...distributionExpectations(flavor)
    });
    assert.doesNotMatch(markdown, /powershell|\.ps1/i, flavor);
    assert.doesNotMatch(markdown, /undefined/, flavor);
    assert.match(markdown, new RegExp(`Runtime flavor: \`${flavor}\``), flavor);
    assert.match(markdown, /## Recovery\n\n- \S/, flavor);
  }
});

test("an installed package is not asked for the acceptance runner it does not ship", () => {
  const packaged = distributionExpectations("posix", { packaged: true });
  assert.equal(packaged.commands.acceptance, undefined);
  assert.equal(packaged.commands.backup, "node bin/ai-dev.mjs backup <label>");
  const plan = distributionFilePlan("posix", { serverRoot: "/srv", vaultRoot: "/vault", packaged: true });
  assert.equal(plan.acceptance.applicable, false);
  assert.match(plan.acceptance.reason, /source checkout/);
  assert.equal(distributionFilePlan("posix", { serverRoot: "/srv", vaultRoot: "/vault" }).acceptance.applicable, true, "a clone still has it");
  assert.equal(distributionExpectations("windows", { packaged: true }).files.acceptance.reason !== undefined, true);
});
