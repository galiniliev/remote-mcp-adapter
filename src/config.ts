/**
 * Configuration parser and environment variable management
 */

import { readFileSync } from 'fs';
import type { McpConfiguration, McpInput, McpTool, BridgeConfig } from './types.js';

/**
 * Load MCP configuration from file
 */
export function loadMcpConfiguration(configPath: string): McpConfiguration {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as McpConfiguration;
    
    if (!config.tools || !Array.isArray(config.tools) || config.tools.length === 0) {
      throw new Error('Configuration must have at least one tool');
    }

    return config;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${configPath}`);
    }
    throw new Error(`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve ${input:...} variables in command arguments
 */
export function resolveInputVariables(
  args: string[],
  inputs: McpInput[] = [],
  envOverrides: Record<string, string> = {}
): string[] {
  return args.map((arg) => {
    // Match ${input:variable_name}
    const match = arg.match(/\$\{input:([^}]+)\}/);
    if (!match) {
      return arg;
    }

    const inputId = match[1];
    
    // Check environment variable override first
    if (envOverrides[inputId]) {
      return arg.replace(match[0], envOverrides[inputId]);
    }

    // Check environment variable with INPUT_ prefix
    const envKey = `INPUT_${inputId.toUpperCase()}`;
    if (process.env[envKey]) {
      return arg.replace(match[0], process.env[envKey]);
    }

    // Check direct environment variable
    if (process.env[inputId]) {
      return arg.replace(match[0], process.env[inputId]);
    }

    // Find input definition
    const inputDef = inputs.find((i) => i.id === inputId);
    if (inputDef?.default) {
      return arg.replace(match[0], inputDef.default);
    }

    // If no resolution found, throw error
    throw new Error(
      `Cannot resolve input variable ${inputId}. ` +
      `Set environment variable INPUT_${inputId.toUpperCase()} or ${inputId}, ` +
      `or provide a default value in configuration.`
    );
  });
}

/**
 * Get the first STDIO tool from configuration
 */
export function getStdioTool(config: McpConfiguration): McpTool {
  const stdioTool = config.tools.find((tool) => tool.type === 'stdio');
  if (!stdioTool) {
    throw new Error('No STDIO tool found in configuration');
  }
  return stdioTool;
}

/**
 * Load bridge configuration from environment variables
 */
export function loadBridgeConfig(): BridgeConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    mcpConfigPath: process.env.MCP_CONFIG_PATH || 'specs/ado-mcp-configuration.json',
    maxBufferSize: parseInt(process.env.MAX_BUFFER_SIZE || '1048576', 10), // 1MB default
    maxSubscribers: parseInt(process.env.MAX_SUBSCRIBERS || '100', 10),
    maxMessageSize: parseInt(process.env.MAX_MESSAGE_SIZE || '1048576', 10), // 1MB default
    keepaliveInterval: parseInt(process.env.KEEPALIVE_INTERVAL || '30000', 10), // 30s default
    streamTimeout: parseInt(process.env.STREAM_TIMEOUT || '300000', 10), // 5min default
    restartBackoffBase: parseInt(process.env.RESTART_BACKOFF_BASE || '1000', 10), // 1s
    restartBackoffMax: parseInt(process.env.RESTART_BACKOFF_MAX || '60000', 10), // 60s
    lazyStart: process.env.LAZY_START !== 'false', // Default true
  };
}

