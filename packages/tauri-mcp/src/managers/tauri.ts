import { spawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

export interface TauriAppConfig {
  appDir: string;
  binaryName: string;
  packageName: string;
}

export type AppStatus = 'not_running' | 'starting' | 'running';

export interface LaunchOptions {
  wait_for_ready?: boolean;
  timeout_secs?: number;
}

const SOCKET_FILE_NAME = '.tauri-mcp.sock';

export class TauriManager {
  private process: ChildProcess | null = null;
  private status: AppStatus = 'not_running';
  private projectRoot: string;
  private appConfig: TauriAppConfig | null = null;
  private vitePort: number;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
    this.vitePort = this.generatePort(this.projectRoot);
    this.appConfig = this.detectTauriApp();
  }

  private generatePort(projectPath: string): number {
    const hash = createHash('sha256').update(projectPath).digest();
    const hashValue = hash.readUInt32BE(0);
    return 10000 + (hashValue % 50000);
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

  private getSocketPath(): string {
    return path.join(this.projectRoot, SOCKET_FILE_NAME);
  }

  private isSocketReady(): boolean {
    const socketPath = this.getSocketPath();
    return fs.existsSync(socketPath);
  }

  async launch(options: LaunchOptions = {}): Promise<{ message: string; port: number }> {
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 60;

    if (!this.appConfig) {
      throw new Error('No Tauri app detected. Make sure src-tauri/Cargo.toml exists.');
    }

    if (this.process) {
      throw new Error('App is already running. Stop it first.');
    }

    // Clean up stale socket file
    const socketPath = this.getSocketPath();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    // Build config override for Vite port
    const configOverride = JSON.stringify({
      build: {
        devUrl: `http://localhost:${this.vitePort}`,
      },
    });

    console.error(`[tauri-mcp] Launching app with Vite port ${this.vitePort}...`);

    this.process = spawn('pnpm', ['tauri', 'dev', '--config', configOverride], {
      cwd: this.appConfig.appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TAURI_MCP_PROJECT_ROOT: this.projectRoot,
        VITE_PORT: this.vitePort.toString(),
      },
      detached: false,
    });

    this.status = 'starting';

    this.process.stdout?.on('data', (data) => {
      console.error(`[tauri stdout] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[tauri stderr] ${data.toString().trim()}`);
    });

    this.process.on('exit', (code) => {
      console.error(`[tauri-mcp] Process exited with code ${code}`);
      this.process = null;
      this.status = 'not_running';
    });

    if (waitForReady) {
      await this.waitForReady(timeoutSecs);
    }

    this.status = 'running';
    return { message: 'App is ready', port: this.vitePort };
  }

  private async waitForReady(timeoutSecs: number): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;

    while (Date.now() - startTime < timeoutMs) {
      // Check if process crashed
      if (!this.process) {
        throw new Error('App process exited unexpectedly');
      }

      // Check if socket is ready
      if (this.isSocketReady()) {
        // Give it a moment to fully initialize
        await this.sleep(500);
        return;
      }

      await this.sleep(500);
    }

    throw new Error(`App did not become ready within ${timeoutSecs} seconds`);
  }

  async stop(): Promise<{ message: string }> {
    // Clean up socket file
    const socketPath = this.getSocketPath();
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (e) {
        // Ignore
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
        proc.kill('SIGTERM');
      }

      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process === proc) {
          proc.kill('SIGKILL');
          this.cleanupOrphanProcesses();
          this.process = null;
          this.status = 'not_running';
          resolve({ message: 'App force stopped' });
        }
      }, 5000);
    });
  }

  private cleanupOrphanProcesses(): void {
    if (!this.appConfig || process.platform === 'win32') return;

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

  getStatus(): AppStatus {
    if (this.process) {
      if (this.isSocketReady()) {
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
