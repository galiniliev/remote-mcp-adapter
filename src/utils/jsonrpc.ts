/**
 * JSON-RPC 2.0 utilities for parsing, validation, and formatting
 */

import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcBatch } from '../types.js';

/**
 * Parse a line of JSON-RPC from STDIO
 */
export function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return validateJsonRpcMessage(parsed);
  } catch (error) {
    throw new Error(`Failed to parse JSON-RPC line: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate that an object is a valid JSON-RPC 2.0 message
 */
export function validateJsonRpcMessage(obj: unknown): JsonRpcMessage {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('JSON-RPC message must be an object');
  }

  const msg = obj as Record<string, unknown>;

  if (msg.jsonrpc !== '2.0') {
    throw new Error('JSON-RPC version must be "2.0"');
  }

  // Check if it's a request (has method, optional id)
  if ('method' in msg && typeof msg.method === 'string') {
    return msg as unknown as JsonRpcRequest | JsonRpcNotification;
  }

  // Check if it's a response (has result or error, required id)
  if (('result' in msg || 'error' in msg) && 'id' in msg) {
    return msg as unknown as JsonRpcResponse;
  }

  throw new Error('Invalid JSON-RPC message: must have method (request/notification) or result/error (response)');
}

/**
 * Check if a message is a request (has id)
 */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg && msg.id !== null && msg.id !== undefined;
}

/**
 * Check if a message is a notification (no id)
 */
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && (!('id' in msg) || msg.id === null || msg.id === undefined);
}

/**
 * Check if a message is a response
 */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg || 'error' in msg;
}

/**
 * Format a JSON-RPC message for STDIO (newline-delimited)
 */
export function formatJsonRpcMessage(msg: JsonRpcMessage | JsonRpcBatch): string {
  const json = JSON.stringify(msg);
  return json + '\n';
}

/**
 * Parse a batch of JSON-RPC messages
 */
export function parseJsonRpcBatch(data: unknown): JsonRpcBatch {
  if (!Array.isArray(data)) {
    throw new Error('JSON-RPC batch must be an array');
  }

  return data.map((item, index) => {
    try {
      return validateJsonRpcMessage(item);
    } catch (error) {
      throw new Error(`Invalid JSON-RPC message at batch index ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

