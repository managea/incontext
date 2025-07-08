#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * InContext MCP Server
 * 
 * This server resolves @project/path references to actual file content,
 * including images as base64 data for LLM consumption.
 */
class InContextMCPServer {
  private server: Server;
  private workspaceRoot: string;

  constructor() {
    this.server = new Server(
      {
        name: "incontext-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Get workspace root from VS Code or fallback to current directory
    this.workspaceRoot = this.getWorkspaceRoot();

    this.setupHandlers();
  }

  private getWorkspaceRoot(): string {
    // Try to get from VS Code workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri.fsPath;
    }
    
    // Fallback to process cwd
    return process.cwd();
  }

  private setupHandlers() {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: "incontext://workspace",
            name: "InContext Workspace Files",
            description: "Access to workspace files via @project/path references",
            mimeType: "application/json",
          },
        ],
      };
    });

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      
      if (uri.startsWith("incontext://")) {
        const reference = uri.replace("incontext://", "");
        return await this.resolveReference(reference);
      }
      
      throw new Error(`Unsupported URI: ${uri}`);
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "resolve_incontext_reference",
            description: "Resolve @project/path references to actual file content",
            inputSchema: {
              type: "object",
              properties: {
                reference: {
                  type: "string",
                  description: "The @project/path reference to resolve (e.g., @incontext/media/new.png)",
                },
              },
              required: ["reference"],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "resolve_incontext_reference") {
        const reference = request.params.arguments?.reference as string;
        if (!reference) {
          throw new Error("Reference parameter is required");
        }

        const result = await this.resolveReference(reference);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async resolveReference(reference: string): Promise<any> {
    // Remove @ prefix if present
    const cleanRef = reference.startsWith('@') ? reference.slice(1) : reference;
    
    // Parse project/path format
    const parts = cleanRef.split('/');
    if (parts.length < 2) {
      throw new Error(`Invalid reference format: ${reference}. Expected @project/path`);
    }

    const projectName = parts[0];
    const relativePath = parts.slice(1).join('/');

    // For now, assume project name matches workspace folder
    // In a multi-workspace setup, you'd match against workspace folder names
    const fullPath = path.join(this.workspaceRoot, relativePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const stats = fs.statSync(fullPath);
    
    if (stats.isDirectory()) {
      return this.handleDirectory(fullPath, reference);
    } else {
      return this.handleFile(fullPath, reference);
    }
  }

  private async handleDirectory(dirPath: string, reference: string): Promise<any> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const contents = entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      path: path.join(dirPath, entry.name)
    }));

    return {
      type: 'directory',
      reference,
      path: dirPath,
      contents,
      text: `Directory: ${reference}\nContents:\n${contents.map(c => `  ${c.type === 'directory' ? '📁' : '📄'} ${c.name}`).join('\n')}`
    };
  }

  private async handleFile(filePath: string, reference: string): Promise<any> {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = this.getMimeType(ext);
    
    if (this.isImageFile(ext)) {
      return this.handleImageFile(filePath, reference, mimeType);
    } else if (this.isTextFile(ext)) {
      return this.handleTextFile(filePath, reference, mimeType);
    } else {
      return this.handleBinaryFile(filePath, reference, mimeType);
    }
  }

  private async handleImageFile(filePath: string, reference: string, mimeType: string): Promise<any> {
    try {
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;

      return {
        type: 'image',
        reference,
        path: filePath,
        mimeType,
        base64,
        dataUrl,
        size: buffer.length,
        text: `Image: ${reference}\nPath: ${filePath}\nSize: ${buffer.length} bytes\nMIME: ${mimeType}`
      };
    } catch (error) {
      throw new Error(`Failed to read image file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleTextFile(filePath: string, reference: string, mimeType: string): Promise<any> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      return {
        type: 'text',
        reference,
        path: filePath,
        mimeType,
        content,
        lineCount: lines.length,
        text: content
      };
    } catch (error) {
      throw new Error(`Failed to read text file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleBinaryFile(filePath: string, reference: string, mimeType: string): Promise<any> {
    try {
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString('base64');

      return {
        type: 'binary',
        reference,
        path: filePath,
        mimeType,
        base64,
        size: buffer.length,
        text: `Binary file: ${reference}\nPath: ${filePath}\nSize: ${buffer.length} bytes\nMIME: ${mimeType}`
      };
    } catch (error) {
      throw new Error(`Failed to read binary file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isImageFile(ext: string): boolean {
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico'];
    return imageExts.includes(ext);
  }

  private isTextFile(ext: string): boolean {
    const textExts = ['.txt', '.md', '.js', '.ts', '.json', '.html', '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.csv'];
    return textExts.includes(ext);
  }

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.js': 'text/javascript',
      '.ts': 'text/typescript',
      '.json': 'application/json',
      '.html': 'text/html',
      '.css': 'text/css',
      '.xml': 'text/xml',
      '.yaml': 'text/yaml',
      '.yml': 'text/yaml',
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("InContext MCP Server running on stdio");
  }
}

// Start the server
async function main() {
  const server = new InContextMCPServer();
  await server.run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}

export { InContextMCPServer };
