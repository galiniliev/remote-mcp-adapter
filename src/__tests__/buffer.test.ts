/**
 * Unit tests for buffer utilities
 */

import {
  calculateBufferSize,
  isBufferOverLimit,
  addToBuffer,
  clearBuffer,
  findStaleSubscribers,
} from '../utils/buffer.js';
import type { StreamSubscriber } from '../types.js';

describe('Buffer Utilities', () => {
  describe('calculateBufferSize', () => {
    it('should calculate total buffer size', () => {
      const buffer = ['message1', 'message2', 'message3'];
      const size = calculateBufferSize(buffer);
      expect(size).toBeGreaterThan(0);
    });

    it('should return 0 for empty buffer', () => {
      expect(calculateBufferSize([])).toBe(0);
    });
  });

  describe('isBufferOverLimit', () => {
    it('should detect buffer over limit', () => {
      const subscriber: StreamSubscriber = {
        id: 'test',
        response: {} as NodeJS.WritableStream,
        buffer: ['large message'],
        bufferSize: 1000,
        connectedAt: new Date(),
        lastActivity: new Date(),
      };
      expect(isBufferOverLimit(subscriber, 500)).toBe(true);
    });

    it('should detect buffer under limit', () => {
      const subscriber: StreamSubscriber = {
        id: 'test',
        response: {} as NodeJS.WritableStream,
        buffer: ['small'],
        bufferSize: 100,
        connectedAt: new Date(),
        lastActivity: new Date(),
      };
      expect(isBufferOverLimit(subscriber, 500)).toBe(false);
    });
  });

  describe('addToBuffer', () => {
    it('should add message to buffer', () => {
      const subscriber: StreamSubscriber = {
        id: 'test',
        response: {} as NodeJS.WritableStream,
        buffer: [],
        bufferSize: 0,
        connectedAt: new Date(),
        lastActivity: new Date(),
      };
      const result = addToBuffer(subscriber, 'test message', 1000);
      expect(result).toBe(true);
      expect(subscriber.buffer.length).toBe(1);
      expect(subscriber.bufferSize).toBeGreaterThan(0);
    });

    it('should reject message that exceeds limit', () => {
      const subscriber: StreamSubscriber = {
        id: 'test',
        response: {} as NodeJS.WritableStream,
        buffer: [],
        bufferSize: 0,
        connectedAt: new Date(),
        lastActivity: new Date(),
      };
      const largeMessage = 'x'.repeat(2000);
      const result = addToBuffer(subscriber, largeMessage, 1000);
      expect(result).toBe(false);
      expect(subscriber.buffer.length).toBe(0);
    });
  });

  describe('clearBuffer', () => {
    it('should clear buffer', () => {
      const subscriber: StreamSubscriber = {
        id: 'test',
        response: {} as NodeJS.WritableStream,
        buffer: ['msg1', 'msg2'],
        bufferSize: 100,
        connectedAt: new Date(),
        lastActivity: new Date(),
      };
      clearBuffer(subscriber);
      expect(subscriber.buffer.length).toBe(0);
      expect(subscriber.bufferSize).toBe(0);
    });
  });

  describe('findStaleSubscribers', () => {
    it('should find stale subscribers', () => {
      const now = Date.now();
      const staleDate = new Date(now - 100000); // 100 seconds ago
      const freshDate = new Date(now - 1000); // 1 second ago

      const subscribers = new Map<string, StreamSubscriber>([
        [
          'stale',
          {
            id: 'stale',
            response: {} as NodeJS.WritableStream,
            buffer: [],
            bufferSize: 0,
            connectedAt: staleDate,
            lastActivity: staleDate,
          },
        ],
        [
          'fresh',
          {
            id: 'fresh',
            response: {} as NodeJS.WritableStream,
            buffer: [],
            bufferSize: 0,
            connectedAt: freshDate,
            lastActivity: freshDate,
          },
        ],
      ]);

      const stale = findStaleSubscribers(subscribers, 50000); // 50 second timeout
      expect(stale.length).toBe(1);
      expect(stale[0].id).toBe('stale');
    });
  });
});

