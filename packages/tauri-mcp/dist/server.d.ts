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
}
//# sourceMappingURL=server.d.ts.map