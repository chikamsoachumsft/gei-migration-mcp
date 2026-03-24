/**
 * AI-powered validation of ADO → GitHub Actions pipeline conversions.
 *
 * Uses MCP sampling (server.createMessage) to ask the host LLM to act as a
 * senior DevOps engineer, review the source vs. converted YAML, identify
 * functional issues, suggest fixes, and separate auto-fixable items from
 * human-only steps.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  description: string;
  /** Optional location reference (e.g. "jobs.build.steps[3]") */
  location?: string;
}

export interface SuggestedFix {
  issue: string;
  /** The corrected YAML snippet (full workflow) when an auto-fix is possible */
  fixedYaml?: string;
  explanation: string;
}

export interface ValidationResult {
  isCorrect: boolean;
  issues: ValidationIssue[];
  suggestedFixes: SuggestedFix[];
  /** Steps that only a human can complete (e.g. create secrets, configure environments) */
  humanOnlySteps: string[];
  reviewSummary: string;
  /** Number of review iterations performed */
  iterations: number;
}

// ─── Module state ────────────────────────────────────────────────────────────

let _server: Server | null = null;

/** Call once at startup to give the reviewer access to MCP sampling. */
export function setServer(server: Server): void {
  _server = server;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 3;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are a senior DevOps engineer reviewing an automated conversion from an Azure DevOps (ADO) pipeline to a GitHub Actions workflow.

Your job:
1. Compare the SOURCE ADO pipeline definition against the CONVERTED GitHub Actions workflow YAML.
2. Identify any functional correctness issues — missing steps, wrong task mappings, incorrect trigger configuration, broken variable/secret references, missing environment setup, or logic errors.
3. For each issue, decide whether it can be auto-fixed by providing a corrected full workflow YAML, or whether it requires human intervention (e.g. creating secrets, configuring environments, updating external integrations).
4. Produce a concise review summary.

Respond with ONLY a JSON object (no markdown fences, no extra text) matching this schema:
{
  "isCorrect": boolean,
  "issues": [
    { "severity": "error"|"warning"|"info", "description": "...", "location": "..." }
  ],
  "suggestedFixes": [
    { "issue": "...", "fixedYaml": "<full corrected workflow YAML or null if human-only>", "explanation": "..." }
  ],
  "humanOnlySteps": ["..."],
  "reviewSummary": "..."
}

Rules:
- If the conversion is functionally correct, set isCorrect=true and return empty issues/suggestedFixes arrays.
- When providing fixedYaml, include the ENTIRE corrected workflow (not just a snippet).
- Do NOT suggest cosmetic/stylistic changes — only flag functional problems.
- Do NOT flag unsupported tasks that are already documented in the provided warnings list.
- Keep descriptions concise.`;

// ─── Core implementation ─────────────────────────────────────────────────────

/**
 * Validate a converted workflow against its source ADO pipeline definition.
 * Iterates up to MAX_ITERATIONS times, applying auto-fixes between rounds.
 */
export async function validateConversion(
  sourceAdoYaml: string,
  convertedWorkflowYaml: string,
  existingWarnings: string[],
  existingUnsupported: string[],
  existingManualSteps: string[],
): Promise<ValidationResult> {
  if (!_server) {
    throw new Error("AI reviewer not initialised — call setServer() first");
  }

  let currentYaml = convertedWorkflowYaml;
  let lastResult: ValidationResult | undefined;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const userMessage = buildUserMessage(
      sourceAdoYaml,
      currentYaml,
      existingWarnings,
      existingUnsupported,
      existingManualSteps,
      iteration > 1 ? lastResult : undefined,
    );

    let parsed: ValidationResult;
    try {
      const response = await _server.createMessage(
        {
          messages: [{ role: "user", content: { type: "text", text: userMessage } }],
          systemPrompt: SYSTEM_PROMPT,
          maxTokens: MAX_TOKENS,
          includeContext: "none",
        },
      );

      parsed = parseResponse(response, iteration);
    } catch (err: unknown) {
      // Sampling may not be supported by the client — return a graceful fallback
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isCorrect: false,
        issues: [{ severity: "warning", description: `AI review unavailable: ${msg}` }],
        suggestedFixes: [],
        humanOnlySteps: existingManualSteps,
        reviewSummary: "AI validation was skipped because the MCP client does not support sampling.",
        iterations: 0,
      };
    }

    // If the workflow is correct or there are no auto-fixable issues, stop
    if (parsed.isCorrect || !hasAutoFix(parsed)) {
      return parsed;
    }

    // Apply the first available auto-fix and re-validate
    const fix = parsed.suggestedFixes.find(f => f.fixedYaml);
    if (fix?.fixedYaml) {
      currentYaml = fix.fixedYaml;
      lastResult = parsed;
    } else {
      return parsed;
    }
  }

  // Exhausted iterations — return last result with updated yaml
  return {
    ...lastResult!,
    reviewSummary: `${lastResult!.reviewSummary} (reached max ${MAX_ITERATIONS} review iterations)`,
  };
}

/**
 * Quick access to the (potentially fixed) workflow YAML after validation.
 * Call validateConversion first, then use this with the original + result.
 */
export function getFinalYaml(
  originalYaml: string,
  result: ValidationResult,
): string {
  // Walk through suggestedFixes in order — last fixedYaml wins
  let yaml = originalYaml;
  for (const fix of result.suggestedFixes) {
    if (fix.fixedYaml) {
      yaml = fix.fixedYaml;
    }
  }
  return yaml;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildUserMessage(
  sourceAdoYaml: string,
  convertedYaml: string,
  warnings: string[],
  unsupported: string[],
  manualSteps: string[],
  previousReview?: ValidationResult,
): string {
  let msg = `## Source ADO Pipeline Definition\n\`\`\`yaml\n${sourceAdoYaml}\n\`\`\`\n\n`;
  msg += `## Converted GitHub Actions Workflow\n\`\`\`yaml\n${convertedYaml}\n\`\`\`\n\n`;

  if (warnings.length > 0) {
    msg += `## Known Warnings (already documented)\n${warnings.map(w => `- ${w}`).join("\n")}\n\n`;
  }
  if (unsupported.length > 0) {
    msg += `## Known Unsupported Items (already documented)\n${unsupported.map(u => `- ${u}`).join("\n")}\n\n`;
  }
  if (manualSteps.length > 0) {
    msg += `## Known Manual Steps (already documented)\n${manualSteps.map(s => `- ${s}`).join("\n")}\n\n`;
  }

  if (previousReview) {
    msg += `## Previous Review (iteration ${previousReview.iterations})\n`;
    msg += `An auto-fix was applied. Please re-review the updated workflow above and check whether the fix resolved the issue and whether any new issues were introduced.\n`;
    msg += `Previous issues: ${JSON.stringify(previousReview.issues)}\n\n`;
  }

  return msg;
}

function parseResponse(response: CreateMessageResult, iteration: number): ValidationResult {
  if (response.content.type !== "text") {
    return {
      isCorrect: false,
      issues: [{ severity: "warning", description: "AI reviewer returned non-text content" }],
      suggestedFixes: [],
      humanOnlySteps: [],
      reviewSummary: "Unable to parse AI review response.",
      iterations: iteration,
    };
  }

  let text = response.content.text.trim();

  // Strip markdown fences if the model wrapped its response
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  try {
    const parsed = JSON.parse(text);
    return {
      isCorrect: Boolean(parsed.isCorrect),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestedFixes: Array.isArray(parsed.suggestedFixes) ? parsed.suggestedFixes : [],
      humanOnlySteps: Array.isArray(parsed.humanOnlySteps) ? parsed.humanOnlySteps : [],
      reviewSummary: typeof parsed.reviewSummary === "string" ? parsed.reviewSummary : "",
      iterations: iteration,
    };
  } catch {
    return {
      isCorrect: false,
      issues: [{ severity: "warning", description: "Failed to parse AI review response as JSON" }],
      suggestedFixes: [],
      humanOnlySteps: [],
      reviewSummary: text.slice(0, 500),
      iterations: iteration,
    };
  }
}

function hasAutoFix(result: ValidationResult): boolean {
  return result.suggestedFixes.some(f => !!f.fixedYaml);
}
