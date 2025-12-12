/**
 * Express HTTP server with MCP bridge endpoints
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { ProcessManager } from './process-manager.js';
import { SseHandler } from './sse-handler.js';
import { StreamableHttpHandler } from './streamable-http-handler.js';
import { MessageRouter } from './message-router.js';
import { HealthHandler } from './health.js';
import { validateJsonRpcMessage, parseJsonRpcBatch, formatJsonRpcMessage } from './utils/jsonrpc.js';
import type { BridgeConfig } from './types.js';
import type { McpTool } from './types.js';

export class BridgeServer {
  private app: express.Application;
  private server: ReturnType<typeof express> | null = null;
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
   * Set up HTTP routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/healthz', (req: Request, res: Response) => {
      this.healthHandler.handleHealth(req, res);
    });

    // SSE stream endpoint
    this.app.get('/mcp/stream', (req: Request, res: Response) => {
      this.sseHandler.handleStream(req, res);
      // Lazy start process on first stream connection
      if (!this.processManager.isRunning() && this.config.lazyStart) {
        this.processManager.start();
      }
    });

    // Streamable HTTP endpoint
    this.app.get('/mcp/streamable', (req: Request, res: Response) => {
      this.streamableHttpHandler.handleStream(req, res);
      // Lazy start process on first stream connection
      if (!this.processManager.isRunning() && this.config.lazyStart) {
        this.processManager.start();
      }
    });

    // POST endpoint for JSON-RPC messages
    this.app.post('/mcp', (req: Request, res: Response) => {
      this.handlePostMcp(req, res);
    });

    // Root endpoint
    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        name: 'Remote MCP Bridge',
        version: '1.0.0',
        endpoints: {
          health: '/healthz',
          sse: '/mcp/stream',
          streamableHttp: '/mcp/streamable',
          post: '/mcp',
        },
      });
    });
  }

  /**
   * Handle POST /mcp endpoint
   */
  private handlePostMcp(req: Request, res: Response): void {
    // Validate Content-Type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      res.status(400).json({ error: 'Content-Type must be application/json' });
      return;
    }

    // Validate body
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Request body must be a JSON object or array' });
      return;
    }

    try {
      // Handle batch or single message
      let messages: unknown[];
      if (Array.isArray(req.body)) {
        // Batch request
        messages = parseJsonRpcBatch(req.body);
      } else {
        // Single message
        validateJsonRpcMessage(req.body);
        messages = [req.body];
      }

      // Ensure process is running
      if (!this.processManager.isRunning()) {
        if (this.config.lazyStart) {
          this.processManager.start();
          // Wait a bit for process to start
          setTimeout(() => {
            this.writeMessages(messages);
          }, 100);
        } else {
          res.status(503).json({ error: 'MCP server process is not running' });
          return;
        }
      } else {
        this.writeMessages(messages);
      }

      // Return 202 Accepted (async mode)
      res.status(202).json({
        status: 'accepted',
        messageCount: messages.length,
      });
    } catch (error) {
      console.error('[POST /mcp] Error:', error);
      res.status(400).json({
        error: 'Invalid JSON-RPC message',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Write messages to process stdin
   */
  private writeMessages(messages: unknown[]): void {
    for (const message of messages) {
      try {
        const formatted = formatJsonRpcMessage(message);
        this.processManager.write(formatted);
      } catch (error) {
        console.error('[POST /mcp] Failed to write message:', error);
        // Continue with other messages
      }
    }
  }

  /**
   * Logging middleware
   */
  private loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const originalEnd = res.end;

    res.end = function (chunk?: unknown, encoding?: unknown) {
      const duration = Date.now() - start;
      const logLevel = res.statusCode >= 400 ? 'error' : 'info';
      console.log(
        `[${logLevel.toUpperCase()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`
      );
      originalEnd.call(this, chunk, encoding);
    };

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

