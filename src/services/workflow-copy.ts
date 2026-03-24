import { getGitHubSourcePAT, getGitHubTargetPAT } from "./session.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkflowFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  downloadUrl: string;
}

export interface WorkflowContent {
  name: string;
  path: string;
  content: string;
  sha: string;
}

export interface CopyResult {
  copied: string[];
  skipped: string[];
  errors: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ghRestGet(url: string, token: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub REST API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function ghRestPut(url: string, token: string, body: object): Promise<any> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub REST API error: ${response.status} ${text}`);
  }
  return response.json();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List all workflow files in a repository's .github/workflows directory.
 */
export async function listWorkflows(
  org: string,
  repo: string,
  sessionId?: string
): Promise<WorkflowFile[]> {
  const token = getGitHubSourcePAT(sessionId);
  const data = await ghRestGet(
    `https://api.github.com/repos/${org}/${repo}/contents/.github/workflows`,
    token
  );

  if (!data || !Array.isArray(data)) return [];

  return data
    .filter((f: any) => f.type === "file" && (f.name.endsWith(".yml") || f.name.endsWith(".yaml")))
    .map((f: any) => ({
      name: f.name,
      path: f.path,
      sha: f.sha,
      size: f.size,
      downloadUrl: f.download_url,
    }));
}

/**
 * Get the content of a single workflow file.
 */
export async function getWorkflowContent(
  org: string,
  repo: string,
  filePath: string,
  sessionId?: string
): Promise<WorkflowContent | null> {
  const token = getGitHubSourcePAT(sessionId);
  const data = await ghRestGet(
    `https://api.github.com/repos/${org}/${repo}/contents/${filePath}`,
    token
  );

  if (!data) return null;

  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { name: data.name, path: data.path, content, sha: data.sha };
}

/**
 * Copy all workflow files from source repo to target repo.
 * Creates them via the Contents API (commit per file).
 */
export async function copyWorkflows(
  sourceOrg: string,
  sourceRepo: string,
  targetOrg: string,
  targetRepo: string,
  sessionId?: string
): Promise<CopyResult> {
  const sourceToken = getGitHubSourcePAT(sessionId);
  const targetToken = getGitHubTargetPAT(sessionId);

  const result: CopyResult = { copied: [], skipped: [], errors: [] };

  // List source workflows
  const workflows = await listWorkflows(sourceOrg, sourceRepo, sessionId);
  if (workflows.length === 0) {
    return result;
  }

  for (const wf of workflows) {
    try {
      // Fetch content from source
      const sourceData = await ghRestGet(
        `https://api.github.com/repos/${sourceOrg}/${sourceRepo}/contents/${wf.path}`,
        sourceToken
      );
      if (!sourceData) {
        result.errors.push(`Could not read ${wf.path} from source`);
        continue;
      }

      // Check if file already exists in target
      const existing = await ghRestGet(
        `https://api.github.com/repos/${targetOrg}/${targetRepo}/contents/${wf.path}`,
        targetToken
      );

      if (existing) {
        result.skipped.push(`${wf.path} (already exists in target)`);
        continue;
      }

      // Create file in target repo
      await ghRestPut(
        `https://api.github.com/repos/${targetOrg}/${targetRepo}/contents/${wf.path}`,
        targetToken,
        {
          message: `chore: copy workflow ${wf.name} from ${sourceOrg}/${sourceRepo}`,
          content: sourceData.content, // already base64 from Contents API
        }
      );

      result.copied.push(wf.path);
    } catch (err: any) {
      result.errors.push(`${wf.path}: ${err.message}`);
    }
  }

  return result;
}
