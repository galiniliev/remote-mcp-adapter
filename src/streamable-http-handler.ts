/**
 * Streamable HTTP handler for alternative streaming transport (APIM preferred)
 */

import type { Request, Response } from 'express';
import type { StreamSubscriber } from './types.js';
import { addToBuffer, isBufferOverLimit, clearBuffer } from './utils/buffer.js';

export class StreamableHttpHandler {
  private subscribers: Map<string, StreamSubscriber> = new Map();
  private readonly maxBufferSize: number;
  private readonly maxSubscribers: number;
  private subscriberIdCounter = 0;

  constructor(maxBufferSize: number = 1048576, maxSubscribers: number = 100) {
    this.maxBufferSize = maxBufferSize;
    this.maxSubscribers = maxSubscribers;
  }

  /**
   * Handle Streamable HTTP connection request
   */
  public handleStream(req: Request, res: Response): void {
    // Check subscriber limit
    if (this.subscribers.size >= this.maxSubscribers) {
      res.status(503).json({ error: 'Maximum number of subscribers reached' });
      return;
    }

    // Set streaming headers (similar to SSE but using chunked transfer encoding)
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

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

    // Send initial connection message
    try {
      res.write(JSON.stringify({ type: 'connected', id: subscriberId }) + '\n');
    } catch (error) {
      console.error(`[StreamableHTTP] Failed to write initial message:`, error);
      this.removeSubscriber(subscriberId);
      return;
    }

    // Handle client disconnect
    req.on('close', () => {
      this.removeSubscriber(subscriberId);
    });

    req.on('aborted', () => {
      this.removeSubscriber(subscriberId);
    });

    console.log(`[StreamableHTTP] Client connected: ${subscriberId} (total: ${this.subscribers.size})`);
  }

  /**
   * Broadcast a message to all subscribers
   */
  public broadcast(message: string): void {
    if (this.subscribers.size === 0) {
      return;
    }

    const messageSize = Buffer.byteLength(message, 'utf8');
    const toRemove: string[] = [];

    for (const [id, subscriber] of this.subscribers.entries()) {
      try {
        // Check if buffer would exceed limit
        if (isBufferOverLimit(subscriber, this.maxBufferSize - messageSize)) {
          console.warn(`[StreamableHTTP] Subscriber ${id} buffer over limit, disconnecting`);
          toRemove.push(id);
          continue;
        }

        // Try to add to buffer
        if (!addToBuffer(subscriber, message, this.maxBufferSize)) {
          console.warn(`[StreamableHTTP] Subscriber ${id} buffer full, disconnecting`);
          toRemove.push(id);
          continue;
        }

        // Write buffered messages if possible
        this.flushSubscriber(subscriber);
      } catch (error) {
        console.error(`[StreamableHTTP] Error broadcasting to subscriber ${id}:`, error);
        toRemove.push(id);
      }
    }

    // Remove failed subscribers
    for (const id of toRemove) {
      this.removeSubscriber(id);
    }
  }

  /**
   * Flush buffered messages for a subscriber
   */
  private flushSubscriber(subscriber: StreamSubscriber): void {
    try {
      while (subscriber.buffer.length > 0) {
        const message = subscriber.buffer[0];
        // Streamable HTTP: send JSON lines (newline-delimited JSON)
        const written = (subscriber.response as Response).write(message + '\n');
        
        if (!written) {
          // Backpressure: can't write more, wait for drain
          (subscriber.response as Response).once('drain', () => {
            this.flushSubscriber(subscriber);
          });
          return;
        }

        // Successfully written, remove from buffer
        subscriber.buffer.shift();
        subscriber.bufferSize -= Buffer.byteLength(message, 'utf8');
        subscriber.lastActivity = new Date();
      }
    } catch (error) {
      console.error(`[StreamableHTTP] Error flushing subscriber ${subscriber.id}:`, error);
      throw error;
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
            (subscriber.response as Response).write(JSON.stringify({ type: 'closing' }) + '\n');
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

