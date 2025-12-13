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
    __MCP_CONSOLE_LOGS__: ConsoleLogEntry[];
    __MCP_NETWORK_LOGS__: NetworkLogEntry[];
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

  // Initialize log storage
  window.__MCP_CONSOLE_LOGS__ = [];
  window.__MCP_NETWORK_LOGS__ = [];

  // Set up console log capture
  setupConsoleCapture();

  // Set up network log capture
  setupNetworkCapture();

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

const MAX_LOG_ENTRIES = 1000;

/**
 * Set up console.log/warn/error/info/debug capture
 */
function setupConsoleCapture(): void {
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;

  for (const level of levels) {
    const original = console[level].bind(console);

    console[level] = (...args: unknown[]) => {
      // Store the log entry
      window.__MCP_CONSOLE_LOGS__.push({
        level,
        args: args.map(serializeArg),
        timestamp: Date.now(),
      });

      // Keep only last N entries
      if (window.__MCP_CONSOLE_LOGS__.length > MAX_LOG_ENTRIES) {
        window.__MCP_CONSOLE_LOGS__.shift();
      }

      // Call original
      original(...args);
    };
  }
}

/**
 * Serialize console argument for storage
 */
function serializeArg(arg: unknown): unknown {
  if (arg === null || arg === undefined) {
    return arg;
  }

  if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
    return arg;
  }

  if (arg instanceof Error) {
    return {
      __type: 'Error',
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    };
  }

  if (arg instanceof HTMLElement) {
    return {
      __type: 'HTMLElement',
      tagName: arg.tagName,
      id: arg.id || undefined,
      className: arg.className || undefined,
    };
  }

  try {
    // Try to serialize as JSON
    return JSON.parse(JSON.stringify(arg));
  } catch {
    // Fallback to string representation
    return String(arg);
  }
}

/**
 * Set up fetch and XMLHttpRequest capture
 */
function setupNetworkCapture(): void {
  // Capture fetch
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method || 'GET';
    const startTime = Date.now();

    try {
      const response = await originalFetch(input, init);

      window.__MCP_NETWORK_LOGS__.push({
        type: 'fetch',
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime,
      });

      // Keep only last N entries
      if (window.__MCP_NETWORK_LOGS__.length > MAX_LOG_ENTRIES) {
        window.__MCP_NETWORK_LOGS__.shift();
      }

      return response;
    } catch (error) {
      window.__MCP_NETWORK_LOGS__.push({
        type: 'fetch',
        method,
        url,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        timestamp: startTime,
      });

      if (window.__MCP_NETWORK_LOGS__.length > MAX_LOG_ENTRIES) {
        window.__MCP_NETWORK_LOGS__.shift();
      }

      throw error;
    }
  };

  // Capture XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    (this as XMLHttpRequest & { __mcp_method: string; __mcp_url: string }).__mcp_method = method;
    (this as XMLHttpRequest & { __mcp_url: string }).__mcp_url = typeof url === 'string' ? url : url.href;
    return originalXhrOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { __mcp_method: string; __mcp_url: string };
    const startTime = Date.now();

    const handleEnd = () => {
      window.__MCP_NETWORK_LOGS__.push({
        type: 'xhr',
        method: xhr.__mcp_method || 'GET',
        url: xhr.__mcp_url || '',
        status: xhr.status,
        statusText: xhr.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime,
      });

      if (window.__MCP_NETWORK_LOGS__.length > MAX_LOG_ENTRIES) {
        window.__MCP_NETWORK_LOGS__.shift();
      }
    };

    const handleError = () => {
      window.__MCP_NETWORK_LOGS__.push({
        type: 'xhr',
        method: xhr.__mcp_method || 'GET',
        url: xhr.__mcp_url || '',
        error: 'Network error',
        duration: Date.now() - startTime,
        timestamp: startTime,
      });

      if (window.__MCP_NETWORK_LOGS__.length > MAX_LOG_ENTRIES) {
        window.__MCP_NETWORK_LOGS__.shift();
      }
    };

    this.addEventListener('load', handleEnd);
    this.addEventListener('error', handleError);

    return originalXhrSend.call(this, body);
  };
}

/**
 * Check if the MCP bridge is initialized
 */
export function isBridgeInitialized(): boolean {
  return window.__MCP_BRIDGE__?.initialized ?? false;
}
