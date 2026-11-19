// The page's side of `window.aiDev` (src/preload/preload.cjs): tool calls
// with an id, their progress, and their cancel.

const api = window.aiDev;
const listeners = new Map();
let counter = 0;

api.onProgress((event) => listeners.get(event?.id)?.(event));

/**
 * Call one of the interface's tools. Resolves with the tool's answer
 * (`structuredContent.result`); rejects with an Error whose `cancelled` is
 * true when the call was cancelled.
 *
 * @param {string} tool
 * @param {object} [args]
 * @param {{ onProgress?: (event: { progress: number, total?: number, message?: string }) => void, onStart?: (id: string) => void }} [options]
 */
export function call(tool, args = {}, options = {}) {
  return invoke(api.call, tool, args, options);
}

/**
 * Run a tool from the tool console. As `call`, and a tool that changes
 * something runs only after the person confirms it: when they do not, the
 * Error's `notConfirmed` is true.
 */
export function consoleCall(tool, args = {}, options = {}) {
  return invoke(api.consoleCall, tool, args, options);
}

async function invoke(channel, tool, args, { onProgress, onStart } = {}) {
  counter += 1;
  const id = `call-${Date.now().toString(36)}-${counter}`;
  if (onProgress) listeners.set(id, onProgress);
  onStart?.(id);
  try {
    const answer = await channel(tool, args, id);
    if (answer?.ok) return answer.result;
    const error = new Error(answer?.error ?? "No answer.");
    error.cancelled = Boolean(answer?.cancelled);
    error.notConfirmed = answer?.confirmed === false;
    // The link's own words come with their key: said again in the language in force.
    error.key = answer?.key ?? null;
    throw error;
  } finally {
    listeners.delete(id);
  }
}

/** What a failed call says, in the language `t` speaks: the link's own words by their key. */
export function failureText(error, t) {
  return error?.key ? t(error.key) : String(error?.message ?? error);
}

/** Cancel a call `call` started; `onStart` gave its id. */
export function cancel(id) {
  return api.cancel(id);
}

export const tools = () => api.tools();
export const reconnect = () => api.reconnect();
export const state = () => api.state();
export const connect = (start) => api.connect(start);
export const retry = () => api.retry();
export const chooseFolder = (purpose) => api.chooseFolder(purpose);
export const setLanguage = (language) => api.setLanguage(language);
export const onState = (callback) => api.onState(callback);
