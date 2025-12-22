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
      devtools: z.boolean().optional().describe('Open devtools on launch'),
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
  get_logs: {
    name: 'get_logs',
    description: 'Get application logs with filtering. Filters can be combined (e.g., ["build", "error"] for build errors only).',
    inputSchema: z.object({
      filter: z.array(z.enum([
        // Source filters
        'build', 'build-frontend', 'build-backend',
        'runtime', 'runtime-frontend', 'runtime-backend', 'runtime-frontend-network',
        // Level filters
        'error', 'warning', 'info',
      ])).optional().default([]).describe('Filters to apply (empty = all logs)'),
      limit: z.number().optional().default(50).describe('Max entries'),
      clear: z.boolean().optional().default(false).describe('Clear logs after reading'),
    }),
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

    launch_app: async (args: { wait_for_ready?: boolean; timeout_secs?: number; features?: string[]; devtools?: boolean }) => {
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

    get_logs: async (args: { filter?: string[]; limit?: number; clear?: boolean }) => {
      const filters = args.filter ?? [];
      const limit = args.limit ?? 50;
      const clear = args.clear ?? false;

      // Parse filters into source and level filters
      const sourceFilters = new Set<string>();
      const levelFilters = new Set<string>();

      for (const f of filters) {
        if (['error', 'warning', 'info'].includes(f)) {
          levelFilters.add(f);
        } else {
          sourceFilters.add(f);
        }
      }

      // Helper to check if entry matches filters
      const matchesFilters = (entry: { category: string; level: string }) => {
        // If no filters, match all
        if (filters.length === 0) return true;

        // Check source filter
        let sourceMatch = sourceFilters.size === 0; // No source filter = match all sources
        if (!sourceMatch) {
          if (sourceFilters.has('build') && entry.category.startsWith('build-')) sourceMatch = true;
          if (sourceFilters.has('build-frontend') && entry.category === 'build-frontend') sourceMatch = true;
          if (sourceFilters.has('build-backend') && entry.category === 'build-backend') sourceMatch = true;
          if (sourceFilters.has('runtime') && entry.category.startsWith('runtime-')) sourceMatch = true;
          if (sourceFilters.has('runtime-frontend') && entry.category === 'runtime-frontend') sourceMatch = true;
          if (sourceFilters.has('runtime-backend') && entry.category === 'runtime-backend') sourceMatch = true;
          if (sourceFilters.has('runtime-frontend-network') && entry.category === 'runtime-frontend-network') sourceMatch = true;
        }

        // Check level filter
        let levelMatch = levelFilters.size === 0; // No level filter = match all levels
        if (!levelMatch) {
          if (levelFilters.has(entry.level)) levelMatch = true;
        }

        // Both must match (AND logic when both types are specified)
        return sourceMatch && levelMatch;
      };

      // Get backend logs from TauriManager (get all, filter later)
      const backendResult = tauriManager.getUnifiedLogs({ filter: 'all', limit: 1000, clear });

      // Get frontend logs from socket if app is running
      let frontendLogs: {
        consoleLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number }>;
        buildLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number; details?: { file?: string; line?: number; column?: number } }>;
        networkLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number; details?: { url?: string; method?: string; status?: number; duration?: number } }>;
        hmrStatus: { connected: boolean; status: string; lastSuccess: number | null };
      } | null = null;

      try {
        frontendLogs = await socketManager.getFrontendLogs(clear);
      } catch {
        // App not running or socket not available
      }

      // Merge all logs
      let allEntries = [
        ...backendResult.entries,
        ...(frontendLogs?.consoleLogs ?? []) as typeof backendResult.entries,
        ...(frontendLogs?.buildLogs ?? []) as typeof backendResult.entries,
        ...(frontendLogs?.networkLogs ?? []) as typeof backendResult.entries,
      ];

      // Apply filters
      allEntries = allEntries.filter(matchesFilters);

      // Sort by timestamp and limit
      allEntries.sort((a, b) => a.timestamp - b.timestamp);
      allEntries = allEntries.slice(-limit);

      // Calculate summary
      const summary = {
        total: allEntries.length,
        errors: allEntries.filter(e => e.level === 'error').length,
        warnings: allEntries.filter(e => e.level === 'warning').length,
      };

      // Build health status
      const buildHealth = {
        frontend: frontendLogs?.buildLogs.some(e => e.level === 'error')
          ? 'error' as const
          : frontendLogs
            ? 'healthy' as const
            : 'unknown' as const,
        backend: backendResult.entries.some(e => e.level === 'error' && e.category.startsWith('build-'))
          ? 'error' as const
          : 'healthy' as const,
        hmrConnected: frontendLogs?.hmrStatus.connected ?? false,
        lastSuccessfulBuild: frontendLogs?.hmrStatus.lastSuccess ?? undefined,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ entries: allEntries, summary, buildHealth }, null, 2),
          },
        ],
      };
    },
  };
}
