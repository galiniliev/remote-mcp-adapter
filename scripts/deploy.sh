#!/bin/bash
# Bash deployment script for Remote MCP Bridge to Azure Container Apps

set -e

# Default values
LOCATION="eastus"
APP_NAME="remote-mcp-bridge"
PARAMETERS_FILE="infra/parameters.json"
SKIP_BUILD=false
REGISTRY_NAME=""
REGISTRY_USERNAME=""
REGISTRY_PASSWORD=""
CONTAINER_IMAGE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -g|--resource-group)
            RESOURCE_GROUP_NAME="$2"
            shift 2
            ;;
        -l|--location)
            LOCATION="$2"
            shift 2
            ;;
        -n|--app-name)
            APP_NAME="$2"
            shift 2
            ;;
        -i|--image)
            CONTAINER_IMAGE="$2"
            shift 2
            ;;
        -p|--parameters)
            PARAMETERS_FILE="$2"
            shift 2
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        -r|--registry)
            REGISTRY_NAME="$2"
            shift 2
            ;;
        -u|--registry-username)
            REGISTRY_USERNAME="$2"
            shift 2
            ;;
        -w|--registry-password)
            REGISTRY_PASSWORD="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$RESOURCE_GROUP_NAME" ]; then
    echo "Error: Resource group name is required (-g or --resource-group)"
    exit 1
fi

echo "========================================="
echo "Remote MCP Bridge Deployment"
echo "========================================="

# Check if Azure CLI is installed
if ! command -v az &> /dev/null; then
    echo "Error: Azure CLI is not installed. Please install it from https://aka.ms/installazureclilinux"
    exit 1
fi

# Check if logged in
if ! az account show &> /dev/null; then
    echo "Not logged in to Azure. Logging in..."
    az login
fi

# Create resource group if it doesn't exist
echo ""
echo "Checking resource group: $RESOURCE_GROUP_NAME"
if ! az group show --name "$RESOURCE_GROUP_NAME" &> /dev/null; then
    echo "Creating resource group: $RESOURCE_GROUP_NAME"
    az group create --name "$RESOURCE_GROUP_NAME" --location "$LOCATION"
fi

# Build and push container image if needed
if [ "$SKIP_BUILD" = false ]; then
    if [ -z "$CONTAINER_IMAGE" ]; then
        if [ -z "$REGISTRY_NAME" ]; then
            echo "Error: Either ContainerImage or RegistryName must be provided"
            exit 1
        fi
        
        echo ""
        echo "Building and pushing container image..."
        
        # Build Docker image
        IMAGE_TAG="${REGISTRY_NAME}.azurecr.io/${APP_NAME}:latest"
        echo "Building image: $IMAGE_TAG"
        docker build -t "$IMAGE_TAG" .
        
        # Login to ACR
        if [ -n "$REGISTRY_USERNAME" ] && [ -n "$REGISTRY_PASSWORD" ]; then
            echo "Logging in to Azure Container Registry..."
            echo "$REGISTRY_PASSWORD" | docker login "$REGISTRY_NAME.azurecr.io" -u "$REGISTRY_USERNAME" --password-stdin
        else
            az acr login --name "$REGISTRY_NAME"
        fi
        
        # Push image
        echo "Pushing image to registry..."
        docker push "$IMAGE_TAG"
        
        CONTAINER_IMAGE="$IMAGE_TAG"
    fi
else
    if [ -z "$CONTAINER_IMAGE" ]; then
        echo "Error: ContainerImage must be provided when using --skip-build"
        exit 1
    fi
fi

# Update parameters file with container image (if jq is available)
if command -v jq &> /dev/null && [ -f "$PARAMETERS_FILE" ]; then
    echo ""
    echo "Updating parameters file with container image..."
    jq ".parameters.containerImage.value = \"$CONTAINER_IMAGE\"" "$PARAMETERS_FILE" > "${PARAMETERS_FILE}.tmp" && mv "${PARAMETERS_FILE}.tmp" "$PARAMETERS_FILE"
fi

# Deploy Bicep template
echo ""
echo "Deploying Bicep template..."
DEPLOYMENT_NAME="mcp-bridge-deployment-$(date +%Y%m%d-%H%M%S)"

az deployment group create \
    --resource-group "$RESOURCE_GROUP_NAME" \
    --name "$DEPLOYMENT_NAME" \
    --template-file "infra/main.bicep" \
    --parameters "@${PARAMETERS_FILE}" \
    --parameters containerImage="$CONTAINER_IMAGE"

# Get deployment outputs
echo ""
echo "Retrieving deployment outputs..."
OUTPUTS=$(az deployment group show \
    --resource-group "$RESOURCE_GROUP_NAME" \
    --name "$DEPLOYMENT_NAME" \
    --query "properties.outputs" -o json)

CONTAINER_APP_NAME=$(echo "$OUTPUTS" | jq -r '.containerAppName.value')
CONTAINER_APP_URL=$(echo "$OUTPUTS" | jq -r '.containerAppUrl.value')
CONTAINER_APP_FQDN=$(echo "$OUTPUTS" | jq -r '.containerAppFqdn.value')

echo ""
echo "========================================="
echo "Deployment Complete!"
echo "========================================="
echo "Container App Name: $CONTAINER_APP_NAME"
echo "Container App URL: $CONTAINER_APP_URL"
echo "FQDN: $CONTAINER_APP_FQDN"
echo ""
echo "Next steps:"
echo "1. Configure APIM to expose this bridge as a Remote MCP Server"
echo "2. Use the bridge URL for APIM configuration: $CONTAINER_APP_URL"
echo "3. Test the bridge endpoints:"
echo "   - Health: ${CONTAINER_APP_URL}/healthz"
echo "   - SSE Stream: ${CONTAINER_APP_URL}/mcp/stream"
echo "   - Streamable HTTP: ${CONTAINER_APP_URL}/mcp/streamable"

