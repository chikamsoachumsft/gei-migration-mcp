// Session-based credentials store for multi-tenant support
export interface SessionCredentials {
  githubSourcePat?: string;
  githubTargetPat?: string;
  adoPat?: string;
}

// Global session store (in-memory for simplicity)
// In production, consider Redis for multi-instance deployments
const sessionCredentials = new Map<string, SessionCredentials>();

export function setSessionCredentials(sessionId: string, credentials: SessionCredentials): void {
  sessionCredentials.set(sessionId, credentials);
}

export function getSessionCredentials(sessionId: string): SessionCredentials | undefined {
  return sessionCredentials.get(sessionId);
}

export function clearSessionCredentials(sessionId: string): void {
  sessionCredentials.delete(sessionId);
}

// Current session context (set per-request in HTTP mode)
let currentSessionId: string | undefined;

export function setCurrentSession(sessionId: string | undefined): void {
  currentSessionId = sessionId;
}

export function getCurrentSession(): string | undefined {
  return currentSessionId;
}

// Get credentials for current session, falling back to environment variables
export function getGitHubSourcePAT(): string {
  // First try session credentials
  if (currentSessionId) {
    const creds = sessionCredentials.get(currentSessionId);
    if (creds?.githubSourcePat) {
      return creds.githubSourcePat;
    }
  }
  
  // Fall back to environment variables (for stdio mode or if not set per-session)
  const token = process.env.GH_SOURCE_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GitHub source PAT not configured. Please provide GH_SOURCE_PAT when connecting.");
  }
  return token;
}

export function getGitHubTargetPAT(): string {
  if (currentSessionId) {
    const creds = sessionCredentials.get(currentSessionId);
    if (creds?.githubTargetPat) {
      return creds.githubTargetPat;
    }
  }
  
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GitHub target PAT not configured. Please provide GH_PAT when connecting.");
  }
  return token;
}

export function getADOPAT(): string {
  if (currentSessionId) {
    const creds = sessionCredentials.get(currentSessionId);
    if (creds?.adoPat) {
      return creds.adoPat;
    }
  }
  
  const token = process.env.ADO_PAT;
  if (!token || token === 'not-configured') {
    throw new Error("Azure DevOps PAT not configured. Please provide ADO_PAT when connecting.");
  }
  return token;
}

export function checkPrerequisites(): { 
  githubSource: boolean; 
  githubTarget: boolean; 
  ado: boolean;
  details: string[];
  sessionBased: boolean;
} {
  const details: string[] = [];
  let githubSource = false;
  let githubTarget = false;
  let ado = false;
  let sessionBased = false;

  // Check session credentials first
  if (currentSessionId) {
    const creds = sessionCredentials.get(currentSessionId);
    if (creds) {
      sessionBased = true;
      githubSource = !!creds.githubSourcePat;
      githubTarget = !!creds.githubTargetPat;
      ado = !!creds.adoPat;
    }
  }

  // Fall back to environment variables
  if (!githubSource) {
    githubSource = !!(process.env.GH_SOURCE_PAT || process.env.GITHUB_TOKEN);
  }
  if (!githubTarget) {
    githubTarget = !!(process.env.GH_PAT || process.env.GITHUB_TOKEN);
  }
  if (!ado) {
    ado = !!(process.env.ADO_PAT && process.env.ADO_PAT !== 'not-configured');
  }

  if (!githubSource) details.push("Missing: GH_SOURCE_PAT or GITHUB_TOKEN for source GitHub org");
  if (!githubTarget) details.push("Missing: GH_PAT for target GitHub org");
  if (!ado) details.push("Missing: ADO_PAT for Azure DevOps (optional if not migrating from ADO)");

  return { githubSource, githubTarget, ado, details, sessionBased };
}
