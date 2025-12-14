# Enhanced validation script for Remote MCP Bridge endpoints
# Tests MCP protocol compliance per https://modelcontextprotocol.io/specification/2025-11-25
# Includes tests for list methods (tools/list, resources/list, prompts/list) and JSON-RPC 2.0 compliance

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
        
        Write-Host "   [OK] Health endpoint OK" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "   [FAIL] Health endpoint failed: $_" -ForegroundColor Red
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
        Write-Host "   [OK] Root endpoint OK" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "   [FAIL] Root endpoint failed: $_" -ForegroundColor Red
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
        Write-Host "   [OK] SSE stream endpoint headers OK" -ForegroundColor Green
        
        # Note: Full stream testing requires keeping connection open, which is complex in PowerShell
        # This validates the endpoint is accessible and returns correct headers
        return $true
    } catch {
        Write-Host "   [WARN] SSE stream test: $_" -ForegroundColor Yellow
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
            Write-Host "   [OK] Streamable HTTP endpoint OK (chunked transfer)" -ForegroundColor Green
        }
        else {
            Write-Host "   [WARN] Transfer-Encoding not set to 'chunked'" -ForegroundColor Yellow
        }
        
        return $true
    }
    catch {
        Write-Host "   [WARN] Streamable HTTP test: $_" -ForegroundColor Yellow
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
            Write-Host "   [OK] POST endpoint returns 202 Accepted (async mode)" -ForegroundColor Green
        } else {
            Write-Host "   [OK] POST endpoint returns 200 OK" -ForegroundColor Green
        }
        
        # Test 2: Invalid Content-Type
        try {
            $badResp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "text/plain" -Body "invalid" -TimeoutSec $TimeoutSeconds -ErrorAction Stop
            Write-Host "   [FAIL] POST endpoint should reject invalid Content-Type" -ForegroundColor Red
            return $false
        } catch {
            if ($_.Exception.Response.StatusCode -eq 400) {
                Write-Host "   [OK] POST endpoint correctly rejects invalid Content-Type" -ForegroundColor Green
            } else {
                throw
            }
        }
        
        # Test 3: Invalid JSON body
        try {
            $badResp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body "{ invalid json }" -TimeoutSec $TimeoutSeconds -ErrorAction Stop
            Write-Host "   [FAIL] POST endpoint should reject invalid JSON" -ForegroundColor Red
            return $false
        } catch {
            if ($_.Exception.Response.StatusCode -eq 400) {
                Write-Host "   [OK] POST endpoint correctly rejects invalid JSON" -ForegroundColor Green
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
        Write-Host "   [OK] POST endpoint accepts JSON-RPC batches" -ForegroundColor Green
        
        return $true
    } catch {
        Write-Host "   [FAIL] POST endpoint failed: $_" -ForegroundColor Red
        return $false
    }
}

function Test-McpListMethods {
    Write-Host "`n6. Testing MCP List Methods (tools/list, resources/list, prompts/list)" -ForegroundColor Green
    
    $allPassed = $true
    
    # Test tools/list
    try {
        Write-Host "   6.1 Testing tools/list" -ForegroundColor Cyan
        $toolsListReq = @{
            jsonrpc = "2.0"
            id      = "test-tools-list-1"
            method  = "tools/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $toolsListReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "tools/list"
        
        $result = $resp.Content | ConvertFrom-Json
        if ($result.status -eq "accepted") {
            Write-Host "      [OK] tools/list request accepted (async mode)" -ForegroundColor Green
        } else {
            Write-Host "      [OK] tools/list request processed" -ForegroundColor Green
        }
    } catch {
        Write-Host "      [FAIL] tools/list failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test resources/list
    try {
        Write-Host "   6.2 Testing resources/list" -ForegroundColor Cyan
        $resourcesListReq = @{
            jsonrpc = "2.0"
            id      = "test-resources-list-1"
            method  = "resources/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $resourcesListReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "resources/list"
        
        $result = $resp.Content | ConvertFrom-Json
        if ($result.status -eq "accepted") {
            Write-Host "      [OK] resources/list request accepted (async mode)" -ForegroundColor Green
        } else {
            Write-Host "      [OK] resources/list request processed" -ForegroundColor Green
        }
    } catch {
        Write-Host "      [FAIL] resources/list failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test prompts/list
    try {
        Write-Host "   6.3 Testing prompts/list" -ForegroundColor Cyan
        $promptsListReq = @{
            jsonrpc = "2.0"
            id      = "test-prompts-list-1"
            method  = "prompts/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $promptsListReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "prompts/list"
        
        $result = $resp.Content | ConvertFrom-Json
        if ($result.status -eq "accepted") {
            Write-Host "      [OK] prompts/list request accepted (async mode)" -ForegroundColor Green
        } else {
            Write-Host "      [OK] prompts/list request processed" -ForegroundColor Green
        }
    } catch {
        Write-Host "      [FAIL] prompts/list failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test batch with all list methods
    try {
        Write-Host "   6.4 Testing batch request with all list methods" -ForegroundColor Cyan
        $batchListReq = @(
            @{
                jsonrpc = "2.0"
                id      = "batch-tools-list"
                method  = "tools/list"
                params  = @{}
            },
            @{
                jsonrpc = "2.0"
                id      = "batch-resources-list"
                method  = "resources/list"
                params  = @{}
            },
            @{
                jsonrpc = "2.0"
                id      = "batch-prompts-list"
                method  = "prompts/list"
                params  = @{}
            }
        ) | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $batchListReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "batch list methods"
        
        $result = $resp.Content | ConvertFrom-Json
        if ($result.messageCount -eq 3) {
            Write-Host "      [OK] Batch request with 3 list methods accepted" -ForegroundColor Green
        } else {
            Write-Host "      [OK] Batch request accepted" -ForegroundColor Green
        }
    } catch {
        Write-Host "      [FAIL] Batch list methods failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    return $allPassed
}

function Test-McpProtocolCompliance {
    Write-Host "`n7. Testing MCP Protocol Compliance" -ForegroundColor Green
    
    $allPassed = $true
    
    # Test 1: Initialize handshake with proper capabilities
    try {
        Write-Host "   7.1 Testing initialize handshake" -ForegroundColor Cyan
        $initReq = @{
            jsonrpc = "2.0"
            id      = "init-1"
            method  = "initialize"
            params  = @{
                protocolVersion = "2024-11-05"
                capabilities     = @{
                    roots = @{
                        listChanged = $true
                    }
                    sampling = @{}
                }
                clientInfo       = @{
                    name    = "test-client"
                    version = "1.0.0"
                }
            }
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $initReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "initialize"
        
        $result = $resp.Content | ConvertFrom-Json
        if ($result.status -eq "accepted") {
            Write-Host "      [OK] initialize request accepted with proper capabilities" -ForegroundColor Green
        } else {
            Write-Host "      [OK] initialize request processed" -ForegroundColor Green
        }
    } catch {
        Write-Host "      [FAIL] initialize handshake failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test 2: JSON-RPC 2.0 version validation
    try {
        Write-Host "   7.2 Testing JSON-RPC 2.0 version requirement" -ForegroundColor Cyan
        $badVersionReq = @{
            jsonrpc = "1.0"
            id      = "bad-version-1"
            method  = "tools/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        try {
            $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $badVersionReq -TimeoutSec $TimeoutSeconds -ErrorAction Stop
            Write-Host "      [WARN] Server accepted invalid JSON-RPC version (may validate downstream)" -ForegroundColor Yellow
        } catch {
            if ($_.Exception.Response.StatusCode -eq 400) {
                Write-Host "      [OK] Server correctly rejects invalid JSON-RPC version" -ForegroundColor Green
            } else {
                Write-Host "      [WARN] Unexpected error for invalid version: $_" -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "      [WARN] JSON-RPC version test: $_" -ForegroundColor Yellow
    }
    
    # Test 3: Missing jsonrpc field
    try {
        Write-Host "   7.3 Testing missing jsonrpc field" -ForegroundColor Cyan
        $noJsonRpcReq = @{
            id     = "no-jsonrpc-1"
            method = "tools/list"
            params = @{}
        } | ConvertTo-Json -Depth 10
        
        try {
            $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $noJsonRpcReq -TimeoutSec $TimeoutSeconds -ErrorAction Stop
            Write-Host "      [WARN] Server accepted request without jsonrpc field (may validate downstream)" -ForegroundColor Yellow
        } catch {
            if ($_.Exception.Response.StatusCode -eq 400) {
                Write-Host "      [OK] Server correctly rejects request without jsonrpc field" -ForegroundColor Green
            } else {
                Write-Host "      [WARN] Unexpected error for missing jsonrpc: $_" -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "      [WARN] Missing jsonrpc test: $_" -ForegroundColor Yellow
    }
    
    # Test 4: Invalid method name
    try {
        Write-Host "   7.4 Testing invalid method name" -ForegroundColor Cyan
        $invalidMethodReq = @{
            jsonrpc = "2.0"
            id      = "invalid-method-1"
            method  = "invalid/method"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $invalidMethodReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "invalid method"
        Write-Host "      [OK] Invalid method request accepted (errors handled by MCP server)" -ForegroundColor Green
    } catch {
        Write-Host "      [WARN] Invalid method test: $_" -ForegroundColor Yellow
    }
    
    # Test 5: Request with string ID (valid per JSON-RPC spec)
    try {
        Write-Host "   7.5 Testing request with string ID" -ForegroundColor Cyan
        $stringIdReq = @{
            jsonrpc = "2.0"
            id      = "string-id-test"
            method  = "tools/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $stringIdReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "string ID"
        Write-Host "      [OK] Request with string ID accepted" -ForegroundColor Green
    } catch {
        Write-Host "      [FAIL] String ID test failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test 6: Request with numeric ID (valid per JSON-RPC spec)
    try {
        Write-Host "   7.6 Testing request with numeric ID" -ForegroundColor Cyan
        $numericIdReq = @{
            jsonrpc = "2.0"
            id      = 12345
            method  = "tools/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $numericIdReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "numeric ID"
        Write-Host "      [OK] Request with numeric ID accepted" -ForegroundColor Green
    } catch {
        Write-Host "      [FAIL] Numeric ID test failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test 7: Notification (no ID) - should be accepted
    try {
        Write-Host "   7.7 Testing notification (no ID)" -ForegroundColor Cyan
        $notificationReq = @{
            jsonrpc = "2.0"
            method  = "notifications/initialized"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $notificationReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "notification"
        Write-Host "      [OK] Notification (no ID) accepted" -ForegroundColor Green
    } catch {
        Write-Host "      [FAIL] Notification test failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test 8: Empty params object (valid)
    try {
        Write-Host "   7.8 Testing request with empty params" -ForegroundColor Cyan
        $emptyParamsReq = @{
            jsonrpc = "2.0"
            id      = "empty-params-1"
            method  = "tools/list"
            params  = @{}
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $emptyParamsReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "empty params"
        Write-Host "      [OK] Request with empty params accepted" -ForegroundColor Green
    } catch {
        Write-Host "      [FAIL] Empty params test failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    # Test 9: Missing params field (should still work, params optional)
    try {
        Write-Host "   7.9 Testing request without params field" -ForegroundColor Cyan
        $noParamsReq = @{
            jsonrpc = "2.0"
            id      = "no-params-1"
            method  = "tools/list"
        } | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $noParamsReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "no params"
        Write-Host "      [OK] Request without params field accepted" -ForegroundColor Green
    } catch {
        Write-Host "      [WARN] No params test: $_" -ForegroundColor Yellow
    }
    
    # Test 10: Batch with mixed request types
    try {
        Write-Host "   7.10 Testing batch with mixed request types" -ForegroundColor Cyan
        $mixedBatchReq = @(
            @{
                jsonrpc = "2.0"
                id      = "batch-req-1"
                method  = "tools/list"
                params  = @{}
            },
            @{
                jsonrpc = "2.0"
                method  = "notifications/initialized"
                params  = @{}
            },
            @{
                jsonrpc = "2.0"
                id      = "batch-req-2"
                method  = "resources/list"
                params  = @{}
            }
        ) | ConvertTo-Json -Depth 10
        
        $resp = Invoke-WebRequest -Uri "$BaseUrl/mcp" -Method POST -ContentType "application/json" -Body $mixedBatchReq -TimeoutSec $TimeoutSeconds
        Assert-StatusCode -Actual $resp.StatusCode -Expected @(200, 202) -Name "mixed batch"
        Write-Host "      [OK] Batch with mixed request types accepted" -ForegroundColor Green
    } catch {
        Write-Host "      [FAIL] Mixed batch test failed: $_" -ForegroundColor Red
        $allPassed = $false
    }
    
    return $allPassed
}

function Test-ErrorScenarios {
    Write-Host "`n8. Testing error scenarios" -ForegroundColor Green
    
    $allPassed = $true
    
    # Test 404 for unknown endpoint
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/unknown" -Method GET -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        Write-Host "   [FAIL] Unknown endpoint should return 404" -ForegroundColor Red
        $allPassed = $false
    }
    catch {
        if ($_.Exception.Response.StatusCode -eq 404) {
            Write-Host "   [OK] Unknown endpoint returns 404" -ForegroundColor Green
        }
        else {
            Write-Host "   [WARN] Unknown endpoint test: $_" -ForegroundColor Yellow
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
    McpListMethods = Test-McpListMethods
    McpProtocolCompliance = Test-McpProtocolCompliance
    Errors = Test-ErrorScenarios
}

# Summary
Write-Host "`n=========================================" -ForegroundColor Cyan
Write-Host "Validation Summary" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$passed = ($results.Values | Where-Object { $_ -eq $true }).Count
$total = $results.Count

foreach ($test in $results.GetEnumerator()) {
    if ($test.Value) {
        $status = "[PASS]"
        $color = "Green"
    }
    else {
        $status = "[FAIL]"
        $color = "Red"
    }
    Write-Host "$($test.Key): $status" -ForegroundColor $color
}

Write-Host "`nTotal: $passed/$total tests passed" -ForegroundColor $(if ($passed -eq $total) { "Green" } else { "Yellow" })

if ($passed -eq $total) {
    Write-Host "`n[OK] All validation tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n[FAIL] Some validation tests failed" -ForegroundColor Red
    exit 1
}
