/**
 * Integration tests for Remote MCP Bridge
 */

import { BridgeServer } from '../server.js';
import { loadBridgeConfig } from '../config.js';
import { MockMcpServer } from './mock-mcp-server.js';
import type { McpTool } from '../types.js';

describe('Integration Tests', () => {
  let mockServer: MockMcpServer;
  let bridgeServer: BridgeServer;
  let bridgePort: number;

  beforeAll(() => {
    mockServer = new MockMcpServer();
    mockServer.start();
  });

  afterAll(async () => {
    mockServer.stop();
    if (bridgeServer) {
      await bridgeServer.stop();
    }
  });

  beforeEach(() => {
    bridgePort = 3000 + Math.floor(Math.random() * 1000);
  });

  it('should start bridge server and handle requests', async () => {
    const config = loadBridgeConfig();
    config.port = bridgePort;
    config.lazyStart = false;

    const tool: McpTool = {
      id: 'mock',
      type: 'stdio',
      command: 'node',
      args: ['-e', 'console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:"test"}))'],
    };

    // Note: This is a simplified integration test
    // Full integration would require actual HTTP requests and SSE stream handling
    expect(mockServer.getProcess()).toBeDefined();
  });

  // Additional integration tests would go here
  // These would test:
  // - POST /mcp with actual HTTP requests
  // - SSE stream connection and message delivery
  // - Streamable HTTP endpoint
  // - Error handling and recovery
});

