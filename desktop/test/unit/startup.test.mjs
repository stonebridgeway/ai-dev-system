import assert from "node:assert/strict";
import test from "node:test";
import { startupFailure } from "../../src/main/startup.mjs";
import { translate } from "../../src/renderer/i18n.js";

const t = (key, params) => translate("en", key, params);
const serverRoot = "/home/me/ai-dev-system/ai-dev-mcp-server";

test("what stops the start is said with what to do, and whether Try again can work", () => {
  const noPackages = startupFailure(Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk' imported from /x/src/core/control-client.mjs"), { code: "ERR_MODULE_NOT_FOUND" }), { serverRoot, loaded: false, t });
  assert.equal(noPackages.error, `The AI Dev server in ${serverRoot} has no packages installed.`);
  assert.match(noPackages.hint, /Run npm ci in .*ai-dev-mcp-server, then restart AI Dev/);
  assert.equal(noPackages.restart, true, "a module that failed to load stays failed in this process");
  const noServer = startupFailure(Object.assign(new Error(`Cannot find module '${serverRoot}/src/core/control-client.mjs'`), { code: "ERR_MODULE_NOT_FOUND" }), { serverRoot, loaded: false, t });
  assert.match(noServer.error, /is not in/);
  assert.match(noServer.hint, /AI_DEV_SERVER_ROOT/);
  // One of the server's own files missing is a server that did not load, not one that is not there.
  const missingFile = startupFailure(Object.assign(new Error(`Cannot find module '${serverRoot}/src/core/log-tail.mjs' imported from ${serverRoot}/src/core/control-client.mjs`), { code: "ERR_MODULE_NOT_FOUND" }), { serverRoot, loaded: false, t });
  assert.equal(missingFile.error, `The AI Dev server in ${serverRoot} did not load.`);
  assert.equal(missingFile.restart, true);
  const settings = startupFailure(new Error("/home/me/.ai-dev/config.json is not JSON. Fix or remove it; the settings are not read until then."), { serverRoot, loaded: true, t });
  assert.deepEqual([settings.restart, settings.error], [false, "/home/me/.ai-dev/config.json is not JSON."], "the server's advice is not said twice");
  assert.equal(settings.hint, "Fix the file or remove it — without it the defaults are used — then press Try again.");
  // Every other settings failure gets the same advice, in the app's language.
  const notObject = startupFailure(new Error("/home/me/.ai-dev/config.json does not hold a settings object."), { serverRoot, loaded: true, t: (key, params) => translate("ru", key, params) });
  assert.equal(notObject.error, "/home/me/.ai-dev/config.json does not hold a settings object.");
  assert.match(notObject.hint, /^Исправьте файл или удалите его/);
  // A folder in its place: the server names the file there too.
  const folder = startupFailure(new Error("/home/me/.ai-dev/config.json cannot be read: EISDIR: illegal operation on a directory, read"), { serverRoot, loaded: true, t });
  assert.equal(folder.hint, "Fix the file or remove it — without it the defaults are used — then press Try again.");
  assert.equal(startupFailure(new Error("odd"), { serverRoot, loaded: true, t }).restart, false);
  assert.equal(startupFailure(new SyntaxError("Unexpected token"), { serverRoot, loaded: false, t }).restart, true);
});
