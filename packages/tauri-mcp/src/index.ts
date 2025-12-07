#!/usr/bin/env node

import { McpServer } from './server.js';

// TAURI_PROJECT_ROOT environment variable or current working directory
const projectRoot = process.env.TAURI_PROJECT_ROOT || process.cwd();
const server = new McpServer(projectRoot);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('[tauri-mcp] Shutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('[tauri-mcp] Shutting down...');
  await server.stop();
  process.exit(0);
});

// Start server
server.start().catch((error) => {
  console.error('[tauri-mcp] Fatal error:', error);
  process.exit(1);
});
