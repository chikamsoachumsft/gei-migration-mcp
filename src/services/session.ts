// Session-based credentials store for multi-tenant support
// Each SSE connection gets a unique sessionId from the MCP SDK's SSEServerTransport.
// That sessionId is passed through to every tool callback via `extra.sessionId`,
// so we never need a global "current session" variable — no race conditions.

export interface SessionCredentials {
  githubSourcePat?: string;
  githubTargetPat?: string;
  adoPat?: string;
}

// Credential store keyed by MCP SDK transport sessionId
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

export function getActiveSessionCount(): number {
  return sessionCredentials.size;
}

// Credential resolvers — accept sessionId explicitly (no global state).
// In HTTP/SSE mode, sessionId comes from extra.sessionId in tool callbacks.
// In stdio mode, sessionId is undefined, so we fall back to environment variables.

export function getGitHubSourcePAT(sessionId?: string): string {
  if (sessionId) {
    const creds = sessionCredentials.get(sessionId);
    if (creds?.githubSourcePat) {
      return creds.githubSourcePat;
    }
  }
  
  // Fall back to environment variables (for stdio mode or if not set per-session)
  const token = process.env.GH_SOURCE_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GitHub source PAT not configured. Provide via X-GitHub-Source-PAT header or GITHUB_TOKEN env var.");
  }
  return token;
}

export function getGitHubTargetPAT(sessionId?: string): string {
  if (sessionId) {
    const creds = sessionCredentials.get(sessionId);
    if (creds?.githubTargetPat) {
      return creds.githubTargetPat;
    }
  }
  
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GitHub target PAT not configured. Provide via X-GitHub-Target-PAT header or GH_PAT env var.");
  }
  return token;
}

export function getADOPAT(sessionId?: string): string {
  if (sessionId) {
    const creds = sessionCredentials.get(sessionId);
    if (creds?.adoPat) {
      return creds.adoPat;
    }
  }
  
  const token = process.env.ADO_PAT;
  if (!token || token === 'not-configured') {
    throw new Error("Azure DevOps PAT not configured. Provide via X-ADO-PAT header or ADO_PAT env var.");
  }
  return token;
}

export function checkPrerequisites(sessionId?: string): { 
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
  if (sessionId) {
    const creds = sessionCredentials.get(sessionId);
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

  if (!githubSource) details.push("Missing: GitHub source PAT (X-GitHub-Source-PAT header or GITHUB_TOKEN env)");
  if (!githubTarget) details.push("Missing: GitHub target PAT (X-GitHub-Target-PAT header or GH_PAT env)");
  if (!ado) details.push("Missing: ADO PAT (X-ADO-PAT header or ADO_PAT env) — optional if not migrating from ADO");

  return { githubSource, githubTarget, ado, details, sessionBased };
}
