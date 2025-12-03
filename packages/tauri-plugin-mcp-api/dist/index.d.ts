import { Channel } from '@tauri-apps/api/core';

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
declare function initMcpBridge(): Promise<void>;
/**
 * Check if the MCP bridge is initialized
 */
declare function isBridgeInitialized(): boolean;

export { initMcpBridge, isBridgeInitialized };
