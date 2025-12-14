/**
 * STDIO process manager for spawning and supervising local MCP servers
 */

import { spawn, ChildProcess } from 'child_process';
import type { McpTool, ProcessState } from './types.js';
import type { JsonRpcMessage, JsonRpcBatch } from './types.js';
import { resolveInputVariables } from './config.js';
import { formatJsonRpcMessage } from './utils/jsonrpc.js';

export interface ProcessManagerCallbacks {
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
}

export class ProcessManager {
  private process: ChildProcess | null = null;
  private state: ProcessState = {
    started: false,
    restartCount: 0,
  };
  private restartTimeout: NodeJS.Timeout | null = null;
  private readonly tool: McpTool;
  private readonly callbacks: ProcessManagerCallbacks;
  private readonly backoffBase: number;
  private readonly backoffMax: number;
  private readonly lazyStart: boolean;

  constructor(
    tool: McpTool,
    callbacks: ProcessManagerCallbacks,
    backoffBase: number = 1000,
    backoffMax: number = 60000,
    lazyStart: boolean = true
  ) {
    this.tool = tool;
    this.callbacks = callbacks;
    this.backoffBase = backoffBase;
    this.backoffMax = backoffMax;
    this.lazyStart = lazyStart;
  }

  /**
   * Start the process (or lazy-start on first use)
   */
  public start(): void {
    if (this.process && this.process.pid) {
      return; // Already running
    }

    this.spawnProcess();
  }

  /**
   * Spawn the actual process
   */
  private spawnProcess(): void {
    try {
      const resolvedArgs = resolveInputVariables(this.tool.args, []);
      
      const isWindows = process.platform === 'win32';
      let command = this.tool.command;
      let args: string[];
      let spawnOptions: Parameters<typeof spawn>[2];
      
      if (isWindows) {
        // On Windows, use cmd.exe explicitly to ensure proper command resolution
        // This ensures npx/npm .cmd files are found correctly
        command = 'cmd.exe';
        args = ['/c', this.tool.command, ...resolvedArgs];
        spawnOptions = {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          shell: false, // We're already using cmd.exe explicitly
        };
      } else {
        // On Unix-like systems, spawn directly without shell
        args = resolvedArgs;
        spawnOptions = {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          shell: false,
        };
      }
      
      console.log(`[ProcessManager] Spawning process: ${command} ${args.join(' ')}`);

      this.process = spawn(command, args, spawnOptions);

      this.state.pid = this.process.pid;
      this.state.started = true;
      this.state.lastRestartTime = new Date();

      // Set up event handlers
      this.process.stdout?.on('data', (data: Buffer) => {
        this.callbacks.onStdout?.(data);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.callbacks.onStderr?.(data);
      });

      this.process.on('exit', (code, signal) => {
        console.log(`[ProcessManager] Process exited with code ${code}, signal ${signal}`);
        this.state.started = false;
        this.state.pid = undefined;
        this.callbacks.onExit?.(code, signal);

        // Auto-restart on unexpected exit (non-zero code or signal)
        if (code !== 0 || signal !== null) {
          this.scheduleRestart();
        }
      });

      this.process.on('error', (error: Error) => {
        console.error(`[ProcessManager] Process error:`, error);
        this.callbacks.onError?.(error);
        this.scheduleRestart();
      });

      console.log(`[ProcessManager] Process started with PID ${this.process.pid}`);
    } catch (error) {
      console.error(`[ProcessManager] Failed to spawn process:`, error);
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleRestart();
    }
  }

  /**
   * Schedule a restart with exponential backoff
   */
  private scheduleRestart(): void {
    if (this.restartTimeout) {
      return; // Already scheduled
    }

    this.state.restartCount++;
    const backoffDelay = Math.min(
      this.backoffBase * Math.pow(2, this.state.restartCount - 1),
      this.backoffMax
    );

    console.log(
      `[ProcessManager] Scheduling restart #${this.state.restartCount} in ${backoffDelay}ms`
    );

    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.spawnProcess();
    }, backoffDelay);
  }

  /**
   * Write a message to the process stdin
   */
  public write(message: string | object): boolean {
    if (!this.process || !this.process.stdin || !this.state.started) {
      // Lazy start if enabled
      if (this.lazyStart) {
        this.start();
        // Wait a bit for process to start
        setTimeout(() => {
          if (this.process?.stdin && this.state.started) {
            this.write(message);
          }
        }, 100);
        return false;
      }
      throw new Error('Process is not running');
    }

    try {
      let jsonString: string;
      if (typeof message === 'string') {
        jsonString = message;
      } else {
        // TypeScript needs explicit type assertion here
        const rpcMessage: JsonRpcMessage | JsonRpcBatch = message as JsonRpcMessage | JsonRpcBatch;
        jsonString = formatJsonRpcMessage(rpcMessage);
      }
      const written = this.process.stdin.write(jsonString);
      
      if (!written) {
        console.warn('[ProcessManager] Write buffer is full, message may be queued');
      }
      
      return written;
    } catch (error) {
      console.error(`[ProcessManager] Failed to write to stdin:`, error);
      throw error;
    }
  }

  /**
   * Get current process state
   */
  public getState(): Readonly<ProcessState> {
    return { ...this.state };
  }

  /**
   * Check if process is running
   */
  public isRunning(): boolean {
    return this.state.started && this.process !== null && this.process.pid !== undefined;
  }

  /**
   * Stop the process gracefully
   */
  public async stop(): Promise<void> {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        console.warn('[ProcessManager] Process did not terminate gracefully, killing');
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000); // 5 second grace period

      this.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Try graceful shutdown first
      if (this.process.stdin) {
        this.process.stdin.end();
      }
      this.process.kill('SIGTERM');
    });
  }
}

