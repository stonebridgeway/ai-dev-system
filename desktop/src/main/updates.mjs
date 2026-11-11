/**
 * Updates of the installed app: electron-updater, from
 * the GitHub Releases of the production repository, `stonebridgeway/ai-dev-system`
 * — the feed the build writes into `resources/app-update.yml`. A signed build
 * has its downloads checked against the signature of the app that runs; an
 * unsigned one against the sha512 the release lists.
 *
 * The app's Chromium resolves no host name (`host-resolver-rules`): its
 * page has no network. The updater's requests go through Chromium too, so the
 * rule makes an exception for the update hosts — by their exact names, never
 * a wildcard a page could put a word of its own into — and the updater's own
 * session lets nothing else through.
 */

/** The hosts an update comes from: the release feed and its downloads, and where GitHub redirects them. */
export const UPDATE_HOSTS = Object.freeze(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

/** The session electron-updater makes its requests in (its `NET_SESSION_NAME`). */
export const UPDATER_PARTITION = "electron-updater";

/** A minute after the start, then every six hours. */
export const UPDATE_TIMING = Object.freeze({ firstCheckMs: 60_000, everyMs: 6 * 60 * 60_000 });

/**
 * Whether this app looks for updates, unless `AI_DEV_DESKTOP_UPDATES=0`: the
 * installed app on Windows, and the AppImage on Linux (`APPIMAGE` names the
 * file it runs from, which the update replaces). A `.deb` is updated by the
 * package manager that installed it; a Mac app updates itself only when it is
 * signed with a Developer ID — the signed build says so in its package.json
 * (`aiDevSigned`) — and is otherwise replaced from the release's `.dmg`. A
 * checkout updates with git.
 *
 * @param {{ packaged: boolean, platform: string, env: NodeJS.ProcessEnv, signed?: boolean }} where
 */
export function updatesEnabled({ packaged, platform, env, signed = false }) {
  if (packaged !== true || env.AI_DEV_DESKTOP_UPDATES === "0") return false;
  if (platform === "win32") return true;
  if (platform === "linux") return Boolean(String(env.APPIMAGE ?? "").trim());
  return platform === "darwin" && signed === true;
}

/**
 * Chromium's resolver rule: every name resolves to nothing — with updates on,
 * except the update hosts.
 *
 * @param {{ updates: boolean }} options
 * @returns {string}
 */
export function resolverRules({ updates }) {
  return ["MAP * ~NOTFOUND", ...(updates ? UPDATE_HOSTS.map((host) => `EXCLUDE ${host}`) : [])].join(", ");
}

/** Whether the updater's session lets a request go: HTTPS to an update host on its default port, nothing else. */
export function updaterRequestAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && UPDATE_HOSTS.includes(parsed.hostname) && !parsed.port && !parsed.username && !parsed.password;
}

/**
 * Close the updater's session to everything but the update hosts.
 *
 * @param {import("electron").Session} session
 */
export function lockUpdaterSession(session) {
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !updaterRequestAllowed(details.url) }));
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

/**
 * Look for updates: a minute after the start, then every six hours. A
 * downloaded update is offered in the tray, and installed at Quit if the
 * person does not restart for it sooner.
 *
 * @param {{ updater: import("electron-updater").AppUpdater, tray: { setUpdate: (update: { version: string } | null) => void }, log?: (line: string) => void, timing?: typeof UPDATE_TIMING }} options
 * @returns {{ check: () => Promise<void>, stop: () => void }}
 */
export function startUpdates({ updater, tray, log = (line) => console.error(line), timing = UPDATE_TIMING }) {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = { info: () => undefined, warn: (line) => log(`update: ${line}`), error: (line) => log(`update: ${line}`), debug: () => undefined };
  updater.on("update-downloaded", (info) => tray.setUpdate({ version: String(info?.version ?? "") }));
  updater.on("error", (error) => log(`update: ${String(error?.message ?? error)}`));
  const check = async () => {
    try {
      await updater.checkForUpdates();
    } catch (error) {
      log(`update: ${String(error?.message ?? error)}`);
    }
  };
  const first = setTimeout(check, timing.firstCheckMs);
  const every = setInterval(check, timing.everyMs);
  first.unref?.();
  every.unref?.();
  return {
    check,
    stop() {
      clearTimeout(first);
      clearInterval(every);
    }
  };
}
