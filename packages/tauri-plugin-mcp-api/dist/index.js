// src/index.ts
import { invoke, Channel } from "@tauri-apps/api/core";
async function initMcpBridge() {
  if (window.__MCP_BRIDGE__?.initialized) {
    console.warn("[tauri-plugin-mcp] Bridge already initialized");
    return;
  }
  const channel = new Channel();
  window.__MCP_BRIDGE__ = {
    initialized: true,
    channel
  };
  window.__MCP_REF_MAP__ = /* @__PURE__ */ new Map();
  window.__MCP_EVAL__ = async (requestId, script) => {
    let result;
    try {
      const fn = new Function(`return (async () => { ${script} })();`);
      const value = await fn();
      result = {
        requestId,
        success: true,
        value
      };
    } catch (e) {
      result = {
        requestId,
        success: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
    await invoke("plugin:mcp|eval_result", { result });
  };
  await invoke("plugin:mcp|register_bridge");
  console.log("[tauri-plugin-mcp] Bridge initialized");
}
function isBridgeInitialized() {
  return window.__MCP_BRIDGE__?.initialized ?? false;
}
export {
  initMcpBridge,
  isBridgeInitialized
};
