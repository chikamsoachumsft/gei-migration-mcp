import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { checkActionsImporterPrereqs, runActionsImporterCommand } from "./docker.js";
import { getGitHubAccessToken, getGitHubTargetPAT, getADOPAT } from "./session.js";
import * as adoPipelines from "./ado-pipelines.js";
import * as converter from "./pipeline-converter.js";
import * as aiReviewer from "./ai-reviewer.js";

// ─── Shared types ────────────────────────────────────────────────────────────

export interface AuditSummary {
  pipelines: {
    total: number;
    supported: number;
    partial: number;
    unsupported: number;
  };
  entries: converter.AuditEntry[];
}

export interface ForecastSummary {
  pipelineCount: number;
  totalRuns: number;
  totalDurationMinutes: number;
  executionTimeHours: number;
  maxConcurrentJobs: number;
  pipelines: adoPipelines.PipelineForecastData[];
}

export interface DryRunResult {
  workflowYaml: string;
  suggestedFilename: string;
  warnings: string[];
  unsupported: string[];
  manualSteps: string[];
  pipelineId: string;
  /** Stringified source ADO pipeline definition (for AI review) */
  sourceDefinition: string;
}

export interface MigrateResult {
  pullRequestUrl: string;
  suggestedFilename: string;
  manualSteps: string[];
  warnings: string[];
  unsupported: string[];
  pipelineId: string;
  /** AI validation report (only present when enableAiReview=true) */
  validationReport?: aiReviewer.ValidationResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NATIVE API IMPLEMENTATION  (no Docker required)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Audit all pipelines in an ADO project using native REST APIs.
 * Fetches every build & release definition, analyses convertibility.
 */
export async function auditAdo(
  adoOrg: string,
  adoProject: string,
  sessionId?: string
): Promise<AuditSummary> {
  const inventory = await adoPipelines.getPipelineInventory(adoOrg, adoProject, sessionId);
  const entries: converter.AuditEntry[] = [];

  // Audit each build pipeline
  for (const def of inventory.buildPipelines) {
    const detail = await adoPipelines.getBuildDefinition(adoOrg, adoProject, def.id, sessionId);
    entries.push(converter.auditBuildPipeline(detail));
  }

  // Audit each release pipeline
  for (const def of inventory.releasePipelines) {
    entries.push(converter.auditReleasePipeline(def));
  }

  const supported = entries.filter(e => e.conversionStatus === "supported").length;
  const partial = entries.filter(e => e.conversionStatus === "partial").length;
  const unsupported = entries.filter(e => e.conversionStatus === "unsupported").length;

  return {
    pipelines: { total: entries.length, supported, partial, unsupported },
    entries,
  };
}

/**
 * Forecast GitHub Actions runner usage from ADO pipeline history.
 */
export async function forecastAdo(
  adoOrg: string,
  adoProject: string,
  startDate?: string,
  sessionId?: string
): Promise<ForecastSummary> {
  const data = await adoPipelines.collectForecastData(adoOrg, adoProject, startDate, sessionId);

  const totalRuns = data.reduce((s, d) => s + d.runCount, 0);
  const totalDurationMinutes = data.reduce((s, d) => s + d.totalDurationMinutes, 0);
  const maxConcurrentJobs = Math.max(0, ...data.map(d => d.maxConcurrent));

  return {
    pipelineCount: data.length,
    totalRuns,
    totalDurationMinutes,
    executionTimeHours: Math.round((totalDurationMinutes / 60) * 100) / 100,
    maxConcurrentJobs,
    pipelines: data,
  };
}

/**
 * Dry-run: convert a single ADO pipeline to GitHub Actions YAML (no PR).
 */
export async function dryRunAdo(
  adoOrg: string,
  adoProject: string,
  pipelineId: string,
  pipelineType: "pipeline" | "release" = "pipeline",
  sessionId?: string
): Promise<DryRunResult> {
  const id = parseInt(pipelineId, 10);

  let result: converter.ConversionResult;
  let sourceDef: unknown;
  if (pipelineType === "release") {
    const def = await adoPipelines.getReleaseDefinition(adoOrg, adoProject, id, sessionId);
    sourceDef = def;
    result = converter.convertReleasePipeline(def);
  } else {
    const def = await adoPipelines.getBuildDefinition(adoOrg, adoProject, id, sessionId);
    sourceDef = def;
    result = converter.convertBuildPipeline(def);
  }

  // Use yamlContent if available (YAML pipelines), otherwise JSON-stringify the definition
  const sourceDefinition = (sourceDef as any)?.yamlContent
    || JSON.stringify(sourceDef, null, 2);

  return {
    workflowYaml: result.workflowYaml,
    suggestedFilename: result.suggestedFilename,
    warnings: result.warnings,
    unsupported: result.unsupported,
    manualSteps: result.manualSteps,
    pipelineId,
    sourceDefinition,
  };
}

/**
 * Migrate: convert an ADO pipeline and create a PR in the target GitHub repo.
 * Uses the GitHub REST API to create a branch + commit + PR.
 */
export async function migrateAdoPipeline(
  adoOrg: string,
  adoProject: string,
  pipelineId: string,
  targetRepoUrl: string,
  pipelineType: "pipeline" | "release" = "pipeline",
  sessionId?: string,
  enableAiReview: boolean = false,
): Promise<MigrateResult> {
  // 1. Convert the pipeline
  const dryRun = await dryRunAdo(adoOrg, adoProject, pipelineId, pipelineType, sessionId);

  // 1b. Optional AI review — may update yaml and surface additional manual steps
  let validationReport: aiReviewer.ValidationResult | undefined;
  let finalYaml = dryRun.workflowYaml;
  let finalManualSteps = [...dryRun.manualSteps];

  if (enableAiReview) {
    validationReport = await aiReviewer.validateConversion(
      dryRun.sourceDefinition,
      dryRun.workflowYaml,
      dryRun.warnings,
      dryRun.unsupported,
      dryRun.manualSteps,
    );

    // Apply auto-fixed YAML if available
    finalYaml = aiReviewer.getFinalYaml(dryRun.workflowYaml, validationReport);

    // Merge AI-discovered human-only steps with existing manual steps
    for (const step of validationReport.humanOnlySteps) {
      if (!finalManualSteps.includes(step)) {
        finalManualSteps.push(step);
      }
    }
  }

  // 2. Parse target repo from URL (e.g. https://github.com/org/repo)
  const urlMatch = targetRepoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!urlMatch) {
    throw new Error(`Invalid GitHub repo URL: ${targetRepoUrl}`);
  }
  const [, owner, repo] = urlMatch;
  const ghToken = getGitHubTargetPAT(sessionId);

  // 3. Get the default branch SHA
  const repoInfo = await ghRestGet(`https://api.github.com/repos/${owner}/${repo}`, ghToken);
  const defaultBranch = repoInfo.default_branch || "main";
  const refData = await ghRestGet(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
    ghToken
  );
  const baseSha = refData.object.sha;

  // 4. Create a new branch
  const branchName = `actions-importer/${dryRun.suggestedFilename.replace(".yml", "")}-${Date.now()}`;
  await ghRestPost(
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    ghToken,
    { ref: `refs/heads/${branchName}`, sha: baseSha }
  );

  // 5. Create the workflow file on the new branch
  const filePath = `.github/workflows/${dryRun.suggestedFilename}`;
  const contentB64 = Buffer.from(finalYaml, "utf-8").toString("base64");
  await ghRestPut(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    ghToken,
    {
      message: `chore: add converted workflow from ADO pipeline ${pipelineId}`,
      content: contentB64,
      branch: branchName,
    }
  );

  // 6. Create a pull request
  const manualStepsMd = finalManualSteps.length > 0
    ? "\n\n## Manual Steps\n" + finalManualSteps.map(s => `- [ ] ${s}`).join("\n")
    : "";
  const unsupportedMd = dryRun.unsupported.length > 0
    ? "\n\n## Unsupported Items\n" + dryRun.unsupported.map(s => `- ${s}`).join("\n")
    : "";
  const aiReviewMd = validationReport
    ? `\n\n## AI Review\n${validationReport.reviewSummary}\n\n` +
      (validationReport.issues.length > 0
        ? "### Issues Found\n" + validationReport.issues.map(i => `- **${i.severity}**: ${i.description}${i.location ? ` (${i.location})` : ""}`).join("\n") + "\n"
        : "No issues found.\n") +
      `\n_Reviewed in ${validationReport.iterations} iteration(s)._`
    : "";

  const pr = await ghRestPost(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    ghToken,
    {
      title: `Import ADO ${pipelineType} ${pipelineId} as GitHub Actions workflow`,
      body: `Converted from Azure DevOps ${pipelineType} **${pipelineId}** in \`${adoOrg}/${adoProject}\`.${manualStepsMd}${unsupportedMd}${aiReviewMd}`,
      head: branchName,
      base: defaultBranch,
    }
  );

  return {
    pullRequestUrl: pr.html_url || "",
    suggestedFilename: dryRun.suggestedFilename,
    manualSteps: finalManualSteps,
    warnings: dryRun.warnings,
    unsupported: dryRun.unsupported,
    pipelineId,
    validationReport,
  };
}

// ─── GitHub REST helpers (for PR creation) ───────────────────────────────────

async function ghRestGet(url: string, token: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }
  return response.json();
}

async function ghRestPost(url: string, token: string, body: object): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text}`);
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
    throw new Error(`GitHub API error ${response.status}: ${text}`);
  }
  return response.json();
}


// ═══════════════════════════════════════════════════════════════════════════════
//  CLI-BASED FALLBACK  (requires Docker + gh-actions-importer)
//  Kept for users who prefer the official CLI or need its full feature set.
// ═══════════════════════════════════════════════════════════════════════════════

export namespace cli {

  function outputDir(label: string): string {
    const dir = path.join(os.tmpdir(), "gei-mcp-actions-importer", label, Date.now().toString());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function ensurePrereqs(): Promise<void> {
    const status = await checkActionsImporterPrereqs();
    if (!status.dockerRunning || !status.actionsImporterInstalled) {
      throw new Error(
        `Actions Importer CLI prerequisites not met:\n${status.details.join("\n")}`
      );
    }
  }

  function buildEnv(
    githubToken: string,
    adoPat?: string,
    adoOrg?: string,
    adoProject?: string,
  ): Record<string, string> {
    const env: Record<string, string> = {
      GITHUB_ACCESS_TOKEN: githubToken,
      GITHUB_INSTANCE_URL: "https://github.com",
      AZURE_DEVOPS_INSTANCE_URL: "https://dev.azure.com",
    };
    if (adoPat) env.AZURE_DEVOPS_ACCESS_TOKEN = adoPat;
    if (adoOrg) env.AZURE_DEVOPS_ORGANIZATION = adoOrg;
    if (adoProject) env.AZURE_DEVOPS_PROJECT = adoProject;
    return env;
  }

  /** CLI-based audit (requires Docker) */
  export async function auditAdo(
    adoOrg: string,
    adoProject?: string,
    sessionId?: string
  ): Promise<{ rawMarkdown: string; outputDir: string }> {
    await ensurePrereqs();

    const ghToken = getGitHubAccessToken(sessionId);
    const adoPat = getADOPAT(sessionId);
    const dir = outputDir("cli-audit-ado");

    const args = ["audit", "azure-devops", "--output-dir", dir];
    if (adoProject) args.push("--azure-devops-project", adoProject);

    const env = buildEnv(ghToken, adoPat, adoOrg, adoProject);
    await runActionsImporterCommand(args, env, 600_000);

    const summaryPath = path.join(dir, "audit_summary.md");
    const rawMarkdown = fs.existsSync(summaryPath)
      ? fs.readFileSync(summaryPath, "utf-8")
      : "Audit completed but no summary file was generated.";

    return { rawMarkdown, outputDir: dir };
  }

  /** CLI-based dry-run (requires Docker) */
  export async function dryRunAdo(
    adoOrg: string,
    adoProject: string,
    pipelineId: string,
    pipelineType: "pipeline" | "release" = "pipeline",
    customTransformersPath?: string,
    sessionId?: string
  ): Promise<{ workflowYaml: string; warnings: string[] }> {
    await ensurePrereqs();

    const ghToken = getGitHubAccessToken(sessionId);
    const adoPat = getADOPAT(sessionId);
    const dir = outputDir("cli-dry-run-ado");

    const args = [
      "dry-run", "azure-devops", pipelineType,
      "--pipeline-id", pipelineId,
      "--output-dir", dir,
    ];
    if (customTransformersPath) args.push("--custom-transformers", customTransformersPath);

    const env = buildEnv(ghToken, adoPat, adoOrg, adoProject);
    const { stdout, stderr } = await runActionsImporterCommand(args, env);

    const workflowDir = path.join(dir, ".github", "workflows");
    let workflowYaml = "";
    if (fs.existsSync(workflowDir)) {
      const files = fs.readdirSync(workflowDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
      if (files.length > 0) workflowYaml = fs.readFileSync(path.join(workflowDir, files[0]), "utf-8");
    }

    const warnings = (stderr + "\n" + stdout)
      .split("\n")
      .filter(line => /warning|manual|unsupported/i.test(line))
      .map(line => line.trim())
      .filter(Boolean);

    return { workflowYaml, warnings };
  }

  /** CLI-based migrate (requires Docker) */
  export async function migrateAdoPipeline(
    adoOrg: string,
    adoProject: string,
    pipelineId: string,
    targetRepoUrl: string,
    pipelineType: "pipeline" | "release" = "pipeline",
    customTransformersPath?: string,
    sessionId?: string
  ): Promise<{ pullRequestUrl: string; manualSteps: string[] }> {
    await ensurePrereqs();

    const ghToken = getGitHubAccessToken(sessionId);
    const adoPat = getADOPAT(sessionId);
    const dir = outputDir("cli-migrate-ado");

    const args = [
      "migrate", "azure-devops", pipelineType,
      "--pipeline-id", pipelineId,
      "--target-url", targetRepoUrl,
      "--output-dir", dir,
    ];
    if (customTransformersPath) args.push("--custom-transformers", customTransformersPath);

    const env = buildEnv(ghToken, adoPat, adoOrg, adoProject);
    const { stdout, stderr } = await runActionsImporterCommand(args, env);

    const prMatch = (stdout + "\n" + stderr).match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    const pullRequestUrl = prMatch?.[0] || "";

    const manualSteps = (stdout + "\n" + stderr)
      .split("\n")
      .filter(line => /manual step|manual task|action required/i.test(line))
      .map(line => line.trim())
      .filter(Boolean);

    return { pullRequestUrl, manualSteps };
  }
}
