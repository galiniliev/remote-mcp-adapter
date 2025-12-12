@description('Main Bicep template for Remote MCP Bridge deployment to Azure Container Apps')
param location string = resourceGroup().location
param appName string = 'remote-mcp-bridge'
param environmentName string = 'mcp-bridge-env'
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
param containerPort int = 3000
param cpuCores string = '0.25'
param memory string = '0.5Gi'
param minReplicas int = 1
param maxReplicas int = 10

// Environment variables
param mcpConfigPath string = 'specs/ado-mcp-configuration.json'
param maxBufferSize string = '1048576'
param maxSubscribers string = '100'
param maxMessageSize string = '1048576'
param keepaliveInterval string = '30000'
param streamTimeout string = '300000'
param restartBackoffBase string = '1000'
param restartBackoffMax string = '60000'
param lazyStart string = 'true'

// Log Analytics
param logAnalyticsWorkspaceName string = '${appName}-logs'
param logAnalyticsWorkspaceSku string = 'PerGB2018'

// Container App Environment
resource containerAppEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

// Log Analytics Workspace
resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: logAnalyticsWorkspaceSku
    }
    retentionInDays: 30
  }
}

// Container App
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: containerAppEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: containerPort
        allowInsecure: false
        transport: 'auto'
      }
      registries: []
    }
    template: {
      containers: [
        {
          name: appName
          image: containerImage
          env: [
            {
              name: 'PORT'
              value: string(containerPort)
            }
            {
              name: 'MCP_CONFIG_PATH'
              value: mcpConfigPath
            }
            {
              name: 'MAX_BUFFER_SIZE'
              value: maxBufferSize
            }
            {
              name: 'MAX_SUBSCRIBERS'
              value: maxSubscribers
            }
            {
              name: 'MAX_MESSAGE_SIZE'
              value: maxMessageSize
            }
            {
              name: 'KEEPALIVE_INTERVAL'
              value: keepaliveInterval
            }
            {
              name: 'STREAM_TIMEOUT'
              value: streamTimeout
            }
            {
              name: 'RESTART_BACKOFF_BASE'
              value: restartBackoffBase
            }
            {
              name: 'RESTART_BACKOFF_MAX'
              value: restartBackoffMax
            }
            {
              name: 'LAZY_START'
              value: lazyStart
            }
          ]
          resources: {
            cpu: json(cpuCores)
            memory: memory
          }
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

// Outputs
output containerAppName string = containerApp.name
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output logAnalyticsWorkspaceId string = logAnalyticsWorkspace.id
output logAnalyticsWorkspaceName string = logAnalyticsWorkspace.name

