# PowerShell deployment script for Remote MCP Bridge to Azure Container Apps

param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,
    
    [Parameter(Mandatory = $false)]
    [string]$Location = "eastus",
    
    [Parameter(Mandatory = $false)]
    [string]$AppName = "remote-mcp-bridge",
    
    [Parameter(Mandatory = $false)]
    [string]$ContainerImage = "",
    
    [Parameter(Mandatory = $false)]
    [string]$ParametersFile = "infra/parameters.json",
    
    [Parameter(Mandatory = $false)]
    [switch]$SkipBuild = $false,
    
    [Parameter(Mandatory = $false)]
    [string]$RegistryName = "",
    
    [Parameter(Mandatory = $false)]
    [string]$RegistryUsername = "",
    
    [Parameter(Mandatory = $false)]
    [string]$RegistryPassword = ""
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Remote MCP Bridge Deployment" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# Check if Azure CLI is installed
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is not installed. Please install it from https://aka.ms/installazurecliwindows"
}

# Check if logged in
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Not logged in to Azure. Logging in..." -ForegroundColor Yellow
    az login
}

# Create resource group if it doesn't exist
Write-Host "`nChecking resource group: $ResourceGroupName" -ForegroundColor Green
$rg = az group show --name $ResourceGroupName 2>$null
if (-not $rg) {
    Write-Host "Creating resource group: $ResourceGroupName" -ForegroundColor Yellow
    az group create --name $ResourceGroupName --location $Location
}

# Build and push container image if needed
if (-not $SkipBuild) {
    if (-not $ContainerImage) {
        if (-not $RegistryName) {
            throw "Either ContainerImage or RegistryName must be provided"
        }
        
        Write-Host "`nBuilding and pushing container image..." -ForegroundColor Green
        
        # Build Docker image
        $imageTag = "${RegistryName}.azurecr.io/${AppName}:latest"
        Write-Host "Building image: $imageTag" -ForegroundColor Yellow
        docker build -t $imageTag .
        
        if ($LASTEXITCODE -ne 0) {
            throw "Docker build failed"
        }
        
        # Login to ACR if credentials provided
        if ($RegistryUsername -and $RegistryPassword) {
            Write-Host "Logging in to Azure Container Registry..." -ForegroundColor Yellow
            az acr login --name $RegistryName --username $RegistryUsername --password $RegistryPassword
        } else {
            az acr login --name $RegistryName
        }
        
        # Push image
        Write-Host "Pushing image to registry..." -ForegroundColor Yellow
        docker push $imageTag
        
        if ($LASTEXITCODE -ne 0) {
            throw "Docker push failed"
        }
        
        $ContainerImage = $imageTag
    }
} else {
    if (-not $ContainerImage) {
        throw "ContainerImage must be provided when using -SkipBuild"
    }
}

# Update parameters file with container image
if (Test-Path $ParametersFile) {
    Write-Host "`nUpdating parameters file with container image..." -ForegroundColor Green
    $params = Get-Content $ParametersFile | ConvertFrom-Json
    $params.parameters.containerImage.value = $ContainerImage
    $params | ConvertTo-Json -Depth 10 | Set-Content $ParametersFile
}

# Deploy Bicep template
Write-Host "`nDeploying Bicep template..." -ForegroundColor Green
$deploymentName = "mcp-bridge-deployment-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

az deployment group create `
    --resource-group $ResourceGroupName `
    --name $deploymentName `
    --template-file "infra/main.bicep" `
    --parameters "@$ParametersFile" `
    --parameters containerImage=$ContainerImage

if ($LASTEXITCODE -ne 0) {
    throw "Deployment failed"
}

# Get deployment outputs
Write-Host "`nRetrieving deployment outputs..." -ForegroundColor Green
$outputs = az deployment group show `
    --resource-group $ResourceGroupName `
    --name $deploymentName `
    --query "properties.outputs" `
    | ConvertFrom-Json

Write-Host "`n=========================================" -ForegroundColor Cyan
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Container App Name: $($outputs.containerAppName.value)" -ForegroundColor Yellow
Write-Host "Container App URL: $($outputs.containerAppUrl.value)" -ForegroundColor Yellow
Write-Host "FQDN: $($outputs.containerAppFqdn.value)" -ForegroundColor Yellow
Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "1. Configure APIM to expose this bridge as a Remote MCP Server" -ForegroundColor White
Write-Host "2. Use the bridge URL for APIM configuration: $($outputs.containerAppUrl.value)" -ForegroundColor White
Write-Host "3. Test the bridge endpoints:" -ForegroundColor White
Write-Host "   - Health: $($outputs.containerAppUrl.value)/healthz" -ForegroundColor Gray
Write-Host "   - SSE Stream: $($outputs.containerAppUrl.value)/mcp/stream" -ForegroundColor Gray
Write-Host "   - Streamable HTTP: $($outputs.containerAppUrl.value)/mcp/streamable" -ForegroundColor Gray

