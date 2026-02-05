// Azure Container Apps deployment for GEI Migration MCP Server
// Deploy with: az deployment group create -g <resource-group> -f infra/main.bicep

@description('The name of the Container App')
param appName string = 'gei-migration-mcp'

@description('The location for all resources')
param location string = resourceGroup().location

@description('Container image to deploy')
param containerImage string = 'ghcr.io/chikamsoachumsft/gei-migration-mcp:latest'

// Note: User credentials are now passed per-session via query parameters,
// not as server-level secrets. This is more secure for multi-tenant use.

// Log Analytics Workspace for Container Apps
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// Container Apps Environment
resource containerAppEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// Container App
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['*']
          allowedMethods: ['GET', 'POST', 'OPTIONS']
          allowedHeaders: ['*']
        }
      }
      // No secrets needed - credentials are passed per-session via query parameters
    }
    template: {
      containers: [
        {
          name: appName
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'MCP_TRANSPORT'
              value: 'http'
            }
            {
              name: 'PORT'
              value: '3000'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 5
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

// Outputs
output fqdn string = containerApp.properties.configuration.ingress.fqdn
output sseEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/sse'
output healthEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/health'
