import assert from "node:assert/strict";
import test from "node:test";
import { createSessionEnd } from "./session-end.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("a session ends when its input has and nothing it asked for is still running", async () => {
  let ends = 0;
  const session = createSessionEnd(() => { ends += 1; });
  let finish;
  const call = session.track(() => new Promise((resolve) => { finish = resolve; }));
  session.inputEnded();
  await turn();
  assert.equal(ends, 0, "ended while a call was running");
  finish("answer");
  assert.equal(await call, "answer", "the call's answer is not cut short");
  await turn();
  assert.equal(ends, 1);
});

test("calls before the end do not end a session; a call that starts in the same turn as the end is waited for", async () => {
  let ends = 0;
  const session = createSessionEnd(() => { ends += 1; });
  await session.track(async () => "first");
  await turn();
  assert.equal(ends, 0, "the input has not ended");
  session.inputEnded();
  let finish;
  const late = session.track(() => new Promise((resolve) => { finish = resolve; }));
  await turn();
  assert.equal(ends, 0, "a call read before the end started after it, and was not waited for");
  finish();
  await late;
  await turn();
  assert.equal(ends, 1);
});

test("a call that fails still lets the session end", async () => {
  let ends = 0;
  const session = createSessionEnd(() => { ends += 1; });
  session.inputEnded();
  await assert.rejects(session.track(async () => { throw new Error("no"); }), /no/);
  await turn();
  assert.ok(ends >= 1);
});
