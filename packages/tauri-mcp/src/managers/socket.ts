import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

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

export class SocketManager {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
  }

  private getSocketPath(): string {
    if (process.platform === 'win32') {
      // Windows named pipe
      const hash = createHash('sha256').update(this.projectRoot).digest('hex').substring(0, 16);
      return `\\\\.\\pipe\\tauri-mcp-${hash}`;
    }
    return path.join(this.projectRoot, SOCKET_FILE_NAME);
  }

  isConnected(): boolean {
    const socketPath = this.getSocketPath();
    if (process.platform === 'win32') {
      // For Windows, we can't easily check named pipe existence
      return true;
    }
    return fs.existsSync(socketPath);
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socketPath = this.getSocketPath();

    if (!this.isConnected()) {
      throw new Error('App not running. Use launch_app first.');
    }

    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        const request: JsonRpcRequest = {
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        };

        client.write(JSON.stringify(request));
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
    const result = await this.sendCommand('snapshot');
    return result as string;
  }

  async click(options: { ref?: number; selector?: string }): Promise<string> {
    const result = await this.sendCommand('click', options);
    return result as string;
  }

  async fill(options: { ref?: number; selector?: string; value: string }): Promise<string> {
    const result = await this.sendCommand('fill', options);
    return result as string;
  }

  async pressKey(key: string): Promise<string> {
    const result = await this.sendCommand('press_key', { key });
    return result as string;
  }

  async evaluateScript(script: string): Promise<unknown> {
    const result = await this.sendCommand('evaluate_script', { script });
    return result;
  }

  async screenshot(): Promise<string> {
    const result = await this.sendCommand('screenshot');
    return result as string;
  }

  async navigate(url: string): Promise<string> {
    const result = await this.sendCommand('navigate', { url });
    return result as string;
  }

  async getConsoleLogs(): Promise<unknown[]> {
    const result = await this.sendCommand('get_console_logs');
    return result as unknown[];
  }

  async getNetworkLogs(): Promise<unknown[]> {
    const result = await this.sendCommand('get_network_logs');
    return result as unknown[];
  }
}
