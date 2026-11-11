/**
 * What the window says when the app cannot get going: the server is not
 * where the app looks, its packages are not
 * installed, the settings file is broken. Each with what to do, and whether
 * Try again can work in this process or the app has to start again — a
 * module that failed to load stays failed until it does.
 */

/** What the server adds to a settings file it cannot read: the hint says it. */
const SERVER_SETTINGS_ADVICE = /\s*Fix or remove it\b[^.]*\./;

/**
 * @param {unknown} error - What stopped the start.
 * @param {{ serverRoot: string, loaded: boolean, t: (key: string, params?: object) => string }} context
 *   `loaded` — whether the server's module had loaded before it.
 * @returns {{ error: string, hint: string, detail?: string, restart: boolean }}
 */
export function startupFailure(error, { serverRoot, loaded, t }) {
  const message = String(error?.message ?? error);
  if (!loaded) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package/.test(message)) {
      return { error: t("broken.noPackages", { path: serverRoot }), hint: t("broken.noPackagesHint", { path: serverRoot }), detail: message, restart: true };
    }
    // The server's entry module itself is missing — not one of the files it imports.
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find module '[^']*[\\/]control-client\.mjs'/.test(message)) {
      return { error: t("broken.noServer", { path: serverRoot }), hint: t("broken.noServerHint"), detail: message, restart: true };
    }
    return { error: t("broken.serverFailed", { path: serverRoot }), hint: t("broken.restartHint"), detail: message, restart: true };
  }
  // The hint says what to do with the file, in the app's language; the
  // server's own "Fix or remove it" is not said a second time.
  if (/config\.json/.test(message)) return { error: message.replace(SERVER_SETTINGS_ADVICE, "").trim(), hint: t("broken.settingsHint"), restart: false };
  return { error: message, hint: t("broken.tryAgainHint"), restart: false };
}
