import { invoke, Channel } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

// Original function references (preserved across HMR reloads)
let originalConsole: Record<string, (...args: unknown[]) => void> | null = null;
let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

// Vite HMR types (only available in dev mode)
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

  // Get and store window label for multi-window support
  try {
    const currentWindow = getCurrentWebviewWindow();
    window.__MCP_WINDOW_LABEL__ = currentWindow.label;
  } catch {
    // Fallback if webviewWindow API is not available
    window.__MCP_WINDOW_LABEL__ = 'main';
  }

  // Initialize log storage (preserve existing logs across HMR reloads)
  window.__MCP_CONSOLE_LOGS__ = window.__MCP_CONSOLE_LOGS__ || [];
  window.__MCP_NETWORK_LOGS__ = window.__MCP_NETWORK_LOGS__ || [];
  window.__MCP_BUILD_LOGS__ = window.__MCP_BUILD_LOGS__ || [];
  window.__MCP_HMR_STATUS__ = window.__MCP_HMR_STATUS__ || 'unknown';
  window.__MCP_HMR_LAST_SUCCESS__ = window.__MCP_HMR_LAST_SUCCESS__ || null;

  // Set up console log capture
  setupConsoleCapture();

  // Set up network log capture
  setupNetworkCapture();

  // Set up Vite HMR monitoring
  setupViteHMRMonitoring();

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

  // Register HMR cleanup handler
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      cleanupMcpBridge();
      window.__MCP_BRIDGE__.initialized = false;
    });
  }

  console.log('[tauri-plugin-mcp] Bridge initialized');
}

const MAX_LOG_ENTRIES = 1000;

/**
 * Clean up MCP bridge overrides (restore original functions)
 * Called before HMR module replacement
 */
function cleanupMcpBridge(): void {
  // Restore console methods
  if (originalConsole) {
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    for (const level of levels) {
      if (originalConsole[level]) {
        console[level] = originalConsole[level] as typeof console.log;
      }
    }
  }

  // Restore fetch
  if (originalFetch) {
    window.fetch = originalFetch;
  }

  // Restore XMLHttpRequest
  if (originalXhrOpen) {
    XMLHttpRequest.prototype.open = originalXhrOpen;
  }
  if (originalXhrSend) {
    XMLHttpRequest.prototype.send = originalXhrSend;
  }

  console.log('[tauri-plugin-mcp] Bridge cleaned up for HMR');
}

/**
 * Set up console.log/warn/error/info/debug capture
 */
function setupConsoleCapture(): void {
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;

  // Store original functions only once (first initialization)
  if (!originalConsole) {
    originalConsole = {};
    for (const level of levels) {
      originalConsole[level] = console[level].bind(console);
    }
  }

  for (const level of levels) {
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

      // Call original (always use the preserved original)
      originalConsole![level](...args);
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
  // Store original functions only once (first initialization)
  if (!originalFetch) {
    originalFetch = window.fetch.bind(window);
  }
  if (!originalXhrOpen) {
    originalXhrOpen = XMLHttpRequest.prototype.open;
  }
  if (!originalXhrSend) {
    originalXhrSend = XMLHttpRequest.prototype.send;
  }

  // Capture fetch
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method || 'GET';
    const startTime = Date.now();

    try {
      const response = await originalFetch!(input, init);

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
  const xhrOpenRef = originalXhrOpen!;
  const xhrSendRef = originalXhrSend!;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    (this as XMLHttpRequest & { __mcp_method: string; __mcp_url: string }).__mcp_method = method;
    (this as XMLHttpRequest & { __mcp_url: string }).__mcp_url = typeof url === 'string' ? url : url.href;
    return xhrOpenRef.call(this, method, url, async ?? true, username, password);
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

    return xhrSendRef.call(this, body);
  };
}

/**
 * Check if the MCP bridge is initialized
 */
export function isBridgeInitialized(): boolean {
  return window.__MCP_BRIDGE__?.initialized ?? false;
}

/**
 * Set up Vite HMR monitoring to capture build errors and connection status
 */
function setupViteHMRMonitoring(): void {
  // Check if we're in Vite dev mode with HMR support
  if (typeof import.meta === 'undefined' || !import.meta.hot) {
    console.log('[tauri-plugin-mcp] Vite HMR not available (production mode or non-Vite build)');
    return;
  }

  const hot = import.meta.hot;

  // Track WebSocket connection status
  hot.on('vite:ws:connect', () => {
    window.__MCP_HMR_STATUS__ = 'connected';
    console.log('[tauri-plugin-mcp] HMR WebSocket connected');
  });

  hot.on('vite:ws:disconnect', () => {
    window.__MCP_HMR_STATUS__ = 'disconnected';
    console.log('[tauri-plugin-mcp] HMR WebSocket disconnected');
  });

  // Track successful HMR updates
  hot.on('vite:afterUpdate', () => {
    window.__MCP_HMR_LAST_SUCCESS__ = Date.now();
    // Clear build errors on successful update
    window.__MCP_BUILD_LOGS__ = window.__MCP_BUILD_LOGS__.filter(
      (log) => log.level !== 'error'
    );
  });

  // Capture build errors
  hot.on('vite:error', (data: unknown) => {
    const event = data as { err?: { message?: string; loc?: { file?: string; line?: number; column?: number } } };
    const err = event.err || {};
    window.__MCP_BUILD_LOGS__.push({
      source: 'vite',
      level: 'error',
      message: err.message || 'Unknown Vite error',
      file: err.loc?.file,
      line: err.loc?.line,
      column: err.loc?.column,
      timestamp: Date.now(),
    });

    // Keep only last N entries
    if (window.__MCP_BUILD_LOGS__.length > MAX_LOG_ENTRIES) {
      window.__MCP_BUILD_LOGS__.shift();
    }

    console.error('[tauri-plugin-mcp] Vite build error captured:', err.message);
  });

  // Mark as connected initially if HMR is available
  window.__MCP_HMR_STATUS__ = 'connected';
  console.log('[tauri-plugin-mcp] Vite HMR monitoring initialized');
}
