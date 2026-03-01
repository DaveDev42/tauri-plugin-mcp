import { z } from 'zod';
// Tool schemas (descriptions kept minimal for context efficiency)
export const toolSchemas = {
    app_status: {
        name: 'app_status',
        description: 'Check app status. Use probe_bridge to verify bridge health per window.',
        inputSchema: z.object({
            probe_bridge: z.boolean().optional().default(false).describe('Actively probe bridge health per window (adds latency)'),
        }),
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
    list_windows: {
        name: 'list_windows',
        description: 'List all open windows with their labels, titles, and focus state',
        inputSchema: z.object({}),
    },
    focus_window: {
        name: 'focus_window',
        description: 'Focus a specific window by label',
        inputSchema: z.object({
            window: z.string().describe('Window label to focus'),
        }),
    },
    snapshot: {
        name: 'snapshot',
        description: 'Get accessibility tree (returns ref numbers for click/fill)',
        inputSchema: z.object({
            window: z.string().optional().describe('Window label (default: focused window)'),
        }),
    },
    click: {
        name: 'click',
        description: 'Click element by ref or selector',
        inputSchema: z.object({
            ref: z.number().optional().describe('Ref from snapshot'),
            selector: z.string().optional().describe('CSS selector'),
            window: z.string().optional().describe('Window label (default: focused window)'),
        }),
    },
    fill: {
        name: 'fill',
        description: 'Fill input by ref or selector',
        inputSchema: z.object({
            ref: z.number().optional().describe('Ref from snapshot'),
            selector: z.string().optional().describe('CSS selector'),
            value: z.string().describe('Value'),
            window: z.string().optional().describe('Window label (default: focused window)'),
        }),
    },
    press_key: {
        name: 'press_key',
        description: 'Press key',
        inputSchema: z.object({
            key: z.string().describe('Key name'),
            window: z.string().optional().describe('Window label (default: focused window)'),
        }),
    },
    evaluate_script: {
        name: 'evaluate_script',
        description: 'Run JS in webview',
        inputSchema: z.object({
            script: z.string().describe('JS code'),
            window: z.string().optional().describe('Window label (default: focused window)'),
        }),
    },
    screenshot: {
        name: 'screenshot',
        description: 'Take screenshot',
        inputSchema: z.object({
            window: z.string().optional().describe('Window label (default: focused window)'),
        }),
    },
    navigate: {
        name: 'navigate',
        description: 'Navigate to URL',
        inputSchema: z.object({
            url: z.string().describe('URL'),
            window: z.string().optional().describe('Window label (default: focused window)'),
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
            window: z.string().optional().describe('Window label for frontend logs (default: focused window)'),
        }),
    },
    get_restart_events: {
        name: 'get_restart_events',
        description: 'Get recent app restart/reload events with the files that triggered them. Includes Rust rebuilds (backend) and HMR updates (frontend).',
        inputSchema: z.object({
            limit: z.number().optional().default(10).describe('Max events'),
            clear: z.boolean().optional().default(false).describe('Clear events after reading'),
            window: z.string().optional().describe('Window label for frontend HMR events (default: focused window)'),
        }),
    },
};
export function createToolHandlers(tauriManager, socketManager) {
    return {
        app_status: async (args) => {
            const status = tauriManager.getStatus();
            const config = tauriManager.getAppConfig();
            const pid = tauriManager.getProcessPid();
            const launchedAt = tauriManager.getLaunchedAt();
            const projectRoot = tauriManager.getProjectRoot();
            const result = {
                status,
                app: config ? {
                    name: config.packageName,
                    binary: config.binaryName,
                    directory: config.appDir,
                } : null,
                ...(pid != null && { pid }),
                ...(launchedAt != null && { launchedAt }),
                projectRoot,
            };
            // When running and probe requested, check bridge health per window
            if (status === 'running' && args.probe_bridge) {
                try {
                    result.bridge = await socketManager.probeBridge();
                }
                catch {
                    // Socket dead or probe failed — omit bridge field (backward compatible)
                }
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        },
        launch_app: async (args) => {
            const result = await tauriManager.launch(args);
            // Apply window title prefix after successful launch if env var is set
            if (result.status === 'launched') {
                const prefix = process.env.TAURI_MCP_WINDOW_PREFIX;
                if (prefix) {
                    try {
                        await socketManager.setTitlePrefix(prefix);
                    }
                    catch {
                        // Best-effort — app may not have finished initializing windows yet
                    }
                }
            }
            return {
                content: [
                    {
                        type: 'text',
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
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        },
        list_windows: async () => {
            const result = await socketManager.listWindows();
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        },
        focus_window: async (args) => {
            const result = await socketManager.focusWindow(args.window);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        },
        snapshot: async (args) => {
            const result = await socketManager.snapshot(args);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        },
        click: async (args) => {
            if (args.ref == null && !args.selector) {
                throw new Error('Either ref or selector must be provided');
            }
            const result = await socketManager.click(args);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        },
        fill: async (args) => {
            if (args.ref == null && !args.selector) {
                throw new Error('Either ref or selector must be provided');
            }
            const result = await socketManager.fill(args);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        },
        press_key: async (args) => {
            const result = await socketManager.pressKey(args.key, args.window);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        },
        evaluate_script: async (args) => {
            const result = await socketManager.evaluateScript(args.script, args.window);
            return {
                content: [
                    {
                        type: 'text',
                        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                    },
                ],
            };
        },
        screenshot: async (args) => {
            const result = await socketManager.screenshot(args);
            return {
                content: [
                    {
                        type: 'image',
                        data: result.data,
                        mimeType: result.mimeType,
                    },
                ],
            };
        },
        navigate: async (args) => {
            const result = await socketManager.navigate(args.url, args.window);
            return {
                content: [
                    {
                        type: 'text',
                        text: result,
                    },
                ],
            };
        },
        get_restart_events: async (args) => {
            const limit = args.limit ?? 10;
            const clear = args.clear ?? false;
            const windowLabel = args.window;
            // Get Rust rebuild events from TauriManager
            const rustEvents = tauriManager.getRustRebuildEvents({ limit, clear });
            // Get frontend HMR updates from socket if app is running
            let frontendEvents = [];
            try {
                const hmrResult = await socketManager.getHmrUpdates(clear, windowLabel);
                frontendEvents = hmrResult.updates ?? [];
            }
            catch {
                // App not running or socket not available
            }
            // Merge and format all events
            const allEvents = [
                ...rustEvents.map(e => ({
                    type: e.type,
                    files: [e.file],
                    timestamp: e.timestamp,
                    source: 'backend',
                })),
                ...frontendEvents.map(e => ({
                    type: e.type,
                    files: e.files,
                    timestamp: e.timestamp,
                    source: 'frontend',
                })),
            ];
            // Sort by timestamp (most recent first) and limit
            allEvents.sort((a, b) => b.timestamp - a.timestamp);
            const limitedEvents = allEvents.slice(0, limit);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            events: limitedEvents,
                            summary: {
                                total: limitedEvents.length,
                                rustRebuilds: limitedEvents.filter(e => e.type === 'rust-rebuild').length,
                                hmrUpdates: limitedEvents.filter(e => e.type === 'hmr-update').length,
                                fullReloads: limitedEvents.filter(e => e.type === 'full-reload').length,
                            },
                        }, null, 2),
                    },
                ],
            };
        },
        get_logs: async (args) => {
            const filters = args.filter ?? [];
            const limit = args.limit ?? 50;
            const clear = args.clear ?? false;
            const windowLabel = args.window;
            // Parse filters into source and level filters
            const sourceFilters = new Set();
            const levelFilters = new Set();
            for (const f of filters) {
                if (['error', 'warning', 'info'].includes(f)) {
                    levelFilters.add(f);
                }
                else {
                    sourceFilters.add(f);
                }
            }
            // Helper to check if entry matches filters
            const matchesFilters = (entry) => {
                // If no filters, match all
                if (filters.length === 0)
                    return true;
                // Check source filter
                let sourceMatch = sourceFilters.size === 0; // No source filter = match all sources
                if (!sourceMatch) {
                    if (sourceFilters.has('build') && entry.category.startsWith('build-'))
                        sourceMatch = true;
                    if (sourceFilters.has('build-frontend') && entry.category === 'build-frontend')
                        sourceMatch = true;
                    if (sourceFilters.has('build-backend') && entry.category === 'build-backend')
                        sourceMatch = true;
                    if (sourceFilters.has('runtime') && entry.category.startsWith('runtime-'))
                        sourceMatch = true;
                    if (sourceFilters.has('runtime-frontend') && entry.category === 'runtime-frontend')
                        sourceMatch = true;
                    if (sourceFilters.has('runtime-backend') && entry.category === 'runtime-backend')
                        sourceMatch = true;
                    if (sourceFilters.has('runtime-frontend-network') && entry.category === 'runtime-frontend-network')
                        sourceMatch = true;
                }
                // Check level filter
                let levelMatch = levelFilters.size === 0; // No level filter = match all levels
                if (!levelMatch) {
                    if (levelFilters.has(entry.level))
                        levelMatch = true;
                }
                // Both must match (AND logic when both types are specified)
                return sourceMatch && levelMatch;
            };
            // Get backend logs from TauriManager (get all, filter later)
            const backendResult = tauriManager.getUnifiedLogs({ filter: 'all', limit: 1000, clear });
            // Get frontend logs from socket if app is running
            let frontendLogs = null;
            try {
                frontendLogs = await socketManager.getFrontendLogs(clear, windowLabel);
            }
            catch {
                // App not running or socket not available
            }
            // Merge all logs
            let allEntries = [
                ...backendResult.entries,
                ...(frontendLogs?.consoleLogs ?? []),
                ...(frontendLogs?.buildLogs ?? []),
                ...(frontendLogs?.networkLogs ?? []),
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
                    ? 'error'
                    : frontendLogs
                        ? 'healthy'
                        : 'unknown',
                backend: backendResult.entries.some(e => e.level === 'error' && e.category.startsWith('build-'))
                    ? 'error'
                    : 'healthy',
                hmrConnected: frontendLogs?.hmrStatus.connected ?? false,
                lastSuccessfulBuild: frontendLogs?.hmrStatus.lastSuccess ?? undefined,
            };
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ entries: allEntries, summary, buildHealth }, null, 2),
                    },
                ],
            };
        },
    };
}
//# sourceMappingURL=lifecycle.js.map