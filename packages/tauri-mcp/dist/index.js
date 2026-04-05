#!/usr/bin/env node
import * as path from 'path';
import { McpServer } from './server.js';
// Auto-detect window prefix from repository directory name (if not explicitly set)
if (!process.env.TAURI_MCP_WINDOW_PREFIX) {
    const dirName = path.basename(process.cwd());
    if (dirName) {
        process.env.TAURI_MCP_WINDOW_PREFIX = dirName;
        console.error(`[tauri-mcp] Auto-detected window prefix: ${dirName}`);
    }
}
// TAURI_APP_DIR (plugin config) > TAURI_PROJECT_ROOT (legacy) > cwd
const projectRoot = process.env.TAURI_APP_DIR || process.env.TAURI_PROJECT_ROOT || process.cwd();
const server = new McpServer(projectRoot);
let isShuttingDown = false;
async function shutdown(reason) {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    console.error(`[tauri-mcp] Shutting down (${reason})...`);
    try {
        await Promise.race([
            server.stop(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 10_000)),
        ]);
    }
    catch (e) {
        console.error('[tauri-mcp] Error during shutdown:', e);
        try {
            server.stopSync();
        }
        catch { }
    }
    process.exit(0);
}
// Graceful shutdown on signals
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
// Handle process exit (sync cleanup - stop() already called or will be called)
process.on('exit', () => {
    if (!isShuttingDown) {
        console.error('[tauri-mcp] Process exiting, forcing app cleanup...');
        // Synchronous cleanup - can't await here
        server.stopSync();
    }
});
// Handle stdin close (MCP connection dropped - e.g., Claude Code terminated)
process.stdin.on('close', () => {
    shutdown('stdin closed');
});
process.stdin.on('end', () => {
    shutdown('stdin ended');
});
// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('[tauri-mcp] Uncaught exception:', error);
    shutdown('uncaught exception');
});
process.on('unhandledRejection', (reason) => {
    console.error('[tauri-mcp] Unhandled rejection:', reason);
    shutdown('unhandled rejection');
});
// Start server
server.start().catch((error) => {
    console.error('[tauri-mcp] Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map