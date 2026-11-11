import assert from "node:assert/strict";
import test from "node:test";
import { translate } from "../../src/renderer/i18n.js";
import { clientChoice, clientResult, modelUnreadable, stepReason, stepTitle, unreadableCode } from "../../src/renderer/setup-words.js";

const view = (language = "en") => ({ t: (key, params) => translate(language, key, params) });

test("a client's row says what its ai-dev entry runs; another program's entry is not chosen for the person", () => {
  const row = (fields) => clientChoice(view(), { found: true, connected: false, entry: "none", ...fields });
  assert.deepEqual(row({}), { note: "installed", checked: true, disabled: false });
  assert.equal(row({ entry: "2.x" }).checked, true, "the 2.x entry is the same server under its old name");
  for (const entry of ["local", "docker", "other", "invalid"]) {
    const choice = row({ entry });
    assert.equal(choice.checked, false, entry);
    assert.match(choice.note, /replaces/, entry);
  }
  const broken = row({ entry: "unreadable", error: "line 1, column 19: expected a \"quoted\" member name" });
  assert.deepEqual([broken.checked, broken.disabled], [false, true]);
  assert.match(broken.note, /cannot be read: line 1, column 19/);
  assert.deepEqual(row({ connected: true, entry: "this install" }), { note: "already connected", checked: false, disabled: false });
  assert.deepEqual(clientChoice(view(), { found: false, entry: "none" }), { note: "not found on this computer", checked: false, disabled: true });
  assert.match(clientChoice(view("ru"), { found: true, connected: false, entry: "docker" }).note, /Docker/);
});

test("after Connect, each client's line with the daemon's reason", () => {
  assert.deepEqual(clientResult(view(), { client: "cursor", status: "failed", error: "line 1, column 19" }), { text: "cursor: failed", why: "line 1, column 19" });
  assert.deepEqual(clientResult(view("ru"), { client: "cursor", label: "Cursor", status: "added" }), { text: "Cursor: подключён", why: "" });
  assert.equal(clientResult(view(), { client: "x", label: "X", status: "would-add" }).text, "X: would-add", "a status without words stays as it is");
});

test("a step's title and reason in the page's words; a failed step shows its error", () => {
  const step = (fields) => ({ id: "search_index", title: "Search index", status: "done", ...fields });
  assert.equal(stepTitle(view("ru"), step({})), "Поисковый индекс");
  assert.equal(stepTitle(view("en"), step({ id: "a_new_step", title: "A new step" })), "A new step");
  assert.equal(stepReason(view(), step({ status: "failed", reason: "missing", error: "EEXIST: file already exists" })), "EEXIST: file already exists");
  assert.equal(stepReason(view(), step({ status: "skipped", reason: "already built; --force rebuilds it" })), "already built");
  assert.equal(stepReason(view(), step({ id: "frontend_qa", status: "skipped", reason: "not installed — pass --frontend-qa to install it" })), "optional, not set up");
  assert.equal(stepReason(view("ru"), step({ id: "dense_model", status: "skipped", reason: "not installed — pass --model to install it" })), "пропущена на шаге модели");
  assert.equal(stepReason(view(), step({ reason: "614 skill(s) indexed" })), "614 skill(s) indexed", "what the step itself said stays as it is");
  for (const reason of ["already built; --force rebuilds it", "not installed — pass --frontend-qa to install it", "out of date; --model rebuilds it"]) {
    assert.doesNotMatch(stepReason(view(), step({ id: "frontend_qa", status: "skipped", reason })), /--/, reason);
  }
});

test("a model that cannot be read is said to be so, with what to do by why — not \"not installed\"", () => {
  const said = [];
  const view = { t: (key, params = {}) => { said.push(key); return `${key}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`; } };
  assert.equal(unreadableCode("ENOTDIR: not a directory, lstat '/m/models.zip/bge-m3-onnx/config.json'"), "ENOTDIR");
  assert.equal(unreadableCode("EACCES: permission denied, open '/m/x'"), "EACCES");
  assert.equal(unreadableCode("something else"), "");
  for (const [reason, advice] of [
    ["EACCES: permission denied, open '/m/x'", "access"],
    ["EPERM: operation not permitted, open '/m/x'", "permission"],
    ["ENOTDIR: not a directory, lstat '/m/x'", "notDirectory"],
    ["ELOOP: too many symbolic links encountered, stat '/m/x'", "loop"],
    ["ESTALE: stale file handle, open '/m/x'", "share"],
    ["EIO: i/o error, read", "share"],
    ["EBUSY: resource busy", "other"]
  ]) {
    said.length = 0;
    const words = modelUnreadable(view, { dir: "/m", unreadable: reason });
    assert.ok(said.includes(`wizard.model.unreadable.${advice}`), `${reason}: ${said.join(", ")}`);
    assert.match(words.status, new RegExp(`^status\\.model\\.unreadable \\{"code":"${unreadableCode(reason)}"\\}$`));
    assert.match(words.wizard, /"dir":"\/m"/);
  }
  assert.match(modelUnreadable(view, { dir: "/m", unreadable: "no code here" }).status, /"code":"no code here"/, "a reason with no code is shown whole");
});

test("EPERM's advice itself sends a macOS user to Privacy & Security, in both languages; EACCES's does not", () => {
  // The words, not only the key: an EPERM advice that read like EACCES's passed every test before.
  const model = (code) => ({ dir: "/Users/me/Documents/models", unreadable: `${code}: operation not permitted, open '/Users/me/Documents/models/bge-m3-onnx/config.json'` });
  const en = modelUnreadable(view("en"), model("EPERM")).wizard;
  assert.match(en, /System Settings → Privacy & Security/);
  assert.match(en, /readable to your user account/);
  const ru = modelUnreadable(view("ru"), model("EPERM")).wizard;
  assert.match(ru, /«Системные настройки → Конфиденциальность и безопасность»/);
  assert.match(ru, /право читать папку/);
  assert.doesNotMatch(modelUnreadable(view("en"), model("EACCES")).wizard, /Privacy & Security/);
  assert.doesNotMatch(modelUnreadable(view("ru"), model("EACCES")).wizard, /Конфиденциальность и безопасность/);
});
