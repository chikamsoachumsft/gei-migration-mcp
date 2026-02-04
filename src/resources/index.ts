import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as state from "../services/state.js";

export function registerResources(server: McpServer): void {
  // Active migrations resource
  server.resource(
    "migrations://active",
    "migrations://active",
    async () => ({
      contents: [{
        uri: "migrations://active",
        mimeType: "application/json",
        text: JSON.stringify(state.getActiveMigrations(), null, 2)
      }]
    })
  );

  // Migration history resource
  server.resource(
    "migrations://history",
    "migrations://history",
    async () => ({
      contents: [{
        uri: "migrations://history",
        mimeType: "application/json",
        text: JSON.stringify(state.getMigrationHistory(), null, 2)
      }]
    })
  );
}
