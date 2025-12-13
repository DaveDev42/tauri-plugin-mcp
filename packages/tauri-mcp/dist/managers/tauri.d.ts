export interface TauriAppConfig {
    appDir: string;
    binaryName: string;
    packageName: string;
}
export type AppStatus = 'not_running' | 'starting' | 'running';
export interface LaunchOptions {
    wait_for_ready?: boolean;
    timeout_secs?: number;
    features?: string[];
}
export declare class TauriManager {
    private process;
    private status;
    private projectRoot;
    private appConfig;
    private vitePort;
    private outputBuffer;
    private detectedPipePath;
    constructor(projectRoot?: string);
    private detectExistingPort;
    private generatePort;
    private detectTauriApp;
    private findCargoTomlRecursive;
    private parseCargoToml;
    /**
     * Get the socket path - uses detected path from Rust logs on Windows
     */
    getSocketPath(): string;
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
    private isSocketReady;
    private isSocketReadyAsync;
    launch(options?: LaunchOptions): Promise<{
        message: string;
        port: number;
    }>;
    private waitForReady;
    private getRecentLogs;
    stop(): Promise<{
        message: string;
    }>;
    private cleanupOrphanProcesses;
    getStatus(): AppStatus;
    getAppConfig(): TauriAppConfig | null;
    private sleep;
}
//# sourceMappingURL=tauri.d.ts.map