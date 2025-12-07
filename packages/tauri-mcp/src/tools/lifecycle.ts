import { z } from 'zod';
import { TauriManager } from '../managers/tauri.js';
import { SocketManager } from '../managers/socket.js';

// Tool schemas
export const toolSchemas = {
  app_status: {
    name: 'app_status',
    description: 'Check if the Tauri app is running',
    inputSchema: z.object({}),
  },
  launch_app: {
    name: 'launch_app',
    description: 'Launch the Tauri desktop app (runs pnpm tauri dev)',
    inputSchema: z.object({
      wait_for_ready: z.boolean().optional().describe('Wait for app to be ready before returning (default: true)'),
      timeout_secs: z.number().optional().describe('Timeout in seconds to wait for app to be ready (default: 60)'),
    }),
  },
  stop_app: {
    name: 'stop_app',
    description: 'Stop the running Tauri app',
    inputSchema: z.object({}),
  },
  snapshot: {
    name: 'snapshot',
    description: 'Get accessibility tree snapshot of the current page. Returns a tree with ref numbers that can be used with click/fill tools.',
    inputSchema: z.object({}),
  },
  click: {
    name: 'click',
    description: "Click an element. Use 'ref' (from snapshot) or 'selector' (CSS). Ref is preferred.",
    inputSchema: z.object({
      ref: z.number().optional().describe('Element ref number from snapshot (preferred)'),
      selector: z.string().optional().describe('CSS selector of the element to click (fallback)'),
    }),
  },
  fill: {
    name: 'fill',
    description: "Fill an input element with a value. Use 'ref' (from snapshot) or 'selector' (CSS).",
    inputSchema: z.object({
      ref: z.number().optional().describe('Element ref number from snapshot (preferred)'),
      selector: z.string().optional().describe('CSS selector of the input element (fallback)'),
      value: z.string().describe('Value to fill into the input'),
    }),
  },
  press_key: {
    name: 'press_key',
    description: 'Press a keyboard key',
    inputSchema: z.object({
      key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'Escape')"),
    }),
  },
  evaluate_script: {
    name: 'evaluate_script',
    description: 'Execute custom JavaScript in the webview',
    inputSchema: z.object({
      script: z.string().describe('JavaScript code to execute'),
    }),
  },
  screenshot: {
    name: 'screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: z.object({}),
  },
  navigate: {
    name: 'navigate',
    description: 'Navigate to a URL',
    inputSchema: z.object({
      url: z.string().describe('URL to navigate to'),
    }),
  },
  get_console_logs: {
    name: 'get_console_logs',
    description: 'Get captured console logs from the frontend',
    inputSchema: z.object({}),
  },
  get_network_logs: {
    name: 'get_network_logs',
    description: 'Get captured network request logs',
    inputSchema: z.object({}),
  },
};

export type ToolName = keyof typeof toolSchemas;

export function createToolHandlers(tauriManager: TauriManager, socketManager: SocketManager) {
  return {
    app_status: async () => {
      const status = tauriManager.getStatus();
      const config = tauriManager.getAppConfig();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status,
              app: config ? {
                name: config.packageName,
                binary: config.binaryName,
                directory: config.appDir,
              } : null,
            }, null, 2),
          },
        ],
      };
    },

    launch_app: async (args: { wait_for_ready?: boolean; timeout_secs?: number }) => {
      const result = await tauriManager.launch(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    stop_app: async () => {
      const result = await tauriManager.stop();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    snapshot: async () => {
      const result = await socketManager.snapshot();
      return {
        content: [
          {
            type: 'text' as const,
            text: result,
          },
        ],
      };
    },

    click: async (args: { ref?: number; selector?: string }) => {
      if (!args.ref && !args.selector) {
        throw new Error('Either ref or selector must be provided');
      }
      const result = await socketManager.click(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: result,
          },
        ],
      };
    },

    fill: async (args: { ref?: number; selector?: string; value: string }) => {
      if (!args.ref && !args.selector) {
        throw new Error('Either ref or selector must be provided');
      }
      const result = await socketManager.fill(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: result,
          },
        ],
      };
    },

    press_key: async (args: { key: string }) => {
      const result = await socketManager.pressKey(args.key);
      return {
        content: [
          {
            type: 'text' as const,
            text: result,
          },
        ],
      };
    },

    evaluate_script: async (args: { script: string }) => {
      const result = await socketManager.evaluateScript(args.script);
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    screenshot: async () => {
      const result = await socketManager.screenshot();
      // Result is base64 encoded image
      return {
        content: [
          {
            type: 'image' as const,
            data: result,
            mimeType: 'image/jpeg',
          },
        ],
      };
    },

    navigate: async (args: { url: string }) => {
      const result = await socketManager.navigate(args.url);
      return {
        content: [
          {
            type: 'text' as const,
            text: result,
          },
        ],
      };
    },

    get_console_logs: async () => {
      const result = await socketManager.getConsoleLogs();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    get_network_logs: async () => {
      const result = await socketManager.getNetworkLogs();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  };
}
