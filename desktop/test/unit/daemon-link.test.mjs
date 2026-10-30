import assert from "node:assert/strict";
import test from "node:test";
import { DaemonLink } from "../../src/main/daemon-link.mjs";

// The link against a stand-in for the server: a daemon that answers
// system_status as told, can go away, and can come back.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeServer() {
  const calls = [];
  const clients = [];
  const opens = [];
  const server = {
    down: false,
    retired: null,
    // Set to make the next opening wait for it (a promise), or the next checks call end the session.
    openGate: null,
    dieOnChecks: false,
    // How many checks answers, from now, find their daemon just retired; whether starting a daemon fails.
    retireOnChecks: 0,
    failStart: false,
    // A tool whose call waits for `release()`: { name, release }.
    held: null,
    // What tools/list answers, in pages of two; how often it was asked; whether it fails.
    tools: [
      { name: "list_projects", annotations: { readOnlyHint: true } },
      { name: "list_tasks", annotations: { readOnlyHint: true } },
      { name: "clients_install", annotations: { readOnlyHint: false } }
    ],
    listings: 0,
    failList: false,
    quick: { status: "ok", index: { exists: true, fresh: true, documents: 5 }, served_by: { pid: 11 } },
    checked: { status: "failed", index: { exists: true, fresh: true, documents: 5 }, served_by: { pid: 11 }, checks: [{ name: "skill_registry", status: "fail", critical: true }] },
    async openControlClient({ start } = {}) {
      opens.push({ start });
      if (server.openGate) await server.openGate;
      if (start && server.failStart) throw new Error("the daemon did not start");
      // A daemon is there, or this one may start it.
      if (server.down && !start) throw Object.assign(new Error("not running"), { code: "ENOTRUNNING" });
      server.down = false;
      const client = {
        onclose: null,
        closed: false,
        async callTool({ name, arguments: args }, _schema, options = {}) {
          calls.push({ name, args });
          if (name === "system_status" && args?.checks !== false && server.dieOnChecks) {
            // The daemon goes away while it runs the checks: the SDK calls onclose, then rejects.
            server.dieOnChecks = false;
            server.down = true;
            client.closed = true;
            client.onclose?.();
            throw new Error("Connection closed");
          }
          if (name === "system_status" && args?.checks !== false && server.retireOnChecks > 0) {
            // A daemon of new code took over while this one ran the checks.
            server.retireOnChecks -= 1;
            server.retired = client;
          }
          if (server.held?.name === name) {
            await new Promise((resolve, reject) => {
              server.held.release = resolve;
              options.signal?.addEventListener("abort", () => reject(options.signal.reason));
            });
          }
          if (name === "system_status") {
            const answer = args?.checks === false ? server.quick : server.checked;
            // The daemon this session is on retired; a session opened after it is on the new one.
            return { structuredContent: { result: server.retired === client ? { ...answer, served_by: { pid: 11, retired: true } } : answer } };
          }
          return { structuredContent: { result: { done: name } } };
        },
        async listTools(params) {
          server.listings += 1;
          if (server.failList) throw new Error("tools/list failed");
          const from = Number(params?.cursor ?? 0);
          const next = from + 2 < server.tools.length ? String(from + 2) : undefined;
          return { tools: server.tools.slice(from, from + 2), ...(next ? { nextCursor: next } : {}) };
        },
        async close() {
          client.closed = true;
        }
      };
      clients.push(client);
      return { client, transport: {} };
    },
    async stopDaemons() {
      server.down = true;
      clients.at(-1)?.onclose?.();
      return { daemons: [{ pid: 11 }] };
    },
    async daemonLogTail() {
      return ["daemon: listening", "daemon: killed"];
    }
  };
  return { server, calls, clients, opens };
}

function link(t, server, timing = {}) {
  const made = new DaemonLink({ env: {}, t: (key) => key, timing: { statusEveryMs: 15, checksEveryMs: 60_000, retryEveryMs: 15, ...timing } });
  made.attach({ server, execPath: "/node" });
  t.after(() => made.close());
  return made;
}

const checksCalls = (calls) => calls.filter((call) => call.name === "system_status" && call.args?.checks !== false).length;

test("the tray's verdict is the health checks' answer, and the quick poll does not overwrite it", async (t) => {
  const { server, calls } = fakeServer();
  const daemon = link(t, server);
  await daemon.connect({ start: true });
  assert.equal(daemon.state.phase, "online");
  assert.equal(daemon.status.status, "failed", "the checks' verdict, not the quick ok");
  await sleep(60);
  assert.equal(daemon.status.status, "failed");
  assert.equal(checksCalls(calls), 1, "the quick state did not move: no new checks");
  // The quick state moves: the checks run again and their verdict is the tray's.
  server.quick = { ...server.quick, index: { ...server.quick.index, documents: 9 } };
  server.checked = { ...server.checked, status: "degraded", index: { ...server.checked.index, documents: 9 } };
  await sleep(60);
  assert.equal(daemon.status.status, "degraded");
  assert.ok(checksCalls(calls) >= 2);
});

test("every system_status answer the window gets is the tray's, and a change runs the checks again", async (t) => {
  const { server, calls } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000 });
  await daemon.connect({ start: true });
  const seen = [];
  daemon.on("status", (status) => seen.push(status?.status));
  server.checked = { ...server.checked, status: "ok" };
  assert.equal((await daemon.call("system_status", { checks: true }, { id: "call-1" })).ok, true);
  assert.deepEqual(seen, ["ok"], "the window's answer reached the tray");
  const before = checksCalls(calls);
  await daemon.call("setup_run", {}, { id: "call-2" });
  await sleep(20);
  assert.equal(checksCalls(calls), before + 1, "after a change, the checks again");
  await daemon.call("clients_list", {}, { id: "call-3" });
  await sleep(20);
  assert.equal(checksCalls(calls), before + 1, "not after a read");
});

test("a retired daemon is left for the daemon of the new code", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server);
  await daemon.connect({ start: true });
  const phases = [];
  daemon.on("state", (state) => phases.push(state.phase));
  server.retired = clients[0];
  server.quick = { ...server.quick, served_by: { pid: 12 } };
  server.checked = { ...server.checked, served_by: { pid: 12 } };
  await sleep(80);
  assert.equal(clients.length, 2, "a second session was opened");
  assert.equal(clients[0].closed, true, "and the first one closed, so the old daemon can finish");
  assert.equal(daemon.state.phase, "online");
  assert.ok(phases.includes("reconnecting") && !phases.includes("offline"), JSON.stringify(phases));
});

test("a daemon that goes away unasked: offline with its log; back when a client starts it again", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server);
  await daemon.connect({ start: true });
  server.down = true;
  clients[0].onclose();
  assert.equal(daemon.state.phase, "offline");
  assert.equal(daemon.state.error, "link.lost");
  await sleep(10);
  assert.deepEqual(daemon.state.log, ["daemon: listening", "daemon: killed"]);
  assert.equal(daemon.state.errorKey, "link.lost", "with its key, after the log came too");
  assert.equal(daemon.status, null);
  await sleep(50);
  assert.equal(daemon.state.phase, "offline", "nothing to come back to yet");
  server.down = false;
  await sleep(60);
  assert.equal(daemon.state.phase, "online", "a client started it: the app is back");
  assert.equal(clients.length, 2);
});

test("Stop from the tray: offline without an error; a call in flight ends with the link's words", async (t) => {
  const { server } = fakeServer();
  const daemon = link(t, server, { retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  assert.equal((await daemon.stopDaemon()).daemons.length, 1);
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
  assert.deepEqual(await daemon.call("system_status", {}, { id: "call-9" }), { ok: false, error: "link.notConnected", key: "link.notConnected", cancelled: false });
});

test("without a Node there is nothing to connect to, and the state says why", async (t) => {
  const made = new DaemonLink({ env: {}, t: (key) => key });
  t.after(() => made.close());
  made.attach({ server: fakeServer().server, execPath: null, noNode: "No Node.js 22.16 or newer was found." });
  assert.deepEqual(made.state, { phase: "no-node", error: "No Node.js 22.16 or newer was found." });
  assert.deepEqual(await made.connect({ start: true }), made.state);
  made.fail({ error: "broken", hint: "fix it", restart: false });
  assert.deepEqual(made.state, { phase: "broken", error: "broken", hint: "fix it", restart: false });
});

test("the daemon goes away while the link's first checks run: offline, and back when a daemon is there again", async (t) => {
  const { server, clients } = fakeServer();
  server.dieOnChecks = true;
  const daemon = link(t, server, { statusEveryMs: 60_000 });
  await daemon.connect({ start: true });
  assert.equal(daemon.state.phase, "offline", "not online without a session");
  assert.equal(daemon.state.error, "link.lost");
  server.down = false;
  await sleep(60);
  assert.equal(daemon.state.phase, "online", "the look found the daemon again");
  assert.equal(clients.length, 2);
  assert.equal((await daemon.call("clients_list", {}, { id: "call-1" })).ok, true);
});

test("without a daemon the link looks for one and never starts it; Stop is followed by the same look", async (t) => {
  const { server, opens } = fakeServer();
  server.down = true;
  const daemon = link(t, server);
  await daemon.connect({ start: false });
  assert.equal(daemon.state.phase, "offline");
  await sleep(80);
  assert.ok(opens.length >= 3, `looked ${opens.length} times`);
  assert.deepEqual([...new Set(opens.map((open) => open.start))], [false], "no look starts a daemon");
  // A client starts it: the app is back. Then Stop, and a client starts it again.
  server.down = false;
  await sleep(60);
  assert.equal(daemon.state.phase, "online");
  await daemon.stopDaemon();
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
  server.down = false;
  await sleep(60);
  assert.equal(daemon.state.phase, "online", "after Stop, the app comes back when a client starts the daemon");
});

test("a quick system_status the page asks for is not the tray's verdict", async (t) => {
  const { server } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000 });
  await daemon.connect({ start: true });
  assert.equal(daemon.status.status, "failed");
  const quick = await daemon.call("system_status", { checks: false }, { id: "call-1" });
  assert.equal(quick.result.status, "ok", "the page gets the quick answer");
  assert.equal(daemon.status.status, "failed", "the tray keeps the checks' verdict");
});

test("an answer that says the daemon retired moves the link at once, without waiting for the next poll", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000 });
  await daemon.connect({ start: true });
  server.retired = clients[0];
  await daemon.refreshStatus({ checks: true });
  await sleep(20);
  assert.equal(clients.length, 2, "a session on the new daemon");
  assert.equal(clients[0].closed, true);
});

test("a call in flight when the daemon retires is finished there; the move waits for it", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000 });
  await daemon.connect({ start: true });
  server.held = { name: "model_install" };
  const download = daemon.call("model_install", {}, { id: "call-1" });
  await sleep(5);
  server.retired = clients[0];
  await daemon.refreshStatus({ checks: true });
  await sleep(20);
  assert.equal(clients.length, 1, "no move while the download runs");
  assert.equal(clients[0].closed, false);
  server.held.release();
  assert.deepEqual(await download, { ok: true, result: { done: "model_install" } });
  await sleep(20);
  assert.equal(clients.length, 2, "then the move");
  assert.equal(clients[0].closed, true);
});

test("a call the daemon's going away ends has failed; Cancel is what the person pressed", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  server.held = { name: "model_install" };
  const cancelled = daemon.call("model_install", {}, { id: "call-1" });
  await sleep(5);
  assert.equal(daemon.cancel("call-1"), true);
  assert.deepEqual(await cancelled, { ok: false, error: "link.cancelled", key: "link.cancelled", cancelled: true });
  const ended = daemon.call("model_install", {}, { id: "call-2" });
  await sleep(5);
  server.down = true;
  clients[0].onclose();
  assert.deepEqual(await ended, { ok: false, error: "link.wentAway", key: "link.wentAway", cancelled: false });
});

test("Start pressed while the link looks for a daemon starts one; a failed Stop leaves later losses unasked", async (t) => {
  const { server, opens, clients } = fakeServer();
  server.down = true;
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 10 });
  await daemon.connect({ start: false });
  // The next look waits at the daemon's door; Start is pressed meanwhile.
  let open;
  server.openGate = new Promise((resolve) => { open = resolve; });
  await sleep(20);
  assert.ok(opens.at(-1).start === false, "a look is under way");
  const started = daemon.connect({ start: true });
  server.openGate = null;
  open();
  await started;
  assert.equal(daemon.state.phase, "online");
  assert.equal(opens.at(-1).start, true, "Start started the daemon");
  // stopDaemons fails: the next loss is the daemon's own, said as such.
  server.stopDaemons = async () => { throw new Error("EPERM"); };
  await assert.rejects(daemon.stopDaemon(), /EPERM/);
  clients.at(-1).onclose();
  assert.equal(daemon.state.error, "link.lost");
});

test("close() while a session opens leaves no session open", async (t) => {
  const { server, clients } = fakeServer();
  let open;
  server.openGate = new Promise((resolve) => { open = resolve; });
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  const connecting = daemon.connect({ start: true });
  await sleep(5);
  await daemon.close();
  open();
  await connecting;
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true, "the late session was given up");
  assert.notEqual(daemon.state.phase, "online");
  assert.deepEqual(await daemon.call("clients_list", {}, { id: "call-1" }), { ok: false, error: "link.notConnected", key: "link.notConnected", cancelled: false });
});


test("a daemon that retires while the link's first checks run: the link moves to the new one", async (t) => {
  const { server, clients } = fakeServer();
  server.retireOnChecks = 1;
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  await sleep(30);
  assert.equal(daemon.state.phase, "online", JSON.stringify(daemon.state));
  assert.equal(clients.length, 2, "a session on the new daemon");
  assert.equal(clients[0].closed, true, "the retired daemon's session closed");
  assert.equal((await daemon.call("clients_list", {}, { id: "call-1" })).ok, true);
});

test("the move's own first checks find that daemon retired too: the link moves again", async (t) => {
  const { server, clients } = fakeServer();
  server.retireOnChecks = 2;
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  await sleep(40);
  assert.equal(daemon.state.phase, "online", JSON.stringify(daemon.state));
  assert.equal(clients.length, 3);
  assert.deepEqual(clients.map((client) => client.closed), [true, true, false]);
});

test("the daemon going away while the move waits for a call ends the wait: nothing starts a daemon", async (t) => {
  const { server, clients, opens } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  server.held = { name: "model_install" };
  const download = daemon.call("model_install", {}, { id: "call-1" });
  await sleep(5);
  server.retired = clients[0];
  await daemon.refreshStatus({ checks: true });
  // The move waits for the download; the daemon goes away meanwhile.
  server.down = true;
  clients[0].onclose();
  assert.deepEqual(await download, { ok: false, error: "link.wentAway", key: "link.wentAway", cancelled: false });
  await sleep(20);
  assert.equal(daemon.state.phase, "offline", "the link looks for a daemon, it does not move to one");
  assert.equal(opens.filter((open) => open.start).length, 1, "only the first connect started a daemon");
});

test("two Starts while one attempt runs share it, after the link has looked for a daemon (U-c)", async (t) => {
  const { server, opens } = fakeServer();
  server.down = true;
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 10 });
  await daemon.connect({ start: false });
  await sleep(35);
  assert.ok(opens.length >= 2, "the link looked for a daemon");
  // The daemon cannot start: both presses end in one failed attempt.
  server.failStart = true;
  let open;
  server.openGate = new Promise((resolve) => { open = resolve; });
  const before = opens.length;
  const first = daemon.connect({ start: true });
  const second = daemon.connect({ start: true });
  server.openGate = null;
  open();
  await Promise.all([first, second]);
  assert.equal(opens.slice(before).filter((attempt) => attempt.start).length, 1, "one attempt for two presses");
  assert.equal(daemon.state.error, "the daemon did not start");
});

test("a daemon that will not stop keeps the link's session: online, and the answer says why", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  server.stopDaemons = async () => ({ daemons: [{ pid: 11, stopped: false, reason: "No handshake within 5000 ms" }] });
  const answer = await daemon.stopDaemon();
  assert.deepEqual(answer.daemons.map((item) => [item.pid, item.stopped]), [[11, false]]);
  assert.equal(daemon.state.phase, "online", "the daemon still serves");
  assert.equal(clients[0].closed, false, "and the session on it is kept");
  assert.equal((await daemon.call("clients_list", {}, { id: "call-1" })).ok, true);
  // Another daemon that would not stop does not keep the link on its own, which did.
  server.stopDaemons = async () => {
    clients[0].onclose();
    return { daemons: [{ pid: 11, stopped: true }, { pid: 12, retired: true, stopped: false, reason: "it is still running" }] };
  };
  await daemon.stopDaemon();
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
});

test("the link's own daemon stopped, another would not: the link's session is closed, not kept or left open", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  // The answer comes before the daemon's close of the session does: the link closes it.
  server.stopDaemons = async () => ({ daemons: [{ pid: 11, stopped: true }, { pid: 12, retired: true, stopped: false, reason: "it is still running" }] });
  await daemon.stopDaemon();
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
  assert.equal(clients[0].closed, true, "closed, not left open on the daemon");
});

test("not knowing its own daemon, the link keeps its session while one would not stop, and closes it once all did", async (t) => {
  const { server, clients } = fakeServer();
  // The first checks named no daemon.
  server.quick = { status: "ok", index: { exists: true, fresh: true, documents: 5 } };
  server.checked = { status: "ok", index: { exists: true, fresh: true, documents: 5 }, checks: [] };
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  assert.equal(daemon.state.served_by, null);
  server.stopDaemons = async () => ({ daemons: [{ pid: 11, stopped: false, reason: "No handshake within 5000 ms" }] });
  await daemon.stopDaemon();
  assert.equal(daemon.state.phase, "online");
  assert.equal(clients[0].closed, false);
  server.stopDaemons = async () => ({ daemons: [{ pid: 11, stopped: true }] });
  await daemon.stopDaemon();
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
  assert.equal(clients[0].closed, true);
});

test("two Stops at once: the session ending during the second is what was asked for", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  server.stopDaemons = async () => ({ daemons: [{ pid: 11, stopped: false, reason: "No handshake within 5000 ms" }] });
  const first = daemon.stopDaemon();
  let answer;
  server.stopDaemons = () => new Promise((resolve) => { answer = resolve; });
  const second = daemon.stopDaemon();
  await first;
  assert.equal(daemon.state.phase, "online", "the first found the daemon hung");
  // The daemon comes back and takes the second: its sessions end.
  clients[0].onclose();
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""], "not \"stopped unexpectedly\"");
  answer({ daemons: [{ pid: 11, stopped: true }] });
  await second;
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
});

test("a Stop acts on the session it began with: one a move opened meanwhile stays; no move starts while it runs", async (t) => {
  const { server, clients, opens } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  // The daemon retires and the move begins; its new session waits at the door when Stop is pressed.
  let open;
  server.openGate = new Promise((resolve) => { open = resolve; });
  server.retired = clients[0];
  await daemon.refreshStatus({ checks: true });
  await sleep(10);
  assert.equal(daemon.state.phase, "reconnecting");
  let answer;
  server.stopDaemons = () => new Promise((resolve) => { answer = resolve; });
  const stopping = daemon.stopDaemon();
  server.openGate = null;
  open();
  await sleep(20);
  answer({ daemons: [{ pid: 11, retired: true, stopped: true }] });
  await stopping;
  assert.equal(daemon.state.phase, "online", "the move's session is not the Stop's");
  assert.equal(clients[1].closed, false);
  assert.equal((await daemon.call("clients_list", {}, { id: "call-1" })).ok, true);
  // A daemon that retires while a Stop runs is not moved off: the move would start one.
  const before = opens.length;
  server.stopDaemons = () => new Promise((resolve) => { answer = resolve; });
  const again = daemon.stopDaemon();
  server.retired = clients[1];
  await daemon.refreshStatus({ checks: true });
  await sleep(20);
  assert.equal(opens.length, before, "no session opened, no daemon started");
  answer({ daemons: [{ pid: 11, stopped: true }] });
  await again;
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
});

test("a move whose next session is opened while a Stop runs starts no daemon", async (t) => {
  const { server, clients, opens } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  // The retired daemon's session takes its time to close; Stop is pressed meanwhile, and no daemon runs.
  let closed;
  const gate = new Promise((resolve) => { closed = resolve; });
  const close = clients[0].close;
  clients[0].close = async () => {
    await gate;
    return close();
  };
  server.retired = clients[0];
  server.down = true;
  await daemon.refreshStatus({ checks: true });
  let answer;
  server.stopDaemons = () => new Promise((resolve) => { answer = resolve; });
  const stopping = daemon.stopDaemon();
  closed();
  await sleep(20);
  assert.equal(opens.at(-1).start, false, "the move only looks");
  answer({ daemons: [{ pid: 11, retired: true, stopped: true }] });
  await stopping;
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
});

test("checks asked for after a change while others run: they run once more after those, which read the install before it", async (t) => {
  const { server, calls } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  const before = checksCalls(calls);
  server.held = { name: "system_status" };
  const running = daemon.refreshStatus({ checks: true });
  await sleep(10);
  // A plain second caller shares the call in flight; one after a change waits for it and asks again.
  const shared = daemon.refreshStatus({ checks: true });
  const fresh = daemon.refreshStatus({ checks: true, fresh: true });
  const alsoFresh = daemon.refreshStatus({ checks: true, fresh: true });
  assert.equal(checksCalls(calls) - before, 1);
  server.held.release();
  server.held = null;
  await Promise.all([running, shared, fresh, alsoFresh]);
  assert.equal(checksCalls(calls) - before, 2, "one more, for both fresh callers");
  // With none in flight, a fresh caller just asks.
  await daemon.refreshStatus({ checks: true, fresh: true });
  assert.equal(checksCalls(calls) - before, 3);
  // A tool that changes something, while checks run: they run again after.
  server.held = { name: "system_status" };
  const another = daemon.refreshStatus({ checks: true });
  await sleep(10);
  assert.equal((await daemon.call("clients_install", { clients: ["cursor"] }, { id: "call-2" })).ok, true);
  server.held.release();
  server.held = null;
  await another;
  await sleep(20);
  assert.equal(checksCalls(calls) - before, 5, "the change's own checks, after the ones that ran");
});

test("the move off a retired daemon starts one only when the app may start one", async (t) => {
  // Autostart off: the link only looked, and found a client's daemon.
  const looked = fakeServer();
  looked.server.down = true;
  const lookOnly = link(t, looked.server, { statusEveryMs: 60_000, retryEveryMs: 10 });
  await lookOnly.connect({ start: false });
  looked.server.down = false;
  await sleep(40);
  assert.equal(lookOnly.state.phase, "online");
  // It retires, and no daemon of the new code serves yet: the move starts none.
  looked.server.retired = looked.clients.at(-1);
  looked.server.down = true;
  await lookOnly.refreshStatus({ checks: true });
  await sleep(20);
  assert.deepEqual(looked.opens.filter((open) => open.start), [], "no daemon started");
  assert.equal(lookOnly.state.phase, "offline");
  // Autostart on (or Start pressed): the move starts one.
  const started = fakeServer();
  const may = link(t, started.server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await may.connect({ start: true });
  started.server.retired = started.clients[0];
  started.server.down = true;
  await may.refreshStatus({ checks: true });
  await sleep(20);
  assert.equal(may.state.phase, "online");
  assert.deepEqual(started.opens.map((open) => open.start), [true, true]);
});

test("a tool the daemon marks read-only asks for no checks, the console opened or not; its list is asked once a session", async (t) => {
  const { server, calls } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000, retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  const before = checksCalls(calls);
  // Reads the screens make, the console never opened: no checks, one listing (two pages).
  await Promise.all([daemon.call("list_projects", {}, { id: "call-1" }), daemon.call("list_tasks", {}, { id: "call-2" })]);
  assert.equal((await daemon.call("list_projects", {}, { id: "call-3" })).ok, true);
  await sleep(20);
  assert.equal(checksCalls(calls) - before, 0, "reads ask for no checks");
  assert.equal(server.listings, 2, "one listing of two pages for all three reads");
  // A change, by the same list: the checks run again.
  await daemon.call("clients_install", { clients: ["cursor"] }, { id: "call-4" });
  await sleep(20);
  assert.equal(checksCalls(calls) - before, 1);
  // A tool the list does not mark read-only, or no list to be had: it may have changed something.
  await daemon.call("record_decision", {}, { id: "call-5" });
  await sleep(20);
  assert.equal(checksCalls(calls) - before, 2);
  await daemon.close();
  server.failList = true;
  await daemon.connect({ start: true });
  const again = checksCalls(calls);
  await daemon.call("list_projects", {}, { id: "call-6" });
  await sleep(20);
  assert.equal(checksCalls(calls) - again, 1, "without the list, a read counts as a change");
  // The failed listing is asked again, and a new session lists anew.
  server.failList = false;
  await daemon.call("list_projects", {}, { id: "call-7" });
  await sleep(20);
  assert.equal(checksCalls(calls) - again, 1, "listed now: the read asks for none");
  assert.deepEqual((await daemon.tools()).map((tool) => tool.name), ["list_projects", "list_tasks", "clients_install"]);
});
