import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

/**
 * SipHash-1-3 Hasher to match Rust's DefaultHasher
 * Implements the Hasher trait interface: write, write_usize, finish
 */
class SipHasher {
  private v0: bigint;
  private v1: bigint;
  private v2: bigint;
  private v3: bigint;
  private tail: number[] = [];
  private ntail: number = 0;
  private length: number = 0;
  private readonly mask64 = BigInt('0xffffffffffffffff');

  constructor() {
    const k0 = BigInt('0x736f6d6570736575');
    const k1 = BigInt('0x646f72616e646f6d');
    this.v0 = k0 ^ BigInt('0x736f6d6570736575');
    this.v1 = k1 ^ BigInt('0x646f72616e646f6d');
    this.v2 = k0 ^ BigInt('0x6c7967656e657261');
    this.v3 = k1 ^ BigInt('0x7465646279746573');
  }

  private rotl(x: bigint, b: number): bigint {
    return ((x << BigInt(b)) | (x >> BigInt(64 - b))) & this.mask64;
  }

  private sipRound(): void {
    this.v0 = (this.v0 + this.v1) & this.mask64;
    this.v1 = this.rotl(this.v1, 13);
    this.v1 ^= this.v0;
    this.v0 = this.rotl(this.v0, 32);
    this.v2 = (this.v2 + this.v3) & this.mask64;
    this.v3 = this.rotl(this.v3, 16);
    this.v3 ^= this.v2;
    this.v0 = (this.v0 + this.v3) & this.mask64;
    this.v3 = this.rotl(this.v3, 21);
    this.v3 ^= this.v0;
    this.v2 = (this.v2 + this.v1) & this.mask64;
    this.v1 = this.rotl(this.v1, 17);
    this.v1 ^= this.v2;
    this.v2 = this.rotl(this.v2, 32);
  }

  write(data: Buffer): void {
    this.length += data.length;
    let i = 0;

    // Fill tail buffer first
    while (this.ntail < 8 && i < data.length) {
      this.tail[this.ntail++] = data[i++];
    }

    // If we have a complete block
    if (this.ntail === 8) {
      let m = BigInt(0);
      for (let j = 0; j < 8; j++) {
        m |= BigInt(this.tail[j]) << BigInt(j * 8);
      }
      this.v3 ^= m;
      this.sipRound();
      this.v0 ^= m;
      this.ntail = 0;
    }

    // Process remaining complete 8-byte blocks
    while (i + 8 <= data.length) {
      let m = BigInt(0);
      for (let j = 0; j < 8; j++) {
        m |= BigInt(data[i + j]) << BigInt(j * 8);
      }
      this.v3 ^= m;
      this.sipRound();
      this.v0 ^= m;
      i += 8;
    }

    // Store remaining bytes in tail
    while (i < data.length) {
      this.tail[this.ntail++] = data[i++];
    }
  }

  writeUsize(value: number): void {
    // Rust's write_usize on 64-bit systems writes 8 bytes (little-endian)
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    this.write(buf);
  }

  finish(): bigint {
    // Final block with length encoding
    let b = BigInt(this.length & 0xff) << BigInt(56);
    for (let i = 0; i < this.ntail; i++) {
      b |= BigInt(this.tail[i]) << BigInt(i * 8);
    }

    this.v3 ^= b;
    this.sipRound();
    this.v0 ^= b;

    // Finalization
    this.v2 ^= BigInt(0xff);
    this.sipRound();
    this.sipRound();
    this.sipRound();

    return (this.v0 ^ this.v1 ^ this.v2 ^ this.v3) & this.mask64;
  }
}

/**
 * Hash a byte slice the same way Rust's DefaultHasher does for &[u8].hash()
 * Rust's slice Hash impl: writes length first, then bytes
 */
function hashBytesLikeRust(data: Buffer): bigint {
  const hasher = new SipHasher();
  hasher.writeUsize(data.length);
  hasher.write(data);
  return hasher.finish();
}

/**
 * Hash a path string the same way Rust hashes path_str.as_bytes()
 */
function hashPathLikeRust(pathStr: string): string {
  const normalizedPath = path.resolve(pathStr);
  const pathBuffer = Buffer.from(normalizedPath, 'utf-8');
  const hash = hashBytesLikeRust(pathBuffer);
  return hash.toString(16);
}

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
  private outputBuffer: string[] = [];

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
    const normalizedPath = path.resolve(projectPath);
    const pathBuffer = Buffer.from(normalizedPath, 'utf-8');
    const hash = hashBytesLikeRust(pathBuffer);
    const hashValue = Number(hash & BigInt(0xFFFFFFFF));
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
    if (process.platform === 'win32') {
      // Windows named pipe - must match Rust plugin's GenericNamespaced format
      // Rust uses @tauri-mcp-{hash} with DefaultHasher, which maps to \\.\pipe\tauri-mcp-{hash}
      const hash = hashPathLikeRust(this.projectRoot);
      const pipePath = `\\\\.\\pipe\\tauri-mcp-${hash}`;
      console.error(`[tauri-mcp] Windows pipe path: ${pipePath}`);
      return pipePath;
    }
    // Unix socket file in project root
    return path.join(this.projectRoot, SOCKET_FILE_NAME);
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
    const pipePath = this.getSocketPath();

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

  async launch(options: LaunchOptions = {}): Promise<{ message: string; port: number }> {
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 60;

    if (!this.appConfig) {
      throw new Error('No Tauri app detected. Make sure src-tauri/Cargo.toml exists.');
    }

    if (this.process) {
      throw new Error('App is already running. Stop it first.');
    }

    // Clean up stale socket file (Unix only)
    if (process.platform !== 'win32') {
      const socketPath = this.getSocketPath();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }

    console.error(`[tauri-mcp] Launching app with Vite port ${this.vitePort}...`);

    // Use shell: true on Windows to find pnpm.cmd
    // Don't override config - use existing tauri.conf.json
    // Add --features dummy_camera for testing without real camera
    const tauriArgs = ['tauri', 'dev', '--features', 'dummy_camera'];
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
        // On Windows, use taskkill to kill the process tree
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
