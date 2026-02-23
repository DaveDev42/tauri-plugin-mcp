import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TauriManager } from './tauri.js';
const execFileAsync = promisify(execFile);
const SOCKET_FILE_NAME = '.tauri-mcp.sock';
export class SocketManager {
    projectRoot;
    socketPathProvider = null;
    static MAX_RETRIES = 3;
    static RETRY_DELAY_MS = 500;
    constructor(projectRoot) {
        this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
    }
    /**
     * Set the socket path provider function.
     * On Windows, this should return the detected pipe path from TauriManager.
     */
    setSocketPathProvider(provider) {
        this.socketPathProvider = provider;
    }
    getSocketPath() {
        // If provider is set (Windows case), use it
        if (this.socketPathProvider) {
            return this.socketPathProvider();
        }
        // Unix: use socket file in project root (with SUN_LEN fallback)
        if (process.platform !== 'win32') {
            return TauriManager.getUnixSocketPath(this.projectRoot);
        }
        // Windows fallback - should not happen if provider is set correctly
        throw new Error('Socket path provider not set. Call setSocketPathProvider() first on Windows.');
    }
    isConnected() {
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
    async verifyConnection() {
        try {
            const result = await this.sendCommandOnce('ping', {});
            return result?.pong === true;
        }
        catch {
            return false;
        }
    }
    /**
     * Send command with retry logic for transient failures
     */
    async sendCommand(method, params = {}) {
        let lastError = null;
        for (let attempt = 1; attempt <= SocketManager.MAX_RETRIES; attempt++) {
            try {
                return await this.sendCommandOnce(method, params);
            }
            catch (error) {
                lastError = error;
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
    isRetryableError(error) {
        const message = error.message.toLowerCase();
        return (message.includes('econnrefused') ||
            message.includes('econnreset') ||
            message.includes('epipe') ||
            message.includes('connection closed') ||
            message.includes('starting up'));
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Send a single command without retry
     */
    async sendCommandOnce(method, params = {}) {
        const socketPath = this.getSocketPath();
        return new Promise((resolve, reject) => {
            const client = net.createConnection(socketPath, () => {
                const request = {
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
                    const response = JSON.parse(data);
                    client.end();
                    if (response.error) {
                        reject(new Error(response.error.message));
                    }
                    else {
                        resolve(response.result);
                    }
                }
                catch (e) {
                    // Incomplete JSON, wait for more data
                }
            });
            client.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    reject(new Error('App not running. Use launch_app first.'));
                }
                else if (err.code === 'ECONNREFUSED') {
                    reject(new Error('App is starting up. Please wait and try again.'));
                }
                else {
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
    async listWindows() {
        const result = await this.sendCommand('list_windows');
        return result;
    }
    async probeBridge(windowLabel) {
        const params = {};
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('probe_bridge', params);
        return result.windows;
    }
    async focusWindow(windowLabel) {
        const result = await this.sendCommand('focus_window', { window: windowLabel });
        return `Focused window: ${result.focused}`;
    }
    async snapshot(options) {
        const params = {};
        if (options?.window)
            params.window = options.window;
        const result = await this.sendCommand('snapshot', params);
        // Format as readable output with window label
        return `# [${result.window}] ${result.title}\nURL: ${result.url}\n\n${result.snapshot}`;
    }
    async click(options) {
        const result = await this.sendCommand('click', options);
        if (!result.success) {
            throw new Error(result.error || 'Click failed');
        }
        const target = options.ref ? `ref=${options.ref}` : options.selector;
        const windowInfo = options.window ? ` in window '${options.window}'` : '';
        return `Clicked ${target}${windowInfo}`;
    }
    async fill(options) {
        const result = await this.sendCommand('fill', options);
        if (!result.success) {
            throw new Error(result.error || 'Fill failed');
        }
        const target = options.ref ? `ref=${options.ref}` : options.selector;
        const windowInfo = options.window ? ` in window '${options.window}'` : '';
        return `Filled ${target} with "${options.value}"${windowInfo}`;
    }
    async pressKey(key, windowLabel) {
        const params = { key };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('press_key', params);
        if (!result.success) {
            throw new Error(result.error || 'Press key failed');
        }
        const windowInfo = windowLabel ? ` in window '${windowLabel}'` : '';
        return `Pressed key: ${key}${windowInfo}`;
    }
    async evaluateScript(script, windowLabel) {
        const params = { script };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('evaluate_script', params);
        return result;
    }
    async screenshot(options) {
        // On macOS, try screencapture CLI first (no Screen Recording permission needed)
        // If it fails, fall through to native xcap capture
        if (os.platform() === 'darwin') {
            try {
                return await this.screenshotMacOS(options);
            }
            catch {
                // screencapture CLI failed, fall through to native
            }
        }
        return this.screenshotNative(options);
    }
    async screenshotMacOS(options) {
        // Get window ID from Tauri app
        // The Rust side closes DevTools if open and returns devtools_was_open flag
        const params = {};
        if (options?.window)
            params.window = options.window;
        const windowInfo = await this.sendCommand('get_window_id', params);
        const windowId = windowInfo.window_id;
        const devtoolsWasOpen = windowInfo.devtools_was_open;
        // Create temp file for screenshot
        const tmpFile = path.join(os.tmpdir(), `tauri-mcp-screenshot-${process.pid}-${crypto.randomUUID()}.png`);
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
        }
        finally {
            // Restore DevTools if they were open before screenshot
            if (devtoolsWasOpen) {
                try {
                    await this.sendCommand('restore_devtools', params);
                }
                catch {
                    // Ignore restore errors — DevTools restoration is best-effort
                }
            }
            // Clean up temp file
            try {
                fs.unlinkSync(tmpFile);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
    async screenshotNative(options) {
        const params = {};
        if (options?.window)
            params.window = options.window;
        const result = await this.sendCommand('screenshot', params);
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
    async navigate(url, windowLabel) {
        const params = { url };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('navigate', params);
        if (!result.success) {
            throw new Error(result.error || 'Navigate failed');
        }
        const windowInfo = windowLabel ? ` in window '${windowLabel}'` : '';
        return `Navigated to ${url}${windowInfo}`;
    }
    async getConsoleLogs(clear, windowLabel) {
        const params = { clear: clear ?? false };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('get_console_logs', params);
        return result;
    }
    async getNetworkLogs(clear, windowLabel) {
        const params = { clear: clear ?? false };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('get_network_logs', params);
        return result;
    }
    async getFrontendLogs(clear, windowLabel) {
        const params = { clear: clear ?? false };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('get_frontend_logs', params);
        return result;
    }
    async setTitlePrefix(prefix) {
        const result = await this.sendCommand('set_title_prefix', { prefix });
        return result;
    }
    async getHmrUpdates(clear, windowLabel) {
        const params = { clear: clear ?? false };
        if (windowLabel)
            params.window = windowLabel;
        const result = await this.sendCommand('get_hmr_updates', params);
        return result;
    }
}
//# sourceMappingURL=socket.js.map