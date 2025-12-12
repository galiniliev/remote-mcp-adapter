/**
 * Unit tests for JSON-RPC utilities
 */

import {
  parseJsonRpcLine,
  validateJsonRpcMessage,
  isRequest,
  isNotification,
  isResponse,
  formatJsonRpcMessage,
  parseJsonRpcBatch,
} from '../utils/jsonrpc.js';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from '../types.js';

describe('JSON-RPC Utilities', () => {
  describe('parseJsonRpcLine', () => {
    it('should parse a valid JSON-RPC request', () => {
      const line = '{"jsonrpc":"2.0","id":1,"method":"test","params":{}}';
      const result = parseJsonRpcLine(line);
      expect(result).toBeDefined();
      expect(result.jsonrpc).toBe('2.0');
      expect('method' in result).toBe(true);
    });

    it('should parse a valid JSON-RPC response', () => {
      const line = '{"jsonrpc":"2.0","id":1,"result":"success"}';
      const result = parseJsonRpcLine(line);
      expect(result).toBeDefined();
      expect(result.jsonrpc).toBe('2.0');
    });

    it('should handle empty lines', () => {
      expect(parseJsonRpcLine('')).toBeNull();
      expect(parseJsonRpcLine('   ')).toBeNull();
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseJsonRpcLine('{ invalid json }')).toThrow();
    });
  });

  describe('validateJsonRpcMessage', () => {
    it('should validate a request', () => {
      const msg: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
        params: {},
      };
      expect(() => validateJsonRpcMessage(msg)).not.toThrow();
    });

    it('should validate a notification', () => {
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'test',
      };
      expect(() => validateJsonRpcMessage(msg)).not.toThrow();
    });

    it('should validate a response', () => {
      const msg: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: 'success',
      };
      expect(() => validateJsonRpcMessage(msg)).not.toThrow();
    });

    it('should reject invalid version', () => {
      expect(() => validateJsonRpcMessage({ jsonrpc: '1.0', method: 'test' })).toThrow();
    });

    it('should reject non-object', () => {
      expect(() => validateJsonRpcMessage('string')).toThrow();
      expect(() => validateJsonRpcMessage(123)).toThrow();
      expect(() => validateJsonRpcMessage([])).toThrow();
    });
  });

  describe('isRequest', () => {
    it('should identify requests', () => {
      const msg: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      };
      expect(isRequest(msg)).toBe(true);
    });

    it('should reject notifications', () => {
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'test',
      };
      expect(isRequest(msg)).toBe(false);
    });
  });

  describe('isNotification', () => {
    it('should identify notifications', () => {
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'test',
      };
      expect(isNotification(msg)).toBe(true);
    });

    it('should reject requests', () => {
      const msg: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      };
      expect(isNotification(msg)).toBe(false);
    });
  });

  describe('formatJsonRpcMessage', () => {
    it('should format a message with newline', () => {
      const msg: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      };
      const formatted = formatJsonRpcMessage(msg);
      expect(formatted).toContain('\n');
      expect(formatted.trim()).toBe(JSON.stringify(msg));
    });

    it('should format a batch', () => {
      const batch = [
        { jsonrpc: '2.0', id: 1, method: 'test' },
        { jsonrpc: '2.0', id: 2, method: 'test2' },
      ];
      const formatted = formatJsonRpcMessage(batch);
      expect(formatted).toContain('\n');
    });
  });

  describe('parseJsonRpcBatch', () => {
    it('should parse a valid batch', () => {
      const batch = [
        { jsonrpc: '2.0', id: 1, method: 'test' },
        { jsonrpc: '2.0', id: 2, method: 'test2' },
      ];
      const result = parseJsonRpcBatch(batch);
      expect(result).toHaveLength(2);
    });

    it('should reject non-array', () => {
      expect(() => parseJsonRpcBatch({})).toThrow();
    });
  });
});

