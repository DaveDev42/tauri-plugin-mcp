export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export type SocketPathProvider = () => string;
export declare class SocketManager {
    private projectRoot;
    private socketPathProvider;
    private static readonly MAX_RETRIES;
    private static readonly RETRY_DELAY_MS;
    constructor(projectRoot?: string);
    /**
     * Set the socket path provider function.
     * On Windows, this should return the detected pipe path from TauriManager.
     */
    setSocketPathProvider(provider: SocketPathProvider): void;
    private getSocketPath;
    isConnected(): boolean;
    /**
     * Verify connection by sending a ping command
     * More reliable than just checking socket file existence
     */
    verifyConnection(): Promise<boolean>;
    /**
     * Send command with retry logic for transient failures
     */
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    /**
     * Check if an error is retryable (transient connection issues)
     */
    private isRetryableError;
    private sleep;
    /**
     * Send a single command without retry
     */
    private sendCommandOnce;
    listWindows(): Promise<{
        windows: Array<{
            label: string;
            title: string;
            focused: boolean;
            visible: boolean;
            size: {
                width: number;
                height: number;
            } | null;
            bridge_initialized: boolean;
        }>;
    }>;
    probeBridge(windowLabel?: string): Promise<Record<string, {
        initialized: boolean;
        bridge_alive: boolean;
    }>>;
    focusWindow(windowLabel: string): Promise<string>;
    snapshot(options?: {
        window?: string;
    }): Promise<string>;
    click(options: {
        ref?: number;
        selector?: string;
        window?: string;
    }): Promise<string>;
    fill(options: {
        ref?: number;
        selector?: string;
        value: string;
        window?: string;
    }): Promise<string>;
    pressKey(key: string, windowLabel?: string): Promise<string>;
    evaluateScript(script: string, windowLabel?: string): Promise<unknown>;
    screenshot(options?: {
        window?: string;
    }): Promise<{
        data: string;
        mimeType: string;
        width: number;
        height: number;
    }>;
    private screenshotMacOS;
    private screenshotNative;
    navigate(url: string, windowLabel?: string): Promise<string>;
    getConsoleLogs(clear?: boolean, windowLabel?: string): Promise<unknown>;
    getNetworkLogs(clear?: boolean, windowLabel?: string): Promise<unknown>;
    getFrontendLogs(clear?: boolean, windowLabel?: string): Promise<{
        consoleLogs: Array<{
            source: string;
            category: string;
            level: string;
            message: string;
            timestamp: number;
        }>;
        buildLogs: Array<{
            source: string;
            category: string;
            level: string;
            message: string;
            timestamp: number;
            details?: {
                file?: string;
                line?: number;
                column?: number;
            };
        }>;
        networkLogs: Array<{
            source: string;
            category: string;
            level: string;
            message: string;
            timestamp: number;
            details?: {
                url?: string;
                method?: string;
                status?: number;
                duration?: number;
            };
        }>;
        hmrStatus: {
            connected: boolean;
            status: string;
            lastSuccess: number | null;
        };
    }>;
    setTitlePrefix(prefix: string | null): Promise<{
        updated: number;
        prefix: string | null;
    }>;
    getHmrUpdates(clear?: boolean, windowLabel?: string): Promise<{
        updates: Array<{
            type: 'hmr-update' | 'full-reload';
            files: string[];
            timestamp: number;
        }>;
    }>;
}
//# sourceMappingURL=socket.d.ts.map