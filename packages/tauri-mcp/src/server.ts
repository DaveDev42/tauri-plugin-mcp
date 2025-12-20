import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { TauriManager } from './managers/tauri.js';
import { SocketManager } from './managers/socket.js';
import { toolSchemas, createToolHandlers, ToolName } from './tools/lifecycle.js';

// Default essential tools (can be overridden via ESSENTIAL_TOOLS env var)
const DEFAULT_ESSENTIAL_TOOLS = [
  'app_status',
  'launch_app',
  'stop_app',
  'snapshot',
  'click',
  'fill',
  'screenshot',
  'navigate',
];

// Parse ESSENTIAL_TOOLS from environment
function getEssentialTools(): Set<string> | null {
  const envValue = process.env.ESSENTIAL_TOOLS;
  if (!envValue) return null; // null means show all tools
  return new Set(envValue.split(',').map((t) => t.trim()).filter(Boolean));
}

export class McpServer {
  private server: Server;
  private tauriManager: TauriManager;
  private socketManager: SocketManager;
  private toolHandlers: ReturnType<typeof createToolHandlers>;

  constructor(projectRoot?: string) {
    this.server = new Server(
      {
        name: 'tauri-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.tauriManager = new TauriManager(projectRoot);
    this.socketManager = new SocketManager(projectRoot);

    // Connect SocketManager to TauriManager's socket path
    // This ensures both use the same path (appDir, not projectRoot)
    this.socketManager.setSocketPathProvider(() => this.tauriManager.getSocketPath());

    this.toolHandlers = createToolHandlers(this.tauriManager, this.socketManager);

    this.setupHandlers();
  }

  private setupHandlers() {
    // Get essential tools filter (null = show all)
    const essentialTools = getEssentialTools();

    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allSchemas = Object.values(toolSchemas);

      // Filter tools if ESSENTIAL_TOOLS is set
      const filteredSchemas = essentialTools
        ? allSchemas.filter((schema) => essentialTools.has(schema.name))
        : allSchemas;

      const tools: Tool[] = filteredSchemas.map((schema) => {
        const properties: Record<string, object> = {};
        const required: string[] = [];

        const shape = schema.inputSchema.shape as Record<string, unknown>;
        for (const [key, zodValue] of Object.entries(shape)) {
          const zodSchema = zodValue as { _def?: { typeName?: string; description?: string }; description?: string; isOptional?: () => boolean };
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
            type: 'object' as const,
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

      const handler = this.toolHandlers[name as ToolName];

      try {
        return await handler(args as never);
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getZodType(zodSchema: unknown): string {
    const schema = zodSchema as { _def?: { typeName?: string } };
    const typeName = schema._def?.typeName;

    if (typeName === 'ZodString') return 'string';
    if (typeName === 'ZodNumber') return 'number';
    if (typeName === 'ZodBoolean') return 'boolean';
    if (typeName === 'ZodOptional') {
      const innerType = (schema as { _def?: { innerType?: unknown } })._def?.innerType;
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
  }
}
