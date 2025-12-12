/**
 * Application entry point for Remote MCP Bridge
 */

import { loadBridgeConfig, loadMcpConfiguration, getStdioTool } from './config.js';
import { BridgeServer } from './server.js';

async function main(): Promise<void> {
  try {
    // Load configuration
    const bridgeConfig = loadBridgeConfig();
    console.log('[Main] Bridge configuration loaded');

    // Load MCP configuration
    const mcpConfig = loadMcpConfiguration(bridgeConfig.mcpConfigPath!);
    console.log(`[Main] MCP configuration loaded from ${bridgeConfig.mcpConfigPath}`);

    // Get STDIO tool
    const tool = getStdioTool(mcpConfig);
    console.log(`[Main] Using tool: ${tool.id} (${tool.command})`);

    // Create and start server
    const server = new BridgeServer(bridgeConfig, tool);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`[Main] Received ${signal}, shutting down...`);
      await server.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('[Main] Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[Main] Unhandled rejection:', reason);
      shutdown('unhandledRejection');
    });

    // Start server
    await server.start();
  } catch (error) {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

main();

