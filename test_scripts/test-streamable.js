#!/usr/bin/env node
/**
 * Test script for Streamable HTTP MCP endpoint
 * Handles chunked transfer encoding and NDJSON parsing
 * Example usage:
 * node test-streamable.js get
 * node test-streamable.js post '{"jsonrpc":"2.0","method":"initialize","params":{},"id":0}'
 * Environment variables:
 * BASE_URL          - Base URL (default: http://localhost:3000)
 * ENDPOINT          - Endpoint path (default: /mcp/streamable)
 * TIMEOUT_SECONDS   - How long to keep stream open (default: 300 = 5 minutes)
 * Examples:
 * node test-streamable.js get
 * node test-streamable.js post '{"jsonrpc":"2.0","method":"initialize","params":{},"id":0}'
 * TIMEOUT_SECONDS=600 node test-streamable.js post  # Keep open for 10 minutes
 */

import http from 'http';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ENDPOINT = process.env.ENDPOINT || '/mcp/streamable';
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || '60', 10); // Default 1 minute

function testGetStream() {
  console.log(`\n[GET Stream] Connecting to ${BASE_URL}${ENDPOINT}...`);
  console.log(`[Info] Stream will stay open for ${TIMEOUT_SECONDS} seconds (or until Ctrl+C)\n`);
  
  let messageCount = 0;
  let timeoutId = null;
  
  const req = http.get(`${BASE_URL}${ENDPOINT}`, {
    headers: {
      'Accept': 'application/json',
      'Connection': 'keep-alive'
    }
  }, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers:`, res.headers);
    console.log(`\n--- Streaming messages ---\n`);
    
    let buffer = '';
    
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      
      // Process complete lines (NDJSON format)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            messageCount++;
            console.log(`[Message #${messageCount} - ${new Date().toISOString()}]`, JSON.stringify(message, null, 2));
          } catch (e) {
            console.log(`[Raw]`, line);
          }
        }
      }
    });
    
    res.on('end', () => {
      console.log(`\n--- Stream ended by server ---`);
      if (buffer.trim()) {
        try {
          const message = JSON.parse(buffer);
          messageCount++;
          console.log(`[Final Message #${messageCount}]`, JSON.stringify(message, null, 2));
        } catch (e) {
          console.log(`[Final Raw]`, buffer);
        }
      }
      console.log(`\nTotal messages received: ${messageCount}`);
      console.log(`Waiting ${TIMEOUT_SECONDS} seconds before closing... (Press Ctrl+C to exit immediately)`);
      
      // Don't exit immediately - wait for timeout or manual exit
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
    
    res.on('error', (err) => {
      console.error(`Stream error:`, err);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      process.exit(1);
    });
  });
  
  req.on('error', (err) => {
    console.error(`Request error:`, err);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    process.exit(1);
  });
  
  // Handle Ctrl+C gracefully
  const cleanup = () => {
    console.log(`\n\n--- Closing connection (received ${messageCount} messages) ---`);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    req.destroy();
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  // Keep connection open for specified duration
  timeoutId = setTimeout(() => {
    console.log(`\n\n--- Closing connection after ${TIMEOUT_SECONDS}s (received ${messageCount} messages) ---`);
    req.destroy();
    process.exit(0);
  }, TIMEOUT_SECONDS * 1000);
}

function testPostStream(body) {
  console.log(`\n[POST Stream] Sending to ${BASE_URL}${ENDPOINT}...`);
  console.log(`[Info] Stream will stay open for ${TIMEOUT_SECONDS} seconds (or until Ctrl+C)`);
  console.log(`Request body:`, JSON.stringify(body, null, 2));
  console.log(`\n--- Streaming response ---\n`);
  
  const postData = JSON.stringify(body);
  let messageCount = 0;
  let timeoutId = null;
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Connection': 'keep-alive'
    }
  };
  
  const req = http.request(`${BASE_URL}${ENDPOINT}`, options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers:`, res.headers);
    console.log(`\n--- Streaming messages ---\n`);
    
    let buffer = '';
    
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      
      // Process complete lines (NDJSON format)
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            messageCount++;
            console.log(`[Message #${messageCount} - ${new Date().toISOString()}]`, JSON.stringify(message, null, 2));
          } catch (e) {
            console.log(`[Raw]`, line);
          }
        }
      }
    });
    
    res.on('end', () => {
      console.log(`\n--- Stream ended by server ---`);
      if (buffer.trim()) {
        try {
          const message = JSON.parse(buffer);
          messageCount++;
          console.log(`[Final Message #${messageCount}]`, JSON.stringify(message, null, 2));
        } catch (e) {
          console.log(`[Final Raw]`, buffer);
        }
      }
      console.log(`\nTotal messages received: ${messageCount}`);
      console.log(`Waiting ${TIMEOUT_SECONDS} seconds before closing... (Press Ctrl+C to exit immediately)`);
      
      // Don't exit immediately - wait for timeout or manual exit
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
    
    res.on('error', (err) => {
      console.error(`Stream error:`, err);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      process.exit(1);
    });
  });
  
  req.on('error', (err) => {
    console.error(`Request error:`, err);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    process.exit(1);
  });
  
  // Handle Ctrl+C gracefully
  const cleanup = () => {
    console.log(`\n\n--- Closing connection (received ${messageCount} messages) ---`);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    req.destroy();
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  req.write(postData);
  req.end();
  
  // Keep connection open for specified duration
  timeoutId = setTimeout(() => {
    console.log(`\n\n--- Closing connection after ${TIMEOUT_SECONDS}s (received ${messageCount} messages) ---`);
    req.destroy();
    process.exit(0);
  }, TIMEOUT_SECONDS * 1000);
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'get';

if (command === 'get') {
  testGetStream();
} else if (command === 'post') {
  const body = args[1] 
    ? JSON.parse(args[1])
    : {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {
            sampling: {},
            elicitation: {},
            roots: {
              listChanged: true
            }
          },
          clientInfo: {
            name: "test-client",
            version: "1.0.0"
          }
        },
        id: 0
      };
  testPostStream(body);
} else {
  console.log(`Usage:
  node test-streamable.js get
  node test-streamable.js post [json-body]
  
Environment variables:
  BASE_URL          - Base URL (default: http://localhost:3000)
  ENDPOINT          - Endpoint path (default: /mcp/streamable)
  TIMEOUT_SECONDS   - How long to keep stream open (default: 300 = 5 minutes)
  
Examples:
  node test-streamable.js get
  node test-streamable.js post '{"jsonrpc":"2.0","method":"initialize","params":{},"id":0}'
  TIMEOUT_SECONDS=600 node test-streamable.js post  # Keep open for 10 minutes
`);
  process.exit(1);
}
