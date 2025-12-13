import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
const SOCKET_FILE_NAME = '.tauri-mcp.sock';
export class SocketManager {
    projectRoot;
    socketPathProvider = null;
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
        // Unix: use socket file in project root
        if (process.platform !== 'win32') {
            return path.join(this.projectRoot, SOCKET_FILE_NAME);
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
    async sendCommand(method, params = {}) {
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
    async snapshot() {
        const result = await this.sendCommand('snapshot');
        // Format as readable output
        return `# ${result.title}\nURL: ${result.url}\n\n${result.snapshot}`;
    }
    async click(options) {
        const result = await this.sendCommand('click', options);
        if (!result.success) {
            throw new Error(result.error || 'Click failed');
        }
        return `Clicked ${options.ref ? `ref=${options.ref}` : options.selector}`;
    }
    async fill(options) {
        const result = await this.sendCommand('fill', options);
        if (!result.success) {
            throw new Error(result.error || 'Fill failed');
        }
        return `Filled ${options.ref ? `ref=${options.ref}` : options.selector} with "${options.value}"`;
    }
    async pressKey(key) {
        const result = await this.sendCommand('press_key', { key });
        if (!result.success) {
            throw new Error(result.error || 'Press key failed');
        }
        return `Pressed key: ${key}`;
    }
    async evaluateScript(script) {
        const result = await this.sendCommand('evaluate_script', { script });
        return result;
    }
    async screenshot() {
        const result = await this.sendCommand('screenshot');
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
    async navigate(url) {
        const result = await this.sendCommand('navigate', { url });
        if (!result.success) {
            throw new Error(result.error || 'Navigate failed');
        }
        return `Navigated to ${url}`;
    }
    async getConsoleLogs() {
        const result = await this.sendCommand('get_console_logs');
        return result;
    }
    async getNetworkLogs() {
        const result = await this.sendCommand('get_network_logs');
        return result;
    }
}
//# sourceMappingURL=socket.js.map