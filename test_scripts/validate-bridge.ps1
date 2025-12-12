Param(
  [Parameter(Mandatory = $false)]
  [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

Write-Host "Validating Remote MCP Bridge endpoints at $BaseUrl"

function Assert-StatusCode {
  Param(
    [Parameter(Mandatory = $true)] [int]$Actual,
    [Parameter(Mandatory = $true)] [int[]]$Expected,
    [Parameter(Mandatory = $true)] [string]$Name
  )
  if ($Expected -notcontains $Actual) {
    throw "$Name expected status code one of [$($Expected -join ", ")], got $Actual"
  }
}

# 1) Validate stream endpoint returns SSE content-type (we do not keep the stream open)
$streamUrl = "$BaseUrl/mcp/stream"
Write-Host "Checking SSE stream headers: GET $streamUrl"

try {
  $resp = Invoke-WebRequest -Uri $streamUrl -Method GET -Headers @{ "Accept" = "text/event-stream" } -TimeoutSec 5
  Assert-StatusCode -Actual $resp.StatusCode -Expected @(200) -Name "GET /mcp/stream"
  if ($resp.Headers["Content-Type"] -notmatch "text/event-stream") {
    throw "GET /mcp/stream expected Content-Type to include 'text/event-stream', got '$($resp.Headers["Content-Type"])'"
  }
} catch {
  Write-Host "NOTE: Some implementations keep SSE connections open and may not complete quickly; this check may fail if the server doesn't respond within TimeoutSec." -ForegroundColor Yellow
  throw
}

# 2) Validate POST endpoint accepts JSON-RPC and returns an acknowledgement.
$postUrl = "$BaseUrl/mcp"
Write-Host "Checking POST ingestion: POST $postUrl"

$jsonRpc = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "tools/list"
  params  = @{}
} | ConvertTo-Json -Depth 10

$postResp = Invoke-WebRequest -Uri $postUrl -Method POST -ContentType "application/json" -Body $jsonRpc -TimeoutSec 10
Assert-StatusCode -Actual $postResp.StatusCode -Expected @(200, 202) -Name "POST /mcp"

Write-Host "OK: Bridge endpoints responded successfully."


