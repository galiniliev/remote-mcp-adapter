/**
 * Express HTTP server with MCP bridge endpoints
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'http';
import { ProcessManager } from './process-manager.js';
import { SseHandler } from './sse-handler.js';
import { StreamableHttpHandler } from './streamable-http-handler.js';
import { MessageRouter } from './message-router.js';
import { HealthHandler } from './health.js';
import { validateJsonRpcMessage, parseJsonRpcBatch, formatJsonRpcMessage } from './utils/jsonrpc.js';
import type { BridgeConfig, JsonRpcMessage, JsonRpcBatch } from './types.js';
import type { McpTool } from './types.js';

export class BridgeServer {
  private app: express.Application;
  private server: Server | null = null;
  private processManager: ProcessManager;
  private sseHandler: SseHandler;
  private streamableHttpHandler: StreamableHttpHandler;
  private messageRouter: MessageRouter;
  private healthHandler: HealthHandler;
  private config: BridgeConfig;
  private shutdownInProgress = false;

  constructor(config: BridgeConfig, tool: McpTool) {
    this.config = config;
    this.app = express();

    // CORS middleware - must be before other middleware
    this.app.use(this.corsMiddleware.bind(this));

    // Middleware
    this.app.use(express.json({ limit: `${config.maxMessageSize}b` }));
    this.app.use(this.loggingMiddleware.bind(this));

    // Initialize handlers
    this.sseHandler = new SseHandler(
      config.keepaliveInterval,
      config.maxBufferSize,
      config.maxSubscribers
    );
    this.streamableHttpHandler = new StreamableHttpHandler(
      config.maxBufferSize,
      config.maxSubscribers
    );
    
    // Set up message relay callback for streamable HTTP handler
    this.streamableHttpHandler.setMessageRelayCallback((message: string) => {
      if (this.processManager.isRunning()) {
        this.processManager.write(message);
      } else if (this.config.lazyStart) {
        this.processManager.start();
        setTimeout(() => {
          if (this.processManager.isRunning()) {
            this.processManager.write(message);
          }
        }, 100);
      }
    });
    
    this.messageRouter = new MessageRouter(this.sseHandler, this.streamableHttpHandler);

    // Initialize process manager
    this.processManager = new ProcessManager(
      tool,
      {
        onStdout: (data: Buffer) => {
          this.messageRouter.processStdout(data);
        },
        onStderr: (data: Buffer) => {
          console.error('[MCP Server stderr]:', data.toString('utf-8'));
        },
        onExit: (code, signal) => {
          console.log(`[ProcessManager] Process exited: code=${code}, signal=${signal}`);
        },
        onError: (error) => {
          console.error('[ProcessManager] Error:', error);
        },
      },
      config.restartBackoffBase,
      config.restartBackoffMax,
      config.lazyStart
    );

    this.healthHandler = new HealthHandler(
      this.processManager,
      () => this.sseHandler.getSubscriberCount(),
      () => this.streamableHttpHandler.getSubscriberCount()
    );

    // Set up routes
    this.setupRoutes();

    // Start process if not lazy-start
    if (!config.lazyStart) {
      this.processManager.start();
    }
  }

  /**
   * CORS middleware to allow all origins, methods, and headers
   */
  private corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Set CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    next();
  }

  /**
   * Set up HTTP routes
   */
  private setupRoutes(): void {
    console.log('[BridgeServer] Setting up routes...');
    
    // Health check endpoint
    this.app.get('/healthz', (req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      console.log(`[GET /healthz] ${requestId} Health check requested`);
      this.healthHandler.handleHealth(req, res);
    });

    // SSE stream endpoint (GET and POST)
    const handleSseStream = (req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      const method = req.method;
      console.log(
        `[${method} /mcp/stream] ${requestId} SSE connection requested | ` +
        `IP: ${req.ip || req.socket.remoteAddress || 'unknown'} | ` +
        `UA: ${req.headers['user-agent'] || 'unknown'} | ` +
        `Accept: ${req.headers['accept'] || 'none'} | ` +
        `Query: ${Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : 'none'}` +
        (method === 'POST' && req.body ? ` | Body size: ${JSON.stringify(req.body).length}b` : '')
      );
      
      // Ensure process is running before handling initial message
      if (!this.processManager.isRunning() && this.config.lazyStart) {
        console.log(`[${method} /mcp/stream] ${requestId} Starting process via lazy start`);
        this.processManager.start();
      }
      
      // Handle initial message from POST body if present
      if (method === 'POST' && req.body && typeof req.body === 'object') {
        try {
          // Ensure process is running before writing
          if (!this.processManager.isRunning()) {
            console.warn(`[${method} /mcp/stream] ${requestId} Process not running, cannot send initial message`);
          } else {
            // Validate and send initial message if it's a valid JSON-RPC message
            if (Array.isArray(req.body)) {
              const messages = parseJsonRpcBatch(req.body);
              for (const msg of messages) {
                const formatted = formatJsonRpcMessage(msg as JsonRpcMessage | JsonRpcBatch);
                this.processManager.write(formatted);
              }
              console.log(`[${method} /mcp/stream] ${requestId} Processed ${messages.length} initial messages from POST body`);
            } else {
              validateJsonRpcMessage(req.body);
              const formatted = formatJsonRpcMessage(req.body as JsonRpcMessage);
              this.processManager.write(formatted);
              const methodName = (req.body as any).method || 'unknown';
              console.log(`[${method} /mcp/stream] ${requestId} Processed initial message from POST body: method=${methodName}`);
            }
          }
        } catch (error) {
          console.warn(`[${method} /mcp/stream] ${requestId} Failed to process initial message from POST body:`, error);
          // Continue with stream establishment even if initial message fails
        }
      }
      
      this.sseHandler.handleStream(req, res);
    };
    
    this.app.get('/mcp/stream', handleSseStream);
    this.app.post('/mcp/stream', handleSseStream);

    // Streamable HTTP endpoint (GET and POST)
    // Per MCP spec: GET establishes stream, POST sends messages and optionally establishes stream
    this.app.get('/mcp/streamable', (req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      console.log(
        `[GET /mcp/streamable] ${requestId} Streamable HTTP GET requested | ` +
        `IP: ${req.ip || req.socket.remoteAddress || 'unknown'} | ` +
        `UA: ${req.headers['user-agent'] || 'unknown'} | ` +
        `Accept: ${req.headers['accept'] || 'none'}`
      );
      
      // Ensure process is running before establishing stream
      if (!this.processManager.isRunning() && this.config.lazyStart) {
        console.log(`[GET /mcp/streamable] ${requestId} Starting process via lazy start`);
        this.processManager.start();
      }
      
      // Handle GET request - establish stream for server-to-client messages
      this.streamableHttpHandler.handleStream(req, res);
    });
    
    this.app.post('/mcp/streamable', (req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      console.log(
        `[POST /mcp/streamable] ${requestId} Streamable HTTP POST requested | ` +
        `IP: ${req.ip || req.socket.remoteAddress || 'unknown'} | ` +
        `UA: ${req.headers['user-agent'] || 'unknown'} | ` +
        `Accept: ${req.headers['accept'] || 'none'} | ` +
        `Content-Type: ${req.headers['content-type'] || 'none'}` +
        (req.body ? ` | Body size: ${JSON.stringify(req.body).length}b` : '')
      );
      
      // Ensure process is running before handling message
      if (!this.processManager.isRunning() && this.config.lazyStart) {
        console.log(`[POST /mcp/streamable] ${requestId} Starting process via lazy start`);
        this.processManager.start();
      }
      
      // Check if client wants to establish a stream (via query parameter or header)
      // Per MCP spec: POST can optionally establish a stream for multiple responses
      const establishStream = req.query.stream === 'true' || req.headers['x-mcp-stream'] === 'true';
      
      // Handle POST request - relay messages to STDIO and optionally establish stream
      this.streamableHttpHandler.handlePost(req, res, establishStream);
    });

    // Handle GET requests to POST endpoint (wrong method)
    this.app.get('/mcp', (req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      const errorMsg = 'GET method not supported for /mcp, use POST instead';
      (res as any).errorDetails = errorMsg;
      (res as any).allowedMethods = ['POST'];
      console.warn(
        `[GET /mcp] ${requestId} Method not allowed | ` +
        `Query: ${Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : 'none'} | ` +
        `IP: ${req.ip || req.socket.remoteAddress || 'unknown'} | ` +
        `Referer: ${req.headers['referer'] || 'none'}`
      );
      res.status(405).json({ 
        error: errorMsg,
        allowedMethods: ['POST'],
        path: '/mcp',
        receivedMethod: 'GET'
      });
    });

    // POST endpoint for JSON-RPC messages
    this.app.post('/mcp', (req: Request, res: Response) => {
      this.handlePostMcp(req, res);
    });

    // Root endpoint
    this.app.get('/', (req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      console.log(
        `[GET /] ${requestId} Root endpoint accessed | ` +
        `IP: ${req.ip || req.socket.remoteAddress || 'unknown'} | ` +
        `UA: ${req.headers['user-agent'] || 'unknown'}`
      );
      res.json({
        name: 'Remote MCP Bridge',
        version: '1.0.0',
        endpoints: {
          health: 'GET /healthz',
          sse: 'GET|POST /mcp/stream',
          streamableHttp: 'GET|POST /mcp/streamable',
          post: 'POST /mcp',
        },
      });
    });

    console.log('[BridgeServer] Routes registered:');
    console.log('  - OPTIONS * (CORS preflight)');
    console.log('  - GET  /healthz');
    console.log('  - GET  /mcp/stream');
    console.log('  - POST /mcp/stream');
    console.log('  - GET  /mcp/streamable');
    console.log('  - POST /mcp/streamable');
    console.log('  - GET  /mcp (405 handler)');
    console.log('  - POST /mcp');
    console.log('  - GET  /');
    console.log('  - *    404 handler (catch-all)');

    // Catch-all 404 handler
    this.app.use((req: Request, res: Response) => {
      const requestId = (req as any).requestId || 'unknown';
      const errorMsg = `Route not found: ${req.method} ${req.path}`;
      (res as any).errorDetails = errorMsg;
      
      // Log comprehensive 404 details
      const queryString = Object.keys(req.query).length > 0 ? `?${new URLSearchParams(req.query as Record<string, string>).toString()}` : '';
      const bodyPreview = req.body ? JSON.stringify(req.body).substring(0, 150) : 'none';
      const contentType = req.headers['content-type'] || 'none';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const referer = req.headers['referer'] || 'none';
      
      console.warn(
        `[404] ${requestId} Route not found | ` +
        `Method: ${req.method} | Path: ${req.path}${queryString} | ` +
        `Content-Type: ${contentType} | ` +
        `Body: ${bodyPreview}${req.body && JSON.stringify(req.body).length > 150 ? '...' : ''} | ` +
        `IP: ${req.ip || req.socket.remoteAddress || 'unknown'} | ` +
        `UA: ${userAgent.substring(0, 60)} | ` +
        `Referer: ${referer}`
      );
      
      // Log available routes for debugging
      console.log(
        `[404] ${requestId} Available routes: ` +
        `GET /healthz, GET|POST /mcp/stream, GET|POST /mcp/streamable, POST /mcp, GET /`
      );
      
      res.status(404).json({
        error: errorMsg,
        received: {
          method: req.method,
          path: req.path,
          query: Object.keys(req.query).length > 0 ? req.query : undefined,
        },
        availableEndpoints: {
          health: 'GET /healthz',
          sse: 'GET|POST /mcp/stream',
          streamableHttp: 'GET|POST /mcp/streamable',
          post: 'POST /mcp',
          root: 'GET /',
        },
      });
    });
  }

  /**
   * Handle POST /mcp endpoint
   */
  private handlePostMcp(req: Request, res: Response): void {
    const requestId = (req as any).requestId || 'unknown';
    
    console.log(
      `[POST /mcp] ${requestId} Processing request | ` +
      `Content-Type: ${req.headers['content-type'] || 'none'} | ` +
      `Body type: ${typeof req.body} | ` +
      `Body size: ${req.body ? JSON.stringify(req.body).length : 0}b | ` +
      `IP: ${req.ip || req.socket.remoteAddress || 'unknown'}`
    );
    
    // Validate Content-Type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      const errorMsg = `Content-Type must be application/json, got: ${contentType || 'none'}`;
      (res as any).errorDetails = errorMsg;
      console.warn(
        `[POST /mcp] ${requestId} Validation failed: ${errorMsg} | ` +
        `All headers: ${JSON.stringify(req.headers)} | ` +
        `Body preview: ${req.body ? JSON.stringify(req.body).substring(0, 500) : 'none'}`
      );
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
      console.warn(
        `[POST /mcp] ${requestId} Validation failed: ${errorMsg} | ` +
        `Body value: ${req.body ? String(req.body).substring(0, 500) : 'null/undefined'}`
      );
      res.status(400).json({ 
        error: errorMsg,
        receivedType: typeof req.body,
        expectedType: 'object or array'
      });
      return;
    }

    try {
      // Handle batch or single message
      let messages: unknown[];
      const isBatch = Array.isArray(req.body);
      
      console.log(`[POST /mcp] ${requestId} Processing ${isBatch ? 'batch' : 'single'} message`);
      
      if (isBatch) {
        // Batch request
        messages = parseJsonRpcBatch(req.body);
        console.log(`[POST /mcp] ${requestId} Parsed batch: ${messages.length} messages`);
      } else {
        // Single message
        validateJsonRpcMessage(req.body);
        messages = [req.body];
        const method = (req.body as any).method || 'unknown';
        console.log(`[POST /mcp] ${requestId} Validated single message: method=${method}`);
      }

      // Ensure process is running
      if (!this.processManager.isRunning()) {
        if (this.config.lazyStart) {
          console.log(`[POST /mcp] ${requestId} Process not running, starting lazy start...`);
          this.processManager.start();
          // Wait a bit for process to start
          setTimeout(() => {
            this.writeMessages(messages);
            console.log(`[POST /mcp] ${requestId} Messages queued after lazy start`);
          }, 100);
        } else {
          const errorMsg = 'MCP server process is not running';
          (res as any).errorDetails = errorMsg;
          console.warn(`[POST /mcp] ${requestId} ${errorMsg}`);
          res.status(503).json({ error: errorMsg });
          return;
        }
      } else {
        this.writeMessages(messages);
        console.log(`[POST /mcp] ${requestId} Messages written to process stdin`);
      }

      // Return 202 Accepted (async mode)
      res.status(202).json({
        status: 'accepted',
        messageCount: messages.length,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      (res as any).errorDetails = `Invalid JSON-RPC message: ${errorMsg}`;
      (res as any).errorStack = errorStack;
      
      console.error(
        `[POST /mcp] ${requestId} Error processing JSON-RPC message | ` +
        `Error: ${errorMsg} | ` +
        `Body: ${req.body ? JSON.stringify(req.body).substring(0, 200) : 'none'} | ` +
        `Stack: ${errorStack ? errorStack.substring(0, 300) : 'none'}`
      );
      
      // Log full error for debugging
      if (error instanceof Error) {
        console.error(`[POST /mcp] ${requestId} Full error:`, error);
      }
      
      res.status(400).json({
        error: 'Invalid JSON-RPC message',
        details: errorMsg,
        path: '/mcp',
        method: 'POST',
      });
    }
  }

  /**
   * Write messages to process stdin
   */
  private writeMessages(messages: unknown[]): void {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      try {
        // Ensure message is properly typed before formatting
        const typedMessage = message as JsonRpcMessage | JsonRpcBatch;
        const formatted = formatJsonRpcMessage(typedMessage);
        const method = (typedMessage as any).method || 'unknown';
        this.processManager.write(formatted);
        console.log(`[POST /mcp] Message ${i + 1}/${messages.length} written (method: ${method})`);
      } catch (error) {
        const method = (message as any)?.method || 'unknown';
        console.error(`[POST /mcp] Failed to write message ${i + 1}/${messages.length} (method: ${method}):`, error);
        // Continue with other messages
      }
    }
  }

  /**
   * Logging middleware
   */
  private loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const originalEnd = res.end.bind(res);
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const processManager = this.processManager; // Capture reference for closure

    // Store response body for logging
    let responseBody: any = null;
    let responseBodyString: string | null = null;

    // Add request ID to request object for tracing
    (req as any).requestId = requestId;

    // Log request start with enriched details
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const queryString = Object.keys(req.query).length > 0 ? `?${new URLSearchParams(req.query as Record<string, string>).toString()}` : '';
    const bodySize = req.body ? JSON.stringify(req.body).length : 0;
    const contentType = req.headers['content-type'] || 'none';
    const accept = req.headers['accept'] || 'none';
    const referer = req.headers['referer'] || 'none';
    
    // Log full request details
    console.log(
      `[REQUEST] ${requestId} ${req.method} ${req.path}${queryString} ` +
      `| IP: ${clientIp} | UA: ${userAgent.substring(0, 80)} | ` +
      `Content-Type: ${contentType} | Accept: ${accept} | ` +
      `Body: ${bodySize}b | Referer: ${referer}`
    );

    // Log body preview for POST requests (truncated)
    if (req.method === 'POST' && req.body) {
      try {
        const bodyPreview = JSON.stringify(req.body).substring(0, 500);
        const truncated = bodyPreview.length >= 500 ? '...' : '';
        console.log(`[REQUEST] ${requestId} Body preview: ${bodyPreview}${truncated}`);
      } catch (e) {
        console.log(`[REQUEST] ${requestId} Body preview: [unable to serialize]`);
      }
    }

    // Override res.json to capture response body
    res.json = function (body: any): Response {
      responseBody = body;
      try {
        responseBodyString = JSON.stringify(body);
      } catch (e) {
        responseBodyString = '[unable to serialize]';
      }
      return originalJson(body);
    } as typeof res.json;

    // Override res.send to capture response body
    res.send = function (body: any): Response {
      if (!responseBody) {
        responseBody = body;
        try {
          if (typeof body === 'string') {
            responseBodyString = body;
          } else {
            responseBodyString = JSON.stringify(body);
          }
        } catch (e) {
          responseBodyString = typeof body === 'string' ? body : '[unable to serialize]';
        }
      }
      return originalSend(body);
    } as typeof res.send;

    // Override res.end to log request completion with enriched details
    res.end = function (...args: any[]): Response {
      const duration = Date.now() - start;
      const logLevel = res.statusCode >= 400 ? 'ERROR' : 'INFO';
      
      // Get error details if available
      const errorDetails = (res as any).errorDetails || '';
      const responseContentType = res.getHeader('content-type') || 'unknown';
      const responseContentLength = res.getHeader('content-length') || 'unknown';
      const errorStack = (res as any).errorStack;
      
      // Build response preview
      let responsePreview = '';
      if (responseBodyString !== null) {
        const maxPreviewLength = 500;
        const preview = responseBodyString.substring(0, maxPreviewLength);
        const truncated = responseBodyString.length > maxPreviewLength ? '...' : '';
        responsePreview = ` | Response: ${preview}${truncated}`;
      } else if (responseBody !== null) {
        try {
          const preview = JSON.stringify(responseBody).substring(0, 500);
          const truncated = JSON.stringify(responseBody).length > 500 ? '...' : '';
          responsePreview = ` | Response: ${preview}${truncated}`;
        } catch (e) {
          responsePreview = ` | Response: [unable to serialize]`;
        }
      }
      
      // Build comprehensive error context
      let errorContext = '';
      if (res.statusCode >= 400) {
        const contextParts: string[] = [];
        
        if (errorDetails) {
          contextParts.push(`Reason: ${errorDetails}`);
        }
        
        if (res.statusCode === 404) {
          contextParts.push(`Route: ${req.method} ${req.path}`);
          contextParts.push(`Available routes: GET /healthz, GET|POST /mcp/stream, GET|POST /mcp/streamable, POST /mcp, GET /`);
        } else if (res.statusCode === 400) {
          contextParts.push(`Path: ${req.method} ${req.path}`);
          if (req.body) {
            try {
              const bodyStr = JSON.stringify(req.body).substring(0, 100);
              contextParts.push(`Body: ${bodyStr}${bodyStr.length >= 100 ? '...' : ''}`);
            } catch (e) {
              contextParts.push(`Body: [unable to serialize]`);
            }
          }
        } else if (res.statusCode === 405) {
          contextParts.push(`Method: ${req.method}`);
          contextParts.push(`Path: ${req.path}`);
          const allowedMethods = (res as any).allowedMethods || [];
          if (allowedMethods.length > 0) {
            contextParts.push(`Allowed: ${allowedMethods.join(', ')}`);
          }
        } else if (res.statusCode === 503) {
          contextParts.push(`Service: MCP process`);
          if (processManager) {
            const state = processManager.getState();
            contextParts.push(`Process running: ${processManager.isRunning()}`);
            contextParts.push(`Restart count: ${state.restartCount}`);
          }
        }
        
        if (errorStack && res.statusCode >= 500) {
          contextParts.push(`Stack: ${errorStack.substring(0, 200)}`);
        }
        
        errorContext = contextParts.length > 0 ? ` | ${contextParts.join(' | ')}` : '';
      }

      // Log with enriched context including response body
      console.log(
        `[${logLevel}] ${requestId} ${req.method} ${req.path} ${res.statusCode} ${duration}ms ` +
        `| Response-Type: ${responseContentType} | Response-Length: ${responseContentLength}${responsePreview}${errorContext}`
      );

      return (originalEnd as any)(...args);
    } as typeof res.end;

    next();
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, () => {
          console.log(`[BridgeServer] Listening on port ${this.config.port}`);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          console.error('[BridgeServer] Server error:', error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server gracefully
   */
  public async stop(): Promise<void> {
    if (this.shutdownInProgress) {
      return;
    }

    this.shutdownInProgress = true;
    console.log('[BridgeServer] Starting graceful shutdown...');

    // Close all SSE connections
    await this.sseHandler.closeAll();

    // Close all Streamable HTTP connections
    await this.streamableHttpHandler.closeAll();

    // Stop process manager
    await this.processManager.stop();

    // Close HTTP server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[BridgeServer] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

