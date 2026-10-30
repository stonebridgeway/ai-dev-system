import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN, CONTENT_SECURITY_POLICY, appFileFor, appFileHandler, isAppUrl, windowPreferences } from "../../src/main/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const renderer = path.join(root, "src", "renderer");

test("an app:// address names a file in the renderer folder, and nothing outside it", () => {
  assert.deepEqual(appFileFor(renderer, `${APP_ORIGIN}/index.html`), { file: path.join(renderer, "index.html"), type: "text/html; charset=utf-8" });
  assert.equal(appFileFor(renderer, `${APP_ORIGIN}/`).file, path.join(renderer, "index.html"));
  assert.equal(appFileFor(renderer, `${APP_ORIGIN}/app.js?x=1#y`).file, path.join(renderer, "app.js"));
  // Dot segments: the URL parser drops them at the root, as the browser does —
  // what is left still names a file in the folder, or nothing.
  for (const url of [`${APP_ORIGIN}/../main/main.mjs`, `${APP_ORIGIN}/%2e%2e/main/main.mjs`, `${APP_ORIGIN}/a/../../../main/main.mjs`]) {
    const target = appFileFor(renderer, url);
    assert.ok(target === null || target.file.startsWith(renderer + path.sep), `${url} -> ${target?.file}`);
  }
  for (const url of [
    `${APP_ORIGIN}/..%2fmain%2fmain.mjs`,
    `${APP_ORIGIN}/..%5cmain%5cmain.mjs`,
    `${APP_ORIGIN}/app.js%00.png`,
    `${APP_ORIGIN}/%E0%A4%A`,
    "app://elsewhere/index.html",
    "file:///etc/passwd",
    "https://ai-dev/index.html",
    `${APP_ORIGIN}/secrets.txt`,
    "not a url"
  ]) assert.equal(appFileFor(renderer, url), null, url);
  assert.equal(isAppUrl(`${APP_ORIGIN}/index.html`), true);
  for (const url of ["app://other/index.html", "https://example.com/", "file:///index.html", "", "javascript:alert(1)"]) assert.equal(isAppUrl(url), false, url);
});

test("the policy allows the page's own files and nothing else: no inline script, no eval, no network", () => {
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-|https?:|\*/);
  for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assert.ok(CONTENT_SECURITY_POLICY.includes(directive), directive);
  }
  const preferences = windowPreferences("/x/preload.cjs");
  assert.deepEqual(
    [preferences.contextIsolation, preferences.sandbox, preferences.nodeIntegration, preferences.nodeIntegrationInWorker, preferences.nodeIntegrationInSubFrames, preferences.webSecurity, preferences.webviewTag, preferences.allowRunningInsecureContent],
    [true, true, false, false, false, true, false, false]
  );
});

test("the page's own meta policy is the same, less what a meta element cannot say", async () => {
  const html = await fs.readFile(path.join(renderer, "index.html"), "utf8");
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.equal(meta, CONTENT_SECURITY_POLICY.replace("; frame-ancestors 'none'", ""));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  assert.doesNotMatch(html, /\son\w+=/, "no inline event handler");
  assert.doesNotMatch(html, /\sstyle=/, "no inline style");
  for (const [, source] of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) assert.doesNotMatch(source, /^(https?:|\/\/|file:)/, source);
});

test("files are served with the policy; a link out of the folder, another method and a missing file get 404", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-serve-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const page = path.join(folder, "page");
  await fs.mkdir(page);
  await fs.writeFile(path.join(page, "index.html"), "<p>hi</p>");
  await fs.writeFile(path.join(folder, "secret.js"), "secret");
  const serve = appFileHandler(page);
  const ok = await serve(new Request(`${APP_ORIGIN}/index.html`));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await ok.text(), "<p>hi</p>");
  assert.equal((await serve(new Request(`${APP_ORIGIN}/missing.js`))).status, 404);
  assert.equal((await serve(new Request(`${APP_ORIGIN}/index.html`, { method: "POST", body: "x" }))).status, 404);
  try {
    await fs.symlink(path.join(folder, "secret.js"), path.join(page, "linked.js"));
  } catch (error) {
    if (process.platform === "win32") return t.skip(`no symbolic links here: ${error.code}`);
    throw error;
  }
  assert.equal((await serve(new Request(`${APP_ORIGIN}/linked.js`))).status, 404, "a link out of the folder is not followed");
  return undefined;
});
