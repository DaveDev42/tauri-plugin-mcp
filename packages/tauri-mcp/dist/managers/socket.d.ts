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
    constructor(projectRoot?: string);
    /**
     * Set the socket path provider function.
     * On Windows, this should return the detected pipe path from TauriManager.
     */
    setSocketPathProvider(provider: SocketPathProvider): void;
    private getSocketPath;
    isConnected(): boolean;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    snapshot(): Promise<string>;
    click(options: {
        ref?: number;
        selector?: string;
    }): Promise<string>;
    fill(options: {
        ref?: number;
        selector?: string;
        value: string;
    }): Promise<string>;
    pressKey(key: string): Promise<string>;
    evaluateScript(script: string): Promise<unknown>;
    screenshot(): Promise<{
        data: string;
        mimeType: string;
        width: number;
        height: number;
    }>;
    navigate(url: string): Promise<string>;
    getConsoleLogs(): Promise<unknown[]>;
    getNetworkLogs(): Promise<unknown[]>;
}
//# sourceMappingURL=socket.d.ts.map