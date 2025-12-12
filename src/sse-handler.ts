/**
 * Server-Sent Events (SSE) handler for streaming JSON-RPC messages to clients
 */

import type { Request, Response } from 'express';
import type { StreamSubscriber } from './types.js';
import { addToBuffer, isBufferOverLimit, clearBuffer } from './utils/buffer.js';

export class SseHandler {
  private subscribers: Map<string, StreamSubscriber> = new Map();
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private readonly keepaliveIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly maxSubscribers: number;
  private subscriberIdCounter = 0;

  constructor(keepaliveIntervalMs: number = 30000, maxBufferSize: number = 1048576, maxSubscribers: number = 100) {
    this.keepaliveIntervalMs = keepaliveIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.maxSubscribers = maxSubscribers;
  }

  /**
   * Handle SSE connection request
   */
  public handleStream(req: Request, res: Response): void {
    // Check subscriber limit
    if (this.subscribers.size >= this.maxSubscribers) {
      res.status(503).json({ error: 'Maximum number of subscribers reached' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Generate unique subscriber ID
    const subscriberId = `sub_${Date.now()}_${++this.subscriberIdCounter}`;
    
    const subscriber: StreamSubscriber = {
      id: subscriberId,
      response: res,
      buffer: [],
      bufferSize: 0,
      connectedAt: new Date(),
      lastActivity: new Date(),
    };

    this.subscribers.set(subscriberId, subscriber);

    // Send initial comment to open the stream
    res.write(': stream opened\n\n');

    // Handle client disconnect
    req.on('close', () => {
      this.removeSubscriber(subscriberId);
    });

    req.on('aborted', () => {
      this.removeSubscriber(subscriberId);
    });

    // Start keepalive if this is the first subscriber
    if (this.subscribers.size === 1) {
      this.startKeepalive();
    }

    console.log(`[SSE] Client connected: ${subscriberId} (total: ${this.subscribers.size})`);
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
          console.warn(`[SSE] Subscriber ${id} buffer over limit, disconnecting`);
          toRemove.push(id);
          continue;
        }

        // Try to add to buffer (for backpressure handling)
        if (!addToBuffer(subscriber, message, this.maxBufferSize)) {
          console.warn(`[SSE] Subscriber ${id} buffer full, disconnecting`);
          toRemove.push(id);
          continue;
        }

        // Write buffered messages if possible
        this.flushSubscriber(subscriber);
      } catch (error) {
        console.error(`[SSE] Error broadcasting to subscriber ${id}:`, error);
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
        const written = (subscriber.response as Response).write(`data: ${message}\n\n`);
        
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
      console.error(`[SSE] Error flushing subscriber ${subscriber.id}:`, error);
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

    // Stop keepalive if no subscribers left
    if (this.subscribers.size === 0) {
      this.stopKeepalive();
    }

    console.log(`[SSE] Client disconnected: ${subscriberId} (remaining: ${this.subscribers.size})`);
  }

  /**
   * Start keepalive timer
   */
  private startKeepalive(): void {
    if (this.keepaliveInterval) {
      return;
    }

    this.keepaliveInterval = setInterval(() => {
      if (this.subscribers.size === 0) {
        this.stopKeepalive();
        return;
      }

      // Send keepalive comment to all subscribers
      for (const subscriber of this.subscribers.values()) {
        try {
          (subscriber.response as Response).write(': keepalive\n\n');
        } catch (error) {
          // Subscriber may have disconnected, will be cleaned up on next broadcast
          console.warn(`[SSE] Keepalive failed for ${subscriber.id}:`, error);
        }
      }
    }, this.keepaliveIntervalMs);

    console.log(`[SSE] Keepalive started (interval: ${this.keepaliveIntervalMs}ms)`);
  }

  /**
   * Stop keepalive timer
   */
  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
      console.log('[SSE] Keepalive stopped');
    }
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
    this.stopKeepalive();

    const closePromises = Array.from(this.subscribers.keys()).map((id) => {
      return new Promise<void>((resolve) => {
        const subscriber = this.subscribers.get(id);
        if (subscriber) {
          try {
            (subscriber.response as Response).write(': closing\n\n');
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
    console.log('[SSE] All connections closed');
  }
}

