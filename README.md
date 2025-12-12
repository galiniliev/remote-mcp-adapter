# Remote MCP Bridge

A **transport adapter (bridge)** that enables clients to use **local MCP servers/tools** (that speak JSON-RPC over **STDIO**) as a **Remote MCP Server** over the network via **HTTP + SSE (or Streamable HTTP)**, typically fronted by **Azure API Management (APIM)** for enterprise **authentication, governance, rate limiting, and observability**.

## Overview

This bridge converts between two transport protocols:

- **Remote MCP clients** (HTTPS + SSE / Streamable HTTP)
- → **APIM** (OAuth/JWT + policies)
- → **Bridge** (HTTP ⇄ STDIO transport conversion)
- → **Local MCP server** (STDIO JSON-RPC)

## Features

- ✅ **Dual Transport Support**: Both SSE (Server-Sent Events) and Streamable HTTP
- ✅ **Process Management**: Automatic spawning, supervision, and restart of local MCP servers
- ✅ **Configuration Parsing**: Supports MCP configuration JSON with variable resolution
- ✅ **Backpressure Handling**: Configurable buffer limits and slow client detection
- ✅ **Health Checks**: Readiness/liveness endpoints for container orchestration
- ✅ **Graceful Shutdown**: Proper cleanup of connections and processes
- ✅ **Azure Ready**: Bicep templates for Container Apps and APIM integration

## Architecture

```
MCP Client (VS Code / Copilot / Foundry Agent)
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
Bridge / Transport Adapter
  - HTTP POST ingress
  - SSE/stream egress
  - local process mgmt
            |
        STDIO (JSON-RPC)
            |
Local MCP Server (STDIO)
```

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Docker (for containerization)
- Azure CLI (for deployment)

### Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Build the project**:
   ```bash
   npm run build
   ```

3. **Configure MCP server**:
   Edit `specs/ado-mcp-configuration.json` or provide your own MCP configuration file.

4. **Set environment variables** (optional):
   ```bash
   export PORT=3000
   export MCP_CONFIG_PATH=specs/ado-mcp-configuration.json
   export INPUT_ADO_ORG=your-org-name
   ```

5. **Run the bridge**:
   ```bash
   npm start
   # Or for development with auto-reload:
   npm run dev
   ```

6. **Validate endpoints**:
   ```powershell
   .\test_scripts\validate-bridge.ps1 -BaseUrl http://localhost:3000
   ```

### Configuration

The bridge reads MCP server configuration from a JSON file (default: `specs/ado-mcp-configuration.json`). Example:

```json
{
  "inputs": [
    {
      "id": "ado_org",
      "type": "promptString",
      "description": "Azure DevOps organization name (e.g. 'contoso')"
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

**Variable Resolution**: `${input:variable_name}` can be resolved from:
- Environment variables: `INPUT_VARIABLE_NAME` or `VARIABLE_NAME`
- Default values in the configuration file
- Explicit overrides (via API or config)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `MCP_CONFIG_PATH` | `specs/ado-mcp-configuration.json` | Path to MCP configuration file |
| `MAX_BUFFER_SIZE` | `1048576` | Maximum buffer size per subscriber (bytes) |
| `MAX_SUBSCRIBERS` | `100` | Maximum number of concurrent stream subscribers |
| `MAX_MESSAGE_SIZE` | `1048576` | Maximum JSON-RPC message size (bytes) |
| `KEEPALIVE_INTERVAL` | `30000` | SSE keepalive interval (ms) |
| `STREAM_TIMEOUT` | `300000` | Stream idle timeout (ms) |
| `RESTART_BACKOFF_BASE` | `1000` | Process restart backoff base (ms) |
| `RESTART_BACKOFF_MAX` | `60000` | Process restart backoff maximum (ms) |
| `LAZY_START` | `true` | Start MCP server process on first connection |

## API Endpoints

### `GET /healthz`
Health check endpoint for container readiness/liveness probes.

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "process": {
    "running": true,
    "pid": 12345,
    "restartCount": 0
  },
  "subscribers": {
    "sse": 2,
    "streamableHttp": 1
  }
}
```

### `GET /mcp/stream`
Server-Sent Events (SSE) stream endpoint for receiving JSON-RPC messages from the local MCP server.

**Headers**:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

**Events**: Each JSON-RPC message is sent as an SSE `data:` event.

### `GET /mcp/streamable`
Streamable HTTP endpoint (alternative to SSE) for APIM-preferred transport.

**Headers**:
- `Content-Type: application/json`
- `Transfer-Encoding: chunked`

**Format**: Newline-delimited JSON (NDJSON).

### `POST /mcp`
Send JSON-RPC requests to the local MCP server.

**Request**:
- `Content-Type: application/json`
- Body: JSON-RPC request object or batch array

**Response**: `202 Accepted` (async mode)
```json
{
  "status": "accepted",
  "messageCount": 1
}
```

**Example**:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

## Docker Deployment

### Build Image

```bash
docker build -t remote-mcp-bridge:latest .
```

### Run Container

```bash
docker run -d \
  -p 3000:3000 \
  -e MCP_CONFIG_PATH=/app/specs/ado-mcp-configuration.json \
  -e INPUT_ADO_ORG=your-org-name \
  remote-mcp-bridge:latest
```

## Azure Deployment

### Prerequisites

- Azure subscription
- Azure CLI installed and logged in
- Docker (for building container images)
- Azure Container Registry (ACR) or container image registry

### Deploy to Azure Container Apps

#### Option 1: PowerShell Script

```powershell
.\scripts\deploy.ps1 `
  -ResourceGroupName "rg-mcp-bridge" `
  -Location "eastus" `
  -AppName "remote-mcp-bridge" `
  -RegistryName "your-acr-name" `
  -ContainerImage "your-acr-name.azurecr.io/remote-mcp-bridge:latest"
```

#### Option 2: Bash Script

```bash
./scripts/deploy.sh \
  -g rg-mcp-bridge \
  -l eastus \
  -n remote-mcp-bridge \
  -r your-acr-name \
  -i your-acr-name.azurecr.io/remote-mcp-bridge:latest
```

#### Option 3: Manual Bicep Deployment

```bash
az deployment group create \
  --resource-group rg-mcp-bridge \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.json \
  --parameters containerImage=your-acr-name.azurecr.io/remote-mcp-bridge:latest
```

### Configure API Management

After deploying the bridge, configure APIM to expose it as a Remote MCP Server:

1. Navigate to **Azure Portal** → **API Management** → Your APIM instance
2. Go to **APIs** → **MCP servers**
3. Click **"+ Create MCP server"** → **"Expose an existing MCP server"**
4. Provide:
   - **Name**: `remote-mcp-bridge`
   - **Base URL**: `https://your-container-app-url.azurecontainerapps.io`
   - **Transport**: `StreamableHttp` (or `SSE`)
   - **Description**: `Remote MCP Bridge exposing local STDIO MCP servers`
5. Configure policies:
   - **Inbound**: JWT validation, rate limiting, IP filtering
   - **Outbound**: Pass-through (avoid transforming JSON-RPC payloads)

See `infra/apim.bicep` for configuration structure (note: APIM MCP server configuration is typically done via Portal or REST API).

## Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

```bash
npm test -- --testPathPattern=integration
```

### Validation Script

```powershell
.\test_scripts\validate-bridge.ps1 -BaseUrl http://localhost:3000
```

## Development

### Project Structure

```
.
├── src/                    # TypeScript source code
│   ├── __tests__/         # Test files
│   ├── utils/             # Utility functions
│   ├── config.ts           # Configuration parser
│   ├── process-manager.ts  # STDIO process management
│   ├── sse-handler.ts      # SSE endpoint handler
│   ├── streamable-http-handler.ts  # Streamable HTTP handler
│   ├── message-router.ts   # Message fan-out router
│   ├── health.ts           # Health check handler
│   ├── server.ts           # Express HTTP server
│   └── index.ts            # Application entry point
├── infra/                  # Azure infrastructure templates
│   ├── main.bicep          # Container Apps deployment
│   ├── apim.bicep          # APIM configuration
│   └── parameters.json     # Deployment parameters
├── scripts/                # Deployment scripts
│   ├── deploy.ps1          # PowerShell deployment
│   └── deploy.sh           # Bash deployment
├── test_scripts/           # Validation scripts
├── specs/                  # Specifications and examples
├── Dockerfile              # Container image definition
└── package.json            # Node.js dependencies
```

### Building

```bash
npm run build
```

### Linting

```bash
npm run lint
```

## Troubleshooting

### Process Not Starting

- Check MCP configuration file path: `MCP_CONFIG_PATH`
- Verify all required environment variables are set (especially `${input:...}` variables)
- Check logs for process spawn errors

### SSE Stream Not Connecting

- Verify the bridge is accessible (check firewall/network rules)
- Ensure proxies/gateways support long-lived connections
- Check `KEEPALIVE_INTERVAL` setting (may need adjustment for proxy timeouts)

### High Memory Usage

- Reduce `MAX_BUFFER_SIZE` and `MAX_SUBSCRIBERS`
- Check for slow clients (they may be buffering messages)
- Monitor process restart count (high counts indicate instability)

### APIM Integration Issues

- Ensure APIM policies don't transform JSON-RPC payloads
- Verify transport type matches bridge endpoint (SSE vs Streamable HTTP)
- Check APIM logs for request/response details

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT

## References

- [Remote MCP Bridge Specification](specs/remote-mcp-bridge-spec.md)
- [Expose an existing MCP server in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
