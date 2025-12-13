import { z } from 'zod';
import { TauriManager } from '../managers/tauri.js';
import { SocketManager } from '../managers/socket.js';

// Tool schemas (descriptions kept minimal for context efficiency)
export const toolSchemas = {
  app_status: {
    name: 'app_status',
    description: 'Check app status',
    inputSchema: z.object({}),
  },
  launch_app: {
    name: 'launch_app',
    description: 'Launch Tauri app',
    inputSchema: z.object({
      wait_for_ready: z.boolean().optional().describe('Wait for ready'),
      timeout_secs: z.number().optional().describe('Timeout seconds'),
      features: z.array(z.string()).optional().describe('Cargo features to enable'),
    }),
  },
  stop_app: {
    name: 'stop_app',
    description: 'Stop app',
    inputSchema: z.object({}),
  },
  snapshot: {
    name: 'snapshot',
    description: 'Get accessibility tree (returns ref numbers for click/fill)',
    inputSchema: z.object({}),
  },
  click: {
    name: 'click',
    description: 'Click element by ref or selector',
    inputSchema: z.object({
      ref: z.number().optional().describe('Ref from snapshot'),
      selector: z.string().optional().describe('CSS selector'),
    }),
  },
  fill: {
    name: 'fill',
    description: 'Fill input by ref or selector',
    inputSchema: z.object({
      ref: z.number().optional().describe('Ref from snapshot'),
      selector: z.string().optional().describe('CSS selector'),
      value: z.string().describe('Value'),
    }),
  },
  press_key: {
    name: 'press_key',
    description: 'Press key',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  },
  evaluate_script: {
    name: 'evaluate_script',
    description: 'Run JS in webview',
    inputSchema: z.object({
      script: z.string().describe('JS code'),
    }),
  },
  screenshot: {
    name: 'screenshot',
    description: 'Take screenshot',
    inputSchema: z.object({}),
  },
  navigate: {
    name: 'navigate',
    description: 'Navigate to URL',
    inputSchema: z.object({
      url: z.string().describe('URL'),
    }),
  },
  get_console_logs: {
    name: 'get_console_logs',
    description: 'Get console logs',
    inputSchema: z.object({}),
  },
  get_network_logs: {
    name: 'get_network_logs',
    description: 'Get network logs',
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

    launch_app: async (args: { wait_for_ready?: boolean; timeout_secs?: number; features?: string[] }) => {
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
      return {
        content: [
          {
            type: 'image' as const,
            data: result.data,
            mimeType: result.mimeType,
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
