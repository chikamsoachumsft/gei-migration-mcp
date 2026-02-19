import { getADOPAT } from "./session.js";

interface ADOProject {
  id: string;
  name: string;
  description: string;
  url: string;
  state: string;
}

interface ADORepository {
  id: string;
  name: string;
  project: { name: string };
  remoteUrl: string;
  size: number;
  defaultBranch?: string;
}

interface DetailedADORepository extends ADORepository {
  lastCommitDate?: string;
  isDisabled: boolean;
}

export async function getProjects(adoOrg: string, sessionId?: string): Promise<ADOProject[]> {
  const token = getADOPAT(sessionId);
  const auth = Buffer.from(`:${token}`).toString("base64");
  
  const response = await fetch(
    `https://dev.azure.com/${adoOrg}/_apis/projects?api-version=7.0`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  
  if (!response.ok) {
    throw new Error(`ADO API error: ${response.status} ${response.statusText}`);
  }
  
  const data: any = await response.json();
  return data.value;
}

export async function getRepos(adoOrg: string, project?: string, sessionId?: string): Promise<ADORepository[]> {
  const token = getADOPAT(sessionId);
  const auth = Buffer.from(`:${token}`).toString("base64");
  
  const projectPath = project ? `${project}/` : "";
  const response = await fetch(
    `https://dev.azure.com/${adoOrg}/${projectPath}_apis/git/repositories?api-version=7.0`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  
  if (!response.ok) {
    throw new Error(`ADO API error: ${response.status} ${response.statusText}`);
  }
  
  const data: any = await response.json();
  return data.value;
}

export async function getReposDetailed(adoOrg: string, project?: string, sessionId?: string): Promise<DetailedADORepository[]> {
  const repos = await getRepos(adoOrg, project, sessionId);
  const token = getADOPAT(sessionId);
  const auth = Buffer.from(`:${token}`).toString("base64");
  
  const detailed: DetailedADORepository[] = [];
  
  for (const repo of repos) {
    try {
      // Get last commit date
      const commitsResponse = await fetch(
        `https://dev.azure.com/${adoOrg}/${repo.project.name}/_apis/git/repositories/${repo.id}/commits?$top=1&api-version=7.0`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      
      let lastCommitDate: string | undefined;
      if (commitsResponse.ok) {
        const commitsData: any = await commitsResponse.json();
        if (commitsData.value?.length > 0) {
          lastCommitDate = commitsData.value[0].committer?.date;
        }
      }
      
      detailed.push({
        ...repo,
        lastCommitDate,
        isDisabled: false
      });
    } catch {
      detailed.push({ ...repo, isDisabled: false });
    }
  }
  
  return detailed;
}

export async function getDetailedInventory(adoOrg: string, sessionId?: string): Promise<{
  projects: ADOProject[];
  repositories: DetailedADORepository[];
  summary: {
    totalProjects: number;
    totalRepos: number;
    totalSizeMB: number;
    reposByProject: Record<string, number>;
  };
}> {
  const projects = await getProjects(adoOrg, sessionId);
  const repositories: DetailedADORepository[] = [];
  const reposByProject: Record<string, number> = {};
  
  for (const project of projects) {
    const projectRepos = await getReposDetailed(adoOrg, project.name, sessionId);
    repositories.push(...projectRepos);
    reposByProject[project.name] = projectRepos.length;
  }
  
  const totalSizeMB = repositories.reduce((sum, r) => sum + (r.size || 0), 0) / (1024 * 1024);
  
  return {
    projects,
    repositories,
    summary: {
      totalProjects: projects.length,
      totalRepos: repositories.length,
      totalSizeMB: Math.round(totalSizeMB * 100) / 100,
      reposByProject
    }
  };
}
