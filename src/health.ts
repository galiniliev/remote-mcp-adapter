/**
 * Health check endpoint for container readiness/liveness probes
 */

import type { Request, Response } from 'express';
import type { ProcessManager } from './process-manager.js';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  process?: {
    running: boolean;
    pid?: number;
    restartCount: number;
  };
  subscribers?: {
    sse: number;
    streamableHttp: number;
  };
}

export class HealthHandler {
  private processManager?: ProcessManager;
  private sseSubscriberCount?: () => number;
  private streamableHttpSubscriberCount?: () => number;

  constructor(
    processManager?: ProcessManager,
    sseSubscriberCount?: () => number,
    streamableHttpSubscriberCount?: () => number
  ) {
    this.processManager = processManager;
    this.sseSubscriberCount = sseSubscriberCount;
    this.streamableHttpSubscriberCount = streamableHttpSubscriberCount;
  }

  /**
   * Handle health check request
   */
  public handleHealth(req: Request, res: Response): void {
    const requestId = (req as any).requestId || 'unknown';
    const health: HealthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };

    // Check process status if available
    if (this.processManager) {
      const state = this.processManager.getState();
      health.process = {
        running: this.processManager.isRunning(),
        pid: state.pid,
        restartCount: state.restartCount,
      };

      // If process is not running and should be, mark as unhealthy
      if (!health.process.running && state.restartCount > 0) {
        health.status = 'unhealthy';
        console.warn(`[Health] ${requestId} Process not running (restartCount: ${state.restartCount})`);
      } else if (state.restartCount > 5) {
        // High restart count indicates degraded state
        health.status = 'degraded';
        console.warn(`[Health] ${requestId} High restart count (${state.restartCount}), marking as degraded`);
      } else {
        console.log(`[Health] ${requestId} Process running (pid: ${state.pid}, restarts: ${state.restartCount})`);
      }
    }

    // Add subscriber counts if available
    if (this.sseSubscriberCount || this.streamableHttpSubscriberCount) {
      health.subscribers = {
        sse: this.sseSubscriberCount?.() ?? 0,
        streamableHttp: this.streamableHttpSubscriberCount?.() ?? 0,
      };
      console.log(`[Health] ${requestId} Subscribers - SSE: ${health.subscribers.sse}, StreamableHTTP: ${health.subscribers.streamableHttp}`);
    }

    // Determine HTTP status code
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    
    if (statusCode !== 200) {
      console.warn(`[Health] ${requestId} Health status: ${health.status} (HTTP ${statusCode})`);
    }

    res.status(statusCode).json(health);
  }
}

