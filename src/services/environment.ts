// Environment service for managing tokens
export function getGitHubSourcePAT(): string {
  const token = process.env.GH_SOURCE_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GH_SOURCE_PAT or GITHUB_TOKEN environment variable is required");
  }
  return token;
}

export function getGitHubTargetPAT(): string {
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GH_PAT or GITHUB_TOKEN environment variable is required for target org");
  }
  return token;
}

export function getADOPAT(): string {
  const token = process.env.ADO_PAT;
  if (!token) {
    throw new Error("ADO_PAT environment variable is required for Azure DevOps migrations");
  }
  return token;
}

export function checkPrerequisites(): { 
  githubSource: boolean; 
  githubTarget: boolean; 
  ado: boolean;
  details: string[];
} {
  const details: string[] = [];
  const githubSource = !!(process.env.GH_SOURCE_PAT || process.env.GITHUB_TOKEN);
  const githubTarget = !!(process.env.GH_PAT || process.env.GITHUB_TOKEN);
  const ado = !!process.env.ADO_PAT;

  if (!githubSource) details.push("Missing: GH_SOURCE_PAT or GITHUB_TOKEN for source GitHub org");
  if (!githubTarget) details.push("Missing: GH_PAT for target GitHub org");
  if (!ado) details.push("Missing: ADO_PAT for Azure DevOps (optional if not migrating from ADO)");

  return { githubSource, githubTarget, ado, details };
}
