import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  // Migration planning prompt
  server.prompt(
    "plan-migration",
    "Help plan a migration from source to GitHub Enterprise",
    {
      sourceType: z.enum(["github", "ado"]).describe("Source platform type"),
      sourceOrg: z.string().describe("Source organization name"),
      targetOrg: z.string().describe("Target GitHub organization")
    },
    async ({ sourceType, sourceOrg, targetOrg }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `I need help planning a migration from ${sourceType === "github" ? "GitHub" : "Azure DevOps"} organization "${sourceOrg}" to GitHub organization "${targetOrg}".

Please help me by:
1. First checking the prerequisites using check_prerequisites
2. Running an inventory of the source organization using inventory_${sourceType}_org
3. Identifying any large repositories (>1GB) that may need special handling
4. Identifying stale repositories that might not need migration
5. Creating a migration plan with recommendations

Start by checking prerequisites and inventorying the source organization.`
        }
      }]
    })
  );

  // Quick migrate prompt
  server.prompt(
    "quick-migrate",
    "Quickly migrate a single repository",
    {
      sourceType: z.enum(["github", "ado"]).describe("Source platform type"),
      sourceOrg: z.string().describe("Source organization"),
      repoName: z.string().describe("Repository name"),
      targetOrg: z.string().describe("Target organization"),
      adoProject: z.string().optional().describe("ADO project (if source is ADO)")
    },
    async ({ sourceType, sourceOrg, repoName, targetOrg, adoProject }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please migrate the repository "${repoName}" from ${sourceType === "github" ? `GitHub org "${sourceOrg}"` : `Azure DevOps org "${sourceOrg}" project "${adoProject}"`} to GitHub org "${targetOrg}".

Steps:
1. Check prerequisites
2. Start the migration with migrate_repo
3. Wait for it to complete using wait_for_migration
4. Report the final status`
        }
      }]
    })
  );

  // Bulk migration prompt
  server.prompt(
    "bulk-migrate",
    "Plan and execute bulk migration of all repositories",
    {
      sourceType: z.enum(["github", "ado"]).describe("Source platform type"),
      sourceOrg: z.string().describe("Source organization"),
      targetOrg: z.string().describe("Target organization"),
      excludeArchived: z.boolean().default(true).describe("Exclude archived repos"),
      excludeStale: z.boolean().default(false).describe("Exclude repos inactive >1 year")
    },
    async ({ sourceType, sourceOrg, targetOrg, excludeArchived, excludeStale }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `I need to migrate all repositories from ${sourceType === "github" ? "GitHub" : "Azure DevOps"} organization "${sourceOrg}" to GitHub organization "${targetOrg}".

Migration preferences:
- ${excludeArchived ? "Exclude" : "Include"} archived repositories
- ${excludeStale ? "Exclude" : "Include"} stale repositories (inactive >1 year)

Please:
1. Check prerequisites
2. Inventory the source organization
3. ${excludeArchived ? "Filter out archived repositories" : ""}
4. ${excludeStale ? "Filter out stale repositories" : ""}
5. List the repositories that will be migrated
6. Ask for confirmation before starting
7. Start migrations in batches of 5
8. Monitor progress and report completion`
        }
      }]
    })
  );
}
