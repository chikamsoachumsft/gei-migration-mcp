import { convertBuildPipeline } from "./dist/services/pipeline-converter.js";

const yamlContent = `trigger:
- main

pool:
  vmImage: ubuntu-latest

extends:
  template: template.yaml
  parameters:
    stages:
      - stage: Build
        displayName: Build
        jobs:
        - job: Build
          steps:
          - checkout: self
          - task: DotNetCoreCLI@2
            displayName: Restore
            inputs:
              command: restore
              projects: "**/*.csproj"
          - task: ms.advancedsecurity-tasks.codeql.init.AdvancedSecurity-Codeql-Init@1
            condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'))
            displayName: Initialize CodeQL
            inputs:
              languages: csharp
          - task: DotNetCoreCLI@2
            displayName: Build
            inputs:
              projects: "**/*.csproj"
              arguments: "--configuration Release"
          - task: PublishBuildArtifacts@1
            displayName: Publish Artifact
            inputs:
              PathtoPublish: output
      - stage: Test
        dependsOn: Build
        condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'))
        displayName: Test Deployment
        jobs:
        - deployment: DeployWeb
          displayName: Deploy to Test
          environment:
            name: Test
          strategy:
            runOnce:
              deploy:
                steps:
                - download: current
                  artifact: drop
                - task: AzureWebApp@1
                  displayName: Test deployment
                  inputs:
                    appName: myapp-test
                    package: drop/Web.zip
`;

const result = convertBuildPipeline({
  id: 1,
  name: "eShopOnWeb",
  process: { type: 2, yamlFilename: "azure-pipelines.yml" },
  yamlContent,
  triggers: [],
  variables: {},
});

console.log("=== WORKFLOW YAML ===");
console.log(result.workflowYaml);
console.log("\n=== WARNINGS ===");
console.log(result.warnings);
console.log("\n=== UNSUPPORTED ===");
console.log(result.unsupported);
console.log("\n=== MANUAL STEPS ===");
console.log(result.manualSteps);
