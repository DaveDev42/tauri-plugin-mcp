import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const SOCKET_FILE_NAME = '.tauri-mcp.sock';

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

interface AppConfig {
  appDir: string;
}

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
  private appConfig: AppConfig | null = null;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.TAURI_PROJECT_ROOT ?? process.cwd();
    this.appConfig = this.detectTauriApp();
  }

  private detectTauriApp(): AppConfig | null {
    // Search for src-tauri/Cargo.toml at various depths
    const searchPaths = [
      path.join(this.projectRoot, 'src-tauri', 'Cargo.toml'),
      path.join(this.projectRoot, '..', 'src-tauri', 'Cargo.toml'),
      ...this.findCargoTomlRecursive(this.projectRoot, 3),
    ];

    for (const cargoPath of searchPaths) {
      if (fs.existsSync(cargoPath)) {
        const srcTauriDir = path.dirname(cargoPath);
        const appDir = path.dirname(srcTauriDir);
        return { appDir };
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

  private getSocketPath(): string {
    if (process.platform === 'win32') {
      // Windows named pipe - must match Rust plugin's GenericNamespaced format
      // Rust uses @tauri-mcp-{hash} with DefaultHasher, which maps to \\.\pipe\tauri-mcp-{hash}
      const hash = hashPathLikeRust(this.projectRoot);
      return `\\\\.\\pipe\\tauri-mcp-${hash}`;
    }
    // Socket is created in project root by tauri-plugin-mcp (Rust uses current_dir())
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

  async getConsoleLogs(): Promise<unknown[]> {
    const result = await this.sendCommand('get_console_logs');
    return result as unknown[];
  }

  async getNetworkLogs(): Promise<unknown[]> {
    const result = await this.sendCommand('get_network_logs');
    return result as unknown[];
  }
}
