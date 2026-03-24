#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { 
  setSessionCredentials, 
  clearSessionCredentials,
  getActiveSessionCount,
  SessionCredentials 
} from "./services/session.js";
import express, { Request, Response } from "express";
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
  // Parse JSON for StreamableHTTP requests (needed for req.body)
  app.use(express.json());

  // Store active transports for cleanup (supports both transport types)
  const transports = new Map<string, SSEServerTransport | StreamableHTTPServerTransport>();
  const sessionServers = new Map<string, McpServer>();

  // Helper to extract credentials from request
  function extractCredentials(req: Request): SessionCredentials {
    return {
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
  }

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ 
      status: "healthy", 
      server: "gei-migration-mcp", 
      version: "1.0.0",
      activeSessions: getActiveSessionCount()
    });
  });

  //=============================================================================
  // STREAMABLE HTTP TRANSPORT (Protocol version 2025-03-26)
  // This is the primary endpoint for VS Code and modern MCP clients
  //=============================================================================
  app.all("/mcp", async (req: Request, res: Response) => {
    console.log(`Received ${req.method} request to /mcp`);
    
    try {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      
      if (sessionId && transports.has(sessionId)) {
        const existingTransport = transports.get(sessionId);
        if (existingTransport instanceof StreamableHTTPServerTransport) {
          transport = existingTransport;
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Session exists but uses a different transport protocol'
            },
            id: null
          });
          return;
        }
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        // New session initialization
        const credentials = extractCredentials(req);
        
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.log(`StreamableHTTP session initialized: ${newSessionId}`);
            transports.set(newSessionId, transport!);
            
            // Store credentials for this session
            if (credentials.githubSourcePat || credentials.githubTargetPat) {
              setSessionCredentials(newSessionId, credentials);
              console.log(`Session ${newSessionId}: Credentials configured`);
            }
          }
        });
        
        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid) {
            console.log(`StreamableHTTP transport closed: ${sid}`);
            transports.delete(sid);
            sessionServers.delete(sid);
            clearSessionCredentials(sid);
          }
        };
        
        // Connect to a new MCP server instance
        const server = createServer();
        await server.connect(transport);
        if (transport.sessionId) {
          sessionServers.set(transport.sessionId, server);
        }
      } else if (!sessionId && req.method === 'GET') {
        // GET without session = new standalone SSE stream (allowed for notifications)
        const credentials = extractCredentials(req);
        
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.log(`StreamableHTTP GET session initialized: ${newSessionId}`);
            transports.set(newSessionId, transport!);
            if (credentials.githubSourcePat || credentials.githubTargetPat) {
              setSessionCredentials(newSessionId, credentials);
            }
          }
        });
        
        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid) {
            transports.delete(sid);
            sessionServers.delete(sid);
            clearSessionCredentials(sid);
          }
        };
        
        const server = createServer();
        await server.connect(transport);
        if (transport.sessionId) {
          sessionServers.set(transport.sessionId, server);
        }
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided'
          },
          id: null
        });
        return;
      }
      
      // Handle the request
      await transport!.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling /mcp request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  //=============================================================================
  // LEGACY SSE TRANSPORT (Protocol version 2024-11-05)
  // For backwards compatibility with older MCP clients
  //=============================================================================
  app.get("/sse", async (req, res) => {
    console.log('Received GET request to /sse (legacy SSE transport)');
    
    const server = createServer();
    const transport = new SSEServerTransport("/message", res);
    const sessionId = transport.sessionId;
    
    console.log(`Legacy SSE connection: ${sessionId}`);
    
    // Extract and store credentials
    const credentials = extractCredentials(req);
    if (credentials.githubSourcePat || credentials.githubTargetPat) {
      setSessionCredentials(sessionId, credentials);
      console.log(`Session ${sessionId}: Credentials configured via headers`);
    }
    
    transports.set(sessionId, transport);
    sessionServers.set(sessionId, server);

    res.on("close", () => {
      console.log(`Legacy SSE connection closed: ${sessionId}`);
      transports.delete(sessionId);
      sessionServers.delete(sessionId);
      clearSessionCredentials(sessionId);
    });

    await server.connect(transport);
  });

  // Legacy message endpoint for SSE transport
  app.post("/message", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    
    if (!transport || !(transport instanceof SSEServerTransport)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error("Error handling message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Endpoint to check session status
  app.get("/session/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    if (transports.has(sessionId)) {
      res.json({ 
        sessionId, 
        active: true,
        hasCredentials: true
      });
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  app.listen(port, () => {
    console.log(`GEI Migration MCP Server running on http://0.0.0.0:${port}`);
    console.log("");
    console.log("==============================================");
    console.log("SUPPORTED TRANSPORT OPTIONS:");
    console.log("");
    console.log("1. Streamable HTTP (Protocol version: 2025-03-26)");
    console.log("   Endpoint: /mcp");
    console.log("   Methods: GET, POST, DELETE");
    console.log("");
    console.log("2. Legacy HTTP + SSE (Protocol version: 2024-11-05)");
    console.log("   Endpoints: /sse (GET) and /message (POST)");
    console.log("==============================================");
    console.log("");
    console.log("Credentials can be provided via HTTP Headers:");
    console.log("  X-GitHub-Source-PAT, X-GitHub-Target-PAT, X-ADO-PAT");
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
