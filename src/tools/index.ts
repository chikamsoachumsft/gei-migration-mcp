import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as github from "../services/github-api.js";
import * as ado from "../services/ado-api.js";
import * as state from "../services/state.js";
import { checkPrerequisites, getGitHubSourcePAT, getADOPAT } from "../services/session.js";

export function registerTools(server: McpServer): void {
  // Check prerequisites
  server.tool(
    "check_prerequisites",
    "Check if required environment variables are configured for migrations",
    {},
    async () => {
      const prereqs = checkPrerequisites();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ready: prereqs.githubSource && prereqs.githubTarget,
            ...prereqs
          }, null, 2)
        }]
      };
    }
  );

  // List source repositories
  server.tool(
    "list_source_repos",
    "List repositories from a source organization (GitHub or Azure DevOps)",
    {
      source: z.enum(["github", "ado"]).describe("Source platform"),
      org: z.string().describe("Organization name"),
      project: z.string().optional().describe("ADO project name (optional, for ADO only)")
    },
    async ({ source, org, project }) => {
      if (source === "github") {
        const repos = await github.getRepos(org);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: repos.length,
              repositories: repos.map(r => ({
                name: r.name,
                url: r.url,
                archived: r.isArchived,
                sizeMB: Math.round(r.diskUsage / 1024 * 100) / 100,
                lastPush: r.pushedAt
              }))
            }, null, 2)
          }]
        };
      } else {
        const repos = await ado.getRepos(org, project);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: repos.length,
              repositories: repos.map(r => ({
                name: r.name,
                project: r.project.name,
                url: r.remoteUrl,
                sizeMB: Math.round(r.size / (1024 * 1024) * 100) / 100
              }))
            }, null, 2)
          }]
        };
      }
    }
  );

  // Inventory GitHub org
  server.tool(
    "inventory_github_org",
    "Get detailed inventory of a GitHub organization including all repos with metadata",
    {
      org: z.string().describe("GitHub organization name")
    },
    async ({ org }) => {
      const repos = await github.getReposDetailed(org);
      const totalSize = repos.reduce((sum, r) => sum + r.diskUsage, 0);
      const archived = repos.filter(r => r.isArchived).length;
      const forks = repos.filter(r => r.isFork).length;
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            organization: org,
            summary: {
              totalRepos: repos.length,
              totalSizeMB: Math.round(totalSize / 1024 * 100) / 100,
              archivedRepos: archived,
              forks: forks,
              activeRepos: repos.length - archived
            },
            repositories: repos.map(r => ({
              name: r.name,
              url: r.url,
              archived: r.isArchived,
              private: r.isPrivate,
              fork: r.isFork,
              sizeMB: Math.round(r.diskUsage / 1024 * 100) / 100,
              lastPush: r.pushedAt,
              defaultBranch: r.defaultBranchRef?.name,
              languages: r.languages.nodes.map(l => l.name)
            }))
          }, null, 2)
        }]
      };
    }
  );

  // Inventory ADO org
  server.tool(
    "inventory_ado_org",
    "Get detailed inventory of an Azure DevOps organization",
    {
      org: z.string().describe("Azure DevOps organization name")
    },
    async ({ org }) => {
      const inventory = await ado.getDetailedInventory(org);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(inventory, null, 2)
        }]
      };
    }
  );

  // Find large repos
  server.tool(
    "find_large_repos",
    "Find repositories larger than a specified size",
    {
      source: z.enum(["github", "ado"]).describe("Source platform"),
      org: z.string().describe("Organization name"),
      thresholdMB: z.number().default(1000).describe("Size threshold in MB")
    },
    async ({ source, org, thresholdMB }) => {
      if (source === "github") {
        const repos = await github.getReposDetailed(org);
        const large = repos
          .filter(r => r.diskUsage / 1024 > thresholdMB)
          .sort((a, b) => b.diskUsage - a.diskUsage);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              threshold: `${thresholdMB} MB`,
              count: large.length,
              repositories: large.map(r => ({
                name: r.name,
                sizeMB: Math.round(r.diskUsage / 1024 * 100) / 100
              }))
            }, null, 2)
          }]
        };
      } else {
        const inventory = await ado.getDetailedInventory(org);
        const thresholdBytes = thresholdMB * 1024 * 1024;
        const large = inventory.repositories
          .filter(r => r.size > thresholdBytes)
          .sort((a, b) => b.size - a.size);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              threshold: `${thresholdMB} MB`,
              count: large.length,
              repositories: large.map(r => ({
                name: r.name,
                project: r.project.name,
                sizeMB: Math.round(r.size / (1024 * 1024) * 100) / 100
              }))
            }, null, 2)
          }]
        };
      }
    }
  );

  // Find stale repos
  server.tool(
    "find_stale_repos",
    "Find repositories that haven't been updated in a while",
    {
      source: z.enum(["github", "ado"]).describe("Source platform"),
      org: z.string().describe("Organization name"),
      daysInactive: z.number().default(365).describe("Days since last activity")
    },
    async ({ source, org, daysInactive }) => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysInactive);
      
      if (source === "github") {
        const repos = await github.getReposDetailed(org);
        const stale = repos
          .filter(r => new Date(r.pushedAt) < cutoff)
          .sort((a, b) => new Date(a.pushedAt).getTime() - new Date(b.pushedAt).getTime());
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              threshold: `${daysInactive} days inactive`,
              count: stale.length,
              repositories: stale.map(r => ({
                name: r.name,
                lastActivity: r.pushedAt,
                archived: r.isArchived
              }))
            }, null, 2)
          }]
        };
      } else {
        const inventory = await ado.getDetailedInventory(org);
        const stale = inventory.repositories
          .filter(r => r.lastCommitDate && new Date(r.lastCommitDate) < cutoff)
          .sort((a, b) => new Date(a.lastCommitDate!).getTime() - new Date(b.lastCommitDate!).getTime());
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              threshold: `${daysInactive} days inactive`,
              count: stale.length,
              repositories: stale.map(r => ({
                name: r.name,
                project: r.project.name,
                lastActivity: r.lastCommitDate
              }))
            }, null, 2)
          }]
        };
      }
    }
  );

  // Migrate repository
  server.tool(
    "migrate_repo",
    "Start a migration for a single repository",
    {
      source: z.enum(["github", "ado"]).describe("Source platform"),
      sourceOrg: z.string().describe("Source organization name"),
      repoName: z.string().describe("Repository name to migrate"),
      targetOrg: z.string().describe("Target GitHub organization"),
      targetRepoName: z.string().optional().describe("New repository name (defaults to same name)"),
      adoProject: z.string().optional().describe("ADO project name (required for ADO source)")
    },
    async ({ source, sourceOrg, repoName, targetOrg, targetRepoName, adoProject }) => {
      const finalRepoName = targetRepoName || repoName;
      
      // Get target org ID
      const targetOrgId = await github.getOrganizationId(targetOrg);
      
      // Build source URL
      let sourceOrgUrl: string;
      let sourceRepoUrl: string;
      let migrationSourceType: "GITHUB_ARCHIVE" | "AZURE_DEVOPS";
      let accessToken: string;
      
      if (source === "github") {
        sourceOrgUrl = `https://github.com/${sourceOrg}`;
        sourceRepoUrl = `https://github.com/${sourceOrg}/${repoName}`;
        migrationSourceType = "GITHUB_ARCHIVE";
        accessToken = getGitHubSourcePAT();
      } else {
        if (!adoProject) {
          throw new Error("adoProject is required for Azure DevOps migrations");
        }
        sourceOrgUrl = `https://dev.azure.com/${sourceOrg}`;
        sourceRepoUrl = `https://dev.azure.com/${sourceOrg}/${adoProject}/_git/${repoName}`;
        migrationSourceType = "AZURE_DEVOPS";
        accessToken = getADOPAT();
      }
      
      // Check if we already have a migration source, otherwise create one
      let migrationSourceId = state.getMigrationSource(sourceOrgUrl);
      if (!migrationSourceId) {
        migrationSourceId = await github.createMigrationSource(targetOrgId, sourceOrgUrl, migrationSourceType);
        state.saveMigrationSource(sourceOrgUrl, migrationSourceId);
      }
      
      // Start the migration
      const migrationId = await github.startRepositoryMigration(
        sourceOrgUrl,
        targetOrgId,
        migrationSourceId,
        sourceRepoUrl,
        finalRepoName,
        accessToken
      );
      
      // Record the migration
      state.addActiveMigration({
        id: migrationId,
        sourceOrg,
        targetOrg,
        repoName: finalRepoName,
        state: "QUEUED",
        startedAt: new Date().toISOString(),
        source
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            migrationId,
            message: `Migration started for ${repoName} -> ${targetOrg}/${finalRepoName}`,
            checkStatus: `Use get_migration_status with migrationId: ${migrationId}`
          }, null, 2)
        }]
      };
    }
  );

  // Get migration status
  server.tool(
    "get_migration_status",
    "Check the status of a specific migration",
    {
      migrationId: z.string().describe("The migration ID to check")
    },
    async ({ migrationId }) => {
      const status = await github.getMigrationStatus(migrationId);
      state.updateMigrationState(migrationId, status.state);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(status, null, 2)
        }]
      };
    }
  );

  // List active migrations
  server.tool(
    "list_active_migrations",
    "List all currently active migrations",
    {},
    async () => {
      const active = state.getActiveMigrations();
      
      // Update statuses
      const updated = await Promise.all(
        active.map(async (m) => {
          try {
            const status = await github.getMigrationStatus(m.id);
            state.updateMigrationState(m.id, status.state);
            return { ...m, state: status.state };
          } catch {
            return m;
          }
        })
      );
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: updated.length,
            migrations: updated
          }, null, 2)
        }]
      };
    }
  );

  // Wait for migration
  server.tool(
    "wait_for_migration",
    "Wait for a migration to complete (polls status)",
    {
      migrationId: z.string().describe("The migration ID to wait for"),
      timeoutMinutes: z.number().default(30).describe("Maximum minutes to wait")
    },
    async ({ migrationId, timeoutMinutes }) => {
      const startTime = Date.now();
      const timeoutMs = timeoutMinutes * 60 * 1000;
      
      while (Date.now() - startTime < timeoutMs) {
        const status = await github.getMigrationStatus(migrationId);
        state.updateMigrationState(migrationId, status.state);
        
        if (["SUCCEEDED", "FAILED", "FAILED_VALIDATION"].includes(status.state)) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                completed: true,
                status,
                duration: `${Math.round((Date.now() - startTime) / 1000)} seconds`
              }, null, 2)
            }]
          };
        }
        
        // Wait 10 seconds between checks
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            completed: false,
            message: `Timeout after ${timeoutMinutes} minutes. Migration still in progress.`,
            migrationId
          }, null, 2)
        }]
      };
    }
  );

  // Abort migration
  server.tool(
    "abort_migration",
    "Abort an in-progress migration",
    {
      migrationId: z.string().describe("The migration ID to abort")
    },
    async ({ migrationId }) => {
      await github.abortMigration(migrationId);
      state.updateMigrationState(migrationId, "ABORTED");
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Migration ${migrationId} has been aborted`
          }, null, 2)
        }]
      };
    }
  );

  // Get migration history
  server.tool(
    "get_migration_history",
    "Get history of completed migrations",
    {
      limit: z.number().default(50).describe("Maximum number of records to return")
    },
    async ({ limit }) => {
      const history = state.getMigrationHistory().slice(-limit);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: history.length,
            migrations: history
          }, null, 2)
        }]
      };
    }
  );

  // Grant migrator role
  server.tool(
    "grant_migrator_role",
    "Grant the migrator role to a user or team in the target organization",
    {
      org: z.string().describe("Target organization name"),
      actor: z.string().describe("Username or team name"),
      actorType: z.enum(["USER", "TEAM"]).describe("Whether the actor is a user or team")
    },
    async ({ org, actor, actorType }) => {
      await github.grantMigratorRole(org, actor, actorType);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Migrator role granted to ${actorType.toLowerCase()} '${actor}' in ${org}`
          }, null, 2)
        }]
      };
    }
  );

  // Export inventory to CSV
  server.tool(
    "export_inventory_csv",
    "Export repository inventory to CSV format",
    {
      source: z.enum(["github", "ado"]).describe("Source platform"),
      org: z.string().describe("Organization name")
    },
    async ({ source, org }) => {
      if (source === "github") {
        const repos = await github.getReposDetailed(org);
        const csv = [
          "Name,URL,Archived,Private,Fork,SizeMB,LastPush,DefaultBranch,Languages",
          ...repos.map(r => 
            `"${r.name}","${r.url}",${r.isArchived},${r.isPrivate},${r.isFork},${Math.round(r.diskUsage / 1024 * 100) / 100},"${r.pushedAt}","${r.defaultBranchRef?.name || ''}","${r.languages.nodes.map(l => l.name).join(';')}"`
          )
        ].join("\n");
        
        return {
          content: [{
            type: "text",
            text: csv
          }]
        };
      } else {
        const inventory = await ado.getDetailedInventory(org);
        const csv = [
          "Name,Project,URL,SizeMB,LastCommit,DefaultBranch",
          ...inventory.repositories.map(r =>
            `"${r.name}","${r.project.name}","${r.remoteUrl}",${Math.round(r.size / (1024 * 1024) * 100) / 100},"${r.lastCommitDate || ''}","${r.defaultBranch || ''}"`
          )
        ].join("\n");
        
        return {
          content: [{
            type: "text",
            text: csv
          }]
        };
      }
    }
  );
}
