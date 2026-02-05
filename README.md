# GEI Migration MCP Server

A Model Context Protocol (MCP) server that wraps GitHub Enterprise Importer (GEI) APIs, enabling natural language-driven repository migrations.

## Features

- **GitHub → GitHub** migrations
- **Azure DevOps → GitHub** migrations  
- Natural language interface via MCP
- Inventory and discovery tools
- Migration tracking and history
- **Local (stdio)** and **Remote (HTTP+SSE)** transport support
- **Azure Container Apps** deployment ready

## Available Tools

| Tool | Description |
|------|-------------|
| `check_prerequisites` | Verify PATs are configured |
| `list_source_repos` | List repos from GitHub or ADO |
| `inventory_github_org` | Full GitHub org inventory |
| `inventory_ado_org` | Full ADO org inventory |
| `find_large_repos` | Find repos over size threshold |
| `find_stale_repos` | Find inactive repos |
| `migrate_repo` | Start a migration |
| `get_migration_status` | Check migration progress |
| `list_active_migrations` | Show running migrations |
| `wait_for_migration` | Wait for completion |
| `abort_migration` | Cancel a migration |
| `get_migration_history` | View completed migrations |
| `grant_migrator_role` | Grant migrator permissions |
| `export_inventory_csv` | Export inventory as CSV |

## Local Setup (stdio)

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build:
   ```bash
   npm run build
   ```

3. Add to VS Code `mcp.json`:
   ```json
   {
     "servers": {
       "gei-migration": {
         "type": "stdio",
         "command": "node",
         "args": ["path/to/gei-migration-mcp/dist/index.js"],
         "env": {
           "GITHUB_TOKEN": "your-source-pat",
           "GH_PAT": "your-target-pat",
           "ADO_PAT": "your-ado-pat"
         }
       }
     }
   }
   ```

## Remote Setup (HTTP+SSE)

### Run Locally with HTTP
```bash
npm run build
MCP_TRANSPORT=http PORT=3000 npm start
```

### Docker
```bash
docker build -t gei-migration-mcp .
docker run -p 3000:3000 gei-migration-mcp
```

### Deploy to Azure Container Apps
```bash
# Create resource group
az group create -n gei-migration-rg -l eastus

# Deploy with Bicep (no secrets needed - users provide their own)
az deployment group create \
  -g gei-migration-rg \
  -f infra/main.bicep
```

### Connect MCP Client to Remote Server

#### Recommended: HTTP Headers (Secure)

Use HTTP headers with VS Code input prompts for secure credential handling:

```json
{
  "servers": {
    "gei-migration": {
      "type": "sse",
      "url": "https://your-app.azurecontainerapps.io/sse",
      "headers": {
        "X-GitHub-Source-PAT": "${input:ghSourcePat}",
        "X-GitHub-Target-PAT": "${input:ghTargetPat}",
        "X-ADO-PAT": "${input:adoPat}"
      }
    }
  },
  "inputs": [
    { "id": "ghSourcePat", "type": "promptString", "description": "GitHub PAT for source org", "password": true },
    { "id": "ghTargetPat", "type": "promptString", "description": "GitHub PAT for target org", "password": true },
    { "id": "adoPat", "type": "promptString", "description": "Azure DevOps PAT (optional, press Enter to skip)", "password": true }
  ]
}
```

This approach:
- Prompts for credentials at runtime (not stored in config files)
- Sends credentials via HTTP headers (not logged in URLs)
- Masks input with `password: true`

#### Alternative: Query Parameters

For quick testing, credentials can also be passed as query parameters:

```json
{
  "servers": {
    "gei-migration": {
      "type": "sse",
      "url": "https://your-app.azurecontainerapps.io/sse?gh_source_pat=YOUR_SOURCE_PAT&gh_pat=YOUR_TARGET_PAT"
    }
  }
}
```

⚠️ **Warning**: Query parameters may appear in logs and browser history. Use headers for production.

**Headers / Query Parameters:**
| Header | Query Param | Description |
|--------|-------------|-------------|
| `X-GitHub-Source-PAT` | `gh_source_pat` | PAT for reading source GitHub org |
| `X-GitHub-Target-PAT` | `gh_pat` | PAT for writing to target GitHub org |
| `X-ADO-PAT` | `ado_pat` | PAT for Azure DevOps (optional) |

## Multi-Tenant Support

The server supports multiple concurrent users, each with their own credentials:
- Each SSE connection creates an isolated session
- Credentials are stored per-session and never shared
- Sessions are automatically cleaned up when connections close
- No credentials are stored on the server - users provide their own

## Usage Examples

```
@gei-migration check prerequisites
@gei-migration inventory github org my-source-org
@gei-migration migrate repo my-repo to target org my-target-org
@gei-migration list active migrations
```

## Environment Variables (Local/stdio mode)

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | PAT for source GitHub org | Yes |
| `GH_PAT` | PAT for target GitHub org | Yes |
| `ADO_PAT` | PAT for Azure DevOps | No |
| `MCP_TRANSPORT` | `stdio` (default) or `http` | No |
| `PORT` | HTTP port (default: 3000) | No |

### PAT Scopes Required
- **Source PAT**: `repo`, `read:org`, `workflow`
- **Target PAT**: `admin:org`, `repo`, `workflow`
- **ADO PAT**: Full access or `Code (Read)`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Client (VS Code, Claude Desktop, etc.)                 │
└─────────────────────┬───────────────────────────────────────┘
                      │ MCP Protocol (stdio or HTTP+SSE)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  GEI Migration MCP Server                                   │
│  ├── Tools (migrate, inventory, status, etc.)               │
│  ├── Resources (active migrations, history)                 │
│  └── Prompts (migration planning templates)                 │
└─────────────────────┬───────────────────────────────────────┘
                      │ GraphQL / REST APIs
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  GitHub API          │  Azure DevOps API                    │
│  (GraphQL)           │  (REST)                              │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT
