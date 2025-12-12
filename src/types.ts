/**
 * TypeScript types for JSON-RPC 2.0, MCP configuration, and bridge internals
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
export type JsonRpcBatch = JsonRpcMessage[];

/**
 * MCP Configuration types
 */
export interface McpInput {
  id: string;
  type: 'promptString' | 'env' | 'config';
  description?: string;
  default?: string;
}

export interface McpTool {
  id: string;
  type: 'stdio';
  command: string;
  args: string[];
}

export interface McpConfiguration {
  inputs?: McpInput[];
  tools: McpTool[];
}

/**
 * Process manager state
 */
export interface ProcessState {
  pid?: number;
  started: boolean;
  restartCount: number;
  lastRestartTime?: Date;
}

/**
 * Stream subscriber for SSE/Streamable HTTP
 */
export interface StreamSubscriber {
  id: string;
  response: NodeJS.WritableStream;
  buffer: string[];
  bufferSize: number;
  connectedAt: Date;
  lastActivity: Date;
}

/**
 * Bridge configuration from environment
 */
export interface BridgeConfig {
  port: number;
  mcpConfigPath?: string;
  maxBufferSize: number;
  maxSubscribers: number;
  maxMessageSize: number;
  keepaliveInterval: number;
  streamTimeout: number;
  restartBackoffBase: number;
  restartBackoffMax: number;
  lazyStart: boolean;
}

