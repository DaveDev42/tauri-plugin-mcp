import { z } from 'zod';
import { TauriManager } from '../managers/tauri.js';
import { SocketManager } from '../managers/socket.js';
export declare const toolSchemas: {
    app_status: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    launch_app: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            wait_for_ready: z.ZodOptional<z.ZodBoolean>;
            timeout_secs: z.ZodOptional<z.ZodNumber>;
            features: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            wait_for_ready?: boolean | undefined;
            timeout_secs?: number | undefined;
            features?: string[] | undefined;
        }, {
            wait_for_ready?: boolean | undefined;
            timeout_secs?: number | undefined;
            features?: string[] | undefined;
        }>;
    };
    stop_app: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    snapshot: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    click: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            ref: z.ZodOptional<z.ZodNumber>;
            selector: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            ref?: number | undefined;
            selector?: string | undefined;
        }, {
            ref?: number | undefined;
            selector?: string | undefined;
        }>;
    };
    fill: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            ref: z.ZodOptional<z.ZodNumber>;
            selector: z.ZodOptional<z.ZodString>;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            ref?: number | undefined;
            selector?: string | undefined;
        }, {
            value: string;
            ref?: number | undefined;
            selector?: string | undefined;
        }>;
    };
    press_key: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            key: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            key: string;
        }, {
            key: string;
        }>;
    };
    evaluate_script: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            script: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            script: string;
        }, {
            script: string;
        }>;
    };
    screenshot: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    navigate: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            url: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            url: string;
        }, {
            url: string;
        }>;
    };
    get_console_logs: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    get_network_logs: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
};
export type ToolName = keyof typeof toolSchemas;
export declare function createToolHandlers(tauriManager: TauriManager, socketManager: SocketManager): {
    app_status: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    launch_app: (args: {
        wait_for_ready?: boolean;
        timeout_secs?: number;
        features?: string[];
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    stop_app: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    snapshot: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    click: (args: {
        ref?: number;
        selector?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    fill: (args: {
        ref?: number;
        selector?: string;
        value: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    press_key: (args: {
        key: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    evaluate_script: (args: {
        script: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    screenshot: () => Promise<{
        content: {
            type: "image";
            data: string;
            mimeType: string;
        }[];
    }>;
    navigate: (args: {
        url: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    get_console_logs: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    get_network_logs: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
//# sourceMappingURL=lifecycle.d.ts.map