/**
 * Pipeline Converter — ADO pipeline definitions → GitHub Actions workflow YAML.
 *
 * This is a native implementation that maps ADO YAML and classic pipeline
 * constructs to their GitHub Actions equivalents.  It does NOT rely on the
 * Docker-based gh-actions-importer CLI.
 */
import YAML from "yaml";
import type {
  ADOBuildDefinitionDetail,
  ADOReleaseDefinition,
  ADOClassicPhase,
  ADOClassicStep,
  ADOReleaseEnvironment,
  ADOReleaseTask,
  ADOTrigger,
} from "./ado-pipelines.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ConversionResult {
  /** The generated GitHub Actions workflow YAML content */
  workflowYaml: string;
  /** Filename suggestion for `.github/workflows/<name>.yml` */
  suggestedFilename: string;
  /** Items that were converted with caveats */
  warnings: string[];
  /** Items that could not be auto-converted */
  unsupported: string[];
  /** Manual steps the user must perform after migration */
  manualSteps: string[];
}

export interface AuditEntry {
  pipelineId: number;
  pipelineName: string;
  type: "yaml" | "classic-build" | "classic-release";
  /** Whether the converter can handle this pipeline */
  conversionStatus: "supported" | "partial" | "unsupported";
  warnings: string[];
  unsupported: string[];
}

export interface AuditReport {
  entries: AuditEntry[];
  summary: {
    total: number;
    supported: number;
    partial: number;
    unsupported: number;
  };
}

// ─── Well-known ADO task → GitHub Action mappings ────────────────────────────

interface ActionMapping {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  /** Function to build `with` from ADO task inputs */
  mapInputs?: (inputs: Record<string, string>) => Record<string, string>;
  warnings?: string[];
}

const TASK_MAP: Record<string, (inputs: Record<string, string>) => ActionMapping> = {
  // ── Build / Compile ────────────────────────────────────────────────────────
  "e213ff0f-5d5c-4791-802d-52ea3e7be1f1": (inputs) => ({
    // DotNetCoreCLI
    run: buildDotnetCommand(inputs),
  }),
  "5541a522-603c-47ad-91fc-a4b1d163081b": (inputs) => ({
    // Npm
    run: `npm ${inputs.command || "install"}`,
  }),
  "fe47e961-9fa8-4106-8571-5f1dbbf790c7": (inputs) => ({
    // NuGetCommand
    run: `nuget ${inputs.command || "restore"} ${inputs.restoreSolution || ""}`.trim(),
  }),
  "71a9a2d3-a98a-4caa-96ab-affca411ecda": () => ({
    // CmdLine
    run: "# Inline script — review and adapt",
  }),

  // ── Node / JS ──────────────────────────────────────────────────────────────
  "31c75bbb-bcdf-4706-8d7c-4da6106f6514": (inputs) => ({
    // NodeTool
    uses: "actions/setup-node@v4",
    with: { "node-version": inputs.versionSpec || "18" },
  }),

  // ── .NET SDK ───────────────────────────────────────────────────────────────
  "b0ce7256-7898-45d3-9cb5-176b752bfea6": (inputs) => ({
    // UseDotNet
    uses: "actions/setup-dotnet@v4",
    with: { "dotnet-version": inputs.version || inputs.packageType || "8.0.x" },
  }),

  // ── Java ───────────────────────────────────────────────────────────────────
  "c0e0b74f-0931-47c7-ac27-7c5a19456a36": (inputs) => ({
    // JavaToolInstaller
    uses: "actions/setup-java@v4",
    with: {
      "java-version": inputs.versionSpec || "17",
      distribution: "temurin",
    },
  }),

  // ── Maven ──────────────────────────────────────────────────────────────────
  "ac4ee482-65da-4485-a532-7b085873e532": (inputs) => ({
    run: `mvn ${inputs.goals || "package"} ${inputs.options || ""}`.trim(),
  }),

  // ── Gradle ─────────────────────────────────────────────────────────────────
  "8d8eebd8-2b94-4c97-85af-839254cc6da4": (inputs) => ({
    run: `gradle ${inputs.tasks || "build"} ${inputs.options || ""}`.trim(),
  }),

  // ── Python ─────────────────────────────────────────────────────────────────
  "0be7ed1a-0f40-4c93-940f-97bf71b4bd5e": (inputs) => ({
    // UsePythonVersion
    uses: "actions/setup-python@v5",
    with: { "python-version": inputs.versionSpec || "3.x" },
  }),

  // ── Checkout ───────────────────────────────────────────────────────────────
  "a]d8b439-8e7d-41ae-bc89-a08a0f3b13ef": () => ({
    // Not directly a task but if referenced
    uses: "actions/checkout@v4",
  }),

  // ── Docker ─────────────────────────────────────────────────────────────────
  "e28912f1-0114-4464-802a-a3a35437fd16": (inputs) => ({
    // Docker
    uses: "docker/build-push-action@v5",
    with: {
      context: inputs.buildContext || ".",
      push: inputs.pushImage === "true" ? "true" : "false",
      tags: inputs.tags || "",
    },
    warnings: ["Review Docker build-push action inputs; ADO Docker task has different options."],
  }),

  // ── Azure CLI ──────────────────────────────────────────────────────────────
  "46e4be58-730b-4389-8a2f-ea10b3e5e815": (inputs) => ({
    uses: "azure/cli@v2",
    with: {
      inlineScript: inputs.scriptType === "pscore"
        ? inputs.scriptPath || inputs.inlineScript || ""
        : inputs.scriptPath || inputs.inlineScript || "",
    },
    warnings: ["Azure CLI action requires configuring azure/login@v2 first."],
  }),

  // ── Publish build artifacts ────────────────────────────────────────────────
  "2ff763a7-ce83-4e93-9ebe-b0a28520d135": (inputs) => ({
    uses: "actions/upload-artifact@v4",
    with: {
      name: inputs.ArtifactName || inputs.artifactName || "drop",
      path: inputs.PathtoPublish || inputs.pathToPublish || ".",
    },
  }),

  // ── Download build artifacts ───────────────────────────────────────────────
  "a433f589-fce1-4460-9ee6-44a624aeb1fb": (inputs) => ({
    uses: "actions/download-artifact@v4",
    with: {
      name: inputs.artifactName || "drop",
    },
  }),

  // ── Copy files ─────────────────────────────────────────────────────────────
  "5bfb729a-a7c8-4a78-a7c3-8d717bb7c13c": (inputs) => ({
    run: `cp -r ${inputs.SourceFolder || "."} ${inputs.TargetFolder || "./output"}`,
  }),

  // ── PowerShell ─────────────────────────────────────────────────────────────
  "e213ff0f-5d5c-4791-802d-52ea3e7be1f2": (inputs) => ({
    // PowerShell@2
    run: inputs.script || inputs.filePath || "# PowerShell script — review and adapt",
    ...(inputs.pwsh === "true" && { shell: "pwsh" }),
  }),

  // ── Script (Bash) ──────────────────────────────────────────────────────────
  "6c731c3c-3c68-459a-a5c9-bde6e6595b5b": (inputs) => ({
    run: inputs.script || "# Bash script — review and adapt",
    ...(inputs.workingDirectory && { "working-directory": inputs.workingDirectory }),
  }),

  // ── Azure Web App Deploy ───────────────────────────────────────────────────
  "497d490f-eea7-4f2b-ab94-48d9c1acdcb1": (inputs) => ({
    uses: "azure/webapps-deploy@v3",
    with: {
      "app-name": inputs.WebAppName || inputs.appName || "",
      package: inputs.Package || inputs.package || ".",
    },
    warnings: ["Azure Web App Deploy requires azure/login@v2 setup step."],
  }),

  // ── Azure App Service Settings ─────────────────────────────────────────────
  "39f35f5c-45ef-4f39-8b0c-1402d16cd8c9": (inputs) => ({
    uses: "azure/appservice-settings@v1",
    with: {
      "app-name": inputs.appName || "",
    },
    warnings: ["Review and migrate Azure App Service settings manually."],
  }),
};

// helper for DotNetCoreCLI
function buildDotnetCommand(inputs: Record<string, string>): string {
  const cmd = inputs.command || "build";
  const projects = inputs.projects || "";
  const args = inputs.arguments || "";
  return `dotnet ${cmd} ${projects} ${args}`.trim();
}

// ─── Pool / runs-on mapping ──────────────────────────────────────────────────

function mapPool(pool: any): string {
  if (!pool) return "ubuntu-latest";
  const vmImage = pool.vmImage || pool.name || "";
  const lower = vmImage.toLowerCase();
  if (lower.includes("ubuntu")) return "ubuntu-latest";
  if (lower.includes("windows")) return "windows-latest";
  if (lower.includes("macos") || lower.includes("mac")) return "macos-latest";
  if (lower.includes("hosted")) return "ubuntu-latest";
  // Self-hosted pools: return a label
  return `self-hosted  # was: ${vmImage}`;
}

// ─── Trigger mapping ────────────────────────────────────────────────────────

function mapTriggers(triggers: ADOTrigger[] | undefined): Record<string, any> {
  const on: Record<string, any> = {};

  if (!triggers || triggers.length === 0) {
    on.push = { branches: ["main"] };
    return on;
  }

  for (const t of triggers) {
    switch (t.triggerType) {
      case "continuousIntegration": {
        const pushConf: any = {};
        if (t.branchFilters?.length) {
          pushConf.branches = t.branchFilters
            .filter(b => b.startsWith("+"))
            .map(b => b.slice(1).replace("refs/heads/", ""));
        }
        if (t.pathFilters?.length) {
          pushConf.paths = t.pathFilters
            .filter(p => p.startsWith("+"))
            .map(p => p.slice(1));
        }
        on.push = pushConf;
        break;
      }
      case "pullRequest": {
        const prConf: any = {};
        if (t.branchFilters?.length) {
          prConf.branches = t.branchFilters
            .filter(b => b.startsWith("+"))
            .map(b => b.slice(1).replace("refs/heads/", ""));
        }
        on.pull_request = prConf;
        break;
      }
      case "schedule": {
        // Schedule triggers need manual review
        on.schedule = [{ cron: "0 0 * * *" }];
        break;
      }
    }
  }

  if (Object.keys(on).length === 0) {
    on.workflow_dispatch = {};
  }
  return on;
}

// ─── Condition mapping ───────────────────────────────────────────────────────

function mapCondition(adoCondition: string): string | undefined {
  if (!adoCondition || adoCondition === "succeeded()") return undefined;
  // Map common ADO conditions
  return adoCondition
    .replace(/succeeded\(\)/g, "success()")
    .replace(/failed\(\)/g, "failure()")
    .replace(/always\(\)/g, "always()")
    .replace(/canceled\(\)/g, "cancelled()")
    .replace(/eq\(variables\['(.+?)'\],\s*'(.+?)'\)/g, "env.$1 == '$2'")
    .replace(/ne\(variables\['(.+?)'\],\s*'(.+?)'\)/g, "env.$1 != '$2'");
}

// ─── Variable mapping ────────────────────────────────────────────────────────

function mapVariables(
  vars: Record<string, { value: string; isSecret?: boolean }> | undefined
): { env: Record<string, string>; secrets: string[] } {
  const env: Record<string, string> = {};
  const secrets: string[] = [];

  if (!vars) return { env, secrets };

  for (const [key, val] of Object.entries(vars)) {
    if (val.isSecret) {
      secrets.push(key);
      env[key] = `\${{ secrets.${key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")} }}`;
    } else {
      env[key] = val.value;
    }
  }
  return { env, secrets };
}

// ─── Step conversion ─────────────────────────────────────────────────────────

interface GHStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  if?: string;
  shell?: string;
  "working-directory"?: string;
}

function convertStep(
  step: ADOClassicStep | ADOReleaseTask,
  warnings: string[],
  unsupported: string[]
): GHStep | null {
  if ("enabled" in step && !step.enabled) return null;

  const taskId = "task" in step ? step.task.id : step.taskId;
  const inputs = step.inputs || {};
  const displayName = "displayName" in step ? step.displayName : step.name;

  // Check for inline script tasks (CmdLine, Bash, PowerShell)
  const isCmdLine = taskId === "d9bafed4-0b18-4f58-968d-86655b4d2ce9";
  const isBash = taskId === "6c731c3c-3c68-459a-a5c9-bde6e6595b5b";
  const isPowerShell = taskId === "e213ff0f-5d5c-4791-802d-52ea3e7be1f1" && inputs.script;

  if (isCmdLine || isBash || isPowerShell) {
    const ghStep: GHStep = {
      name: displayName,
      run: inputs.script || inputs.inlineScript || "# script — review and adapt",
    };
    if (isBash) ghStep.shell = "bash";
    if (isPowerShell && inputs.targetType === "inline") ghStep.shell = "pwsh";
    if (inputs.workingDirectory) ghStep["working-directory"] = inputs.workingDirectory;
    if (step.environment && Object.keys(step.environment).length > 0) ghStep.env = step.environment;
    const cond = mapCondition(step.condition);
    if (cond) ghStep.if = cond;
    return ghStep;
  }

  // Look up the task in our mapping table
  const mapper = TASK_MAP[taskId];
  if (mapper) {
    const mapping = mapper(inputs);
    const ghStep: GHStep = { name: displayName };
    if (mapping.uses) ghStep.uses = mapping.uses;
    if (mapping.run) ghStep.run = mapping.run;
    if (mapping.with) ghStep.with = mapping.with;
    if ((mapping as any).shell) ghStep.shell = (mapping as any).shell;
    if ((mapping as any)["working-directory"]) ghStep["working-directory"] = (mapping as any)["working-directory"];
    if (step.environment && Object.keys(step.environment).length > 0) ghStep.env = step.environment;
    const cond = mapCondition(step.condition);
    if (cond) ghStep.if = cond;
    if (mapping.warnings) warnings.push(...mapping.warnings);
    return ghStep;
  }

  // Unknown task — add as comment with original info
  unsupported.push(`Task '${displayName}' (taskId: ${taskId}) has no known mapping.`);
  return {
    name: `${displayName} (UNSUPPORTED — manual conversion required)`,
    run: `echo "TODO: Convert ADO task ${taskId} (${displayName})"`,
    env: step.environment && Object.keys(step.environment).length > 0 ? step.environment : undefined,
  };
}

// ─── YAML serialisation (intentionally simple, no deps) ──────────────────────

function indent(s: string, level: number): string {
  const prefix = "  ".repeat(level);
  return s.split("\n").map(l => (l.trim() ? prefix + l : "")).join("\n");
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (/[\n:{}\[\]#&*!|>',"]/.test(s) || s.startsWith("${{")) {
    // Needs quoting
    if (s.includes("\n")) return `|\n${indent(s, 1)}`;
    return JSON.stringify(s);
  }
  return s;
}

function renderSteps(steps: (GHStep | null)[], lvl: number): string {
  const lines: string[] = [];
  for (const step of steps) {
    if (!step) continue;
    const pfx = "  ".repeat(lvl);
    lines.push(`${pfx}- name: ${yamlValue(step.name || "Step")}`);
    if (step.if) lines.push(`${pfx}  if: ${yamlValue(step.if)}`);
    if (step.uses) lines.push(`${pfx}  uses: ${step.uses}`);
    if (step.run) {
      if (step.run.includes("\n")) {
        lines.push(`${pfx}  run: |`);
        for (const rl of step.run.split("\n")) {
          lines.push(`${pfx}    ${rl}`);
        }
      } else {
        lines.push(`${pfx}  run: ${yamlValue(step.run)}`);
      }
    }
    if (step.shell) lines.push(`${pfx}  shell: ${step.shell}`);
    if (step["working-directory"]) lines.push(`${pfx}  working-directory: ${yamlValue(step["working-directory"])}`);
    if (step.with && Object.keys(step.with).length > 0) {
      lines.push(`${pfx}  with:`);
      for (const [k, v] of Object.entries(step.with)) {
        lines.push(`${pfx}    ${k}: ${yamlValue(v)}`);
      }
    }
    if (step.env && Object.keys(step.env).length > 0) {
      lines.push(`${pfx}  env:`);
      for (const [k, v] of Object.entries(step.env)) {
        lines.push(`${pfx}    ${k}: ${yamlValue(v)}`);
      }
    }
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADO YAML PIPELINE → GITHUB ACTIONS CONVERTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Well-known ADO YAML task name → GitHub Actions mapping.
 * Keys are lowercase task names WITHOUT the version suffix.
 */
const ADO_YAML_TASK_MAP: Record<string, (inputs: Record<string, string>, version?: number) => {
  uses?: string; run?: string; with?: Record<string, string>; shell?: string;
  "working-directory"?: string; warnings?: string[];
}> = {
  dotnetcorecli: (inputs) => ({ run: buildDotnetCommand(inputs) }),
  npm: (inputs) => ({ run: `npm ${inputs.command || "install"}` }),
  nugetcommand: (inputs) => ({
    run: `nuget ${inputs.command || "restore"} ${inputs.restoreSolution || ""}`.trim(),
  }),
  nodetool: (inputs) => ({
    uses: "actions/setup-node@v4",
    with: { "node-version": inputs.versionSpec || "18" },
  }),
  usedotnet: (inputs) => ({
    uses: "actions/setup-dotnet@v4",
    with: { "dotnet-version": inputs.version || inputs.packageType || "8.0.x" },
  }),
  javatoolinstaller: (inputs) => ({
    uses: "actions/setup-java@v4",
    with: { "java-version": inputs.versionSpec || "17", distribution: "temurin" },
  }),
  maven: (inputs) => ({
    run: `mvn ${inputs.goals || "package"} ${inputs.options || ""}`.trim(),
  }),
  gradle: (inputs) => ({
    run: `gradle ${inputs.tasks || "build"} ${inputs.options || ""}`.trim(),
  }),
  usepythonversion: (inputs) => ({
    uses: "actions/setup-python@v5",
    with: { "python-version": inputs.versionSpec || "3.x" },
  }),
  docker: (inputs) => ({
    uses: "docker/build-push-action@v5",
    with: {
      context: inputs.buildContext || ".",
      push: inputs.pushImage === "true" ? "true" : "false",
      tags: inputs.tags || "",
    },
    warnings: ["Review Docker build-push action inputs."],
  }),
  azurecliv2: (inputs) => ({
    uses: "azure/cli@v2",
    with: { inlineScript: inputs.scriptPath || inputs.inlineScript || "" },
    warnings: ["Azure CLI action requires configuring azure/login@v2 first."],
  }),
  azurecli: (inputs) => ({
    uses: "azure/cli@v2",
    with: { inlineScript: inputs.scriptPath || inputs.inlineScript || "" },
    warnings: ["Azure CLI action requires configuring azure/login@v2 first."],
  }),
  publishbuildartifacts: (inputs) => ({
    uses: "actions/upload-artifact@v4",
    with: {
      name: inputs.ArtifactName || inputs.artifactName || "drop",
      path: inputs.PathtoPublish || inputs.pathToPublish || ".",
    },
  }),
  downloadbuildartifacts: (inputs) => ({
    uses: "actions/download-artifact@v4",
    with: { name: inputs.artifactName || "drop" },
  }),
  copyfiles: (inputs) => {
    const src = inputs.SourceFolder || ".";
    const contents = inputs.Contents || "**";
    const dest = inputs.TargetFolder || "./output";
    return {
      run: `mkdir -p "${dest}"\ncp -r ${src}/${contents} "${dest}/"`,
      warnings: ["Review CopyFiles conversion — glob patterns may need adjustment."],
    };
  },
  powershell: (inputs) => ({
    run: inputs.script || inputs.filePath || "# PowerShell script — review and adapt",
    shell: inputs.pwsh === "true" || inputs.targetType === "inline" ? "pwsh" : "powershell",
  }),
  bash: (inputs) => ({
    run: inputs.script || "# Bash script — review and adapt",
    shell: "bash",
    ...(inputs.workingDirectory ? { "working-directory": inputs.workingDirectory } : {}),
  }),
  cmdline: (inputs) => ({
    run: inputs.script || inputs.inlineScript || "# Script — review and adapt",
  }),
  azurewebapp: (inputs) => ({
    uses: "azure/webapps-deploy@v3",
    with: {
      "app-name": inputs.appName || "",
      package: inputs.package || ".",
    },
    warnings: ["Azure Web App Deploy requires azure/login@v2 setup step."],
  }),
  azurermwebappdeployment: (inputs) => ({
    uses: "azure/webapps-deploy@v3",
    with: {
      "app-name": inputs.WebAppName || inputs.appName || "",
      package: inputs.Package || inputs.package || ".",
    },
    warnings: ["Azure Web App Deploy requires azure/login@v2 setup step."],
  }),
  azureresourcegroupdeployment: (inputs) => ({
    uses: "azure/arm-deploy@v2",
    with: {
      resourceGroupName: inputs.resourceGroupName || "",
      template: inputs.csmFile || "",
      parameters: inputs.csmParametersFile || "",
    },
    warnings: [
      "Azure ARM deployment requires azure/login@v2 setup step.",
      inputs.overrideParameters ? `Review override parameters: ${inputs.overrideParameters}` : "",
    ].filter(Boolean),
  }),
  azureresourcemanagertemplatedeployment: (inputs) => ({
    uses: "azure/arm-deploy@v2",
    with: {
      resourceGroupName: inputs.resourceGroupName || "",
      template: inputs.csmFile || "",
      parameters: inputs.csmParametersFile || "",
    },
    warnings: ["Azure ARM deployment requires azure/login@v2 setup step."],
  }),
  azureappservicesettings: (inputs) => ({
    uses: "azure/appservice-settings@v1",
    with: { "app-name": inputs.appName || "" },
    warnings: ["Review and migrate Azure App Service settings manually."],
  }),
  // ── ADO Advanced Security → GitHub native equivalents ──────────────────────
  "advancedsecurity-codeql-init": (inputs) => ({
    uses: "github/codeql-action/init@v3",
    with: { languages: inputs.languages || "csharp" },
  }),
  "advancedsecurity-codeql-analyze": () => ({
    uses: "github/codeql-action/analyze@v3",
  }),
  "advancedsecurity-publish": () => ({
    run: "echo 'CodeQL results are automatically published in GitHub Advanced Security'",
    warnings: ["ADO AdvancedSecurity-Publish is not needed — results auto-publish in GitHub."],
  }),
  "advancedsecurity-dependency-scanning": () => ({
    uses: "actions/dependency-review-action@v4",
    warnings: ["ADO Dependency Scanning replaced with dependency-review-action. Only runs on PRs by default."],
  }),
};

/**
 * Normalize an ADO task reference like "DotNetCoreCLI@2" or
 * "ms.advancedsecurity-tasks.codeql.init.AdvancedSecurity-Codeql-Init@1"
 * into a lookup key for ADO_YAML_TASK_MAP.
 */
function normalizeTaskName(taskRef: string): { key: string; version: number } {
  const atIdx = taskRef.lastIndexOf("@");
  const name = atIdx > 0 ? taskRef.slice(0, atIdx) : taskRef;
  const version = atIdx > 0 ? parseInt(taskRef.slice(atIdx + 1), 10) || 0 : 0;

  // For marketplace tasks like "ms.advancedsecurity-tasks.codeql.init.AdvancedSecurity-Codeql-Init"
  // extract the last segment after the last dot
  const segments = name.split(".");
  const lastSegment = segments[segments.length - 1];
  const key = lastSegment.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return { key, version };
}

/** Convert ADO variable references $(varName) to GH ${{ env.varName }} or ${{ secrets.X }}. */
function convertAdoVariableRefs(value: string, secretNames?: Set<string>): string {
  if (typeof value !== "string") return String(value ?? "");

  const predefinedMap: Record<string, string> = {
    "Build.SourceBranch": "github.ref",
    "Build.SourceBranchName": "github.ref_name",
    "Build.Repository.Name": "github.repository",
    "Build.BuildId": "github.run_id",
    "Build.BuildNumber": "github.run_number",
    "Build.SourceVersion": "github.sha",
    "Build.Reason": "github.event_name",
    "System.PullRequest.PullRequestId": "github.event.pull_request.number",
    "System.TeamProject": "github.repository",
    "Agent.BuildDirectory": "github.workspace",
    "Build.ArtifactStagingDirectory": "github.workspace/artifacts",
    "Build.SourcesDirectory": "github.workspace",
    "build.artifactstagingdirectory": "github.workspace/artifacts",
  };

  let result = value;
  for (const [adoVar, ghVar] of Object.entries(predefinedMap)) {
    const re = new RegExp(`\\$\\(${adoVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, "gi");
    result = result.replace(re, `\${{ ${ghVar} }}`);
  }
  // Remaining $(VarName) → ${{ secrets.X }} if known secret, else ${{ env.VarName }}
  result = result.replace(/\$\(([^)]+)\)/g, (_m, v) => {
    if (secretNames?.has(v)) {
      return `\${{ secrets.${v.toUpperCase().replace(/[^A-Z0-9_]/g, "_")} }}`;
    }
    return `\${{ env.${v} }}`;
  });
  return result;
}

/** Convert an ADO YAML condition to a GH Actions `if:` expression. */
function convertAdoYamlCondition(cond: string): string {
  if (!cond || cond === "succeeded()") return "";
  return cond
    .replace(/succeeded\(\)/g, "success()")
    .replace(/failed\(\)/g, "failure()")
    .replace(/always\(\)/g, "always()")
    .replace(/canceled\(\)/g, "cancelled()")
    .replace(/succeededOrFailed\(\)/g, "always()")
    .replace(/variables\['Build\.Reason'\]/g, "github.event_name")
    .replace(/'PullRequest'/g, "'pull_request'")
    .replace(/variables\['([^']+)'\]/g, "env.$1")
    .replace(/variables\.([a-zA-Z_][a-zA-Z0-9_.]*)/g, "env.$1");
}

/** Convert an ADO pool spec to runs-on. */
function convertPoolSpec(pool: any): string {
  if (!pool) return "ubuntu-latest";
  if (typeof pool === "string") return mapPool({ vmImage: pool });
  if (pool.vmImage) return mapPool(pool);
  if (pool.name) return `self-hosted  # was: ${pool.name}`;
  return "ubuntu-latest";
}

/** Convert a single ADO YAML step to a GH Actions step object. */
function convertAdoYamlStep(
  step: Record<string, any>,
  warnings: string[],
  unsupportedItems: string[]
): Record<string, any> | null {
  // checkout:
  if ("checkout" in step) {
    if (step.checkout === "none") return null;
    if (step.checkout === "self") return { name: "Checkout", uses: "actions/checkout@v4" };
    return { name: `Checkout ${step.checkout}`, uses: "actions/checkout@v4",
      with: { repository: convertAdoVariableRefs(String(step.checkout)) } };
  }

  // download:
  if ("download" in step) {
    if (step.download === "none") return null;
    return {
      name: step.displayName || "Download artifacts",
      uses: "actions/download-artifact@v4",
      ...(step.artifact ? { with: { name: step.artifact } } : {}),
    };
  }

  // Detect step-level secret env vars: when env maps VAR: $(VAR) (self-referencing), treat as secret
  const stepSecrets = new Set<string>();
  if (step.env && typeof step.env === "object") {
    for (const [k, v] of Object.entries(step.env as Record<string, any>)) {
      const strVal = String(v);
      // Self-referencing $(VAR_NAME) means it's pulling from a secret variable
      if (strVal === `$(${k})`) {
        stepSecrets.add(k);
      }
    }
  }

  // Build converted env block for script-type steps
  const buildStepEnv = (): Record<string, string> | undefined => {
    if (!step.env || typeof step.env !== "object") return undefined;
    const converted: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env as Record<string, any>)) {
      if (stepSecrets.has(k)) {
        converted[k] = `\${{ secrets.${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")} }}`;
      } else {
        converted[k] = convertAdoVariableRefs(String(v), stepSecrets);
      }
    }
    return Object.keys(converted).length > 0 ? converted : undefined;
  };

  // script:
  if ("script" in step) {
    const ghStep: Record<string, any> = {
      name: step.displayName || "Run script",
      run: convertAdoVariableRefs(step.script, stepSecrets),
      ...(step.workingDirectory ? { "working-directory": convertAdoVariableRefs(step.workingDirectory, stepSecrets) } : {}),
    };
    const env = buildStepEnv();
    if (env) ghStep.env = env;
    return ghStep;
  }

  // bash:
  if ("bash" in step) {
    const ghStep: Record<string, any> = {
      name: step.displayName || "Run bash",
      run: convertAdoVariableRefs(step.bash, stepSecrets),
      shell: "bash",
    };
    const env = buildStepEnv();
    if (env) ghStep.env = env;
    return ghStep;
  }

  // powershell: / pwsh:
  if ("powershell" in step || "pwsh" in step) {
    const ghStep: Record<string, any> = {
      name: step.displayName || "Run PowerShell",
      run: convertAdoVariableRefs(step.powershell || step.pwsh, stepSecrets),
      shell: step.pwsh ? "pwsh" : "powershell",
    };
    const env = buildStepEnv();
    if (env) ghStep.env = env;
    return ghStep;
  }

  // template:
  if ("template" in step) {
    warnings.push(`Step template "${step.template}" used — convert to composite action or reusable workflow.`);
    return {
      name: step.displayName || `Template: ${step.template}`,
      run: `echo "TODO: Convert ADO step template '${step.template}'"`,
    };
  }

  // task:
  if ("task" in step) {
    const { key, version } = normalizeTaskName(step.task);
    const inputs: Record<string, string> = {};
    if (step.inputs) {
      for (const [k, v] of Object.entries(step.inputs)) {
        inputs[k] = convertAdoVariableRefs(String(v));
      }
    }

    const mapper = ADO_YAML_TASK_MAP[key];
    if (mapper) {
      const mapping = mapper(inputs, version);
      const ghStep: Record<string, any> = {};
      if (step.displayName) ghStep.name = step.displayName;
      if (mapping.uses) ghStep.uses = mapping.uses;
      if (mapping.run) ghStep.run = mapping.run;
      if (mapping.with) ghStep.with = mapping.with;
      if (mapping.shell) ghStep.shell = mapping.shell;
      if (mapping["working-directory"]) ghStep["working-directory"] = mapping["working-directory"];
      if (step.condition) {
        const c = convertAdoYamlCondition(step.condition);
        if (c) ghStep.if = c;
      }
      if (step.env) {
        const converted: Record<string, string> = {};
        for (const [k, v] of Object.entries(step.env as Record<string, any>)) {
          if (stepSecrets.has(k)) {
            converted[k] = `\${{ secrets.${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")} }}`;
          } else {
            converted[k] = convertAdoVariableRefs(String(v), stepSecrets);
          }
        }
        ghStep.env = converted;
      }
      if (mapping.warnings) warnings.push(...mapping.warnings);
      return ghStep;
    }

    // Unknown task
    unsupportedItems.push(`Task '${step.task}' (${step.displayName || "unnamed"}) has no known mapping.`);
    return {
      name: `${step.displayName || step.task} (UNSUPPORTED — manual conversion required)`,
      run: `echo "TODO: Convert ADO task '${step.task}'"`,
      ...(step.condition ? { if: convertAdoYamlCondition(step.condition) } : {}),
    };
  }

  warnings.push(`Unknown step type: ${JSON.stringify(Object.keys(step))}`);
  return { name: "Unknown step — review manually", run: 'echo "TODO: Unknown step type"' };
}

/** Convert ADO YAML variables (object or array) to env + secrets. */
function convertAdoYamlVariables(vars: any): { env: Record<string, string>; secrets: string[] } {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  if (!vars) return { env, secrets };

  if (!Array.isArray(vars) && typeof vars === "object") {
    for (const [k, v] of Object.entries(vars)) {
      env[k] = convertAdoVariableRefs(String(v));
    }
    return { env, secrets };
  }

  if (Array.isArray(vars)) {
    for (const item of vars) {
      if (item.group || item.template) continue;
      if (item.name && item.value !== undefined) {
        if (item.isSecret) {
          secrets.push(item.name);
          env[item.name] = `\${{ secrets.${item.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")} }}`;
        } else {
          env[item.name] = convertAdoVariableRefs(String(item.value));
        }
      }
    }
  }
  return { env, secrets };
}

/** Convert ADO YAML trigger/pr/schedules to GH `on:` block. */
function convertAdoYamlTriggers(parsed: Record<string, any>): Record<string, any> {
  const on: Record<string, any> = {};

  const trigger = parsed.trigger;
  if (trigger === "none") {
    // No CI trigger
  } else if (Array.isArray(trigger)) {
    on.push = { branches: trigger };
  } else if (trigger && typeof trigger === "object") {
    const pushConf: Record<string, any> = {};
    if (trigger.branches?.include) pushConf.branches = trigger.branches.include;
    if (trigger.paths?.include) pushConf.paths = trigger.paths.include;
    on.push = Object.keys(pushConf).length > 0 ? pushConf : null;
  } else if (trigger === undefined) {
    on.push = { branches: ["main"] };
  }

  const pr = parsed.pr;
  if (pr === "none") {
    // No PR trigger
  } else if (Array.isArray(pr)) {
    on.pull_request = { branches: pr };
  } else if (pr && typeof pr === "object") {
    const prConf: Record<string, any> = {};
    if (pr.branches?.include) prConf.branches = pr.branches.include;
    on.pull_request = Object.keys(prConf).length > 0 ? prConf : {};
  }

  if (parsed.schedules && Array.isArray(parsed.schedules)) {
    on.schedule = parsed.schedules.map((s: any) => ({ cron: s.cron || "0 0 * * *" }));
  }

  on.workflow_dispatch = {};
  return on;
}

/**
 * Main ADO YAML → GitHub Actions converter.
 * Parses the raw ADO YAML, walks the structure, and generates a GH Actions workflow.
 */
function convertAdoYamlPipeline(
  yamlContent: string,
  def: ADOBuildDefinitionDetail,
  warnings: string[],
  unsupported: string[],
  manualSteps: string[]
): ConversionResult {
  let parsed: Record<string, any>;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e: any) {
    warnings.push(`Failed to parse ADO YAML: ${e.message}. Returning original content.`);
    return {
      workflowYaml: `# Could not parse ADO YAML: ${def.name} (ID: ${def.id})\n# Error: ${e.message}\n\n${yamlContent}`,
      suggestedFilename: sanitizeFilename(def.name) + ".yml",
      warnings, unsupported, manualSteps,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      workflowYaml: `# Empty ADO YAML pipeline: ${def.name}\nname: ${def.name}\non:\n  workflow_dispatch:\njobs:\n  placeholder:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Empty pipeline"`,
      suggestedFilename: sanitizeFilename(def.name) + ".yml",
      warnings, unsupported, manualSteps,
    };
  }

  // ── Handle `extends:` — flatten template parameters into main body ─────────
  if (parsed.extends) {
    const tmpl = parsed.extends.template;
    warnings.push(
      `Pipeline uses 'extends: template: ${tmpl}'. Parameters have been inlined. Merge logic from '${tmpl}' manually.`
    );
    manualSteps.push(`Review and merge ADO template file '${tmpl}' into the generated workflow.`);
    const params = parsed.extends.parameters || {};
    if (params.stages) parsed.stages = params.stages;
    if (params.jobs) parsed.jobs = params.jobs;
    if (params.steps) parsed.steps = params.steps;
  }

  // ── Triggers ───────────────────────────────────────────────────────────────
  const onBlock = convertAdoYamlTriggers(parsed);

  // ── Variables ──────────────────────────────────────────────────────────────
  const yamlVars = convertAdoYamlVariables(parsed.variables);
  const defVars = mapVariables(def.variables);
  const allEnv = { ...defVars.env, ...yamlVars.env };
  const allSecrets = [...new Set([...defVars.secrets, ...yamlVars.secrets])];
  if (allSecrets.length > 0) manualSteps.push(`Create GitHub secrets for: ${allSecrets.join(", ")}`);

  // Variable groups
  const varGroups: string[] = [];
  if (Array.isArray(parsed.variables)) {
    for (const v of parsed.variables) { if (v.group) varGroups.push(v.group); }
  }
  if (def.variableGroups?.length) {
    for (const g of def.variableGroups) { if (!varGroups.includes(g.name)) varGroups.push(g.name); }
  }
  if (varGroups.length > 0) manualSteps.push(`Migrate ADO variable groups: ${varGroups.join(", ")}`);

  // ── Pool ───────────────────────────────────────────────────────────────────
  const defaultRunsOn = convertPoolSpec(parsed.pool);

  if (parsed.resources?.containers) {
    warnings.push("Pipeline uses resource containers — map to GitHub Actions service containers.");
  }

  // ── Build jobs ─────────────────────────────────────────────────────────────
  const ghJobs: Record<string, any> = {};

  if (parsed.stages) {
    convertStages(parsed.stages, ghJobs, defaultRunsOn, allEnv, warnings, unsupported, manualSteps);
  } else if (parsed.jobs) {
    convertYamlJobs(parsed.jobs, ghJobs, defaultRunsOn, allEnv, warnings, unsupported);
  } else if (parsed.steps) {
    const steps = convertStepsList(parsed.steps, warnings, unsupported);
    ghJobs.build = {
      "runs-on": defaultRunsOn,
      ...(Object.keys(allEnv).length > 0 ? { env: allEnv } : {}),
      steps: [{ uses: "actions/checkout@v4" }, ...steps],
    };
  } else {
    warnings.push("No stages, jobs, or steps found in ADO YAML.");
    ghJobs.build = {
      "runs-on": defaultRunsOn,
      steps: [{ run: 'echo "Empty pipeline — add steps"' }],
    };
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  const workflow: Record<string, any> = { name: def.name, on: onBlock };
  if (Object.keys(allEnv).length > 0 && !parsed.stages && !parsed.jobs) {
    workflow.env = allEnv;
  }
  workflow.jobs = ghJobs;

  const workflowYaml =
    `# Converted from ADO YAML pipeline: ${def.name} (ID: ${def.id})\n` +
    YAML.stringify(workflow, { lineWidth: 120, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });

  return {
    workflowYaml,
    suggestedFilename: sanitizeFilename(def.name) + ".yml",
    warnings, unsupported, manualSteps,
  };
}

/** Convert ADO stages[] to GH jobs (flattened — one job per stage/job). */
function convertStages(
  stages: any[],
  ghJobs: Record<string, any>,
  defaultRunsOn: string,
  globalEnv: Record<string, string>,
  warnings: string[],
  unsupported: string[],
  manualSteps: string[]
): void {
  let prevStageJobIds: string[] = [];

  for (const stage of stages) {
    const stageName = stage.stage || stage.displayName || "stage";
    const stageCondition = stage.condition ? convertAdoYamlCondition(stage.condition) : "";
    const stageRunsOn = stage.pool ? convertPoolSpec(stage.pool) : defaultRunsOn;
    const stageVars = convertAdoYamlVariables(stage.variables);
    const stageEnv = { ...globalEnv, ...stageVars.env };
    const currentStageJobIds: string[] = [];

    const jobs: any[] = stage.jobs || [];
    if (jobs.length === 0) {
      warnings.push(`Stage "${stageName}" has no jobs.`);
      continue;
    }

    for (const job of jobs) {
      const isDeployment = "deployment" in job;
      const jobName = job.job || job.deployment || "job";
      const jobId = sanitizeJobId(`${stageName}_${jobName}`);
      currentStageJobIds.push(jobId);

      const ghJob: Record<string, any> = {
        name: job.displayName || `${stageName} - ${jobName}`,
        "runs-on": job.pool ? convertPoolSpec(job.pool) : stageRunsOn,
      };

      // Dependencies
      const needsList: string[] = [];
      if (stage.dependsOn) {
        const deps = Array.isArray(stage.dependsOn) ? stage.dependsOn : [stage.dependsOn];
        for (const depStage of deps) {
          const depIds = Object.keys(ghJobs).filter(id => id.startsWith(sanitizeJobId(depStage) + "_"));
          needsList.push(...depIds);
        }
      } else if (prevStageJobIds.length > 0) {
        needsList.push(...prevStageJobIds);
      }
      if (job.dependsOn) {
        const jobDeps = Array.isArray(job.dependsOn) ? job.dependsOn : [job.dependsOn];
        for (const dep of jobDeps) {
          const depId = sanitizeJobId(`${stageName}_${dep}`);
          if (!needsList.includes(depId)) needsList.push(depId);
        }
      }
      if (needsList.length > 0) ghJob.needs = needsList;

      // Conditions
      if (stageCondition) ghJob.if = stageCondition;
      if (job.condition) {
        const jc = convertAdoYamlCondition(job.condition);
        if (jc) ghJob.if = ghJob.if ? `${ghJob.if} && ${jc}` : jc;
      }

      // Environment (deployment jobs)
      if (isDeployment) {
        const envSpec = job.environment;
        ghJob.environment = typeof envSpec === "string" ? envSpec : envSpec?.name;
        manualSteps.push(`Configure GitHub Environment protection rules for "${ghJob.environment || jobName}".`);
      }

      if (Object.keys(stageEnv).length > 0) ghJob.env = { ...stageEnv };

      // Steps
      let rawSteps: any[] = [];
      if (isDeployment) {
        rawSteps = job.strategy?.runOnce?.deploy?.steps
          || job.strategy?.rolling?.deploy?.steps
          || job.strategy?.canary?.deploy?.steps
          || [];
      } else {
        rawSteps = job.steps || [];
      }

      const convertedSteps = convertStepsList(rawSteps, warnings, unsupported);
      const hasCheckout = convertedSteps.some((s: any) => s.uses?.startsWith("actions/checkout"));
      if (!hasCheckout && !isDeployment) {
        ghJob.steps = [{ uses: "actions/checkout@v4" }, ...convertedSteps];
      } else {
        ghJob.steps = convertedSteps;
      }

      ghJobs[jobId] = ghJob;
    }

    prevStageJobIds = currentStageJobIds;
  }
}

/** Convert ADO jobs[] (no stages) to GH jobs. */
function convertYamlJobs(
  jobs: any[],
  ghJobs: Record<string, any>,
  defaultRunsOn: string,
  globalEnv: Record<string, string>,
  warnings: string[],
  unsupported: string[]
): void {
  for (const job of jobs) {
    const isDeployment = "deployment" in job;
    const jobName = job.job || job.deployment || "job";
    const jobId = sanitizeJobId(jobName);
    const ghJob: Record<string, any> = {
      name: job.displayName || jobName,
      "runs-on": job.pool ? convertPoolSpec(job.pool) : defaultRunsOn,
    };

    if (job.dependsOn) {
      ghJob.needs = (Array.isArray(job.dependsOn) ? job.dependsOn : [job.dependsOn]).map(sanitizeJobId);
    }
    if (job.condition) {
      const c = convertAdoYamlCondition(job.condition);
      if (c) ghJob.if = c;
    }
    if (isDeployment && job.environment) {
      ghJob.environment = typeof job.environment === "string" ? job.environment : job.environment.name;
    }
    if (Object.keys(globalEnv).length > 0) ghJob.env = { ...globalEnv };

    let rawSteps = job.steps || [];
    if (isDeployment && job.strategy?.runOnce?.deploy?.steps) {
      rawSteps = job.strategy.runOnce.deploy.steps;
    }
    ghJob.steps = convertStepsList(rawSteps, warnings, unsupported);
    ghJobs[jobId] = ghJob;
  }
}

/** Convert array of ADO YAML steps to GH Actions steps. */
function convertStepsList(steps: any[], warnings: string[], unsupported: string[]): Record<string, any>[] {
  if (!steps || !Array.isArray(steps)) return [];
  return steps.map(s => convertAdoYamlStep(s, warnings, unsupported)).filter(Boolean) as Record<string, any>[];
}

// ─── Build pipeline → workflow ───────────────────────────────────────────────

export function convertBuildPipeline(def: ADOBuildDefinitionDetail): ConversionResult {
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const manualSteps: string[] = [];

  // If it's a YAML pipeline and we have the YAML content, we still convert it
  // because the YAML references ADO-specific tasks that need mapping.
  // But for YAML pipelines that are already standard, we preserve them closer.
  const isYaml = def.process?.type === 2;

  if (isYaml && def.yamlContent) {
    return convertAdoYamlPipeline(def.yamlContent, def, warnings, unsupported, manualSteps);
  }

  // Classic (designer) pipeline conversion
  const { env: envVars, secrets } = mapVariables(def.variables);
  if (secrets.length > 0) {
    manualSteps.push(`Create GitHub secrets for: ${secrets.join(", ")}`);
  }
  if (def.variableGroups?.length) {
    manualSteps.push(`Migrate variable groups: ${def.variableGroups.map(g => g.name).join(", ")}`);
  }

  const onTriggers = mapTriggers(def.triggers);
  const phases = def.processPhases ?? [];

  // Build jobs
  const jobLines: string[] = [];
  if (phases.length === 0) {
    // Single-job pipeline from flat steps
    const steps = (def.processSteps ?? []).map(s => convertStep(s, warnings, unsupported));
    jobLines.push("  build:");
    jobLines.push(`    runs-on: ${mapPool((def as any).queue?.pool)}`);
    if (Object.keys(envVars).length > 0) {
      jobLines.push("    env:");
      for (const [k, v] of Object.entries(envVars)) {
        jobLines.push(`      ${k}: ${yamlValue(v)}`);
      }
    }
    jobLines.push("    steps:");
    jobLines.push("      - uses: actions/checkout@v4");
    jobLines.push(renderSteps(steps, 3));
  } else {
    let prevJobId: string | undefined;
    for (const phase of phases) {
      const jobId = sanitizeJobId(phase.name || phase.refName || "job");
      const phaseSteps = (phase.steps ?? []).map(s => convertStep(s, warnings, unsupported));
      const pool = (phase.target as any)?.queue?.pool ?? (def as any).queue?.pool;

      jobLines.push(`  ${jobId}:`);
      if (phase.name) jobLines.push(`    name: ${yamlValue(phase.name)}`);
      jobLines.push(`    runs-on: ${mapPool(pool)}`);
      if (prevJobId) jobLines.push(`    needs: ${prevJobId}`);
      const cond = mapCondition(phase.condition);
      if (cond) jobLines.push(`    if: ${yamlValue(cond)}`);
      if (Object.keys(envVars).length > 0) {
        jobLines.push("    env:");
        for (const [k, v] of Object.entries(envVars)) {
          jobLines.push(`      ${k}: ${yamlValue(v)}`);
        }
      }
      jobLines.push("    steps:");
      jobLines.push("      - uses: actions/checkout@v4");
      jobLines.push(renderSteps(phaseSteps, 3));

      prevJobId = jobId;
    }
  }

  // Render triggers
  const triggerLines: string[] = [];
  for (const [key, val] of Object.entries(onTriggers)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      triggerLines.push(`  ${key}:`);
      for (const [tk, tv] of Object.entries(val as Record<string, any>)) {
        if (Array.isArray(tv)) {
          triggerLines.push(`    ${tk}:`);
          for (const item of tv) {
            if (typeof item === "object") {
              // schedule items
              for (const [sk, sv] of Object.entries(item)) {
                triggerLines.push(`      - ${sk}: ${yamlValue(sv)}`);
              }
            } else {
              triggerLines.push(`      - ${yamlValue(item)}`);
            }
          }
        } else {
          triggerLines.push(`    ${tk}: ${yamlValue(tv)}`);
        }
      }
    } else {
      triggerLines.push(`  ${key}:`);
    }
  }

  const yaml = [
    `# Converted from ADO classic pipeline: ${def.name} (ID: ${def.id})`,
    `name: ${yamlValue(def.name)}`,
    "",
    "on:",
    triggerLines.join("\n"),
    "",
    "jobs:",
    jobLines.join("\n"),
    "",
  ].join("\n");

  return {
    workflowYaml: yaml,
    suggestedFilename: sanitizeFilename(def.name) + ".yml",
    warnings,
    unsupported,
    manualSteps,
  };
}

// ─── Release pipeline → workflow ─────────────────────────────────────────────

export function convertReleasePipeline(def: ADOReleaseDefinition): ConversionResult {
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const manualSteps: string[] = [];

  const { env: envVars, secrets } = mapVariables(def.variables);
  if (secrets.length > 0) {
    manualSteps.push(`Create GitHub secrets for: ${secrets.join(", ")}`);
  }

  // Check for approval gates
  for (const env of def.environments) {
    const preApprovals = env.preDeployApprovals?.approvals ?? [];
    const postApprovals = env.postDeployApprovals?.approvals ?? [];
    if (preApprovals.length > 0 || postApprovals.length > 0) {
      manualSteps.push(
        `Configure GitHub Environment protection rules for "${env.name}" (ADO has approval gates).`
      );
    }
  }

  // Build artifact trigger
  const artifactAliases = def.artifacts
    .filter(a => a.type === "Build")
    .map(a => a.definitionReference?.definition?.name || a.alias);

  if (artifactAliases.length > 0) {
    warnings.push(
      `Release is triggered by build artifacts: ${artifactAliases.join(", ")}. ` +
      `In GitHub Actions, use workflow_run or workflow_call to chain workflows.`
    );
  }

  // Build jobs — one per environment (stage)
  const jobLines: string[] = [];
  let prevJobId: string | undefined;

  for (const env of def.environments) {
    const jobId = sanitizeJobId(env.name);
    jobLines.push(`  ${jobId}:`);
    jobLines.push(`    name: Deploy to ${env.name}`);
    jobLines.push("    runs-on: ubuntu-latest");
    if (prevJobId) jobLines.push(`    needs: ${prevJobId}`);
    jobLines.push(`    environment: ${yamlValue(env.name)}`);

    if (Object.keys(envVars).length > 0) {
      jobLines.push("    env:");
      for (const [k, v] of Object.entries(envVars)) {
        jobLines.push(`      ${k}: ${yamlValue(v)}`);
      }
    }

    // Merge env-level variables
    const { env: envLevelVars, secrets: envSecrets } = mapVariables(env.variables);
    if (envSecrets.length > 0) {
      manualSteps.push(`Create secrets for environment "${env.name}": ${envSecrets.join(", ")}`);
    }
    if (Object.keys(envLevelVars).length > 0) {
      if (!jobLines.some(l => l.includes("    env:"))) jobLines.push("    env:");
      for (const [k, v] of Object.entries(envLevelVars)) {
        jobLines.push(`      ${k}: ${yamlValue(v)}`);
      }
    }

    // Steps from deploy phases
    jobLines.push("    steps:");
    jobLines.push("      - uses: actions/checkout@v4");

    for (const phase of env.deployPhases) {
      for (const task of phase.workflowTasks) {
        const step = convertStep(task, warnings, unsupported);
        if (step) {
          jobLines.push(renderSteps([step], 3));
        }
      }
    }

    prevJobId = jobId;
  }

  const yaml = [
    `# Converted from ADO release pipeline: ${def.name} (ID: ${def.id})`,
    `name: ${yamlValue(def.name)}`,
    "",
    "on:",
    "  workflow_dispatch:",
    artifactAliases.length > 0
      ? `  # TODO: Set up workflow_run trigger for build pipelines: ${artifactAliases.join(", ")}`
      : "",
    "",
    "jobs:",
    jobLines.join("\n"),
    "",
  ].join("\n");

  return {
    workflowYaml: yaml,
    suggestedFilename: sanitizeFilename(def.name) + ".yml",
    warnings,
    unsupported,
    manualSteps,
  };
}

// ─── Audit (analysis only, no conversion) ────────────────────────────────────

export function auditBuildPipeline(def: ADOBuildDefinitionDetail): AuditEntry {
  const isYaml = def.process?.type === 2;
  const warnings: string[] = [];
  const unsupportedItems: string[] = [];

  if (isYaml) {
    if (!def.yamlContent) {
      warnings.push("Could not fetch YAML content from repository.");
    }
    return {
      pipelineId: def.id,
      pipelineName: def.name,
      type: "yaml",
      conversionStatus: "supported",
      warnings,
      unsupported: unsupportedItems,
    };
  }

  // Classic: check steps for known mappings
  const allSteps = def.processSteps ?? [];
  let unmapped = 0;
  for (const step of allSteps) {
    if (!step.enabled) continue;
    const taskId = step.task.id;
    const isCmdLine = taskId === "d9bafed4-0b18-4f58-968d-86655b4d2ce9";
    const isBash = taskId === "6c731c3c-3c68-459a-a5c9-bde6e6595b5b";
    if (!isCmdLine && !isBash && !TASK_MAP[taskId]) {
      unmapped++;
      unsupportedItems.push(`Task "${step.displayName}" (${taskId})`);
    }
  }

  const total = allSteps.filter(s => s.enabled).length;
  const conversionStatus =
    unmapped === 0 ? "supported" :
    unmapped < total ? "partial" :
    "unsupported";

  return {
    pipelineId: def.id,
    pipelineName: def.name,
    type: "classic-build",
    conversionStatus,
    warnings,
    unsupported: unsupportedItems,
  };
}

export function auditReleasePipeline(def: ADOReleaseDefinition): AuditEntry {
  const unsupportedItems: string[] = [];
  const warnings: string[] = [];

  let totalTasks = 0;
  let unmapped = 0;

  for (const env of def.environments) {
    for (const phase of env.deployPhases) {
      for (const task of phase.workflowTasks) {
        if (!task.enabled) continue;
        totalTasks++;
        const isCmdLine = task.taskId === "d9bafed4-0b18-4f58-968d-86655b4d2ce9";
        const isBash = task.taskId === "6c731c3c-3c68-459a-a5c9-bde6e6595b5b";
        if (!isCmdLine && !isBash && !TASK_MAP[task.taskId]) {
          unmapped++;
          unsupportedItems.push(`Task "${task.name}" (${task.taskId})`);
        }
      }
    }
    // Approval gates
    const preApprovals = env.preDeployApprovals?.approvals ?? [];
    if (preApprovals.length > 0) {
      warnings.push(`Environment "${env.name}" has pre-deploy approvals — needs GitHub Environment protection rules.`);
    }
  }

  const conversionStatus =
    unmapped === 0 ? "supported" :
    unmapped < totalTasks ? "partial" :
    "unsupported";

  return {
    pipelineId: def.id,
    pipelineName: def.name,
    type: "classic-release",
    conversionStatus,
    warnings,
    unsupported: unsupportedItems,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sanitizeJobId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&") || "job";
}
