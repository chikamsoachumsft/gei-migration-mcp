# GEI Migration MCP Server

A Model Context Protocol (MCP) server that wraps GitHub Enterprise Importer (GEI) APIs, enabling natural language-driven repository migrations.

## Features

- **GitHub → GitHub** migrations
- **Azure DevOps → GitHub** migrations
- Natural language interface via MCP
- Inventory and discovery tools
- Migration tracking and history

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

## Setup

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

## Usage Examples

```
@gei-migration check prerequisites
@gei-migration inventory github org my-source-org
@gei-migration migrate repo my-repo to target org my-target-org
@gei-migration list active migrations
```

## Environment Variables

- `GITHUB_TOKEN` / `GH_SOURCE_PAT` - PAT for source GitHub org (needs `repo`, `read:org`, `workflow`)
- `GH_PAT` - PAT for target GitHub org (needs `admin:org`, `repo`, `workflow`)
- `ADO_PAT` - PAT for Azure DevOps (optional, for ADO migrations)

## License

MIT
