/**
 * Streamable HTTP handler for MCP Streamable HTTP transport
 * Implements bidirectional messaging per MCP specification 2025-11-25
 */

import type { Request, Response } from 'express';
import type { StreamSubscriber } from './types.js';
import { addToBuffer, isBufferOverLimit, clearBuffer } from './utils/buffer.js';
import { validateJsonRpcMessage, parseJsonRpcBatch, formatJsonRpcMessage } from './utils/jsonrpc.js';
import type { JsonRpcMessage, JsonRpcBatch } from './types.js';

export type MessageRelayCallback = (message: string) => void;

export class StreamableHttpHandler {
  private subscribers: Map<string, StreamSubscriber> = new Map();
  private readonly maxBufferSize: number;
  private readonly maxSubscribers: number;
  private subscriberIdCounter = 0;
  private messageRelayCallback?: MessageRelayCallback;
  private globalMessageBuffer: string[] = []; // Buffer messages when no subscribers
  private globalBufferSize: number = 0;

  constructor(maxBufferSize: number = 1048576, maxSubscribers: number = 100) {
    this.maxBufferSize = maxBufferSize;
    this.maxSubscribers = maxSubscribers;
  }

  /**
   * Set callback for relaying incoming messages to STDIO
   */
  public setMessageRelayCallback(callback: MessageRelayCallback): void {
    this.messageRelayCallback = callback;
  }

  /**
   * Handle Streamable HTTP GET request (establish stream for server-to-client messages)
   * Per MCP spec: GET requests establish a stream to receive server messages
   */
  public handleStream(req: Request, res: Response): void {
    const requestId = (req as any).requestId || 'unknown';
    
    // Check subscriber limit
    if (this.subscribers.size >= this.maxSubscribers) {
      const errorMsg = `Maximum number of subscribers reached (${this.maxSubscribers})`;
      (res as any).errorDetails = errorMsg;
      const errorResponse = { error: errorMsg };
      console.warn(`[StreamableHTTP] ${requestId} ${errorMsg} | Response: ${JSON.stringify(errorResponse)}`);
      res.status(503).json(errorResponse);
      return;
    }

    // Set status code first (200 OK for successful stream establishment)
    res.status(200);
    
    // Set streaming headers per MCP spec for Streamable HTTP transport
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    // Don't flush headers explicitly - let Express handle it when we write data
    // Explicitly flushing might cause an empty chunk to be sent

    // Generate unique subscriber ID
    const subscriberId = `stream_${Date.now()}_${++this.subscriberIdCounter}`;
    
    const subscriber: StreamSubscriber = {
      id: subscriberId,
      response: res,
      buffer: [],
      bufferSize: 0,
      connectedAt: new Date(),
      lastActivity: new Date(),
    };

    this.subscribers.set(subscriberId, subscriber);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`[StreamableHTTP] ${requestId} Client connection closed: ${subscriberId}`);
      this.removeSubscriber(subscriberId);
    });

    req.on('aborted', () => {
      console.log(`[StreamableHTTP] ${requestId} Client connection aborted: ${subscriberId}`);
      this.removeSubscriber(subscriberId);
    });

    // Handle response errors
    res.on('error', (error) => {
      console.error(`[StreamableHTTP] ${requestId} Response error for ${subscriberId}:`, error);
      this.removeSubscriber(subscriberId);
    });

    // Send initial response to open the stream
    // For Streamable HTTP, we need to write something immediately to prevent Express
    // from sending an empty chunk that the client tries to parse as JSON
    try {
      console.log(`[StreamableHTTP] ${requestId} GET stream established: ${subscriberId} (total: ${this.subscribers.size})`);
      
      // Deliver any buffered messages to the new subscriber immediately
      // This will write actual JSON messages
      this.deliverBufferedMessages(subscriber);
      
      // If no buffered messages, write a keepalive/connection confirmation message
      // This prevents Express from sending an empty chunk that causes parse errors
      if (subscriber.buffer.length === 0) {
        // Write a valid JSON object that clients can safely ignore
        // Using a notification-style message that won't interfere with request/response flow
        const keepalive = JSON.stringify({ jsonrpc: "2.0", method: "_stream_opened" }) + '\n';
        try {
          res.write(keepalive);
          console.log(`[StreamableHTTP] ${requestId} Sent stream opened keepalive to ${subscriberId}`);
        } catch (writeError) {
          console.error(`[StreamableHTTP] ${requestId} Failed to write keepalive to ${subscriberId}:`, writeError);
        }
      }
    } catch (error) {
      console.error(`[StreamableHTTP] ${requestId} Failed to open stream for ${subscriberId}:`, error);
      this.removeSubscriber(subscriberId);
      try {
        res.status(500).json({ error: 'Failed to establish stream' });
      } catch (e) {
        // Response might already be closed
      }
    }
  }

  /**
   * Handle Streamable HTTP POST request (client-to-server messages)
   * Per MCP spec: POST requests send JSON-RPC messages to server
   * Server can respond with single JSON response or establish stream for multiple responses
   */
  public handlePost(req: Request, res: Response, establishStream: boolean = false): void {
    const requestId = (req as any).requestId || 'unknown';
    
    // Validate Content-Type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      const errorMsg = `Content-Type must be application/json, got: ${contentType || 'none'}`;
      (res as any).errorDetails = errorMsg;
      console.warn(`[StreamableHTTP] ${requestId} ${errorMsg}`);
      res.status(400).json({ 
        error: errorMsg,
        receivedContentType: contentType || 'none',
        expectedContentType: 'application/json'
      });
      return;
    }

    // Validate body
    if (!req.body || typeof req.body !== 'object') {
      const errorMsg = `Request body must be a JSON object or array, got: ${typeof req.body}`;
      (res as any).errorDetails = errorMsg;
      console.warn(`[StreamableHTTP] ${requestId} ${errorMsg}`);
      res.status(400).json({ 
        error: errorMsg,
        receivedType: typeof req.body,
        expectedType: 'object or array'
      });
      return;
    }

    try {
      // Parse and validate JSON-RPC messages
      let messages: JsonRpcMessage[];
      const isBatch = Array.isArray(req.body);
      
      if (isBatch) {
        messages = parseJsonRpcBatch(req.body);
        console.log(`[StreamableHTTP] ${requestId} POST parsed batch: ${messages.length} messages`);
      } else {
        validateJsonRpcMessage(req.body);
        messages = [req.body as JsonRpcMessage];
        const method = (req.body as any).method || 'unknown';
        console.log(`[StreamableHTTP] ${requestId} POST validated message: method=${method}`);
      }

      // Relay messages to STDIO via callback
      if (this.messageRelayCallback) {
        for (const msg of messages) {
          const formatted = formatJsonRpcMessage(msg as JsonRpcMessage | JsonRpcBatch);
          this.messageRelayCallback(formatted);
        }
        console.log(`[StreamableHTTP] ${requestId} POST relayed ${messages.length} message(s) to STDIO`);
      } else {
        console.warn(`[StreamableHTTP] ${requestId} POST no message relay callback set, messages not relayed`);
      }

      // If establishing a stream, set up streaming response
      if (establishStream) {
        // Check subscriber limit
        if (this.subscribers.size >= this.maxSubscribers) {
          const errorMsg = `Maximum number of subscribers reached (${this.maxSubscribers})`;
          (res as any).errorDetails = errorMsg;
          res.status(503).json({ error: errorMsg });
          return;
        }

        // Set status code first (200 OK for successful stream establishment)
        res.status(200);
        
        // Set streaming headers
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        // Don't flush headers explicitly - let Express handle it when we write data
        // Explicitly flushing might cause an empty chunk to be sent

        // Generate unique subscriber ID
        const subscriberId = `stream_post_${Date.now()}_${++this.subscriberIdCounter}`;
        
        const subscriber: StreamSubscriber = {
          id: subscriberId,
          response: res,
          buffer: [],
          bufferSize: 0,
          connectedAt: new Date(),
          lastActivity: new Date(),
        };

        this.subscribers.set(subscriberId, subscriber);

        // Handle client disconnect
        req.on('close', () => {
          console.log(`[StreamableHTTP] ${requestId} POST stream connection closed: ${subscriberId}`);
          this.removeSubscriber(subscriberId);
        });

        req.on('aborted', () => {
          console.log(`[StreamableHTTP] ${requestId} POST stream connection aborted: ${subscriberId}`);
          this.removeSubscriber(subscriberId);
        });

        // Handle response errors
        res.on('error', (error) => {
          console.error(`[StreamableHTTP] ${requestId} POST response error for ${subscriberId}:`, error);
          this.removeSubscriber(subscriberId);
        });

        // Send initial response to open the stream
        try {
          console.log(`[StreamableHTTP] ${requestId} POST stream established: ${subscriberId} (total: ${this.subscribers.size})`);
          
          // Deliver any buffered messages to the new subscriber immediately
          // This will write actual JSON messages
          this.deliverBufferedMessages(subscriber);
          
          // If no buffered messages, write a keepalive/connection confirmation message
          // This prevents Express from sending an empty chunk that causes parse errors
          if (subscriber.buffer.length === 0) {
            // Write a valid JSON object that clients can safely ignore
            // Using a notification-style message that won't interfere with request/response flow
            const keepalive = JSON.stringify({ jsonrpc: "2.0", method: "_stream_opened" }) + '\n';
            try {
              res.write(keepalive);
              console.log(`[StreamableHTTP] ${requestId} Sent stream opened keepalive to ${subscriberId}`);
            } catch (writeError) {
              console.error(`[StreamableHTTP] ${requestId} Failed to write keepalive to ${subscriberId}:`, writeError);
            }
          }
        } catch (error) {
          console.error(`[StreamableHTTP] ${requestId} Failed to open POST stream for ${subscriberId}:`, error);
          this.removeSubscriber(subscriberId);
          try {
            res.status(500).json({ error: 'Failed to establish stream' });
          } catch (e) {
            // Response might already be closed
          }
        }
      } else {
        // Return 202 Accepted for async processing (responses will come via stream)
        // Per MCP spec: server can respond with single JSON response or establish stream
        res.status(202).json({
          status: 'accepted',
          messageCount: messages.length,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      (res as any).errorDetails = `Invalid JSON-RPC message: ${errorMsg}`;
      
      console.error(`[StreamableHTTP] ${requestId} POST error processing message:`, error);
      
      res.status(400).json({
        error: 'Invalid JSON-RPC message',
        details: errorMsg,
      });
    }
  }

  /**
   * Broadcast a message to all subscribers
   */
  public broadcast(message: string): void {
    // Skip empty messages - they cause parsing errors on the client
    if (!message || message.trim().length === 0) {
      console.warn(`[StreamableHTTP] Skipping empty message in broadcast`);
      return;
    }
    
    const messageSize = Buffer.byteLength(message, 'utf8');
    let parsedMessage: any;
    
    try {
      parsedMessage = JSON.parse(message);
    } catch {
      parsedMessage = { type: 'unknown' };
    }
    
    const messageType = parsedMessage.method || parsedMessage.type || 'unknown';
    const messageId = parsedMessage.id || 'unknown';

    // If no subscribers, buffer the message for later delivery
    if (this.subscribers.size === 0) {
      // Check if global buffer would exceed limit
      if (this.globalBufferSize + messageSize <= this.maxBufferSize) {
        this.globalMessageBuffer.push(message);
        this.globalBufferSize += messageSize;
        console.log(`[StreamableHTTP] No subscribers, buffering message: type=${messageType}, id=${messageId}, size=${messageSize}b (buffer: ${this.globalMessageBuffer.length} messages, ${this.globalBufferSize}b)`);
      } else {
        console.warn(`[StreamableHTTP] Global buffer full (${this.globalBufferSize}/${this.maxBufferSize}), dropping message: type=${messageType}, id=${messageId}`);
      }
      return;
    }

    console.log(`[StreamableHTTP] Broadcasting message to ${this.subscribers.size} subscribers: type=${messageType}, id=${messageId}, size=${messageSize}b`);

    const toRemove: string[] = [];
    for (const [id, subscriber] of this.subscribers.entries()) {
      try {
        // Check if buffer would exceed limit
        if (isBufferOverLimit(subscriber, this.maxBufferSize - messageSize)) {
          console.warn(`[StreamableHTTP] Subscriber ${id} buffer over limit (${subscriber.bufferSize}/${this.maxBufferSize}), disconnecting`);
          toRemove.push(id);
          continue;
        }

        // Try to add to buffer
        if (!addToBuffer(subscriber, message, this.maxBufferSize)) {
          console.warn(`[StreamableHTTP] Subscriber ${id} buffer full (${subscriber.bufferSize}/${this.maxBufferSize}), disconnecting`);
          toRemove.push(id);
          continue;
        }

        // Write buffered messages if possible
        this.flushSubscriber(subscriber);
      } catch (error) {
        console.error(`[StreamableHTTP] Error broadcasting to subscriber ${id} (message: ${messageType}, id: ${messageId}):`, error);
        toRemove.push(id);
      }
    }

    // Remove failed subscribers
    if (toRemove.length > 0) {
      console.warn(`[StreamableHTTP] Removing ${toRemove.length} failed subscribers`);
      for (const id of toRemove) {
        this.removeSubscriber(id);
      }
    }
  }

  /**
   * Flush buffered messages for a subscriber
   * Per MCP spec: Streamable HTTP uses newline-delimited JSON (NDJSON) format
   * Each JSON-RPC message is sent as a single line, terminated by a newline
   */
  private flushSubscriber(subscriber: StreamSubscriber): void {
    try {
      const res = subscriber.response as Response;
      
      // Check if response is still writable
      if (res.writableEnded || res.destroyed) {
        console.warn(`[StreamableHTTP] Response for ${subscriber.id} is closed, cannot write`);
        this.removeSubscriber(subscriber.id);
        return;
      }
      
      while (subscriber.buffer.length > 0) {
        const message = subscriber.buffer[0];
        
        // Skip empty messages - they cause parsing errors on the client
        if (!message || message.trim().length === 0) {
          console.warn(`[StreamableHTTP] Skipping empty message for ${subscriber.id}`);
          subscriber.buffer.shift();
          subscriber.bufferSize -= Buffer.byteLength(message || '', 'utf8');
          continue;
        }
        
        const messageWithNewline = message + '\n';
        
        // Streamable HTTP: send JSON lines (newline-delimited JSON per MCP spec)
        // Format: <json-object>\n (one JSON object per line)
        console.log(`[StreamableHTTP] Attempting to write to ${subscriber.id}: ${messageWithNewline.length} bytes`);
        
        // Check again before each write
        if (res.writableEnded || res.destroyed) {
          console.warn(`[StreamableHTTP] Response for ${subscriber.id} closed during flush`);
          this.removeSubscriber(subscriber.id);
          return;
        }
        
        try {
          const written = res.write(messageWithNewline);
          
          if (!written) {
            // Backpressure: can't write more, wait for drain
            console.log(`[StreamableHTTP] Backpressure detected for ${subscriber.id}, waiting for drain`);
            (subscriber.response as Response).once('drain', () => {
              console.log(`[StreamableHTTP] Drain event received for ${subscriber.id}, resuming flush`);
              this.flushSubscriber(subscriber);
            });
            return;
          }

          // Log response sent to subscriber
          try {
            let parsedMessage: any;
            try {
              parsedMessage = JSON.parse(message);
            } catch {
              parsedMessage = { type: 'unknown' };
            }
            const messageType = parsedMessage.method || (parsedMessage.result !== undefined ? 'response' : (parsedMessage.error !== undefined ? 'error' : 'unknown'));
            const messageId = parsedMessage.id !== undefined ? parsedMessage.id : 'notification';
            const messagePreview = message.length > 200 ? message.substring(0, 200) + '...' : message;
            console.log(`[StreamableHTTP] ✓ Successfully wrote to ${subscriber.id}: type=${messageType}, id=${messageId}, size=${message.length}b | ${messagePreview}`);
          } catch (logError) {
            // Don't fail on logging errors
            console.log(`[StreamableHTTP] ✓ Successfully wrote to ${subscriber.id}: size=${message.length}b`);
          }

          // Successfully written, remove from buffer
          subscriber.buffer.shift();
          subscriber.bufferSize -= Buffer.byteLength(message, 'utf8');
          subscriber.lastActivity = new Date();
        } catch (writeError) {
          console.error(`[StreamableHTTP] ✗ Write error for ${subscriber.id}:`, writeError);
          throw writeError;
        }
      }
    } catch (error) {
      console.error(`[StreamableHTTP] Error flushing subscriber ${subscriber.id}:`, error);
      throw error;
    }
  }

  /**
   * Deliver buffered messages to a new subscriber
   */
  private deliverBufferedMessages(subscriber: StreamSubscriber): void {
    if (this.globalMessageBuffer.length === 0) {
      return;
    }

    console.log(`[StreamableHTTP] Delivering ${this.globalMessageBuffer.length} buffered messages to ${subscriber.id}`);
    
    // Add all buffered messages to the subscriber's buffer
    let deliveredCount = 0;
    const messagesToDeliver = [...this.globalMessageBuffer]; // Copy array before clearing
    
    for (const message of messagesToDeliver) {
      const messageSize = Buffer.byteLength(message, 'utf8');
      
      // Check if subscriber buffer would exceed limit
      if (isBufferOverLimit(subscriber, this.maxBufferSize - messageSize)) {
        console.warn(`[StreamableHTTP] Subscriber ${subscriber.id} buffer would exceed limit, stopping delivery`);
        break;
      }

      // Add to subscriber buffer
      if (!addToBuffer(subscriber, message, this.maxBufferSize)) {
        console.warn(`[StreamableHTTP] Subscriber ${subscriber.id} buffer full, stopping delivery`);
        break;
      }
      
      deliveredCount++;
    }

    // Clear global buffer after delivering
    this.globalMessageBuffer = [];
    this.globalBufferSize = 0;

    console.log(`[StreamableHTTP] Delivered ${deliveredCount} buffered messages to ${subscriber.id}`);

    // Flush the subscriber to send the messages
    try {
      this.flushSubscriber(subscriber);
    } catch (error) {
      console.error(`[StreamableHTTP] Error flushing subscriber ${subscriber.id} after delivering buffered messages:`, error);
    }
  }

  /**
   * Remove a subscriber
   */
  private removeSubscriber(subscriberId: string): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) {
      return;
    }

    try {
      clearBuffer(subscriber);
      (subscriber.response as Response).end();
    } catch (error) {
      // Ignore errors on cleanup
    }

    this.subscribers.delete(subscriberId);
    console.log(`[StreamableHTTP] Client disconnected: ${subscriberId} (remaining: ${this.subscribers.size})`);
  }

  /**
   * Get subscriber count
   */
  public getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Close all connections (for graceful shutdown)
   */
  public async closeAll(): Promise<void> {
    const closePromises = Array.from(this.subscribers.keys()).map((id) => {
      return new Promise<void>((resolve) => {
        const subscriber = this.subscribers.get(id);
        if (subscriber) {
          try {
            // Just close the connection - no need for a closing message
            (subscriber.response as Response).end(() => resolve());
          } catch {
            resolve();
          }
        } else {
          resolve();
        }
      });
    });

    await Promise.all(closePromises);
    this.subscribers.clear();
    console.log('[StreamableHTTP] All connections closed');
  }
}

