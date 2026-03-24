import { getBuildDefinition } from "./dist/services/ado-pipelines.js";
import { convertBuildPipeline } from "./dist/services/pipeline-converter.js";

const def = await getBuildDefinition("canayorachu", "Project2", 1);
const result = convertBuildPipeline(def);

console.log("=== CONVERTED WORKFLOW ===");
console.log(result.workflowYaml);
console.log("\n=== WARNINGS ===");
console.log(JSON.stringify(result.warnings, null, 2));
console.log("\n=== UNSUPPORTED ===");
console.log(JSON.stringify(result.unsupported, null, 2));
console.log("\n=== MANUAL STEPS ===");
console.log(JSON.stringify(result.manualSteps, null, 2));

// Now push it to the repo
const ghToken = process.env.GH_PAT;
const owner = "Dexters-Garage";
const repo = "eshopweb2";
const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

// Get main branch SHA
const repoInfo = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }).then(r => r.json());
const defaultBranch = repoInfo.default_branch || "main";
const refData = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, { headers }).then(r => r.json());
const baseSha = refData.object.sha;

// Create branch
const branchName = `actions-importer/eshoponweb-fixed-${Date.now()}`;
await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
  method: "POST", headers,
  body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
});

// Get existing file SHA (to update it)
const existing = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/eshoponweb.yml?ref=${branchName}`,
  { headers }
).then(r => r.json());

// Update the workflow file
const content = Buffer.from(result.workflowYaml, "utf-8").toString("base64");
const putRes = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/eshoponweb.yml`,
  {
    method: "PUT", headers,
    body: JSON.stringify({
      message: "fix: replace passthrough ADO YAML with properly converted GitHub Actions workflow",
      content,
      sha: existing.sha,
      branch: branchName,
    }),
  }
).then(r => r.json());
console.log("\n=== FILE UPDATE ===");
console.log("Commit:", putRes.commit?.sha || "ERROR", putRes.commit?.message || JSON.stringify(putRes));

// Create PR
const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
  method: "POST", headers,
  body: JSON.stringify({
    title: "fix: Convert ADO pipeline to GitHub Actions workflow (proper conversion)",
    body: `## Pipeline Conversion\n\nThis PR replaces the previously passthrough ADO YAML with a properly converted GitHub Actions workflow.\n\n### Warnings\n${result.warnings.map(w => `- ${w}`).join("\n")}\n\n### Manual Steps\n${result.manualSteps.map(s => `- [ ] ${s}`).join("\n") || "None"}\n\n### Unsupported\n${result.unsupported.map(s => `- ${s}`).join("\n") || "None"}`,
    head: branchName,
    base: defaultBranch,
  }),
}).then(r => r.json());

console.log("\n=== PR CREATED ===");
console.log("PR URL:", prRes.html_url || "ERROR");
console.log("PR #:", prRes.number || JSON.stringify(prRes));
