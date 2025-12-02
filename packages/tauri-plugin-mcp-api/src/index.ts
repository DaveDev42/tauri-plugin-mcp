import { invoke, Channel } from '@tauri-apps/api/core';

/**
 * Result of a JavaScript evaluation
 */
interface EvalResult {
  requestId: string;
  success: boolean;
  value?: unknown;
  error?: string;
}

/**
 * MCP Bridge state
 */
interface McpBridgeState {
  initialized: boolean;
  channel: Channel<EvalResult> | null;
}

declare global {
  interface Window {
    __MCP_BRIDGE__: McpBridgeState;
    __MCP_EVAL__: (requestId: string, script: string) => Promise<void>;
    __MCP_REF_MAP__: Map<number, Element>;
  }
}

/**
 * Initialize the MCP bridge for Tauri plugin communication.
 *
 * Call this once in your app's entry point (e.g., main.tsx):
 *
 * ```typescript
 * import { initMcpBridge } from 'tauri-plugin-mcp-api';
 * initMcpBridge();
 * ```
 */
export async function initMcpBridge(): Promise<void> {
  // Prevent double initialization
  if (window.__MCP_BRIDGE__?.initialized) {
    console.warn('[tauri-plugin-mcp] Bridge already initialized');
    return;
  }

  // Create channel for receiving eval requests from Rust
  const channel = new Channel<EvalResult>();

  // Initialize state
  window.__MCP_BRIDGE__ = {
    initialized: true,
    channel,
  };

  // Initialize ref map for accessibility tree
  window.__MCP_REF_MAP__ = new Map();

  // Set up eval function that Rust will call via invoke
  window.__MCP_EVAL__ = async (requestId: string, script: string) => {
    let result: EvalResult;

    try {
      // Execute the script
      const fn = new Function(`return (async () => { ${script} })();`);
      const value = await fn();

      result = {
        requestId,
        success: true,
        value,
      };
    } catch (e) {
      result = {
        requestId,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Send result back to Rust
    await invoke('plugin:mcp|eval_result', { result });
  };

  // Register the bridge with the Rust plugin
  await invoke('plugin:mcp|register_bridge');

  console.log('[tauri-plugin-mcp] Bridge initialized');
}

/**
 * Check if the MCP bridge is initialized
 */
export function isBridgeInitialized(): boolean {
  return window.__MCP_BRIDGE__?.initialized ?? false;
}
