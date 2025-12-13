import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const SOCKET_FILE_NAME = '.tauri-mcp.sock';

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

export class SocketManager {
  private projectRoot: string;
  private socketPathProvider: SocketPathProvider | null = null;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
  }

  /**
   * Set the socket path provider function.
   * On Windows, this should return the detected pipe path from TauriManager.
   */
  setSocketPathProvider(provider: SocketPathProvider): void {
    this.socketPathProvider = provider;
  }

  private getSocketPath(): string {
    // If provider is set (Windows case), use it
    if (this.socketPathProvider) {
      return this.socketPathProvider();
    }

    // Unix: use socket file in project root
    if (process.platform !== 'win32') {
      return path.join(this.projectRoot, SOCKET_FILE_NAME);
    }

    // Windows fallback - should not happen if provider is set correctly
    throw new Error('Socket path provider not set. Call setSocketPathProvider() first on Windows.');
  }

  isConnected(): boolean {
    if (process.platform === 'win32') {
      // For Windows, we can't easily check named pipe existence
      // The provider being set indicates TauriManager detected the pipe
      return this.socketPathProvider !== null;
    }
    const socketPath = this.getSocketPath();
    return fs.existsSync(socketPath);
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socketPath = this.getSocketPath();

    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        const request: JsonRpcRequest = {
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        };

        // Rust server uses read_line which requires newline delimiter
        client.write(JSON.stringify(request) + '\n');
      });

      let data = '';

      client.on('data', (chunk) => {
        data += chunk.toString();

        // Try to parse complete JSON response
        try {
          const response: JsonRpcResponse = JSON.parse(data);
          client.end();

          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          // Incomplete JSON, wait for more data
        }
      });

      client.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('App not running. Use launch_app first.'));
        } else if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          reject(new Error('App is starting up. Please wait and try again.'));
        } else {
          reject(new Error(`Socket error: ${err.message}`));
        }
      });

      client.on('close', () => {
        if (!data) {
          reject(new Error('Connection closed without response'));
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        client.destroy();
        reject(new Error('Command timed out after 30 seconds'));
      }, 30000);
    });
  }

  async snapshot(): Promise<string> {
    const result = await this.sendCommand('snapshot') as { snapshot: string; title: string; url: string };
    // Format as readable output
    return `# ${result.title}\nURL: ${result.url}\n\n${result.snapshot}`;
  }

  async click(options: { ref?: number; selector?: string }): Promise<string> {
    const result = await this.sendCommand('click', options) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Click failed');
    }
    return `Clicked ${options.ref ? `ref=${options.ref}` : options.selector}`;
  }

  async fill(options: { ref?: number; selector?: string; value: string }): Promise<string> {
    const result = await this.sendCommand('fill', options) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Fill failed');
    }
    return `Filled ${options.ref ? `ref=${options.ref}` : options.selector} with "${options.value}"`;
  }

  async pressKey(key: string): Promise<string> {
    const result = await this.sendCommand('press_key', { key }) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Press key failed');
    }
    return `Pressed key: ${key}`;
  }

  async evaluateScript(script: string): Promise<unknown> {
    const result = await this.sendCommand('evaluate_script', { script });
    return result;
  }

  async screenshot(): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    const result = await this.sendCommand('screenshot') as { data: string; width: number; height: number };
    // data is a Data URL like "data:image/jpeg;base64,..."
    // Extract the base64 part and mime type
    const match = result.data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        data: match[2],
        mimeType: match[1],
        width: result.width,
        height: result.height,
      };
    }
    // Fallback: assume it's already raw base64
    return { ...result, mimeType: 'image/png' };
  }

  async navigate(url: string): Promise<string> {
    const result = await this.sendCommand('navigate', { url }) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Navigate failed');
    }
    return `Navigated to ${url}`;
  }

  async getConsoleLogs(clear?: boolean): Promise<unknown> {
    const result = await this.sendCommand('get_console_logs', { clear: clear ?? false });
    return result;
  }

  async getNetworkLogs(clear?: boolean): Promise<unknown> {
    const result = await this.sendCommand('get_network_logs', { clear: clear ?? false });
    return result;
  }
}
