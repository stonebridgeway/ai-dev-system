/**
 * The runtime the installed app ships (docs/DESKTOP.md, "The desktop
 * install"): the server with its dependencies and a Node of its own, in the
 * app's `resources/runtime` — on Windows, macOS and Linux alike. The app does not run it there — a client
 * holding a file of it would stop the next update — but copies it into the
 * app home and points the stable link AI clients run at the copy
 * (`ai-dev-mcp-server/src/core/app-bundle.mjs`). It does so at every start: a
 * runtime already copied is found, not copied again, and what it lost since
 * is put back.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The systems the app is built for with a runtime of its own (`desktop/scripts/runtime-bundle.mjs`, `TARGETS`). */
export const BUNDLED_PLATFORMS = Object.freeze(["win32", "darwin", "linux"]);

/**
 * Where the installer put the runtime: `resources/runtime` of the packaged
 * app — inside the AppImage's mount on Linux, the app bundle's `Resources` on
 * macOS; `AI_DEV_DESKTOP_BUNDLE` names one for the end-to-end tests. Null
 * everywhere else: a checkout runs the server beside it.
 *
 * @param {{ env: NodeJS.ProcessEnv, packaged: boolean, platform: string, resourcesPath?: string }} where
 * @returns {string | null}
 */
export function shippedRuntime({ env, packaged, platform, resourcesPath }) {
  if (env.AI_DEV_DESKTOP_BUNDLE) return path.resolve(env.AI_DEV_DESKTOP_BUNDLE);
  return packaged && BUNDLED_PLATFORMS.includes(platform) && resourcesPath ? path.join(resourcesPath, "runtime") : null;
}

/**
 * Copy the shipped runtime into the app home, once per runtime, and make it
 * the one AI clients run. The code that does it is the runtime's own: the
 * app holds no second copy of it.
 *
 * @param {{ bundleRoot: string, env: NodeJS.ProcessEnv, onProgress?: (progress: { progress: number, total: number }) => void }} options
 * @returns {Promise<{ status: string, version: string, folder: string, serverRoot: string, node: string, cli: string, linkError?: string, repaired: string[] }>}
 */
export async function prepareRuntime({ bundleRoot, env, onProgress }) {
  const load = (name) => import(pathToFileURL(path.join(bundleRoot, "ai-dev-mcp-server", "src", "core", name)).href);
  const [{ provisionBundle }, { resolveRuntimeStateRoot }] = await Promise.all([load("app-bundle.mjs"), load("runtime-home.mjs")]);
  // The clients' configs are read in the app's environment: a copy one of them names is kept.
  return provisionBundle({ bundleRoot, runtimeRoot: resolveRuntimeStateRoot("", env), env, onProgress });
}

/**
 * What the Status screen says of the runtime, when there is something to
 * say: it runs from its copy because the drive holds no link — after an
 * update the clients must be connected again — or files of it went
 * missing and were put back, which an antivirus taking them away at every
 * start would show. Null otherwise.
 *
 * @param {{ folder: string, linkError?: string, repaired?: string[] } | null} runtime
 * @returns {{ folder: string, linkError: string, repaired: string[] } | null}
 */
export function runtimeNotice(runtime) {
  if (!runtime || (!runtime.linkError && !runtime.repaired?.length)) return null;
  return { folder: runtime.folder, linkError: runtime.linkError ?? "", repaired: runtime.repaired ?? [] };
}
