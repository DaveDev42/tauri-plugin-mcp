import { spawn, spawnSync, ChildProcess } from 'child_process';
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
  portOverrideApplied: boolean;
  warnings?: string[];
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

export interface RustRebuildEvent {
  type: 'rust-rebuild';
  file: string;
  timestamp: number;
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
  private rustRebuildEvents: RustRebuildEvent[] = [];

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
    this.appConfig = this.detectTauriApp();
    // Port will be dynamically assigned in launch()
    this.vitePort = 0;
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

  /**
   * Check if a port is available for use
   */
  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Find an available random port
   */
  private async findAvailablePort(): Promise<number> {
    const minPort = 10000;
    const maxPort = 60000;
    const maxAttempts = 100;

    for (let i = 0; i < maxAttempts; i++) {
      const port = minPort + Math.floor(Math.random() * (maxPort - minPort));
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('Could not find an available port after 100 attempts');
  }

  /**
   * Read Tauri configuration from tauri.conf.json
   */
  private readTauriConfig(): { beforeDevCommand?: string; devUrl?: string } | null {
    if (!this.appConfig) return null;

    const confPath = path.join(this.appConfig.appDir, 'src-tauri', 'tauri.conf.json');
    try {
      const content = fs.readFileSync(confPath, 'utf-8');
      const config = JSON.parse(content);
      return {
        beforeDevCommand: config?.build?.beforeDevCommand,
        devUrl: config?.build?.devUrl,
      };
    } catch {
      return null;
    }
  }

  /**
   * Detect the bundler type from beforeDevCommand and package.json
   */
  private detectBundlerType(command: string): 'vite' | 'webpack' | 'unknown' {
    // Direct command detection
    if (/\bvite\b/i.test(command)) {
      return 'vite';
    }
    if (/\bwebpack\b/i.test(command) || /webpack-dev-server/i.test(command)) {
      return 'webpack';
    }

    // If command is like "npm run dev" or "pnpm dev", check package.json
    if (/^(npm|pnpm|yarn)\s+(run\s+)?dev/i.test(command)) {
      return this.detectBundlerFromPackageJson();
    }

    return 'unknown';
  }

  /**
   * Detect bundler type by analyzing package.json
   */
  private detectBundlerFromPackageJson(): 'vite' | 'webpack' | 'unknown' {
    if (!this.appConfig) return 'unknown';

    const pkgPath = path.join(this.appConfig.appDir, 'package.json');
    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      // Check dev script content
      const devScript = pkg.scripts?.dev || '';
      if (devScript.includes('vite')) return 'vite';
      if (devScript.includes('webpack')) return 'webpack';

      // Check devDependencies
      if (pkg.devDependencies?.vite || pkg.dependencies?.vite) return 'vite';
      if (pkg.devDependencies?.webpack || pkg.dependencies?.webpack) return 'webpack';
    } catch {
      // Ignore errors
    }

    return 'unknown';
  }

  /**
   * Inject --port flag into beforeDevCommand
   */
  private injectPortToCommand(command: string, port: number): string {
    // If --port is already specified, replace it
    if (/--port\s+\d+/.test(command)) {
      return command.replace(/--port\s+\d+/, `--port ${port}`);
    }

    // npm/pnpm run commands need -- separator
    if (/^(npm|pnpm)\s+run\s+/i.test(command)) {
      return `${command} -- --port ${port}`;
    }

    // yarn doesn't need -- separator
    // Direct vite command or other commands
    return `${command} --port ${port}`;
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

  /**
   * Check if an external app instance is already running and responding
   * This detects apps launched by other MCP sessions
   */
  private async checkExternalAppRunning(): Promise<boolean> {
    // For Unix, check if socket file exists
    if (process.platform !== 'win32') {
      const socketPath = this.getSocketPath();
      if (!fs.existsSync(socketPath)) {
        return false;
      }
    }

    // For Windows, try to find existing pipe
    if (process.platform === 'win32') {
      const pipePath = this.calculateWindowsPipePath();
      if (!pipePath) {
        return false;
      }
    }

    // Try to ping the existing socket/pipe
    return this.verifyAppReady();
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

    if (!this.appConfig) {
      throw new Error('No Tauri app detected. Make sure src-tauri/Cargo.toml exists.');
    }

    // Idempotent: if already running (managed by this instance), return current status
    if (this.process) {
      const errors = this.parseBackendLogs(this.outputBuffer);
      const backendHealth = errors.some(e => e.level === 'error') ? 'error' as const : 'healthy' as const;
      return {
        status: 'already_running',
        message: 'App is already running',
        port: this.vitePort,
        portOverrideApplied: true, // Was applied on initial launch
        buildHealth: {
          frontend: 'unknown', // Will be determined by frontend logs
          backend: backendHealth,
        },
        errors: errors.filter(e => e.level === 'error'),
      };
    }

    // Check if another instance already has an app running (external process)
    // This prevents duplicate launches that cause connection issues
    const externalAppRunning = await this.checkExternalAppRunning();
    if (externalAppRunning) {
      throw new Error(
        'Another Tauri app instance is already running and responding on the socket. ' +
        'This can happen when launch_app is called from a different MCP session. ' +
        'Please call stop_app first to terminate the existing app, then try launch_app again.'
      );
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

    // Dynamic port allocation with bundler detection
    const tauriConfig = this.readTauriConfig();
    let portOverrideApplied = false;
    const warnings: string[] = [];
    let configOverride: string | null = null;

    if (tauriConfig?.beforeDevCommand) {
      const bundlerType = this.detectBundlerType(tauriConfig.beforeDevCommand);

      if (bundlerType === 'vite') {
        // Vite supported - apply dynamic port
        this.vitePort = await this.findAvailablePort();
        const modifiedCommand = this.injectPortToCommand(tauriConfig.beforeDevCommand, this.vitePort);
        configOverride = JSON.stringify({
          build: {
            beforeDevCommand: modifiedCommand,
            devUrl: `http://localhost:${this.vitePort}`,
          },
        });
        portOverrideApplied = true;
        console.error(`[tauri-mcp] Vite detected. Using dynamic port ${this.vitePort}`);
      } else if (bundlerType === 'webpack') {
        // Webpack - try port override with warning
        this.vitePort = await this.findAvailablePort();
        const modifiedCommand = this.injectPortToCommand(tauriConfig.beforeDevCommand, this.vitePort);
        configOverride = JSON.stringify({
          build: {
            beforeDevCommand: modifiedCommand,
            devUrl: `http://localhost:${this.vitePort}`,
          },
        });
        portOverrideApplied = true;
        warnings.push(`Webpack detected. Port override may not work correctly. Using port ${this.vitePort}`);
        console.error(`[tauri-mcp] Webpack detected. Attempting dynamic port ${this.vitePort} (may not work)`);
      } else {
        // Unknown bundler - use default configuration
        this.vitePort = this.detectExistingPort() ?? 1420;
        warnings.push(
          `Unknown bundler in beforeDevCommand: "${tauriConfig.beforeDevCommand}". ` +
          `Dynamic port override not applied. Using default port ${this.vitePort}. ` +
          `If running multiple apps, port conflicts may occur.`
        );
        console.error(`[tauri-mcp] Unknown bundler. Using default port ${this.vitePort}`);
      }
    } else {
      // No beforeDevCommand - use default configuration
      this.vitePort = this.detectExistingPort() ?? 1420;
      warnings.push('No beforeDevCommand found in tauri.conf.json. Using default port configuration.');
      console.error(`[tauri-mcp] No beforeDevCommand. Using default port ${this.vitePort}`);
    }

    console.error(`[tauri-mcp] Launching app with Vite port ${this.vitePort}...`);

    // Build tauri dev command with optional features
    const tauriArgs = ['tauri', 'dev'];
    if (features.length > 0) {
      tauriArgs.push('--features', features.join(','));
    }
    // Add config override for dynamic port
    if (configOverride) {
      tauriArgs.push('--config', configOverride);
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
        // Keep VITE_PORT for backwards compatibility
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
      // Parse Rust rebuild trigger
      this.parseRustRebuildTrigger(line);
    });

    this.process.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      console.error(`[tauri stderr] ${line}`);
      this.outputBuffer.push(`[stderr] ${line}`);
      if (this.outputBuffer.length > 100) this.outputBuffer.shift();
      // Parse Rust rebuild trigger
      this.parseRustRebuildTrigger(line);
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
          portOverrideApplied,
          warnings: warnings.length > 0 ? warnings : undefined,
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
          portOverrideApplied,
          warnings: warnings.length > 0 ? warnings : undefined,
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
      portOverrideApplied,
      warnings: warnings.length > 0 ? warnings : undefined,
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

  /**
   * Synchronous stop for use in process.on('exit') handler
   * Uses spawnSync to ensure cleanup happens before Node.js exits
   */
  stopSync(): void {
    // Clean up socket file (Unix only)
    if (process.platform !== 'win32') {
      const socketPath = this.getSocketPath();
      if (fs.existsSync(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // Ignore
        }
      }
    }

    if (!this.process) {
      // No managed process, but try to kill orphan processes anyway
      this.cleanupOrphanProcessesSync();
      return;
    }

    const pid = this.process.pid;
    if (!pid) {
      this.cleanupOrphanProcessesSync();
      return;
    }

    // Kill process synchronously
    if (process.platform !== 'win32') {
      // Kill process group on Unix
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Ignore
        }
      }
    } else {
      // On Windows, use taskkill synchronously
      spawnSync('taskkill', ['/PID', pid.toString(), '/T', '/F'], {
        stdio: 'ignore',
        shell: true,
      });
    }

    this.cleanupOrphanProcessesSync();
    this.process = null;
    this.status = 'not_running';
    this.detectedPipePath = null;
  }

  private cleanupOrphanProcessesSync(): void {
    if (!this.appConfig) return;

    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/IM', `${this.appConfig.binaryName}.exe`, '/F'], {
        stdio: 'ignore',
        shell: true,
      });
    } else {
      // Kill by binary name
      spawnSync('pkill', ['-9', this.appConfig.binaryName], { stdio: 'ignore' });
    }
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

  /**
   * Parse Rust rebuild trigger from tauri dev output
   * Looks for: "File src-tauri/src/main.rs changed. Rebuilding application..."
   */
  private parseRustRebuildTrigger(line: string): void {
    // Match: "File <path> changed. Rebuilding application..."
    // Also match: "Info File <path> changed. Rebuilding application..."
    // Also match with ANSI color codes: "\x1b[32mInfo\x1b[0m File ..."
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI codes
    const match = cleanLine.match(/(?:Info\s+)?File\s+(.+?)\s+changed\.\s*Rebuilding/i);
    if (match) {
      const file = match[1];
      this.rustRebuildEvents.push({
        type: 'rust-rebuild',
        file,
        timestamp: Date.now(),
      });

      // Keep only last 50 events
      if (this.rustRebuildEvents.length > 50) {
        this.rustRebuildEvents.shift();
      }

      console.error(`[tauri-mcp] Rust rebuild triggered by: ${file}`);
    }
  }

  /**
   * Get Rust rebuild events
   * @param limit Maximum number of events to return (default: all)
   * @param clear Whether to clear the events after reading (default: false)
   */
  getRustRebuildEvents(options: { limit?: number; clear?: boolean } = {}): RustRebuildEvent[] {
    const { limit, clear = false } = options;
    const events = limit ? this.rustRebuildEvents.slice(-limit) : [...this.rustRebuildEvents];
    if (clear) {
      this.rustRebuildEvents = [];
    }
    return events;
  }
}
