/**
 * Message router for fanning out local MCP server stdout to stream subscribers
 */

import { EventEmitter } from 'events';
import { parseJsonRpcLine } from './utils/jsonrpc.js';
import type { SseHandler } from './sse-handler.js';
import type { StreamableHttpHandler } from './streamable-http-handler.js';

export class MessageRouter extends EventEmitter {
  private stdoutBuffer: string = '';
  private readonly sseHandler?: SseHandler;
  private readonly streamableHttpHandler?: StreamableHttpHandler;

  constructor(sseHandler?: SseHandler, streamableHttpHandler?: StreamableHttpHandler) {
    super();
    this.sseHandler = sseHandler;
    this.streamableHttpHandler = streamableHttpHandler;
  }

  /**
   * Process stdout data from the local MCP server
   */
  public processStdout(data: Buffer): void {
    // Append to buffer
    this.stdoutBuffer += data.toString('utf-8');

    // Process complete lines (newline-delimited JSON)
    const lines = this.stdoutBuffer.split('\n');
    
    // Keep the last incomplete line in buffer
    this.stdoutBuffer = lines.pop() || '';

    // Process each complete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue; // Skip empty lines
      }

      try {
        // Parse JSON-RPC message
        const message = parseJsonRpcLine(trimmed);
        
        // Format as JSON string for broadcasting
        const jsonString = JSON.stringify(message);

        // Fan out to SSE subscribers
        if (this.sseHandler) {
          this.sseHandler.broadcast(jsonString);
        }

        // Fan out to Streamable HTTP subscribers
        if (this.streamableHttpHandler) {
          this.streamableHttpHandler.broadcast(jsonString);
        }

        // Emit event for other listeners
        this.emit('message', message);
      } catch (error) {
        console.error(`[MessageRouter] Failed to process message:`, error);
        console.error(`[MessageRouter] Raw line:`, trimmed);
        // Continue processing other lines
      }
    }
  }

  /**
   * Clear the stdout buffer (useful for testing or reset)
   */
  public clearBuffer(): void {
    this.stdoutBuffer = '';
  }
}

