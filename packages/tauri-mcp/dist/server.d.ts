export declare class McpServer {
    private server;
    private tauriManager;
    private socketManager;
    private toolHandlers;
    constructor(projectRoot?: string);
    private setupHandlers;
    private getZodType;
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Synchronous stop for use in process.on('exit') handler
     * Uses spawnSync to ensure cleanup happens before process exits
     */
    stopSync(): void;
}
//# sourceMappingURL=server.d.ts.map