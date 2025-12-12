# remote-mcp-adapter

## Purpose

This project is a **transport adapter (bridge)** that enables clients to use **local MCP servers/tools** (that speak JSON-RPC over **STDIO**) as a **Remote MCP Server** over the network via **HTTP + SSE (or Streamable HTTP)**, typically fronted by **Azure API Management (APIM)** for enterprise **authentication, governance, rate limiting, and observability**.

In other words, it bridges:

- **Remote MCP clients** (HTTPS + SSE / Streamable HTTP)
- → **APIM** (OAuth/JWT + policies)
- → **Bridge** (HTTP ⇄ STDIO transport conversion)
- → **Local MCP server** (STDIO JSON-RPC)

## Specs

- **Remote bridge (STDIO ⇄ HTTP + SSE / Streamable HTTP)**: `specs/remote-mcp-bridge-spec.md`