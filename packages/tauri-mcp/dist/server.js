import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { TauriManager } from './managers/tauri.js';
import { SocketManager } from './managers/socket.js';
import { toolSchemas, createToolHandlers } from './tools/lifecycle.js';
// Default essential tools (can be overridden via ESSENTIAL_TOOLS env var)
const DEFAULT_ESSENTIAL_TOOLS = [
    'get_session_status',
    'start_session',
    'stop_session',
    'snapshot',
    'click',
    'fill',
    'screenshot',
    'navigate',
];
// Parse ESSENTIAL_TOOLS from environment
function getEssentialTools() {
    const envValue = process.env.ESSENTIAL_TOOLS;
    if (!envValue)
        return null; // null means show all tools
    return new Set(envValue.split(',').map((t) => t.trim()).filter(Boolean));
}
export class McpServer {
    server;
    tauriManager;
    socketManager;
    toolHandlers;
    constructor(projectRoot) {
        this.server = new Server({
            name: 'tauri-mcp',
            version: '0.1.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.tauriManager = new TauriManager(projectRoot);
        this.socketManager = new SocketManager(projectRoot);
        // Connect SocketManager to TauriManager's socket path
        // This ensures both use the same path (appDir, not projectRoot)
        this.socketManager.setSocketPathProvider(() => this.tauriManager.getSocketPath());
        this.toolHandlers = createToolHandlers(this.tauriManager, this.socketManager);
        this.setupHandlers();
    }
    setupHandlers() {
        // Get essential tools filter (null = show all)
        const essentialTools = getEssentialTools();
        // List tools handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const allSchemas = Object.values(toolSchemas);
            // Filter tools if ESSENTIAL_TOOLS is set
            const filteredSchemas = essentialTools
                ? allSchemas.filter((schema) => essentialTools.has(schema.name))
                : allSchemas;
            const tools = filteredSchemas.map((schema) => {
                const properties = {};
                const required = [];
                const shape = schema.inputSchema.shape;
                for (const [key, zodValue] of Object.entries(shape)) {
                    const zodSchema = zodValue;
                    properties[key] = {
                        type: this.getZodType(zodSchema),
                        description: zodSchema._def?.description || zodSchema.description || '',
                    };
                    // Check if required (not optional)
                    if (!zodSchema.isOptional?.()) {
                        const typeName = zodSchema._def?.typeName;
                        if (typeName !== 'ZodOptional') {
                            required.push(key);
                        }
                    }
                }
                return {
                    name: schema.name,
                    description: schema.description,
                    inputSchema: {
                        type: 'object',
                        properties,
                        required: required.length > 0 ? required : undefined,
                    },
                };
            });
            return { tools };
        });
        // Call tool handler
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            if (!(name in this.toolHandlers)) {
                throw new Error(`Unknown tool: ${name}`);
            }
            const handler = this.toolHandlers[name];
            try {
                return await handler(args);
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
    }
    getZodType(zodSchema) {
        const schema = zodSchema;
        const typeName = schema._def?.typeName;
        if (typeName === 'ZodString')
            return 'string';
        if (typeName === 'ZodNumber')
            return 'number';
        if (typeName === 'ZodBoolean')
            return 'boolean';
        if (typeName === 'ZodOptional') {
            const innerType = schema._def?.innerType;
            return this.getZodType(innerType);
        }
        return 'string';
    }
    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('[tauri-mcp] Server started on stdio');
    }
    async stop() {
        await this.tauriManager.stop();
        await this.server.close();
    }
    /**
     * Synchronous stop for use in process.on('exit') handler
     * Uses spawnSync to ensure cleanup happens before process exits
     */
    stopSync() {
        this.tauriManager.stopSync();
    }
}
//# sourceMappingURL=server.js.map