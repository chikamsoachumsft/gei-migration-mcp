/**
 * ADO Pipelines REST API service.
 * Talks directly to Azure DevOps Build/Release/Pipelines APIs — no Docker required.
 */
import { getADOPAT } from "./session.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ADOBuildDefinition {
  id: number;
  name: string;
  path: string;
  type: "build" | "xaml" | "designerHyphenJson";
  queueStatus: string;
  revision: number;
  createdDate: string;
  project: { id: string; name: string };
  process?: {
    type: number;        // 1 = designer (classic), 2 = YAML
    yamlFilename?: string;
  };
  repository?: {
    id: string;
    name: string;
    type: string;        // "TfsGit" | "Git" | "GitHub" etc.
    defaultBranch?: string;
    url?: string;
  };
  triggers?: ADOTrigger[];
  variables?: Record<string, { value: string; isSecret?: boolean; allowOverride?: boolean }>;
  variableGroups?: { id: number; name: string }[];
}

export interface ADOBuildDefinitionDetail extends ADOBuildDefinition {
  /** Full YAML pipeline content (fetched separately for YAML pipelines) */
  yamlContent?: string;
  /** Classic pipeline process steps (for designer pipelines) */
  processSteps?: ADOClassicStep[];
  /** Phases/jobs for classic pipelines */
  processPhases?: ADOClassicPhase[];
  options?: any[];
  jobAuthorizationScope?: string;
}

export interface ADOClassicPhase {
  name: string;
  refName: string;
  condition: string;
  target: { type: number; executionOptions?: any; allowScriptsAuthAccessOption?: boolean };
  jobAuthorizationScope?: string;
  steps: ADOClassicStep[];
}

export interface ADOClassicStep {
  environment: Record<string, string>;
  enabled: boolean;
  continueOnError: boolean;
  alwaysRun: boolean;
  displayName: string;
  timeoutInMinutes: number;
  condition: string;
  task: {
    id: string;
    versionSpec: string;
    definitionType: string;
  };
  inputs: Record<string, string>;
}

export interface ADOTrigger {
  triggerType: string;
  branchFilters?: string[];
  pathFilters?: string[];
  settingsSourceType?: number;
  batchChanges?: boolean;
  maxConcurrentBuildsPerBranch?: number;
  schedules?: ADOSchedule[];
}

export interface ADOSchedule {
  branchFilters: string[];
  daysToRuild: string;  // "monday,tuesday,..." or bitmask
  scheduleOnlyWithChanges: boolean;
  startHours: number;
  startMinutes: number;
  timeZoneId: string;
}

export interface ADOReleaseDefinition {
  id: number;
  name: string;
  path: string;
  createdOn: string;
  modifiedOn: string;
  environments: ADOReleaseEnvironment[];
  artifacts: ADOReleaseArtifact[];
  triggers: any[];
  variables: Record<string, { value: string; isSecret?: boolean }>;
  variableGroups: number[];
}

export interface ADOReleaseEnvironment {
  id: number;
  name: string;
  rank: number;
  conditions: any[];
  preDeployApprovals: any;
  postDeployApprovals: any;
  deployPhases: ADOReleaseDeployPhase[];
  variables: Record<string, { value: string; isSecret?: boolean }>;
  retentionPolicy: any;
}

export interface ADOReleaseDeployPhase {
  deploymentInput: any;
  rank: number;
  phaseType: string;
  name: string;
  workflowTasks: ADOReleaseTask[];
}

export interface ADOReleaseTask {
  taskId: string;
  version: string;
  name: string;
  enabled: boolean;
  continueOnError: boolean;
  condition: string;
  alwaysRun: boolean;
  timeoutInMinutes: number;
  inputs: Record<string, string>;
  environment: Record<string, string>;
}

export interface ADOReleaseArtifact {
  alias: string;
  type: string; // "Build", "Git", etc.
  definitionReference: Record<string, { id: string; name: string }>;
}

export interface ADOBuildRun {
  id: number;
  buildNumber: string;
  status: string;         // "completed", "inProgress", etc.
  result: string;         // "succeeded", "failed", "canceled", etc.
  queueTime: string;
  startTime: string;
  finishTime: string;
  definition: { id: number; name: string };
  sourceBranch: string;
  requestedFor: { displayName: string };
}

export interface ADOTaskDefinition {
  id: string;
  name: string;
  friendlyName: string;
  description: string;
  category: string;
  version: { major: number; minor: number; patch: number };
  inputs: { name: string; type: string; label: string; defaultValue?: string; required?: boolean }[];
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

function authHeader(sessionId?: string): { Authorization: string } {
  const token = getADOPAT(sessionId);
  return { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}` };
}

async function adoGet<T>(url: string, sessionId?: string): Promise<T> {
  const response = await fetch(url, { headers: authHeader(sessionId) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ADO API error ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

async function adoGetOrNull<T>(url: string, sessionId?: string): Promise<T | null> {
  const response = await fetch(url, { headers: authHeader(sessionId) });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ADO API error ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

/** Paginated helper that collects all `value` items */
async function adoGetAll<T>(baseUrl: string, sessionId?: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = baseUrl;
  while (url) {
    const data: any = await adoGet(url, sessionId);
    items.push(...(data.value ?? []));
    url = data.continuationToken
      ? `${baseUrl}&continuationToken=${data.continuationToken}`
      : null;
  }
  return items;
}

// ─── Build Pipelines ─────────────────────────────────────────────────────────

/** List all build pipeline definitions in a project */
export async function listBuildDefinitions(
  org: string,
  project: string,
  sessionId?: string
): Promise<ADOBuildDefinition[]> {
  return adoGetAll<ADOBuildDefinition>(
    `https://dev.azure.com/${org}/${project}/_apis/build/definitions?api-version=7.0&includeLatestBuilds=true`,
    sessionId
  );
}

/** Get detailed build definition including process, triggers, variables */
export async function getBuildDefinition(
  org: string,
  project: string,
  definitionId: number,
  sessionId?: string
): Promise<ADOBuildDefinitionDetail> {
  const def = await adoGet<ADOBuildDefinitionDetail>(
    `https://dev.azure.com/${org}/${project}/_apis/build/definitions/${definitionId}?api-version=7.0`,
    sessionId
  );

  // For YAML pipelines, fetch the actual YAML content from the repo
  if (def.process?.type === 2 && def.process.yamlFilename && def.repository) {
    try {
      def.yamlContent = await getFileContent(
        org, project, def.repository.id, def.process.yamlFilename, def.repository.defaultBranch, sessionId
      );
    } catch {
      // Could not fetch YAML — will be noted in conversion
    }
  }

  // For classic (designer) pipelines, extract phases & steps
  if (def.process?.type === 1) {
    const processAny = def.process as any;
    def.processPhases = processAny.phases ?? [];
    def.processSteps = (processAny.phases ?? []).flatMap((p: any) => p.steps ?? []);
  }

  return def;
}

/** Get recent build runs for a definition (for forecasting) */
export async function getBuildRuns(
  org: string,
  project: string,
  definitionId: number,
  top = 100,
  minTime?: string,
  sessionId?: string
): Promise<ADOBuildRun[]> {
  let url = `https://dev.azure.com/${org}/${project}/_apis/build/builds?definitions=${definitionId}&$top=${top}&api-version=7.0`;
  if (minTime) url += `&minTime=${minTime}`;
  const data = await adoGet<{ value: ADOBuildRun[] }>(url, sessionId);
  return data.value;
}

// ─── Release Pipelines ───────────────────────────────────────────────────────

/** List all release definitions in a project */
export async function listReleaseDefinitions(
  org: string,
  project: string,
  sessionId?: string
): Promise<ADOReleaseDefinition[]> {
  // Release API uses vsrm subdomain
  return adoGetAll<ADOReleaseDefinition>(
    `https://vsrm.dev.azure.com/${org}/${project}/_apis/release/definitions?api-version=7.0&$expand=environments,artifacts`,
    sessionId
  );
}

/** Get detailed release definition */
export async function getReleaseDefinition(
  org: string,
  project: string,
  definitionId: number,
  sessionId?: string
): Promise<ADOReleaseDefinition> {
  return adoGet<ADOReleaseDefinition>(
    `https://vsrm.dev.azure.com/${org}/${project}/_apis/release/definitions/${definitionId}?api-version=7.0`,
    sessionId
  );
}

/** Get recent release runs for forecasting */
export async function getReleaseRuns(
  org: string,
  project: string,
  definitionId: number,
  top = 100,
  sessionId?: string
): Promise<any[]> {
  const data = await adoGet<{ value: any[] }>(
    `https://vsrm.dev.azure.com/${org}/${project}/_apis/release/releases?definitionId=${definitionId}&$top=${top}&api-version=7.0`,
    sessionId
  );
  return data.value;
}

// ─── File Content ────────────────────────────────────────────────────────────

/** Get a file from an ADO Git repo (used to fetch azure-pipelines.yml etc.) */
export async function getFileContent(
  org: string,
  project: string,
  repoId: string,
  filePath: string,
  branch?: string,
  sessionId?: string
): Promise<string> {
  let url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(filePath)}&api-version=7.0`;
  if (branch) {
    const ref = branch.replace("refs/heads/", "");
    url += `&versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=branch`;
  }

  const response = await fetch(url, { headers: authHeader(sessionId) });
  if (!response.ok) {
    throw new Error(`Failed to fetch file ${filePath}: ${response.status}`);
  }
  return response.text();
}

// ─── Task Definitions ────────────────────────────────────────────────────────

/** Get details about a specific task (used to map ADO tasks → GH Actions) */
export async function getTaskDefinition(
  org: string,
  taskId: string,
  sessionId?: string
): Promise<ADOTaskDefinition | null> {
  return adoGetOrNull<ADOTaskDefinition>(
    `https://dev.azure.com/${org}/_apis/distributedtask/tasks/${taskId}?api-version=7.0`,
    sessionId
  );
}

// ─── Aggregated Pipeline Inventory ───────────────────────────────────────────

export interface PipelineInventory {
  buildPipelines: ADOBuildDefinition[];
  releasePipelines: ADOReleaseDefinition[];
  summary: {
    totalBuild: number;
    totalRelease: number;
    yamlPipelines: number;
    classicPipelines: number;
    total: number;
  };
}

/** Get full pipeline inventory for a project */
export async function getPipelineInventory(
  org: string,
  project: string,
  sessionId?: string
): Promise<PipelineInventory> {
  const [buildPipelines, releasePipelines] = await Promise.all([
    listBuildDefinitions(org, project, sessionId),
    listReleaseDefinitions(org, project, sessionId).catch(() => [] as ADOReleaseDefinition[]),
  ]);

  const yamlPipelines = buildPipelines.filter(p => p.process?.type === 2).length;
  const classicPipelines = buildPipelines.filter(p => p.process?.type === 1).length;

  return {
    buildPipelines,
    releasePipelines,
    summary: {
      totalBuild: buildPipelines.length,
      totalRelease: releasePipelines.length,
      yamlPipelines,
      classicPipelines,
      total: buildPipelines.length + releasePipelines.length,
    },
  };
}

// ─── Forecast Data ───────────────────────────────────────────────────────────

export interface PipelineForecastData {
  pipelineId: number;
  pipelineName: string;
  type: "build" | "release";
  runCount: number;
  totalDurationMinutes: number;
  avgDurationMinutes: number;
  maxConcurrent: number;
}

/** Collect run statistics for all build pipelines in a project */
export async function collectForecastData(
  org: string,
  project: string,
  startDate?: string,
  sessionId?: string
): Promise<PipelineForecastData[]> {
  const defs = await listBuildDefinitions(org, project, sessionId);
  const results: PipelineForecastData[] = [];

  for (const def of defs) {
    const runs = await getBuildRuns(org, project, def.id, 200, startDate, sessionId);
    if (runs.length === 0) continue;

    let totalDurationMs = 0;
    const intervals: { start: number; end: number }[] = [];

    for (const run of runs) {
      if (run.startTime && run.finishTime) {
        const start = new Date(run.startTime).getTime();
        const end = new Date(run.finishTime).getTime();
        totalDurationMs += end - start;
        intervals.push({ start, end });
      }
    }

    // Calculate max concurrency via sweep-line
    let maxConcurrent = 0;
    if (intervals.length > 0) {
      const events: { time: number; delta: number }[] = [];
      for (const iv of intervals) {
        events.push({ time: iv.start, delta: 1 });
        events.push({ time: iv.end, delta: -1 });
      }
      events.sort((a, b) => a.time - b.time || a.delta - b.delta);
      let current = 0;
      for (const e of events) {
        current += e.delta;
        if (current > maxConcurrent) maxConcurrent = current;
      }
    }

    results.push({
      pipelineId: def.id,
      pipelineName: def.name,
      type: "build",
      runCount: runs.length,
      totalDurationMinutes: Math.round(totalDurationMs / 60_000),
      avgDurationMinutes: Math.round(totalDurationMs / runs.length / 60_000),
      maxConcurrent,
    });
  }

  return results;
}
