@description('Bicep template for Azure API Management Remote MCP Server configuration')
param apimServiceName string
param mcpServerName string = 'remote-mcp-bridge'
param bridgeBaseUrl string = ''
param transport string = 'StreamableHttp' // 'StreamableHttp' or 'SSE'
param description string = 'Remote MCP Bridge exposing local STDIO MCP servers via HTTP+SSE/Streamable HTTP'

// Get APIM service
resource apimService 'Microsoft.ApiManagement/service@2023-05-01-preview' existing = {
  name: apimServiceName
}

// Note: APIM MCP Server configuration is typically done via Azure Portal or REST API
// This template provides the structure for manual configuration or can be extended
// with custom resources if APIM adds Bicep support for MCP servers

// Output configuration instructions
output configurationInstructions object = {
  message: 'APIM MCP Server configuration must be done via Azure Portal or REST API'
  steps: [
    '1. Navigate to Azure Portal > API Management > ${apimServiceName}'
    '2. Go to APIs > MCP servers'
    '3. Click "+ Create MCP server" > "Expose an existing MCP server"'
    '4. Provide the following:'
    '   - Name: ${mcpServerName}'
    '   - Base URL: ${bridgeBaseUrl}'
    '   - Transport: ${transport}'
    '   - Description: ${description}'
    '5. Configure policies (JWT validation, rate limiting, etc.)'
  ]
  bridgeBaseUrl: bridgeBaseUrl
  transport: transport
  mcpServerName: mcpServerName
}

