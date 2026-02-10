export interface TauriAppConfig {
    appDir: string;
    binaryName: string;
    packageName: string;
}
export type AppStatus = 'not_running' | 'starting' | 'running';
export type BuildHealthStatus = 'healthy' | 'error' | 'unknown';
export interface LaunchOptions {
    wait_for_ready?: boolean;
    timeout_secs?: number;
    features?: string[];
    devtools?: boolean;
}
export interface LaunchResult {
    status: 'launched' | 'already_running' | 'build_error';
    message: string;
    port: number;
    portOverrideApplied: boolean;
    warnings?: string[];
    buildHealth: {
        frontend: BuildHealthStatus;
        backend: BuildHealthStatus;
    };
    errors?: LogEntry[];
}
export interface LogEntry {
    source: 'console' | 'network' | 'vite' | 'typescript' | 'rust' | 'tauri';
    category: 'build-frontend' | 'build-backend' | 'runtime-frontend' | 'runtime-backend' | 'runtime-frontend-network';
    level: 'debug' | 'info' | 'warning' | 'error';
    message: string;
    timestamp: number;
    details?: {
        file?: string;
        line?: number;
        column?: number;
        stack?: string;
        url?: string;
        method?: string;
        status?: number;
        duration?: number;
    };
}
export interface RustRebuildEvent {
    type: 'rust-rebuild';
    file: string;
    timestamp: number;
}
export declare class TauriManager {
    private process;
    private status;
    private projectRoot;
    private appConfig;
    private vitePort;
    private outputBuffer;
    private detectedPipePath;
    private detectedUnixSocketPath;
    private rustRebuildEvents;
    constructor(projectRoot?: string);
    private detectExistingPort;
    private generatePort;
    /**
     * Check if a port is available for use
     */
    private isPortAvailable;
    /**
     * Find an available random port
     */
    private findAvailablePort;
    /**
     * Read Tauri configuration from tauri.conf.json
     */
    private readTauriConfig;
    /**
     * Detect the bundler type from beforeDevCommand and package.json
     */
    private detectBundlerType;
    /**
     * Detect bundler type by analyzing package.json
     */
    private detectBundlerFromPackageJson;
    /**
     * Inject --port flag into beforeDevCommand
     */
    private injectPortToCommand;
    private detectTauriApp;
    private findCargoTomlRecursive;
    private parseCargoToml;
    /**
     * Get the socket path - uses appDir where the Tauri app actually runs
     * On Windows, uses detected path from Rust logs
     * On Unix, falls back to /tmp/ with hash if path exceeds SUN_LEN (104 bytes)
     */
    getSocketPath(): string;
    /**
     * Get Unix socket path, falling back to /tmp/ if path is too long for SUN_LEN
     * Uses same FNV-1a hash algorithm as the Rust plugin for consistency
     */
    static getUnixSocketPath(socketDir: string): string;
    /**
     * FNV-1a hash - same algorithm as Rust side for deterministic socket paths
     */
    private static fnv1aHash;
    /**
     * Find Windows named pipe matching tauri-mcp-* pattern
     * Since calculating the exact hash is complex, we enumerate existing pipes
     */
    private calculateWindowsPipePath;
    /**
     * Parse pipe path from Rust plugin output
     * Looks for: [stderr] [tauri-plugin-mcp]   full_path: \\.\pipe\tauri-mcp-XXXXX
     */
    private parsePipePathFromLogs;
    /**
     * Parse Unix socket path from Rust plugin output
     * Looks for: [tauri-plugin-mcp] Starting debug server at: /path/to/socket.sock
     */
    private parseUnixSocketPathFromLogs;
    private isSocketReady;
    private isSocketReadyAsync;
    /**
     * Check if Rust build cache exists (incremental build will be fast)
     */
    private hasBuildCache;
    /**
     * Check if an external app instance is already running and responding
     * This detects apps launched by other MCP sessions
     */
    private checkExternalAppRunning;
    launch(options?: LaunchOptions): Promise<LaunchResult>;
    private waitForReady;
    /**
     * Verify the app is fully ready by sending a ping command
     * Returns true if ping succeeds, false otherwise
     */
    private verifyAppReady;
    private getRecentLogs;
    stop(): Promise<{
        message: string;
    }>;
    /**
     * Synchronous stop for use in process.on('exit') handler
     * Uses spawnSync to ensure cleanup happens before Node.js exits
     */
    stopSync(): void;
    private cleanupOrphanProcessesSync;
    private cleanupOrphanProcesses;
    getStatus(): AppStatus;
    getAppConfig(): TauriAppConfig | null;
    /**
     * Get captured app logs (stdout/stderr)
     * @param limit Maximum number of lines to return (default: all)
     * @param clear Whether to clear the buffer after reading (default: false)
     */
    getLogs(options?: {
        limit?: number;
        clear?: boolean;
    }): string[];
    private sleep;
    /**
     * Parse backend logs (stdout/stderr) for errors
     */
    parseBackendLogs(rawLogs: string[]): LogEntry[];
    /**
     * Get unified logs with optional filtering
     */
    getUnifiedLogs(options?: {
        filter?: string;
        limit?: number;
        clear?: boolean;
    }): {
        entries: LogEntry[];
        summary: {
            total: number;
            errors: number;
            warnings: number;
        };
    };
    /**
     * Parse Rust rebuild trigger from tauri dev output
     * Looks for: "File src-tauri/src/main.rs changed. Rebuilding application..."
     */
    private parseRustRebuildTrigger;
    /**
     * Get Rust rebuild events
     * @param limit Maximum number of events to return (default: all)
     * @param clear Whether to clear the events after reading (default: false)
     */
    getRustRebuildEvents(options?: {
        limit?: number;
        clear?: boolean;
    }): RustRebuildEvent[];
}
//# sourceMappingURL=tauri.d.ts.map