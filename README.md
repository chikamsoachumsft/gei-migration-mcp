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
docker run -p 3000:3000 \
  -e GITHUB_TOKEN=your-source-pat \
  -e GH_PAT=your-target-pat \
  gei-migration-mcp
```

### Deploy to Azure Container Apps
```bash
# Create resource group
az group create -n gei-migration-rg -l eastus

# Deploy with Bicep
az deployment group create \
  -g gei-migration-rg \
  -f infra/main.bicep \
  -p githubSourcePat=<source-pat> \
  -p githubTargetPat=<target-pat>
```

### Connect MCP Client to Remote Server
```json
{
  "servers": {
    "gei-migration": {
      "type": "sse",
      "url": "https://your-app.azurecontainerapps.io/sse"
    }
  }
}
```

## Usage Examples

```
@gei-migration check prerequisites
@gei-migration inventory github org my-source-org
@gei-migration migrate repo my-repo to target org my-target-org
@gei-migration list active migrations
```

## Environment Variables

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
