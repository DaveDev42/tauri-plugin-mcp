import { Channel } from '@tauri-apps/api/core';
interface ViteHot {
    on(event: string, callback: (data: unknown) => void): void;
    off?(event: string, callback: (data: unknown) => void): void;
    dispose(callback: () => void): void;
}
declare global {
    interface ImportMeta {
        hot?: ViteHot;
    }
}
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
 * Console log entry
 */
interface ConsoleLogEntry {
    level: 'log' | 'info' | 'warn' | 'error' | 'debug';
    args: unknown[];
    timestamp: number;
}
/**
 * Network log entry
 */
interface NetworkLogEntry {
    type: 'fetch' | 'xhr';
    method: string;
    url: string;
    status?: number;
    statusText?: string;
    duration?: number;
    error?: string;
    timestamp: number;
}
/**
 * Build log entry (Vite/TypeScript errors)
 */
interface BuildLogEntry {
    source: 'vite' | 'typescript' | 'hmr';
    level: 'info' | 'warning' | 'error';
    message: string;
    file?: string;
    line?: number;
    column?: number;
    timestamp: number;
}
/**
 * HMR update entry - records why app was hot-reloaded
 */
interface HmrUpdateEntry {
    type: 'hmr-update' | 'full-reload';
    files: string[];
    timestamp: number;
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
        __MCP_WINDOW_LABEL__: string;
        __MCP_CONSOLE_LOGS__: ConsoleLogEntry[];
        __MCP_NETWORK_LOGS__: NetworkLogEntry[];
        __MCP_BUILD_LOGS__: BuildLogEntry[];
        __MCP_HMR_UPDATES__: HmrUpdateEntry[];
        __MCP_HMR_STATUS__: 'connected' | 'disconnected' | 'unknown';
        __MCP_HMR_LAST_SUCCESS__: number | null;
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
export declare function initMcpBridge(): Promise<void>;
/**
 * Check if the MCP bridge is initialized
 */
export declare function isBridgeInitialized(): boolean;
export {};
//# sourceMappingURL=index.d.ts.map