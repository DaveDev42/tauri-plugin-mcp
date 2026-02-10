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
            devtools: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            wait_for_ready?: boolean | undefined;
            timeout_secs?: number | undefined;
            features?: string[] | undefined;
            devtools?: boolean | undefined;
        }, {
            wait_for_ready?: boolean | undefined;
            timeout_secs?: number | undefined;
            features?: string[] | undefined;
            devtools?: boolean | undefined;
        }>;
    };
    stop_app: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    list_windows: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    focus_window: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            window: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            window: string;
        }, {
            window: string;
        }>;
    };
    snapshot: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            window?: string | undefined;
        }, {
            window?: string | undefined;
        }>;
    };
    click: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            ref: z.ZodOptional<z.ZodNumber>;
            selector: z.ZodOptional<z.ZodString>;
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            window?: string | undefined;
            ref?: number | undefined;
            selector?: string | undefined;
        }, {
            window?: string | undefined;
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
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            value: string;
            window?: string | undefined;
            ref?: number | undefined;
            selector?: string | undefined;
        }, {
            value: string;
            window?: string | undefined;
            ref?: number | undefined;
            selector?: string | undefined;
        }>;
    };
    press_key: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            key: z.ZodString;
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            key: string;
            window?: string | undefined;
        }, {
            key: string;
            window?: string | undefined;
        }>;
    };
    evaluate_script: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            script: z.ZodString;
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            script: string;
            window?: string | undefined;
        }, {
            script: string;
            window?: string | undefined;
        }>;
    };
    screenshot: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            window?: string | undefined;
        }, {
            window?: string | undefined;
        }>;
    };
    navigate: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            url: z.ZodString;
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            url: string;
            window?: string | undefined;
        }, {
            url: string;
            window?: string | undefined;
        }>;
    };
    get_logs: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            filter: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodEnum<["build", "build-frontend", "build-backend", "runtime", "runtime-frontend", "runtime-backend", "runtime-frontend-network", "error", "warning", "info"]>, "many">>>;
            limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
            clear: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            filter: ("error" | "build-frontend" | "build-backend" | "runtime-frontend" | "runtime-backend" | "runtime-frontend-network" | "info" | "warning" | "build" | "runtime")[];
            limit: number;
            clear: boolean;
            window?: string | undefined;
        }, {
            filter?: ("error" | "build-frontend" | "build-backend" | "runtime-frontend" | "runtime-backend" | "runtime-frontend-network" | "info" | "warning" | "build" | "runtime")[] | undefined;
            limit?: number | undefined;
            clear?: boolean | undefined;
            window?: string | undefined;
        }>;
    };
    get_restart_events: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
            clear: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            window: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            limit: number;
            clear: boolean;
            window?: string | undefined;
        }, {
            limit?: number | undefined;
            clear?: boolean | undefined;
            window?: string | undefined;
        }>;
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
        devtools?: boolean;
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
    list_windows: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    focus_window: (args: {
        window: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    snapshot: (args: {
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    click: (args: {
        ref?: number;
        selector?: string;
        window?: string;
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
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    press_key: (args: {
        key: string;
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    evaluate_script: (args: {
        script: string;
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    screenshot: (args: {
        window?: string;
    }) => Promise<{
        content: {
            type: "image";
            data: string;
            mimeType: string;
        }[];
    }>;
    navigate: (args: {
        url: string;
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    get_restart_events: (args: {
        limit?: number;
        clear?: boolean;
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    get_logs: (args: {
        filter?: string[];
        limit?: number;
        clear?: boolean;
        window?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
//# sourceMappingURL=lifecycle.d.ts.map