import assert from "node:assert/strict";
import test from "node:test";
import { clientServerConfig } from "./install-client.mjs";

test("standalone client configuration starts the serve bridge", () => {
  const config = clientServerConfig("codex");
  assert.equal(config.command, process.execPath);
  assert.equal(config.args.at(-1), "serve");
  assert.deepEqual(config.env, {});
  assert.equal(clientServerConfig("vscode").type, "stdio");
});
