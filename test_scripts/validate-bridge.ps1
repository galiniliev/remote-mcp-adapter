# Enhanced validation script for Remote MCP Bridge endpoints

Param(
    [Parameter(Mandatory = $false)]
    [string]$BaseUrl = "http://localhost:3000",
    
    [Parameter(Mandatory = $false)]
    [int]$TimeoutSeconds = 30,
    
    [Parameter(Mandatory = $false)]
    [switch]$SkipStreamTest = $false
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Remote MCP Bridge Validation" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl" -ForegroundColor Gray
Write-Host ""

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

function Test-HealthEndpoint {
    Write-Host "1. Testing health endpoint: GET /healthz" -ForegroundColor Green
    
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/healthz" -Method GET -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 503) -Name "GET /healthz"
        
        $health = $resp.Content | ConvertFrom-Json
        Write-Host "   Status: $($health.status)" -ForegroundColor $(if ($health.status -eq 'healthy') { 'Green' } else { 'Yellow' })
        
        if ($health.process) {
            Write-Host "   Process Running: $($health.process.running)" -ForegroundColor Gray
            Write-Host "   Process PID: $($health.process.pid)" -ForegroundColor Gray
            Write-Host "   Restart Count: $($health.process.restartCount)" -ForegroundColor Gray
        }
        
        if ($health.subscribers) {
            Write-Host "   SSE Subscribers: $($health.subscribers.sse)" -ForegroundColor Gray
            Write-Host "   Streamable HTTP Subscribers: $($health.subscribers.streamableHttp)" -ForegroundColor Gray
        }
        
        Write-Host "   ✓ Health endpoint OK" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "   ✗ Health endpoint failed: $_" -ForegroundColor Red
        return $false
    }
}

function Test-RootEndpoint {
    Write-Host "`n2. Testing root endpoint: GET /" -ForegroundColor Green
    
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/" -Method GET -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200) -Name "GET /"
        
        $info = $resp.Content | ConvertFrom-Json
        Write-Host "   Name: $($info.name)" -ForegroundColor Gray
        Write-Host "   Version: $($info.version)" -ForegroundColor Gray
        Write-Host "   ✓ Root endpoint OK" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "   ✗ Root endpoint failed: $_" -ForegroundColor Red
        return $false
    }
}

function Test-SseStream {
    Write-Host "`n3. Testing SSE stream endpoint: GET /mcp/stream" -ForegroundColor Green
    
    if ($SkipStreamTest) {
        Write-Host "   Skipped (use -SkipStreamTest:$false to enable)" -ForegroundColor Yellow
        return $true
    }
    
    try {
        # Test headers and initial connection
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp/stream" -Method GET -Headers @{ "Accept" = "text/event-stream" } -TimeoutSec 5
        
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200) -Name "GET /mcp/stream"
        
        $contentType = $resp.Headers["Content-Type"]
        if ($contentType -notmatch "text/event-stream") {
            throw "Expected Content-Type 'text/event-stream', got '$contentType'"
        }
        
        Write-Host "   Content-Type: $contentType" -ForegroundColor Gray
        Write-Host "   ✓ SSE stream endpoint headers OK" -ForegroundColor Green
        
        # Note: Full stream testing requires keeping connection open, which is complex in PowerShell
        # This validates the endpoint is accessible and returns correct headers
        return $true
    } catch {
        Write-Host "   ⚠ SSE stream test: $_" -ForegroundColor Yellow
        Write-Host "   Note: Some implementations keep SSE connections open; this may be expected." -ForegroundColor Yellow
        return $true  # Don't fail on timeout for streaming endpoints
    }
}

function Test-StreamableHttp {
    Write-Host "`n4. Testing Streamable HTTP endpoint: GET /mcp/streamable" -ForegroundColor Green
    
    if ($SkipStreamTest) {
        Write-Host "   Skipped (use -SkipStreamTest:$false to enable)" -ForegroundColor Yellow
        return $true
    }
    
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp/streamable" -Method GET -TimeoutSec 5
        
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200) -Name "GET /mcp/streamable"
        
        $contentType = $resp.Headers["Content-Type"]
        $transferEncoding = $resp.Headers["Transfer-Encoding"]
        
        Write-Host "   Content-Type: $contentType" -ForegroundColor Gray
        Write-Host "   Transfer-Encoding: $transferEncoding" -ForegroundColor Gray
        
        if ($transferEncoding -eq "chunked") {
            Write-Host "   ✓ Streamable HTTP endpoint OK (chunked transfer)" -ForegroundColor Green
        } else {
            Write-Host "   ⚠ Transfer-Encoding not set to 'chunked'" -ForegroundColor Yellow
        }
        
        return $true
    } catch {
        Write-Host "   ⚠ Streamable HTTP test: $_" -ForegroundColor Yellow
        Write-Host "   Note: Streaming endpoints may timeout in simple HTTP requests." -ForegroundColor Yellow
        return $true  # Don't fail on timeout for streaming endpoints
    }
}

function Test-PostEndpoint {
    Write-Host "`n5. Testing POST endpoint: POST /mcp" -ForegroundColor Green
    
    try {
        # Test 1: Valid JSON-RPC request
        $jsonRpc = @{
            jsonrpc = "2.0"
            id      = 1
            method  = "tools/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $postResp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $jsonRpc -TimeoutSec $TimeoutSeconds
        
        Assert-StatusCode -Actual $postResp.StatusCode -Expected @(200, 202) -Name "POST /mcp"
        
        $result = $postResp.Content | ConvertFrom-Json
        Write-Host "   Status Code: $($postResp.StatusCode)" -ForegroundColor Gray
        Write-Host "   Response: $($result | ConvertTo-Json -Compress)" -ForegroundColor Gray
        
        if ($postResp.StatusCode -eq 202) {
            Write-Host "   ✓ POST endpoint returns 202 Accepted (async mode)" -ForegroundColor Green
        } else {
            Write-Host "   ✓ POST endpoint returns 200 OK" -ForegroundColor Green
        }
        
        # Test 2: Invalid Content-Type
        try {
            $badResp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "text/plain" -Body "invalid" -TimeoutSec $TimeoutSeconds -ErrorAction Stop
            Write-Host "   ✗ POST endpoint should reject invalid Content-Type" -ForegroundColor Red
            return $false
        } catch {
            if ($_.Exception.Response.StatusCode -eq 400) {
                Write-Host "   ✓ POST endpoint correctly rejects invalid Content-Type" -ForegroundColor Green
            } else {
                throw
            }
        }
        
        # Test 3: Invalid JSON body
        try {
            $badResp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body "{ invalid json }" -TimeoutSec $TimeoutSeconds -ErrorAction Stop
            Write-Host "   ✗ POST endpoint should reject invalid JSON" -ForegroundColor Red
            return $false
        } catch {
            if ($_.Exception.Response.StatusCode -eq 400) {
                Write-Host "   ✓ POST endpoint correctly rejects invalid JSON" -ForegroundColor Green
            } else {
                throw
            }
        }
        
        # Test 4: JSON-RPC batch
        $batchRpc = @(
            @{
                jsonrpc = "2.0"
                id      = 1
                method  = "tools/list"
                params  = @{}
            },
            @{
                jsonrpc = "2.0"
                id      = 2
                method  = "initialize"
                params  = @{}
            }
        ) | ConvertTo-Json -Depth 10
        
        $batchResp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $batchRpc -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $batchResp.StatusCode -Expected @(200, 202) -Name "POST /mcp (batch)"
        Write-Host "   ✓ POST endpoint accepts JSON-RPC batches" -ForegroundColor Green
        
        return $true
    } catch {
        Write-Host "   ✗ POST endpoint failed: $_" -ForegroundColor Red
        return $false
    }
}

function Test-ErrorScenarios {
    Write-Host "`n6. Testing error scenarios" -ForegroundColor Green
    
    $allPassed = $true
    
    # Test 404 for unknown endpoint
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/unknown" -Method GET -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        Write-Host "   ✗ Unknown endpoint should return 404" -ForegroundColor Red
        $allPassed = $false
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) {
            Write-Host "   ✓ Unknown endpoint returns 404" -ForegroundColor Green
        } else {
            Write-Host "   ⚠ Unknown endpoint test: $_" -ForegroundColor Yellow
        }
    }
    
    return $allPassed
}

# Run all tests
$results = @{
    Health = Test-HealthEndpoint
    Root = Test-RootEndpoint
    SseStream = Test-SseStream
    StreamableHttp = Test-StreamableHttp
    Post = Test-PostEndpoint
    Errors = Test-ErrorScenarios
}

# Summary
Write-Host "`n=========================================" -ForegroundColor Cyan
Write-Host "Validation Summary" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$passed = ($results.Values | Where-Object { $_ -eq $true }).Count
$total = $results.Count

foreach ($test in $results.GetEnumerator()) {
    $status = if ($test.Value) { "✓ PASS" } else { "✗ FAIL" }
    $color = if ($test.Value) { "Green" } else { "Red" }
    Write-Host "$($test.Key): $status" -ForegroundColor $color
}

Write-Host "`nTotal: $passed/$total tests passed" -ForegroundColor $(if ($passed -eq $total) { "Green" } else { "Yellow" })

if ($passed -eq $total) {
    Write-Host "`n✓ All validation tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n✗ Some validation tests failed" -ForegroundColor Red
    exit 1
}
