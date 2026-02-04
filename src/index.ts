#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
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

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "healthy", server: "gei-migration-mcp", version: "1.0.0" });
  });

  // SSE endpoint for MCP connections
  app.get("/sse", async (req, res) => {
    console.log("New SSE connection");
    
    const server = createServer();
    const transport = new SSEServerTransport("/message", res);
    
    const sessionId = crypto.randomUUID();
    transports.set(sessionId, transport);

    res.on("close", () => {
      console.log(`SSE connection closed: ${sessionId}`);
      transports.delete(sessionId);
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

    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error handling message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.listen(port, () => {
    console.log(`GEI Migration MCP Server running on http://0.0.0.0:${port}`);
    console.log(`  - SSE endpoint: http://0.0.0.0:${port}/sse`);
    console.log(`  - Health check: http://0.0.0.0:${port}/health`);
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
