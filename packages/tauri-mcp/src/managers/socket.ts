import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 500;

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

  /**
   * Verify connection by sending a ping command
   * More reliable than just checking socket file existence
   */
  async verifyConnection(): Promise<boolean> {
    try {
      const result = await this.sendCommandOnce('ping', {}) as { pong?: boolean };
      return result?.pong === true;
    } catch {
      return false;
    }
  }

  /**
   * Send command with retry logic for transient failures
   */
  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SocketManager.MAX_RETRIES; attempt++) {
      try {
        return await this.sendCommandOnce(method, params);
      } catch (error) {
        lastError = error as Error;
        const isRetryable = this.isRetryableError(lastError);

        if (!isRetryable || attempt === SocketManager.MAX_RETRIES) {
          throw lastError;
        }

        console.error(`[tauri-mcp] Command failed (attempt ${attempt}/${SocketManager.MAX_RETRIES}): ${lastError.message}`);
        await this.sleep(SocketManager.RETRY_DELAY_MS * attempt); // Exponential backoff
      }
    }

    throw lastError;
  }

  /**
   * Check if an error is retryable (transient connection issues)
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('epipe') ||
      message.includes('connection closed') ||
      message.includes('starting up')
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send a single command without retry
   */
  private async sendCommandOnce(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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

  // Multi-window support methods

  async listWindows(): Promise<{ windows: Array<{ label: string; title: string; focused: boolean; visible: boolean; size: { width: number; height: number } | null }> }> {
    const result = await this.sendCommand('list_windows') as { windows: Array<{ label: string; title: string; focused: boolean; visible: boolean; size: { width: number; height: number } | null }> };
    return result;
  }

  async focusWindow(windowLabel: string): Promise<string> {
    const result = await this.sendCommand('focus_window', { window: windowLabel }) as { focused: string };
    return `Focused window: ${result.focused}`;
  }

  async snapshot(options?: { window?: string }): Promise<string> {
    const params: Record<string, unknown> = {};
    if (options?.window) params.window = options.window;

    const result = await this.sendCommand('snapshot', params) as { window: string; snapshot: string; title: string; url: string };
    // Format as readable output with window label
    return `# [${result.window}] ${result.title}\nURL: ${result.url}\n\n${result.snapshot}`;
  }

  async click(options: { ref?: number; selector?: string; window?: string }): Promise<string> {
    const result = await this.sendCommand('click', options) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Click failed');
    }
    const target = options.ref ? `ref=${options.ref}` : options.selector;
    const windowInfo = options.window ? ` in window '${options.window}'` : '';
    return `Clicked ${target}${windowInfo}`;
  }

  async fill(options: { ref?: number; selector?: string; value: string; window?: string }): Promise<string> {
    const result = await this.sendCommand('fill', options) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Fill failed');
    }
    const target = options.ref ? `ref=${options.ref}` : options.selector;
    const windowInfo = options.window ? ` in window '${options.window}'` : '';
    return `Filled ${target} with "${options.value}"${windowInfo}`;
  }

  async pressKey(key: string, windowLabel?: string): Promise<string> {
    const params: Record<string, unknown> = { key };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('press_key', params) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Press key failed');
    }
    const windowInfo = windowLabel ? ` in window '${windowLabel}'` : '';
    return `Pressed key: ${key}${windowInfo}`;
  }

  async evaluateScript(script: string, windowLabel?: string): Promise<unknown> {
    const params: Record<string, unknown> = { script };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('evaluate_script', params);
    return result;
  }

  async screenshot(options?: { window?: string }): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    // On macOS, use screencapture command which doesn't require Screen Recording permission
    // when capturing by window ID (the app captures its own window)
    if (os.platform() === 'darwin') {
      return this.screenshotMacOS(options);
    }

    // On other platforms, use native screenshot via Rust
    return this.screenshotNative(options);
  }

  private async screenshotMacOS(options?: { window?: string }): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    // Get window ID from Tauri app
    const params: Record<string, unknown> = {};
    if (options?.window) params.window = options.window;

    const windowInfo = await this.sendCommand('get_window_id', params) as { window_id: number; pid: number };
    const windowId = windowInfo.window_id;

    // Create temp file for screenshot
    const tmpFile = path.join(os.tmpdir(), `tauri-mcp-screenshot-${Date.now()}.png`);

    try {
      // Use screencapture command with window ID
      // -l<windowid>: capture specific window
      // -x: no sound
      // -o: no shadow
      await execFileAsync('screencapture', [
        `-l${windowId}`,
        '-x',
        '-o',
        tmpFile
      ]);

      // Read the file and convert to base64
      const imageBuffer = fs.readFileSync(tmpFile);
      const base64Data = imageBuffer.toString('base64');

      // Get image dimensions (basic PNG header parsing)
      // PNG dimensions are at bytes 16-23 (width: 16-19, height: 20-23)
      let width = 0;
      let height = 0;
      if (imageBuffer.length > 24 && imageBuffer.toString('ascii', 1, 4) === 'PNG') {
        width = imageBuffer.readUInt32BE(16);
        height = imageBuffer.readUInt32BE(20);
      }

      return {
        data: base64Data,
        mimeType: 'image/png',
        width,
        height
      };
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private async screenshotNative(options?: { window?: string }): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    const params: Record<string, unknown> = {};
    if (options?.window) params.window = options.window;

    const result = await this.sendCommand('screenshot', params) as { data: string; width: number; height: number };
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

  async navigate(url: string, windowLabel?: string): Promise<string> {
    const params: Record<string, unknown> = { url };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('navigate', params) as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'Navigate failed');
    }
    const windowInfo = windowLabel ? ` in window '${windowLabel}'` : '';
    return `Navigated to ${url}${windowInfo}`;
  }

  async getConsoleLogs(clear?: boolean, windowLabel?: string): Promise<unknown> {
    const params: Record<string, unknown> = { clear: clear ?? false };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('get_console_logs', params);
    return result;
  }

  async getNetworkLogs(clear?: boolean, windowLabel?: string): Promise<unknown> {
    const params: Record<string, unknown> = { clear: clear ?? false };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('get_network_logs', params);
    return result;
  }

  async getFrontendLogs(clear?: boolean, windowLabel?: string): Promise<{
    consoleLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number }>;
    buildLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number; details?: { file?: string; line?: number; column?: number } }>;
    networkLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number; details?: { url?: string; method?: string; status?: number; duration?: number } }>;
    hmrStatus: { connected: boolean; status: string; lastSuccess: number | null };
  }> {
    const params: Record<string, unknown> = { clear: clear ?? false };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('get_frontend_logs', params);
    return result as {
      consoleLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number }>;
      buildLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number; details?: { file?: string; line?: number; column?: number } }>;
      networkLogs: Array<{ source: string; category: string; level: string; message: string; timestamp: number; details?: { url?: string; method?: string; status?: number; duration?: number } }>;
      hmrStatus: { connected: boolean; status: string; lastSuccess: number | null };
    };
  }

  async getHmrUpdates(clear?: boolean, windowLabel?: string): Promise<{
    updates: Array<{ type: 'hmr-update' | 'full-reload'; files: string[]; timestamp: number }>;
  }> {
    const params: Record<string, unknown> = { clear: clear ?? false };
    if (windowLabel) params.window = windowLabel;

    const result = await this.sendCommand('get_hmr_updates', params);
    return result as {
      updates: Array<{ type: 'hmr-update' | 'full-reload'; files: string[]; timestamp: number }>;
    };
  }
}
