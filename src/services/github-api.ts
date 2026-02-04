import { graphql } from "@octokit/graphql";
import { getGitHubSourcePAT, getGitHubTargetPAT } from "./environment.js";

interface Repository {
  name: string;
  nameWithOwner: string;
  url: string;
  isArchived: boolean;
  diskUsage: number;
  pushedAt: string;
  description: string | null;
}

interface DetailedRepository extends Repository {
  defaultBranchRef: { name: string } | null;
  languages: { nodes: { name: string }[] };
  isPrivate: boolean;
  isFork: boolean;
}

interface Migration {
  id: string;
  state: string;
  repositoryName: string;
  createdAt: string;
  failureReason?: string;
}

export async function getRepos(org: string): Promise<Repository[]> {
  const token = getGitHubSourcePAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const repos: Repository[] = [];
  let cursor: string | null = null;
  
  do {
    const response: any = await gql(`
      query($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              nameWithOwner
              url
              isArchived
              diskUsage
              pushedAt
              description
            }
          }
        }
      }
    `, { org, cursor });
    
    repos.push(...response.organization.repositories.nodes);
    cursor = response.organization.repositories.pageInfo.hasNextPage 
      ? response.organization.repositories.pageInfo.endCursor 
      : null;
  } while (cursor);
  
  return repos;
}

export async function getReposDetailed(org: string): Promise<DetailedRepository[]> {
  const token = getGitHubSourcePAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const repos: DetailedRepository[] = [];
  let cursor: string | null = null;
  
  do {
    const response: any = await gql(`
      query($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              nameWithOwner
              url
              isArchived
              diskUsage
              pushedAt
              description
              defaultBranchRef { name }
              languages(first: 5) { nodes { name } }
              isPrivate
              isFork
            }
          }
        }
      }
    `, { org, cursor });
    
    repos.push(...response.organization.repositories.nodes);
    cursor = response.organization.repositories.pageInfo.hasNextPage 
      ? response.organization.repositories.pageInfo.endCursor 
      : null;
  } while (cursor);
  
  return repos;
}

export async function createMigrationSource(
  targetOrgId: string,
  sourceOrgUrl: string,
  type: "GITHUB_ARCHIVE" | "AZURE_DEVOPS"
): Promise<string> {
  const token = getGitHubTargetPAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const response: any = await gql(`
    mutation($ownerId: ID!, $name: String!, $sourceUrl: String!, $sourceType: MigrationSourceType!) {
      createMigrationSource(input: {
        ownerId: $ownerId
        name: $name
        url: $sourceUrl
        type: $sourceType
      }) {
        migrationSource { id }
      }
    }
  `, {
    ownerId: targetOrgId,
    name: `migration-source-${Date.now()}`,
    sourceUrl: sourceOrgUrl,
    sourceType: type
  });
  
  return response.createMigrationSource.migrationSource.id;
}

export async function getOrganizationId(org: string): Promise<string> {
  const token = getGitHubTargetPAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const response: any = await gql(`
    query($org: String!) {
      organization(login: $org) { id }
    }
  `, { org });
  
  return response.organization.id;
}

export async function startRepositoryMigration(
  sourceOrgUrl: string,
  targetOrgId: string,
  migrationSourceId: string,
  sourceRepoUrl: string,
  targetRepoName: string,
  accessToken: string
): Promise<string> {
  const token = getGitHubTargetPAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const response: any = await gql(`
    mutation($sourceId: ID!, $ownerId: ID!, $sourceRepoUrl: URI!, $repoName: String!, $accessToken: String!, $githubPat: String!) {
      startRepositoryMigration(input: {
        sourceId: $sourceId
        ownerId: $ownerId
        sourceRepositoryUrl: $sourceRepoUrl
        repositoryName: $repoName
        accessToken: $accessToken
        githubPat: $githubPat
        continueOnError: true
      }) {
        repositoryMigration { id state }
      }
    }
  `, {
    sourceId: migrationSourceId,
    ownerId: targetOrgId,
    sourceRepoUrl,
    repoName: targetRepoName,
    accessToken,
    githubPat: token
  });
  
  return response.startRepositoryMigration.repositoryMigration.id;
}

export async function getMigrationStatus(migrationId: string): Promise<Migration> {
  const token = getGitHubTargetPAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const response: any = await gql(`
    query($id: ID!) {
      node(id: $id) {
        ... on RepositoryMigration {
          id
          state
          repositoryName
          createdAt
          failureReason
        }
      }
    }
  `, { id: migrationId });
  
  return response.node;
}

export async function abortMigration(migrationId: string): Promise<boolean> {
  const token = getGitHubTargetPAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  await gql(`
    mutation($id: ID!) {
      abortRepositoryMigration(input: { migrationId: $id }) {
        success
      }
    }
  `, { id: migrationId });
  
  return true;
}

export async function grantMigratorRole(org: string, actor: string, actorType: "USER" | "TEAM"): Promise<boolean> {
  const token = getGitHubTargetPAT();
  const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  
  const orgId = await getOrganizationId(org);
  
  await gql(`
    mutation($orgId: ID!, $actor: String!, $actorType: ActorType!) {
      grantMigratorRole(input: {
        organizationId: $orgId
        actor: $actor
        actorType: $actorType
      }) {
        success
      }
    }
  `, { orgId, actor, actorType });
  
  return true;
}
