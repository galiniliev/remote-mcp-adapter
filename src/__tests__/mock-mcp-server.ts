/**
 * Mock MCP server for integration testing
 * This simulates a STDIO-based MCP server that responds to JSON-RPC messages
 */

import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export class MockMcpServer {
  private process: ChildProcess | null = null;
  private scriptPath: string;

  constructor() {
    // Create a temporary script file for the mock server
    this.scriptPath = join(tmpdir(), `mock-mcp-server-${Date.now()}.js`);
    this.createMockScript();
  }

  private createMockScript(): void {
    const script = `
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    
    // Echo back a response
    if (request.id !== undefined) {
      const response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          method: request.method,
          params: request.params || {},
          timestamp: new Date().toISOString()
        }
      };
      console.log(JSON.stringify(response));
    }
    
    // Send a notification
    const notification = {
      jsonrpc: '2.0',
      method: 'test/notification',
      params: {
        message: 'Test notification',
        requestId: request.id
      }
    };
    console.log(JSON.stringify(notification));
  } catch (error) {
    const errorResponse = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
        data: error.message
      }
    };
    console.log(JSON.stringify(errorResponse));
  }
});
`;
    writeFileSync(this.scriptPath, script);
  }

  public start(): void {
    this.process = spawn('node', [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (error) => {
      console.error('[MockMcpServer] Error:', error);
    });
  }

  public stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    try {
      unlinkSync(this.scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  public getProcess(): ChildProcess | null {
    return this.process;
  }
}

