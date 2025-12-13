import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
const SOCKET_FILE_NAME = '.tauri-mcp.sock';
export class TauriManager {
    process = null;
    status = 'not_running';
    projectRoot;
    appConfig = null;
    vitePort;
    outputBuffer = [];
    detectedPipePath = null;
    constructor(projectRoot) {
        this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
        this.appConfig = this.detectTauriApp();
        this.vitePort = this.detectExistingPort() ?? this.generatePort(this.projectRoot);
    }
    detectExistingPort() {
        if (!this.appConfig)
            return null;
        // Try to read port from existing tauri.conf.json
        const tauriConfPath = path.join(this.appConfig.appDir, 'src-tauri', 'tauri.conf.json');
        if (fs.existsSync(tauriConfPath)) {
            try {
                const content = fs.readFileSync(tauriConfPath, 'utf-8');
                const config = JSON.parse(content);
                const devUrl = config?.build?.devUrl;
                if (devUrl) {
                    const match = devUrl.match(/:(\d+)/);
                    if (match) {
                        const port = parseInt(match[1], 10);
                        console.error(`[tauri-mcp] Using existing devUrl port: ${port}`);
                        return port;
                    }
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        return null;
    }
    generatePort(projectPath) {
        // Simple hash for port generation
        const normalizedPath = path.resolve(projectPath);
        let hash = 0;
        for (let i = 0; i < normalizedPath.length; i++) {
            const char = normalizedPath.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return 10000 + (Math.abs(hash) % 50000);
    }
    detectTauriApp() {
        // Search for src-tauri/Cargo.toml at various depths
        const searchPaths = [
            path.join(this.projectRoot, 'src-tauri', 'Cargo.toml'),
            path.join(this.projectRoot, '..', 'src-tauri', 'Cargo.toml'),
            ...this.findCargoTomlRecursive(this.projectRoot, 3),
        ];
        for (const cargoPath of searchPaths) {
            if (fs.existsSync(cargoPath)) {
                try {
                    const config = this.parseCargoToml(cargoPath);
                    if (config) {
                        console.error(`[tauri-mcp] Detected Tauri app: ${config.packageName} at ${config.appDir}`);
                        return config;
                    }
                }
                catch (e) {
                    // Continue searching
                }
            }
        }
        return null;
    }
    findCargoTomlRecursive(dir, depth) {
        if (depth <= 0)
            return [];
        const results = [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'target') {
                    const subDir = path.join(dir, entry.name);
                    if (entry.name === 'src-tauri') {
                        const cargoPath = path.join(subDir, 'Cargo.toml');
                        if (fs.existsSync(cargoPath)) {
                            results.push(cargoPath);
                        }
                    }
                    else {
                        results.push(...this.findCargoTomlRecursive(subDir, depth - 1));
                    }
                }
            }
        }
        catch (e) {
            // Permission denied or other errors
        }
        return results;
    }
    parseCargoToml(cargoPath) {
        const content = fs.readFileSync(cargoPath, 'utf-8');
        // Simple TOML parsing for package name and binary name
        let packageName = '';
        let binaryName = '';
        // Parse [package] name
        const packageMatch = content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
        if (packageMatch) {
            packageName = packageMatch[1];
        }
        // Parse [[bin]] name or use package name
        const binMatch = content.match(/\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/);
        if (binMatch) {
            binaryName = binMatch[1];
        }
        else {
            binaryName = packageName;
        }
        if (!packageName) {
            return null;
        }
        const srcTauriDir = path.dirname(cargoPath);
        const appDir = path.dirname(srcTauriDir);
        return {
            appDir,
            binaryName,
            packageName,
        };
    }
    /**
     * Get the socket path - uses detected path from Rust logs on Windows
     */
    getSocketPath() {
        if (process.platform === 'win32') {
            // Use detected pipe path from Rust plugin logs if available
            if (this.detectedPipePath) {
                return this.detectedPipePath;
            }
            // Fallback: calculate pipe path using same algorithm as Rust
            const pipePath = this.calculateWindowsPipePath();
            if (pipePath) {
                return pipePath;
            }
            console.error('[tauri-mcp] Warning: pipe path not yet detected');
            return '\\\\.\\pipe\\tauri-mcp-unknown';
        }
        // Unix socket file in project root
        return path.join(this.projectRoot, SOCKET_FILE_NAME);
    }
    /**
     * Find Windows named pipe matching tauri-mcp-* pattern
     * Since calculating the exact hash is complex, we enumerate existing pipes
     */
    calculateWindowsPipePath() {
        try {
            // List all pipes using fs.readdirSync
            const pipes = fs.readdirSync('//./pipe/').filter((f) => f.startsWith('tauri-mcp-'));
            if (pipes.length > 0) {
                return `//./pipe/${pipes[0]}`;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * Parse pipe path from Rust plugin output
     * Looks for: [stderr] [tauri-plugin-mcp]   full_path: \\.\pipe\tauri-mcp-XXXXX
     */
    parsePipePathFromLogs() {
        for (const line of this.outputBuffer) {
            // Match the full_path line from Rust debug output (with [stderr] prefix)
            const match = line.match(/\[tauri-plugin-mcp\]\s+full_path:\s*(\\\\\.\\pipe\\[^\s]+)/);
            if (match) {
                return match[1];
            }
        }
        return null;
    }
    isSocketReady() {
        if (process.platform === 'win32') {
            // For Windows named pipes, we need async check - this is a sync fallback
            // The real check happens in isSocketReadyAsync
            return false;
        }
        const socketPath = this.getSocketPath();
        return fs.existsSync(socketPath);
    }
    async isSocketReadyAsync() {
        // First try to parse pipe path from logs
        let pipePath = this.parsePipePathFromLogs();
        // If not found in logs, calculate the path
        if (!pipePath) {
            pipePath = this.calculateWindowsPipePath();
        }
        if (!pipePath) {
            return false;
        }
        // Store detected path for later use
        this.detectedPipePath = pipePath;
        return new Promise((resolve) => {
            const client = net.createConnection(pipePath, () => {
                client.destroy();
                resolve(true);
            });
            client.on('error', () => {
                resolve(false);
            });
            // Timeout after 1 second
            setTimeout(() => {
                client.destroy();
                resolve(false);
            }, 1000);
        });
    }
    async launch(options = {}) {
        const waitForReady = options.wait_for_ready ?? true;
        const timeoutSecs = options.timeout_secs ?? 60;
        const features = options.features ?? [];
        if (!this.appConfig) {
            throw new Error('No Tauri app detected. Make sure src-tauri/Cargo.toml exists.');
        }
        if (this.process) {
            throw new Error('App is already running. Stop it first.');
        }
        // Reset detected pipe path
        this.detectedPipePath = null;
        // Clean up stale socket file (Unix only)
        if (process.platform !== 'win32') {
            const socketPath = this.getSocketPath();
            if (fs.existsSync(socketPath)) {
                fs.unlinkSync(socketPath);
            }
        }
        console.error(`[tauri-mcp] Launching app with Vite port ${this.vitePort}...`);
        // Build tauri dev command with optional features
        const tauriArgs = ['tauri', 'dev'];
        if (features.length > 0) {
            tauriArgs.push('--features', features.join(','));
        }
        console.error(`[tauri-mcp] Command: pnpm ${tauriArgs.join(' ')}`);
        this.process = spawn('pnpm', tauriArgs, {
            cwd: this.appConfig.appDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                TAURI_MCP_PROJECT_ROOT: this.projectRoot,
                VITE_PORT: this.vitePort.toString(),
            },
            detached: false,
            shell: process.platform === 'win32',
        });
        this.status = 'starting';
        // Reset output buffer for this launch
        this.outputBuffer = [];
        this.process.stdout?.on('data', (data) => {
            const line = data.toString().trim();
            console.error(`[tauri stdout] ${line}`);
            this.outputBuffer.push(`[stdout] ${line}`);
            // Keep only last 100 lines
            if (this.outputBuffer.length > 100)
                this.outputBuffer.shift();
        });
        this.process.stderr?.on('data', (data) => {
            const line = data.toString().trim();
            console.error(`[tauri stderr] ${line}`);
            this.outputBuffer.push(`[stderr] ${line}`);
            if (this.outputBuffer.length > 100)
                this.outputBuffer.shift();
        });
        this.process.on('exit', (code) => {
            console.error(`[tauri-mcp] Process exited with code ${code}`);
            this.outputBuffer.push(`[exit] Process exited with code ${code}`);
            this.process = null;
            this.status = 'not_running';
        });
        if (waitForReady) {
            await this.waitForReady(timeoutSecs);
        }
        this.status = 'running';
        return { message: 'App is ready', port: this.vitePort };
    }
    async waitForReady(timeoutSecs) {
        const startTime = Date.now();
        const timeoutMs = timeoutSecs * 1000;
        while (Date.now() - startTime < timeoutMs) {
            // Check if process crashed
            if (!this.process) {
                const logs = this.getRecentLogs();
                throw new Error(`App process exited unexpectedly\n\n${logs}`);
            }
            // Check if socket is ready (use async check for Windows named pipes)
            const socketReady = process.platform === 'win32'
                ? await this.isSocketReadyAsync()
                : this.isSocketReady();
            if (socketReady) {
                // Give it a moment to fully initialize
                await this.sleep(500);
                return;
            }
            await this.sleep(500);
        }
        const logs = this.getRecentLogs();
        throw new Error(`App did not become ready within ${timeoutSecs} seconds\n\n${logs}`);
    }
    getRecentLogs() {
        if (this.outputBuffer.length === 0) {
            return '(no output captured)';
        }
        // Return last 20 lines
        return this.outputBuffer.slice(-20).join('\n');
    }
    async stop() {
        // Clean up socket file (Unix only)
        if (process.platform !== 'win32') {
            const socketPath = this.getSocketPath();
            if (fs.existsSync(socketPath)) {
                try {
                    fs.unlinkSync(socketPath);
                }
                catch (e) {
                    // Ignore
                }
            }
        }
        if (!this.process) {
            return { message: 'App was not running' };
        }
        return new Promise((resolve) => {
            const proc = this.process;
            proc.on('exit', () => {
                this.process = null;
                this.status = 'not_running';
                this.detectedPipePath = null;
                resolve({ message: 'App stopped' });
            });
            // Send SIGTERM
            if (process.platform !== 'win32') {
                // Kill process group on Unix
                try {
                    process.kill(-proc.pid, 'SIGTERM');
                }
                catch (e) {
                    proc.kill('SIGTERM');
                }
            }
            else {
                // On Windows, kill the app binary first, then the process tree
                // This ensures the actual Tauri app is terminated even if process tree fails
                this.cleanupOrphanProcesses();
                if (proc.pid) {
                    spawn('taskkill', ['/PID', proc.pid.toString(), '/T', '/F'], {
                        stdio: 'ignore',
                        shell: true,
                    });
                }
                proc.kill('SIGTERM');
            }
            // Force kill after 5 seconds
            setTimeout(() => {
                if (this.process === proc) {
                    proc.kill('SIGKILL');
                    this.cleanupOrphanProcesses();
                    this.process = null;
                    this.status = 'not_running';
                    this.detectedPipePath = null;
                    resolve({ message: 'App force stopped' });
                }
            }, 5000);
        });
    }
    cleanupOrphanProcesses() {
        if (!this.appConfig)
            return;
        if (process.platform === 'win32') {
            // On Windows, try to kill by binary name
            try {
                spawn('taskkill', ['/IM', `${this.appConfig.binaryName}.exe`, '/F'], {
                    stdio: 'ignore',
                    shell: true,
                });
            }
            catch (e) {
                // Ignore errors
            }
        }
        else {
            try {
                // Kill by binary name
                spawn('pkill', ['-9', this.appConfig.binaryName], { stdio: 'ignore' });
                // Kill tauri dev processes for this directory
                const pattern = `tauri dev.*${this.appConfig.appDir.replace(/\//g, '\\/')}`;
                spawn('pkill', ['-9', '-f', pattern], { stdio: 'ignore' });
            }
            catch (e) {
                // Ignore errors
            }
        }
    }
    getStatus() {
        if (this.process) {
            if (this.detectedPipePath || this.isSocketReady()) {
                this.status = 'running';
            }
            else {
                this.status = 'starting';
            }
        }
        else {
            this.status = 'not_running';
        }
        return this.status;
    }
    getAppConfig() {
        return this.appConfig;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=tauri.js.map