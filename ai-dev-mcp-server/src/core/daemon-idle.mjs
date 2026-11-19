/**
 * How long a daemon nobody talks to stays: the daemon reads it when it starts,
 * the settings show it as the value in force — one reading for both.
 */
import process from "node:process";

/**
 * A daemon nobody is talking to should not outlive the day. Thirty minutes is
 * long enough that a client reconnecting between tasks finds a warm process,
 * short enough that a forgotten one goes away on its own.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The longest delay a Node timer holds, about 24.8 days. A longer one fires at
 * once: a daemon told to wait thirty days left as soon as it started.
 */
export const MAX_IDLE_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * `AI_DEV_IDLE_TIMEOUT_MS`, or the default; 0 keeps the daemon until it is
 * stopped, and a value past what a timer holds is cut to {@link MAX_IDLE_TIMEOUT_MS}.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function idleTimeoutMs(env = process.env) {
  const raw = String(env.AI_DEV_IDLE_TIMEOUT_MS ?? "").trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(Math.max(0, value), MAX_IDLE_TIMEOUT_MS);
}
