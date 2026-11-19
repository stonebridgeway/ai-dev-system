/**
 * The server's tools for a CLI command, in this process: what `ai-dev
 * skills`, `ai-dev rules` and `ai-dev servers` do is what an agent's or the
 * desktop app's call does, by the same code. `ai-dev doctor` and `reindex`
 * run their tools the same way (`runtime.mjs`).
 */

/**
 * Load the runtime once and hand back a caller that answers each tool's
 * result as an object — or throws its error, message only.
 *
 * @returns {Promise<{ call: (name: string, args?: object) => Promise<any>, close: () => Promise<void> }>}
 */
export async function openTools() {
  // What 2.x left in AI_DEV_HOME/.ai-dev moves first: the tools read the
  // runtime tree.
  const { prepareRuntimeHome } = await import("../core/runtime-home-migration.mjs");
  await prepareRuntimeHome();
  const { callTool, shutdownBgeWorkers } = await import("../mcp-stdio.mjs");
  return {
    async call(name, args = {}) {
      const result = await callTool(name, args);
      const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
      if (result?.isError) throw new Error(text || `${name} failed.`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => shutdownBgeWorkers()
  };
}

/**
 * Run `work` with the tools open, and close them after, whatever happened.
 *
 * @template T
 * @param {(tools: { call: (name: string, args?: object) => Promise<any> }) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withTools(work) {
  const tools = await openTools();
  try {
    return await work(tools);
  } finally {
    await tools.close();
  }
}

/** A long text cut to `length` with "…", on one line. */
export function cut(text, length) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** The width a line may take: the terminal's, or 100 when output goes elsewhere. */
export function lineWidth(io) {
  const columns = Number(io.stdout?.columns);
  return Number.isFinite(columns) && columns >= 40 ? columns : 100;
}
