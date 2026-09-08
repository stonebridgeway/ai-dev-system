export function createToolRouter({ handlers, resolveCoreCall, textContent }) {
  async function callTool(name, args = {}) {
    const coreCall = resolveCoreCall(name, args);
    if (coreCall) return callTool(coreCall.name, coreCall.args);
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const result = await handler(args);
    return result?.content ? result : textContent(result);
  }

  return { callTool };
}
