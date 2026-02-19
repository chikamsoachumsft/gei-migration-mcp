#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { 
  setSessionCredentials, 
  clearSessionCredentials,
  getActiveSessionCount,
  SessionCredentials 
} from "./services/session.js";
import express from "express";
import cors from "cors";

function createServer(): McpServer {
  const server = new McpServer({
    name: "gei-migration-mcp",
    version: "1.0.0",
  });

  // Register all components
  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

// Start stdio transport (for local VS Code / Claude Desktop)
async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GEI Migration MCP Server running on stdio");
}

// Start HTTP+SSE transport (for remote access)
async function startHttp(port: number) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Store active transports for cleanup
  const transports = new Map<string, SSEServerTransport>();
  const sessionServers = new Map<string, McpServer>();

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ 
      status: "healthy", 
      server: "gei-migration-mcp", 
      version: "1.0.0",
      activeSessions: getActiveSessionCount()
    });
  });

  // SSE endpoint for MCP connections
  // Accepts credentials via HTTP headers (preferred) or query parameters (fallback):
  // Headers: X-GitHub-Source-PAT, X-GitHub-Target-PAT, X-ADO-PAT
  // Query: ?gh_source_pat=xxx&gh_pat=xxx&ado_pat=xxx
  app.get("/sse", async (req, res) => {
    // Create transport first — it generates the canonical sessionId
    const server = createServer();
    const transport = new SSEServerTransport("/message", res);
    const sessionId = transport.sessionId; // SDK-generated UUID — unique per connection
    
    console.log(`New SSE connection: ${sessionId}`);
    
    // Extract credentials from headers first (more secure), then fall back to query params
    const credentials: SessionCredentials = {
      githubSourcePat: 
        (req.headers['x-github-source-pat'] as string) || 
        (req.query.gh_source_pat as string) || 
        (req.query.github_token as string),
      githubTargetPat: 
        (req.headers['x-github-target-pat'] as string) || 
        (req.query.gh_pat as string),
      adoPat: 
        (req.headers['x-ado-pat'] as string) || 
        (req.query.ado_pat as string),
    };

    // Check if at least one credential was provided
    const hasCredentials = credentials.githubSourcePat || credentials.githubTargetPat;
    const credentialSource = req.headers['x-github-source-pat'] || req.headers['x-github-target-pat'] 
      ? 'headers' : 'query params';
    
    if (hasCredentials) {
      setSessionCredentials(sessionId, credentials);
      console.log(`Session ${sessionId}: Credentials configured via ${credentialSource}`);
    } else {
      console.log(`Session ${sessionId}: No credentials provided, will use server defaults`);
    }
    
    transports.set(sessionId, transport);
    sessionServers.set(sessionId, server);

    res.on("close", () => {
      console.log(`SSE connection closed: ${sessionId}`);
      transports.delete(sessionId);
      sessionServers.delete(sessionId);
      clearSessionCredentials(sessionId);
    });

    await server.connect(transport);
  });

  // Message endpoint for client-to-server messages
  app.post("/message", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // No need to set session context — the MCP SDK passes extra.sessionId
    // to tool callbacks automatically via transport.sessionId

    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error handling message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Endpoint to check session credentials
  app.get("/session/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    if (transports.has(sessionId)) {
      res.json({ 
        sessionId, 
        active: true,
        hasCredentials: true // Don't expose actual credentials
      });
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  app.listen(port, () => {
    console.log(`GEI Migration MCP Server running on http://0.0.0.0:${port}`);
    console.log(`  - SSE endpoint: http://0.0.0.0:${port}/sse`);
    console.log(`  - Health check: http://0.0.0.0:${port}/health`);
    console.log("");
    console.log("Credentials can be provided via:");
    console.log("  1. HTTP Headers (recommended):");
    console.log("     X-GitHub-Source-PAT, X-GitHub-Target-PAT, X-ADO-PAT");
    console.log("  2. Query Parameters (fallback):");
    console.log(`     ${port}/sse?gh_source_pat=X&gh_pat=Y&ado_pat=Z`);
  });
}

// Main entry point
async function main() {
  const mode = process.env.MCP_TRANSPORT || "stdio";
  const port = parseInt(process.env.PORT || "3000", 10);

  if (mode === "http" || mode === "sse") {
    await startHttp(port);
  } else {
    await startStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
