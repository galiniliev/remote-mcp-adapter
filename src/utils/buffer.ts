/**
 * Utilities for buffering and backpressure management
 */

import type { StreamSubscriber } from '../types.js';

/**
 * Calculate total buffer size in bytes (approximate)
 */
export function calculateBufferSize(buffer: string[]): number {
  return buffer.reduce((total, msg) => total + Buffer.byteLength(msg, 'utf8'), 0);
}

/**
 * Check if a subscriber's buffer exceeds the limit
 */
export function isBufferOverLimit(subscriber: StreamSubscriber, maxSize: number): boolean {
  return subscriber.bufferSize > maxSize;
}

/**
 * Add a message to a subscriber's buffer
 */
export function addToBuffer(subscriber: StreamSubscriber, message: string, maxSize: number): boolean {
  const messageSize = Buffer.byteLength(message, 'utf8');
  
  if (subscriber.bufferSize + messageSize > maxSize) {
    return false; // Buffer would exceed limit
  }

  subscriber.buffer.push(message);
  subscriber.bufferSize += messageSize;
  subscriber.lastActivity = new Date();
  return true;
}

/**
 * Clear a subscriber's buffer
 */
export function clearBuffer(subscriber: StreamSubscriber): void {
  subscriber.buffer = [];
  subscriber.bufferSize = 0;
}

/**
 * Remove slow subscribers that haven't been active
 */
export function findStaleSubscribers(
  subscribers: Map<string, StreamSubscriber>,
  timeoutMs: number
): StreamSubscriber[] {
  const now = Date.now();
  const stale: StreamSubscriber[] = [];

  for (const subscriber of subscribers.values()) {
    const idleTime = now - subscriber.lastActivity.getTime();
    if (idleTime > timeoutMs) {
      stale.push(subscriber);
    }
  }

  return stale;
}

