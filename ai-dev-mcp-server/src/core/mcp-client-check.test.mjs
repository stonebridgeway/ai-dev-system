import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkServerCommand } from "./mcp-client-check.mjs";

/** A child process that answers its first line on stdin with `reply`. */
function fakeSpawn(reply, { calls = [] } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit("close", null, "SIGTERM");
    };
    child.stdin.once("data", (chunk) => setImmediate(() => reply(child, JSON.parse(String(chunk)))));
    return child;
  };
}

test("an answer with instructions passes, with the server's name and the time it took", async () => {
  const calls = [];
  const result = await checkServerCommand(
    { command: "/usr/bin/node", args: ["/opt/ai-dev/bin/ai-dev.mjs", "mcp"], env: { AI_DEV_VAULT_ROOT: "/v" } },
    {
      env: { PATH: "/bin" },
      spawnProcess: fakeSpawn((child, request) => {
        assert.equal(request.method, "initialize");
        child.stdout.write("\n");
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n`);
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "ai-dev-system", version: "3.0.0" }, instructions: "x".repeat(900) } }).slice(0, 40));
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "ai-dev-system", version: "3.0.0" }, instructions: "x".repeat(900) } }).slice(40)}\n`);
      }, { calls })
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.server, { name: "ai-dev-system", version: "3.0.0" });
  assert.equal(result.instructions, 900);
  assert.ok(result.ms >= 0);
  assert.deepEqual(calls[0].options.env, { PATH: "/bin", AI_DEV_VAULT_ROOT: "/v" }, "the entry's env on top of the environment");
  assert.equal(calls[0].options.shell, false);
});

test("each way a client would see a red dot is named", async () => {
  const cases = [
    [(child) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x" } })}\n`), /answered initialize without instructions/],
    [(child) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } })}\n`), /refused initialize: bad/],
    [(child) => child.stdout.write("Starting server v1...\n"), /printed something other than MCP on stdout, which clients cannot read: Starting server/],
    [(child) => {
      child.stderr.write("Error: Cannot find module '/old/clone/src/server.mjs'\n");
      child.emit("close", 1, null);
    }, /exited with code 1 before answering: Error: Cannot find module/]
  ];
  for (const [reply, said] of cases) {
    const result = await checkServerCommand({ command: "node", args: [] }, { spawnProcess: fakeSpawn(reply) });
    assert.equal(result.ok, false);
    assert.match(result.error, said);
  }
});

test("a command that died is named by its error, not by Node's version, its stack or its code", async () => {
  const stderrs = [
    [[
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '/old/clone/ai-dev-mcp-server/src/server.mjs'",
      "    at Function._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "    at node:internal/main/run_main_module:36:49 {",
      "  code: 'MODULE_NOT_FOUND',",
      "  requireStack: []",
      "}",
      "",
      "Node.js v22.22.0",
      ""
    ], "Error: Cannot find module '/old/clone/ai-dev-mcp-server/src/server.mjs'"],
    [[
      "file:///opt/ai-dev/src/server.mjs:3",
      "throw new Error(\"vault missing\");",
      "^",
      "",
      "Error: vault missing",
      "    at file:///opt/ai-dev/src/server.mjs:3:7",
      "  [cause]: Error: ENOENT: no such file or directory, stat '/vault'",
      "",
      "Node.js v24.1.0"
    ], "Error: vault missing"],
    [["Warning: something", "  [errors]: [ AggregateError: two failed ]"], "[errors]: [ AggregateError: two failed ]"],
    [["Traceback (most recent call last):", "  File \"x.py\", line 1, in <module>", "ModuleNotFoundError: No module named 'mcp'"], "ModuleNotFoundError: No module named 'mcp'"],
    [["docker: Error response from daemon: pull access denied for ai-dev.", "See 'docker run --help'."], "docker: Error response from daemon: pull access denied for ai-dev."],
    [["ai-dev: the vault folder /v does not exist.", "Set AI_DEV_VAULT_ROOT to it."], "Set AI_DEV_VAULT_ROOT to it."],
    [["", "Node.js v22.22.0", ""], ""]
  ];
  for (const [lines, said] of stderrs) {
    const result = await checkServerCommand({ command: "node", args: [] }, {
      spawnProcess: fakeSpawn((child) => {
        child.stderr.write(lines.join("\r\n"));
        setImmediate(() => child.emit("close", 1, null));
      })
    });
    assert.equal(result.error, `it exited with code 1 before answering${said ? `: ${said}` : ""}`, lines.join("\n"));
  }
  // Node names the entry as it resolved it: on Windows, on the current drive.
  const entry = path.resolve("/old/clone/ai-dev-mcp-server/src/server.mjs");
  const moved = await checkServerCommand({ command: process.execPath, args: [entry] });
  assert.equal(moved.ok, false);
  assert.ok(moved.error.startsWith(`it exited with code 1 before answering: Error: Cannot find module '${entry}'`), moved.error);
});

test("a warning Docker prints before it goes on is no reason a command stopped: the reason Docker gives is said", async () => {
  // Docker 29.8.2's own words, as measured (the home shortened): its config.json broken, then a folder in its place,
  // each before it refused a --mount; an image of another platform; ports published with the host's network.
  const refusal = "invalid argument \"type=bind,source=/tmp,target=/models,readonly=TRUE\" for \"--mount\" flag: invalid value for 'readonly': invalid boolean value (\"TRUE\"): must be one of \"true\", \"1\", \"false\", or \"0\" (default \"true\")";
  const usage = ["", "Usage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]", "", "Run 'docker run --help' for more information"];
  const platform = "WARNING: The requested image's platform (linux/arm64) does not match the detected host platform (linux/amd64/v4) and no specific platform was requested";
  const ports = "WARNING: Published ports are discarded when using host network mode";
  const cases = [
    [125, ["WARNING: Error parsing config file (/home/me/.docker/config.json): invalid character 'b' looking for beginning of object key string", refusal, ...usage], refusal],
    [125, ["WARNING: Error parsing config file (/home/me/.docker/config.json): read /home/me/.docker/config.json: is a directory", refusal, ...usage], refusal],
    // CLI 27.5.1's own warning for a broken config.json, as measured, before its refusal.
    [125, ["WARNING: Error loading config file: /home/me/.docker/config.json: : invalid character 'b' looking for beginning of object key string",
      "invalid argument \"type=bind,source=/tmp,target=/models,bogus=1\" for \"--mount\" flag: unexpected key 'bogus' in 'bogus=1'", "See 'docker run --help'."],
      "invalid argument \"type=bind,source=/tmp,target=/models,bogus=1\" for \"--mount\" flag: unexpected key 'bogus' in 'bogus=1'"],
    [127, [platform, "docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: \"/usr/local/bin/ai-dev\": stat /usr/local/bin/ai-dev: no such file or directory", "", "Run 'docker run --help' for more information"],
      "docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: \"/usr/local/bin/ai-dev\": stat /usr/local/bin/ai-dev: no such file or directory"],
    [3, [platform], ""],
    [3, [ports, "server: cannot open /data/index.db"], "server: cannot open /data/index.db"],
    [3, [ports], ""],
    // Not Docker's: a line that only begins as its warnings do, or another program's warning, is said as before.
    [1, ["WARNING:root:the index at /data/index.db is from another version"], "WARNING:root:the index at /data/index.db is from another version"],
    [1, ["Warning: no vault at /data/vault; run ai-dev setup first"], "Warning: no vault at /data/vault; run ai-dev setup first"],
    // A third-party server's Go log line, its warning past the line's start: the reason it stopped.
    [1, ["2026/10/19 12:00:00 WARNING: GITHUB_TOKEN is not set; the server cannot start without it"], "2026/10/19 12:00:00 WARNING: GITHUB_TOKEN is not set; the server cannot start without it"]
  ];
  for (const [code, lines, said] of cases) {
    const result = await checkServerCommand({ command: "docker", args: [] }, {
      spawnProcess: fakeSpawn((child) => {
        child.stderr.write(`${lines.join("\n")}\n`);
        setImmediate(() => child.emit("close", code, null));
      })
    });
    assert.equal(result.error, `it exited with code ${code} before answering${said ? `: ${said}` : ""}`, lines.join("\n"));
  }
});

test("a command that does not exist, an empty one, and one that never answers", async () => {
  const missing = await checkServerCommand({ command: "/nonexistent/node-that-is-not-there", args: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /\/nonexistent\/node-that-is-not-there does not exist/);
  assert.match((await checkServerCommand({ args: [] })).error, /names no command/);
  const silent = await checkServerCommand({ command: "node", args: [] }, { timeoutMs: 50, spawnProcess: fakeSpawn(() => undefined) });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /no answer to initialize within 0 s/);
  const thrown = await checkServerCommand({ command: "node" }, { spawnProcess: () => { throw new Error("EACCES"); } });
  assert.match(thrown.error, /node could not be started: EACCES/);
});

test("a line too long to keep whole is cut between characters, never inside a surrogate pair", async () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const said = async (line) => (await checkServerCommand({ command: "node", args: [] }, {
    spawnProcess: fakeSpawn((child) => {
      child.stderr.write(`${line}\n`);
      setImmediate(() => child.emit("close", 1, null));
    })
  })).error.replace("it exited with code 1 before answering: ", "");
  // A long line: 301 characters, an emoji at 149 and 150, where the head is cut.
  const head = `Error: ${"x".repeat(142)}\u{1F600}${"y".repeat(150)}`;
  assert.equal(await said(head), `Error: ${"x".repeat(142)}\u2026${"y".repeat(149)}`);
  // An emoji at the first two places the tail keeps: it is kept whole.
  const tail = `Error: ${"x".repeat(150)}\u{1F600}${"y".repeat(148)}`;
  assert.equal(tail.length, 307);
  assert.equal(await said(tail), `Error: ${"x".repeat(143)}\u2026\u{1F600}${"y".repeat(148)}`);
  // Both edges at once, and neither: the cut as before, 150 and 149 characters around the ellipsis.
  const both = `Error: ${"x".repeat(142)}\u{1F600}${"z".repeat(10)}\u{1F600}${"y".repeat(148)}`;
  assert.equal(await said(both), `Error: ${"x".repeat(142)}\u2026\u{1F600}${"y".repeat(148)}`);
  const plain = `Error: ${"x".repeat(400)}`;
  assert.equal(await said(plain), `Error: ${"x".repeat(143)}\u2026${"x".repeat(149)}`);
  for (const line of [head, tail, both]) assert.doesNotMatch(await said(line), lone);
});

test("a command that ended before it answered gives back its exit code and its stderr as written", async () => {
  const stderr = "invalid argument \"type=bind,source=/x,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'\nSee 'docker run --help'.\n";
  const result = await checkServerCommand({ command: "docker", args: [] }, {
    spawnProcess: fakeSpawn((child) => {
      child.stderr.write(stderr);
      setImmediate(() => child.emit("close", 125, null));
    })
  });
  assert.deepEqual([result.ok, result.code, result.stderr], [false, 125, stderr]);
  const silent = await checkServerCommand({ command: "node", args: [] }, { timeoutMs: 50, spawnProcess: fakeSpawn(() => undefined) });
  assert.deepEqual([silent.code, silent.stderr], [undefined, undefined], "a check that ended otherwise has neither");
});

// A real child that records how it ended; `exit` resolves once it is gone. Whatever a test found, none outlives it:
// a child still running would keep the test's own process from exiting.
function recordedSpawn(children, t) {
  t.after(() => {
    for (const { child } of children) child.kill("SIGKILL");
  });
  return (command, args, options) => {
    const child = spawn(command, args, options);
    children.push({ child, exit: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() }))) });
    return child;
  };
}

// On Windows a child is stopped by TerminateProcess, SIGTERM or not: there is no signal to ignore.
const signals = { skip: process.platform === "win32" && "no SIGTERM to ignore on Windows" };

test("a command that does not stop for SIGTERM is killed a few seconds on, so the doctor can exit", signals, async (t) => {
  const children = [];
  // As a container whose first process has no handler for SIGTERM, behind `docker run -i`: it never answers either.
  const deaf = { command: process.execPath, args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"] };
  const started = Date.now();
  const result = await checkServerCommand(deaf, { timeoutMs: 1000, killAfterMs: 500, spawnProcess: recordedSpawn(children, t) });
  assert.equal(result.error, "no answer to initialize within 1 s");
  const ended = await Promise.race([children[0].exit, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
  assert.ok(ended, "the child is gone");
  assert.equal(ended.signal, "SIGKILL");
  assert.ok(ended.at - started < 1000 + 500 + 2000, `gone ${ended.at - started} ms after the start`);
});

test("a command that stops for SIGTERM, or when its stdin closes, is not killed", signals, async (t) => {
  const children = [];
  const answer = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "s", version: "1" }, instructions: "Begin." } });
  // One that answers and stops for SIGTERM, as a Node server does; one that ignores SIGTERM and stops at the end of its input.
  const polite = `process.stdin.once("data", () => console.log(${JSON.stringify(answer)})); setInterval(() => {}, 1000)`;
  const reader = `process.on("SIGTERM", () => {}); process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1000)`;
  for (const script of [polite, reader]) {
    const result = await checkServerCommand({ command: process.execPath, args: ["-e", script] }, { timeoutMs: 5000, killAfterMs: 3000, spawnProcess: recordedSpawn(children, t) });
    assert.equal(result.ok, script === polite, result.error);
  }
  const [stopped, ended] = await Promise.all(children.map((each) => each.exit));
  assert.deepEqual([stopped.code, stopped.signal], [null, "SIGTERM"]);
  assert.deepEqual([ended.code, ended.signal], [0, null]);
});

test("clients doctor exits after an entry that does not stop for SIGTERM: it is killed a few seconds on", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-doctor-"));
  const pidFile = path.join(home, "deaf.pid");
  // Whatever the doctor did, nothing it started outlives the test.
  t.after(async () => {
    const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // Gone, as it should be.
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(home, ".cursor"));
  const script = "require('node:fs').writeFileSync(process.env.DEAF_PID, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: process.execPath, args: ["-e", script], env: { DEAF_PID: pidFile } } } }));
  const cli = fileURLToPath(new URL("../../bin/ai-dev.mjs", import.meta.url));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", AI_DEV_HOME: ""
  };
  // The doctor says its verdict once the second is up, and exits when the entry's process is killed, the 5 s grace
  // on: it waits that out and no longer. Measured on 4 CPUs, idle and with 32 busy loops: 6.1–8.3 s in all, the
  // start slower under load; 5.0–5.3 s from the verdict to the exit. On Windows the entry's process is stopped
  // at once, SIGTERM or not, so there is no grace to wait out.
  const started = Date.now();
  const doctor = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "clients", "doctor", "--clients=cursor", "--timeout=1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let stdout = "";
    let stderr = "";
    let verdict = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!verdict && stdout.includes("FAILED")) verdict = Date.now();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, took: Date.now() - started, afterVerdict: Date.now() - verdict });
    });
  });
  assert.equal(doctor.status, 1, `${doctor.signal ?? ""} ${doctor.stdout}${doctor.stderr}`);
  assert.match(doctor.stdout, /Cursor\s+FAILED — no answer to initialize within 1 s\n/);
  if (process.platform !== "win32") assert.ok(doctor.took >= 1000 + 5000, `the doctor exited ${doctor.took} ms after it started: before the second and the grace were up`);
  assert.ok(doctor.afterVerdict < 5000 + 2000, `the doctor exited ${doctor.afterVerdict} ms after its verdict: past the grace`);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" }, "the entry's process is gone");
  // A server that answers and stops for SIGTERM, as a Node one does: the doctor does not wait out the grace after it.
  const answer = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "s", version: "1" }, instructions: "Begin." } });
  const polite = `process.stdin.once("data", () => console.log(${JSON.stringify(answer)})); setInterval(() => {}, 1000)`;
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: process.execPath, args: ["-e", polite] } } }));
  const quick = Date.now();
  const answered = spawnSync(process.execPath, [cli, "clients", "doctor", "--clients=cursor"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(answered.status, 0, `${answered.stdout}${answered.stderr}`);
  assert.ok(Date.now() - quick < 5000, `the doctor exited ${Date.now() - quick} ms after it started`);
});
