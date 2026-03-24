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
      adoProject: z.string().optional().describe("ADO project (if source is ADO)"),
      importPipelines: z.boolean().default(true).describe("Whether to also import CI/CD pipelines")
    },
    async ({ sourceType, sourceOrg, repoName, targetOrg, adoProject, importPipelines }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please migrate the repository "${repoName}" from ${sourceType === "github" ? `GitHub org "${sourceOrg}"` : `Azure DevOps org "${sourceOrg}" project "${adoProject}"`} to GitHub org "${targetOrg}".

Steps:
1. Check prerequisites
2. Start the migration with migrate_repo
3. Wait for it to complete using wait_for_migration
4. Report the final status${importPipelines ? `
5. ${sourceType === "ado" ? `Audit ADO pipelines for this project using actions_importer_audit, then migrate each pipeline with actions_importer_migrate targeting https://github.com/${targetOrg}/${repoName}` : `Copy GitHub Actions workflows from the source repo using copy_workflows`}
6. Report on any manual steps needed for the imported pipelines/workflows` : ""}`
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

  // Pipeline/workflow import prompt
  server.prompt(
    "import-pipelines",
    "Import CI/CD pipelines or workflows into a migrated GitHub repository",
    {
      sourceType: z.enum(["github", "ado"]).describe("Source platform type"),
      sourceOrg: z.string().describe("Source organization name"),
      targetOrg: z.string().describe("Target GitHub organization"),
      targetRepo: z.string().describe("Target repository name"),
      adoProject: z.string().optional().describe("ADO project name (required if source is ADO)")
    },
    async ({ sourceType, sourceOrg, targetOrg, targetRepo, adoProject }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: sourceType === "ado"
            ? `I need to import CI/CD pipelines from Azure DevOps org "${sourceOrg}" project "${adoProject || "(please ask)"}" into the GitHub repo "${targetOrg}/${targetRepo}".

Please:
1. Check prerequisites (including Docker and gh-actions-importer CLI)
2. Run actions_importer_audit to analyze all pipelines in the ADO project
3. Show me the audit summary — how many can be auto-converted
4. For each pipeline that can be converted, run actions_importer_dry_run first to preview
5. Ask for confirmation, then run actions_importer_migrate for approved pipelines targeting https://github.com/${targetOrg}/${targetRepo}
6. List any manual steps needed (secrets, environments, self-hosted runners)`
            : `I need to copy GitHub Actions workflows from "${sourceOrg}/${targetRepo}" to "${targetOrg}/${targetRepo}".

Please:
1. Use list_repo_workflows to see what workflows exist in the source repo
2. Show me the list and let me confirm
3. Use copy_workflows to copy them to the target repo
4. Remind me to update any org-specific secrets or environment references`
        }
      }]
    })
  );
}
