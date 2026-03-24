import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerStatus {
  dockerRunning: boolean;
  actionsImporterInstalled: boolean;
  details: string[];
}

/** Check if Docker daemon is running */
export async function isDockerRunning(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if the gh-actions-importer extension is installed */
export async function isActionsImporterInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("gh", ["extension", "list"], { timeout: 10_000 });
    return stdout.includes("actions-importer");
  } catch {
    return false;
  }
}

/** Run a combined check of Docker + gh-actions-importer prerequisites */
export async function checkActionsImporterPrereqs(): Promise<DockerStatus> {
  const details: string[] = [];

  const dockerRunning = await isDockerRunning();
  if (!dockerRunning) {
    details.push("Docker is not running. Start Docker Desktop and try again.");
  }

  const actionsImporterInstalled = await isActionsImporterInstalled();
  if (!actionsImporterInstalled) {
    details.push(
      "gh-actions-importer is not installed. Run: gh extension install github/gh-actions-importer"
    );
  }

  return { dockerRunning, actionsImporterInstalled, details };
}

/**
 * Execute a gh actions-importer CLI command.
 * Returns { stdout, stderr } on success, throws on failure.
 */
export async function runActionsImporterCommand(
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 300_000 // 5 minutes default
): Promise<{ stdout: string; stderr: string }> {
  const mergedEnv = { ...process.env, ...env };
  return execFileAsync("gh", ["actions-importer", ...args], {
    env: mergedEnv,
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024, // 50 MB for large audit outputs
  });
}
