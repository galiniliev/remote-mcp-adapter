/**
 * Unit tests for configuration parser
 */

import {
  resolveInputVariables,
  getStdioTool,
  loadBridgeConfig,
} from '../config.js';
import type { McpConfiguration, McpInput } from '../types.js';

describe('Configuration Parser', () => {
  describe('resolveInputVariables', () => {
    beforeEach(() => {
      // Clear environment variables
      delete process.env.INPUT_TEST_VAR;
      delete process.env.TEST_VAR;
    });

    it('should resolve environment variable with INPUT_ prefix', () => {
      process.env.INPUT_MY_VAR = 'resolved_value';
      const args = ['test', '${input:my_var}', 'end'];
      const result = resolveInputVariables(args, []);
      expect(result[1]).toBe('resolved_value');
    });

    it('should resolve direct environment variable', () => {
      process.env.MY_VAR = 'direct_value';
      const args = ['${input:my_var}'];
      const result = resolveInputVariables(args, []);
      expect(result[0]).toBe('direct_value');
    });

    it('should use default value from input definition', () => {
      const inputs: McpInput[] = [
        {
          id: 'test_var',
          type: 'promptString',
          default: 'default_value',
        },
      ];
      const args = ['${input:test_var}'];
      const result = resolveInputVariables(args, inputs);
      expect(result[0]).toBe('default_value');
    });

    it('should use env override over input definition', () => {
      process.env.INPUT_TEST_VAR = 'env_value';
      const inputs: McpInput[] = [
        {
          id: 'test_var',
          type: 'promptString',
          default: 'default_value',
        },
      ];
      const args = ['${input:test_var}'];
      const result = resolveInputVariables(args, inputs, { test_var: 'override_value' });
      expect(result[0]).toBe('override_value');
    });

    it('should throw on unresolved variable', () => {
      const args = ['${input:unknown_var}'];
      expect(() => resolveInputVariables(args, [])).toThrow();
    });

    it('should leave non-variable args unchanged', () => {
      const args = ['arg1', 'arg2', 'arg3'];
      const result = resolveInputVariables(args, []);
      expect(result).toEqual(args);
    });
  });

  describe('getStdioTool', () => {
    it('should return first STDIO tool', () => {
      const config: McpConfiguration = {
        tools: [
          {
            id: 'tool1',
            type: 'stdio',
            command: 'node',
            args: ['script.js'],
          },
        ],
      };
      const tool = getStdioTool(config);
      expect(tool.id).toBe('tool1');
      expect(tool.command).toBe('node');
    });

    it('should throw if no STDIO tool found', () => {
      const config: McpConfiguration = {
        tools: [],
      };
      expect(() => getStdioTool(config)).toThrow();
    });
  });

  describe('loadBridgeConfig', () => {
    it('should load default configuration', () => {
      const config = loadBridgeConfig();
      expect(config.port).toBeDefined();
      expect(config.maxBufferSize).toBeDefined();
    });

    it('should respect environment variables', () => {
      process.env.PORT = '8080';
      process.env.MAX_BUFFER_SIZE = '2048';
      const config = loadBridgeConfig();
      expect(config.port).toBe(8080);
      expect(config.maxBufferSize).toBe(2048);
      delete process.env.PORT;
      delete process.env.MAX_BUFFER_SIZE;
    });
  });
});

