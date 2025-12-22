import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

export interface TauriAppConfig {
  appDir: string;
  binaryName: string;
  packageName: string;
}

export type AppStatus = 'not_running' | 'starting' | 'running';

export type BuildHealthStatus = 'healthy' | 'error' | 'unknown';

export interface LaunchOptions {
  wait_for_ready?: boolean;
  timeout_secs?: number;
  features?: string[];
  devtools?: boolean;
}

export interface LaunchResult {
  status: 'launched' | 'already_running' | 'build_error';
  message: string;
  port: number;
  buildHealth: {
    frontend: BuildHealthStatus;
    backend: BuildHealthStatus;
  };
  errors?: LogEntry[];
}

export interface LogEntry {
  source: 'console' | 'network' | 'vite' | 'typescript' | 'rust' | 'tauri';
  category: 'build-frontend' | 'build-backend' | 'runtime-frontend' | 'runtime-backend' | 'runtime-frontend-network';
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  timestamp: number;
  details?: {
    file?: string;
    line?: number;
    column?: number;
    stack?: string;
    url?: string;
    method?: string;
    status?: number;
    duration?: number;
  };
}

const SOCKET_FILE_NAME = '.tauri-mcp.sock';

export class TauriManager {
  private process: ChildProcess | null = null;
  private status: AppStatus = 'not_running';
  private projectRoot: string;
  private appConfig: TauriAppConfig | null = null;
  private vitePort: number;
  private outputBuffer: string[] = [];
  private detectedPipePath: string | null = null;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
    this.appConfig = this.detectTauriApp();
    this.vitePort = this.detectExistingPort() ?? this.generatePort(this.projectRoot);
  }

  private detectExistingPort(): number | null {
    if (!this.appConfig) return null;

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
      } catch (e) {
        // Ignore parse errors
      }
    }
    return null;
  }

  private generatePort(projectPath: string): number {
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

  private detectTauriApp(): TauriAppConfig | null {
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
        } catch (e) {
          // Continue searching
        }
      }
    }

    return null;
  }

  private findCargoTomlRecursive(dir: string, depth: number): string[] {
    if (depth <= 0) return [];

    const results: string[] = [];
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
          } else {
            results.push(...this.findCargoTomlRecursive(subDir, depth - 1));
          }
        }
      }
    } catch (e) {
      // Permission denied or other errors
    }
    return results;
  }

  private parseCargoToml(cargoPath: string): TauriAppConfig | null {
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
    } else {
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
   * Get the socket path - uses appDir where the Tauri app actually runs
   * On Windows, uses detected path from Rust logs
   */
  getSocketPath(): string {
    // Use appDir instead of projectRoot - this is where Rust plugin creates the socket
    const socketDir = this.appConfig?.appDir ?? this.projectRoot;

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
    // Unix socket file in app directory (where Rust plugin runs)
    return path.join(socketDir, SOCKET_FILE_NAME);
  }

  /**
   * Find Windows named pipe matching tauri-mcp-* pattern
   * Since calculating the exact hash is complex, we enumerate existing pipes
   */
  private calculateWindowsPipePath(): string | null {
    try {
      // List all pipes using fs.readdirSync
      const pipes = fs.readdirSync('//./pipe/').filter((f: string) => f.startsWith('tauri-mcp-'));
      if (pipes.length > 0) {
        return `//./pipe/${pipes[0]}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse pipe path from Rust plugin output
   * Looks for: [stderr] [tauri-plugin-mcp]   full_path: \\.\pipe\tauri-mcp-XXXXX
   */
  private parsePipePathFromLogs(): string | null {
    for (const line of this.outputBuffer) {
      // Match the full_path line from Rust debug output (with [stderr] prefix)
      const match = line.match(/\[tauri-plugin-mcp\]\s+full_path:\s*(\\\\\.\\pipe\\[^\s]+)/);
      if (match) {
        return match[1];
      }
    }
    return null;
  }

  private isSocketReady(): boolean {
    if (process.platform === 'win32') {
      // For Windows named pipes, we need async check - this is a sync fallback
      // The real check happens in isSocketReadyAsync
      return false;
    }
    const socketPath = this.getSocketPath();
    return fs.existsSync(socketPath);
  }

  private async isSocketReadyAsync(): Promise<boolean> {
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

  /**
   * Check if Rust build cache exists (incremental build will be fast)
   */
  private hasBuildCache(): boolean {
    if (!this.appConfig) return false;

    const targetDir = path.join(this.appConfig.appDir, 'src-tauri', 'target', 'debug');
    const binaryPath = process.platform === 'win32'
      ? path.join(targetDir, `${this.appConfig.binaryName}.exe`)
      : path.join(targetDir, this.appConfig.binaryName);

    return fs.existsSync(binaryPath);
  }

  async launch(options: LaunchOptions = {}): Promise<LaunchResult> {
    const waitForReady = options.wait_for_ready ?? true;
    const devtools = options.devtools ?? false;

    // Handle features as string or array (MCP may pass string)
    let features: string[] = [];
    if (options.features) {
      if (Array.isArray(options.features)) {
        features = options.features;
      } else if (typeof options.features === 'string') {
        features = (options.features as string).split(',').map(f => f.trim()).filter(Boolean);
      }
    }

    // Always add dev-tools feature for MCP plugin to work
    // (devtools option controls whether to open devtools, but feature is always needed)
    if (!features.includes('dev-tools')) {
      features.push('dev-tools');
    }

    if (!this.appConfig) {
      throw new Error('No Tauri app detected. Make sure src-tauri/Cargo.toml exists.');
    }

    // Idempotent: if already running, return current status
    if (this.process) {
      const errors = this.parseBackendLogs(this.outputBuffer);
      const backendHealth = errors.some(e => e.level === 'error') ? 'error' as const : 'healthy' as const;
      return {
        status: 'already_running',
        message: 'App is already running',
        port: this.vitePort,
        buildHealth: {
          frontend: 'unknown', // Will be determined by frontend logs
          backend: backendHealth,
        },
        errors: errors.filter(e => e.level === 'error'),
      };
    }

    // Determine timeout based on build cache existence
    // Fresh build: 300 seconds (5 minutes), Incremental build: 60 seconds
    const hasCachedBuild = this.hasBuildCache();
    const defaultTimeout = hasCachedBuild ? 60 : 300;
    const timeoutSecs = options.timeout_secs ?? defaultTimeout;

    console.error(`[tauri-mcp] Build cache ${hasCachedBuild ? 'found' : 'not found'}, using ${timeoutSecs}s timeout`);

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
    console.error(`[tauri-mcp] Socket will be at: ${this.getSocketPath()}`);
    this.process = spawn('pnpm', tauriArgs, {
      cwd: this.appConfig.appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Use appDir as project root for Rust plugin - this is where socket will be created
        TAURI_MCP_PROJECT_ROOT: this.appConfig.appDir,
        TAURI_MCP_DEVTOOLS: devtools ? '1' : '',
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
      if (this.outputBuffer.length > 100) this.outputBuffer.shift();
    });

    this.process.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      console.error(`[tauri stderr] ${line}`);
      this.outputBuffer.push(`[stderr] ${line}`);
      if (this.outputBuffer.length > 100) this.outputBuffer.shift();
    });

    this.process.on('exit', (code) => {
      console.error(`[tauri-mcp] Process exited with code ${code}`);
      this.outputBuffer.push(`[exit] Process exited with code ${code}`);
      this.process = null;
      this.status = 'not_running';
    });

    if (waitForReady) {
      try {
        await this.waitForReady(timeoutSecs);
        const errors = this.parseBackendLogs(this.outputBuffer);
        const hasErrors = errors.some(e => e.level === 'error');
        this.status = 'running';
        return {
          status: hasErrors ? 'build_error' : 'launched',
          message: hasErrors ? 'App started with build errors' : 'App is ready',
          port: this.vitePort,
          buildHealth: {
            frontend: 'unknown', // Will be determined by frontend logs
            backend: hasErrors ? 'error' : 'healthy',
          },
          errors: hasErrors ? errors.filter(e => e.level === 'error') : undefined,
        };
      } catch (e) {
        // Timeout or crash - still return useful info
        const errors = this.parseBackendLogs(this.outputBuffer);
        return {
          status: 'build_error',
          message: e instanceof Error ? e.message : 'Build failed',
          port: this.vitePort,
          buildHealth: {
            frontend: 'unknown',
            backend: 'error',
          },
          errors: errors.filter(e => e.level === 'error'),
        };
      }
    }

    this.status = 'running';
    return {
      status: 'launched',
      message: 'App launched (not waiting for ready)',
      port: this.vitePort,
      buildHealth: {
        frontend: 'unknown',
        backend: 'unknown',
      },
    };
  }

  private async waitForReady(timeoutSecs: number): Promise<void> {
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
        // Socket exists, now verify the app is actually ready by sending a ping
        // This ensures: 1) Handler is set, 2) JS Bridge is initialized
        const pingSuccess = await this.verifyAppReady();
        if (pingSuccess) {
          console.error('[tauri-mcp] App is fully ready (ping successful)');
          return;
        }
        // Ping failed, app not fully ready yet
        console.error('[tauri-mcp] Socket ready but ping failed, waiting...');
      }

      await this.sleep(500);
    }

    const logs = this.getRecentLogs();
    throw new Error(`App did not become ready within ${timeoutSecs} seconds\n\n${logs}`);
  }

  /**
   * Verify the app is fully ready by sending a ping command
   * Returns true if ping succeeds, false otherwise
   */
  private async verifyAppReady(): Promise<boolean> {
    const socketPath = this.getSocketPath();

    return new Promise((resolve) => {
      const client = net.createConnection(socketPath, () => {
        const request = {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'ping',
          params: {},
        };

        client.write(JSON.stringify(request) + '\n');
      });

      let data = '';

      client.on('data', (chunk) => {
        data += chunk.toString();
        try {
          const response = JSON.parse(data);
          client.end();
          // Check if ping was successful (pong: true)
          if (response.result?.pong === true) {
            resolve(true);
          } else if (response.error) {
            // Handler returned an error (e.g., not initialized)
            resolve(false);
          } else {
            resolve(false);
          }
        } catch {
          // Incomplete JSON, wait for more data
        }
      });

      client.on('error', () => {
        resolve(false);
      });

      client.on('close', () => {
        if (!data) {
          resolve(false);
        }
      });

      // Timeout after 2 seconds
      setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 2000);
    });
  }

  private getRecentLogs(): string {
    if (this.outputBuffer.length === 0) {
      return '(no output captured)';
    }
    // Return last 20 lines
    return this.outputBuffer.slice(-20).join('\n');
  }

  async stop(): Promise<{ message: string }> {
    // Clean up socket file (Unix only)
    if (process.platform !== 'win32') {
      const socketPath = this.getSocketPath();
      if (fs.existsSync(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
        } catch (e) {
          // Ignore
        }
      }
    }

    if (!this.process) {
      return { message: 'App was not running' };
    }

    return new Promise((resolve) => {
      const proc = this.process!;

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
          process.kill(-proc.pid!, 'SIGTERM');
        } catch (e) {
          proc.kill('SIGTERM');
        }
      } else {
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

  private cleanupOrphanProcesses(): void {
    if (!this.appConfig) return;

    if (process.platform === 'win32') {
      // On Windows, try to kill by binary name
      try {
        spawn('taskkill', ['/IM', `${this.appConfig.binaryName}.exe`, '/F'], {
          stdio: 'ignore',
          shell: true,
        });
      } catch (e) {
        // Ignore errors
      }
    } else {
      try {
        // Kill by binary name
        spawn('pkill', ['-9', this.appConfig.binaryName], { stdio: 'ignore' });

        // Kill tauri dev processes for this directory
        const pattern = `tauri dev.*${this.appConfig.appDir.replace(/\//g, '\\/')}`;
        spawn('pkill', ['-9', '-f', pattern], { stdio: 'ignore' });
      } catch (e) {
        // Ignore errors
      }
    }
  }

  getStatus(): AppStatus {
    if (this.process) {
      if (this.detectedPipePath || this.isSocketReady()) {
        this.status = 'running';
      } else {
        this.status = 'starting';
      }
    } else {
      this.status = 'not_running';
    }
    return this.status;
  }

  getAppConfig(): TauriAppConfig | null {
    return this.appConfig;
  }

  /**
   * Get captured app logs (stdout/stderr)
   * @param limit Maximum number of lines to return (default: all)
   * @param clear Whether to clear the buffer after reading (default: false)
   */
  getLogs(options: { limit?: number; clear?: boolean } = {}): string[] {
    const { limit, clear = false } = options;
    const logs = limit ? this.outputBuffer.slice(-limit) : [...this.outputBuffer];
    if (clear) {
      this.outputBuffer = [];
    }
    return logs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Parse backend logs (stdout/stderr) for errors
   */
  parseBackendLogs(rawLogs: string[]): LogEntry[] {
    const entries: LogEntry[] = [];
    const now = Date.now();

    for (const line of rawLogs) {
      // Rust compile error: error[E0425]: cannot find value `x`
      const rustError = line.match(/error\[E(\d+)\]:\s*(.+)/);
      if (rustError) {
        entries.push({
          source: 'rust',
          category: 'build-backend',
          level: 'error',
          message: `E${rustError[1]}: ${rustError[2]}`,
          timestamp: now,
        });
        continue;
      }

      // Rust compile error with file location: --> src/main.rs:10:5
      const rustLocation = line.match(/-->\s+(.+?):(\d+):(\d+)/);
      if (rustLocation && entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry.source === 'rust' && !lastEntry.details?.file) {
          lastEntry.details = {
            file: rustLocation[1],
            line: parseInt(rustLocation[2]),
            column: parseInt(rustLocation[3]),
          };
        }
        continue;
      }

      // Vite error: [vite] Internal server error: ...
      const viteError = line.match(/\[vite\].*error:?\s*(.+)/i);
      if (viteError) {
        entries.push({
          source: 'vite',
          category: 'build-frontend',
          level: 'error',
          message: viteError[1],
          timestamp: now,
        });
        continue;
      }

      // TypeScript error: src/App.tsx(45,12): error TS2345: ...
      // Or: src/App.tsx:45:12 - error TS2345: ...
      const tsError = line.match(/(.+?)[:\(](\d+)[,:](\d+)\)?:?\s*error\s*(TS\d+):\s*(.+)/);
      if (tsError) {
        entries.push({
          source: 'typescript',
          category: 'build-frontend',
          level: 'error',
          message: `${tsError[4]}: ${tsError[5]}`,
          timestamp: now,
          details: {
            file: tsError[1],
            line: parseInt(tsError[2]),
            column: parseInt(tsError[3]),
          },
        });
        continue;
      }

      // Rust warning: warning[...]
      const rustWarning = line.match(/warning\[?.*\]?:\s*(.+)/);
      if (rustWarning) {
        entries.push({
          source: 'rust',
          category: 'build-backend',
          level: 'warning',
          message: rustWarning[1],
          timestamp: now,
        });
        continue;
      }

      // Generic error lines (case insensitive)
      if (/\berror\b/i.test(line) && !/\[tauri-plugin-mcp\]/.test(line)) {
        entries.push({
          source: 'tauri',
          category: 'runtime-backend',
          level: 'error',
          message: line.replace(/^\[(?:stdout|stderr)\]\s*/, ''),
          timestamp: now,
        });
      }
    }

    return entries;
  }

  /**
   * Get unified logs with optional filtering
   */
  getUnifiedLogs(options: {
    filter?: string;
    limit?: number;
    clear?: boolean;
  } = {}): { entries: LogEntry[]; summary: { total: number; errors: number; warnings: number } } {
    const { filter = 'all', limit = 50, clear = false } = options;

    let entries = this.parseBackendLogs(this.outputBuffer);

    // Apply filter
    if (filter !== 'all') {
      switch (filter) {
        case 'build':
          entries = entries.filter(e => e.category.startsWith('build-'));
          break;
        case 'build-frontend':
          entries = entries.filter(e => e.category === 'build-frontend');
          break;
        case 'build-backend':
          entries = entries.filter(e => e.category === 'build-backend');
          break;
        case 'runtime':
          entries = entries.filter(e => e.category.startsWith('runtime-'));
          break;
        case 'runtime-backend':
          entries = entries.filter(e => e.category === 'runtime-backend');
          break;
        case 'errors-and-warnings':
          entries = entries.filter(e => e.level === 'error' || e.level === 'warning');
          break;
      }
    }

    // Apply limit
    entries = entries.slice(-limit);

    // Calculate summary
    const summary = {
      total: entries.length,
      errors: entries.filter(e => e.level === 'error').length,
      warnings: entries.filter(e => e.level === 'warning').length,
    };

    if (clear) {
      this.outputBuffer = [];
    }

    return { entries, summary };
  }
}
