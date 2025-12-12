# Remote MCP Bridge Specification (STDIO ⇄ HTTP + SSE / Streamable HTTP)

## 1. Purpose

This specification describes **end-to-end** how to expose **local MCP tools** (running as a **STDIO** MCP server process) as a **Remote MCP Server** reachable over the network via:

- A **Bridge / Transport Adapter** that exposes **HTTP + SSE (or Streamable HTTP)** and forwards JSON-RPC messages to/from the local STDIO process.
- **Azure API Management (APIM)** as the secure enterprise “front door” for authentication, governance, rate limiting, and observability.

It is designed to work with local MCP server definitions similar to `specs/ado-mcp-configuration.json`, and aligns with Microsoft guidance for exposing an existing MCP server via APIM (see [Expose an existing MCP server in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server)).

## 2. Scope

### 2.1 In scope

- **Local MCP server** that speaks JSON-RPC over **STDIO** (newline-delimited JSON messages).
- **Remote transport** using:
  - **SSE** for server → client streaming events; and
  - **HTTP POST** for client → server messages,
  - OR **Streamable HTTP** as the newer equivalent transport (APIM supports it).
- **APIM configuration** to publish the bridge as a Remote MCP Server with enterprise controls.
- **Validation** steps and scripts for basic endpoint verification.

### 2.2 Out of scope

- Authoring new MCP tools themselves (this spec assumes the local MCP tool server already works).
- Full MCP protocol documentation (this spec focuses on transport bridging and publishing).
- Client UX specifics (VS Code, Claude Desktop, Copilot/Foundry, etc.) beyond minimal configuration notes.

## 3. Inputs and artifacts

### 3.1 Local MCP server configuration input

The bridge MUST be able to start or connect to a local STDIO MCP server. One supported pattern is a JSON configuration describing how to launch a tool server, e.g.:

- `specs/ado-mcp-configuration.json`:

```json
{
  "inputs": [
    {
      "id": "ado_org",
      "type": "promptString",
      "description": "Azure DevOps organization name  (e.g. 'contoso')"
    }
  ],
  "tools": [
    {
      "id": "ado",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@azure-devops/mcp", "${input:ado_org}"]
    }
  ]
}
```

**Bridge requirement**: resolve `${input:...}` variables (prompt, env vars, config file, or explicit bridge API call) before spawning the local process.

### 3.2 Remote bridge outputs

The bridge exposes a Remote MCP transport surface that APIM and clients can reach:

- **Inbound** (client → server): `POST /mcp` (or `/messages`)
- **Outbound** (server → client): `GET /mcp/stream` (SSE) or Streamable HTTP endpoint(s)

The bridge SHOULD publish OpenAPI (or equivalent) for APIM import, including:

- Streaming endpoint(s)
- Message ingestion endpoint
- Health endpoint(s) for deployment readiness

## 4. Architecture

### 4.1 Logical topology

```
MCP Client (VS Code / Copilot / Foundry Agent / etc.)
            |
        HTTPS (SSE or Streamable HTTP)
            |
Azure API Management (APIM)
  - OAuth/JWT validation
  - quotas / rate limits
  - IP filtering
  - logging / analytics
            |
        HTTPS (SSE or Streamable HTTP)
            |
Bridge / Transport Adapter (this spec)
  - HTTP POST ingress
  - SSE/stream egress
  - local process mgmt
            |
        STDIO (JSON-RPC)
            |
Local MCP Server (STDIO)
```

### 4.2 Core responsibilities

- **Bridge**
  - Spawn and supervise a local STDIO MCP server process (or attach to one).
  - Translate between:
    - **HTTP POST** request bodies (JSON-RPC objects or batches), and
    - **STDIO** newline-delimited JSON-RPC messages.
  - Provide **server → client** streaming via **SSE** (or Streamable HTTP).
  - Handle multi-client fan-out, basic buffering/backpressure, and graceful disconnects.
  - Provide observability and health checks.

- **APIM**
  - Authenticate and authorize client access (OAuth2/JWT recommended).
  - Enforce policy controls (quotas, rate limit, IP allowlists/denylists).
  - Provide API analytics and request/response logs (careful with payload sensitivity).

## 5. Protocol and transport requirements (normative)

### 5.1 Message format

- The bridge MUST treat messages as **JSON-RPC 2.0** objects (or JSON-RPC batches).
- The bridge MUST forward JSON-RPC messages to the local MCP server over STDIO as **newline-delimited JSON**:
  - One JSON object per line.
  - For batches, the bridge MAY send one line containing the JSON array (if local server supports it), or MUST split into per-request lines if the local server requires it.

### 5.2 Endpoints

#### 5.2.1 `POST /mcp` (client → server)

- **Request**: JSON body containing a JSON-RPC request object or batch.
- The bridge MUST validate:
  - `Content-Type: application/json`
  - body parses as JSON object or array
- The bridge MUST write the serialized JSON plus `\n` to the local process stdin.

**Response modes** (choose one; both MAY be supported):

- **Async streaming mode (RECOMMENDED)**:
  - Return `202 Accepted` immediately with an acknowledgement payload.
  - The actual JSON-RPC responses/notifications are delivered via the stream endpoint.
  - This mode matches many MCP client expectations when streaming is available.

- **Synchronous mode (OPTIONAL)**:
  - If the incoming JSON-RPC request has an `id`, the bridge MAY wait for the matching response from the local process and return it directly from the POST.
  - MUST implement timeouts and correlation.
  - MUST handle concurrent requests safely.

#### 5.2.2 `GET /mcp/stream` (server → client, SSE)

- The bridge MUST support Server-Sent Events:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
- On connect:
  - The bridge SHOULD send an initial comment or blank line to open the stream promptly.
  - The bridge SHOULD send periodic keepalives (comment events) to prevent idle timeouts through proxies.
- The bridge MUST fan out local process stdout messages to all connected stream subscribers.

**SSE event framing**:

- Each JSON-RPC message from the local server SHOULD be emitted as one SSE `data:` event containing the raw JSON text.
- If local stdout chunks contain partial JSON, the bridge MUST buffer until a full message delimiter is reached (newline), then emit.

#### 5.2.3 Streamable HTTP (alternative to SSE)

If implementing Streamable HTTP instead of SSE:

- The bridge MUST provide the equivalent “server → client streaming” semantics expected by APIM’s Remote MCP Server support.
- The bridge SHOULD keep payloads unmodified and forward the JSON-RPC text as-is.

> Note: APIM supports Remote MCP Servers using Streamable HTTP transport. See [Expose an existing MCP server in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server).

### 5.3 Connection and process lifecycle

- The bridge MUST manage the local server process lifecycle:
  - Start at bridge boot OR lazy-start on first client connect.
  - Restart on crash with exponential backoff (to avoid hot-looping).
  - Emit clear logs when restarting.
- The bridge MUST implement graceful shutdown:
  - Close SSE connections with a final message (best effort).
  - Terminate or signal the child process.

### 5.4 Backpressure and buffering

- The bridge MUST avoid unbounded buffering:
  - Per-subscriber buffer limit (drop or disconnect slow clients).
  - Global buffer limit for stdout processing.
- The bridge SHOULD provide configuration knobs:
  - max subscribers
  - max message size
  - max buffered messages/bytes
  - timeouts (POST sync mode timeout, idle stream timeout, keepalive interval)

## 6. Security and governance

### 6.1 Transport security

- All external endpoints MUST use **HTTPS**.
- If the bridge is behind APIM, the bridge SHOULD still use HTTPS between APIM and bridge (internal TLS), depending on network constraints.

### 6.2 Authentication and authorization (APIM)

APIM SHOULD be used to provide authentication/authorization because remote MCP auth is often implemented at the gateway layer:

- Validate **JWT/OAuth2** on inbound requests.
- Enforce **tool governance** at APIM where feasible (by routing rules, quotas, per-client access).
- Apply **rate limiting / quotas** by subscription or client identity.
- Apply **IP filtering** as required.

### 6.3 Secrets and credentials

- The bridge MUST NOT hardcode secrets.
- If the bridge needs Azure integration (logs/metrics), prefer **Managed Identity** for Azure-hosted deployments.

### 6.4 Logging and privacy

- The bridge SHOULD log:
  - request ids, correlation ids, timestamps
  - local process lifecycle events
  - errors and restarts
- The bridge SHOULD avoid logging full JSON-RPC payload bodies by default (may contain sensitive data).
- If APIM logging is enabled, ensure policies do not transform or truncate MCP envelopes.

## 7. Deployment patterns

### 7.1 Bridge hosting options (Azure)

The bridge can be deployed to:

- **Azure Container Apps (ACA)** (recommended for containerized workloads)
- **Azure App Service** (for HTTP workloads; ensure streaming/SSE is supported end-to-end)
- **AKS** (for advanced networking and scaling needs)

Key operational requirements:

- Ensure the bridge’s listening port matches the platform’s configured target port.
- Configure timeouts for long-lived streaming connections (SSE / Streamable HTTP).

### 7.2 APIM configuration (end-to-end)

In Azure portal (high level steps):

1. Deploy the bridge privately (VNet/internal) or publicly depending on security needs.
2. In APIM: **APIs → MCP servers → + Create MCP server → “Expose an existing MCP server”**
3. Provide:
   - Bridge base URL
   - Transport selection: **Streamable HTTP** (default) or **SSE**
4. Configure policies:
   - JWT validation / OAuth
   - rate limiting / quotas
   - IP filtering
   - observability settings

Reference: [Expose an existing MCP server in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server)

## 8. Example: bridging the Azure DevOps MCP tool server

Using `specs/ado-mcp-configuration.json`, the bridge starts the local server:

- Command: `npx`
- Args: `-y @azure-devops/mcp <ado_org>`

End-to-end flow:

1. Client connects to APIM stream endpoint (SSE/Streamable HTTP).
2. Client sends JSON-RPC requests to APIM `POST /mcp`.
3. APIM forwards to bridge.
4. Bridge writes JSON-RPC to local server stdin.
5. Local server emits JSON-RPC responses/notifications on stdout.
6. Bridge forwards those messages to connected clients via stream.

## 9. Validation

### 9.1 Local validation (without APIM)

Minimum checks:

- `GET /healthz` returns 200 (if implemented)
- `GET /mcp/stream` returns 200 and `Content-Type: text/event-stream`
- `POST /mcp` returns 202 (async mode) for valid JSON-RPC payloads

### 9.2 APIM validation

Minimum checks:

- Auth enforcement works (401/403 without token).
- Stream endpoint remains connected and delivers events.
- POST requests pass through without payload transformation.

## 10. Compatibility notes

- Some MCP clients expect **async responses via the stream**; prefer async mode unless your client explicitly requires POST responses.
- Ensure proxies and gateways support long-lived streaming connections and do not buffer SSE responses.


