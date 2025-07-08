# InContext MCP Server

A minimal Model Context Protocol (MCP) server implementation that provides workspace context to AI assistants.

## Features

- Provides workspace file structure and content
- Supports file reading and search capabilities
- Compatible with Claude Desktop and VS Code
- Simple JavaScript implementation (no TypeScript required)

## Files

- `mcp-server.js` - The main MCP server implementation
- `test-mcp.js` - Test script to verify server functionality
- `claude-desktop-config.json` - Configuration for Claude Desktop integration

## Installation

1. Ensure you have Node.js installed
2. The server uses only built-in Node.js modules, so no additional dependencies are required

## Testing the Server

Run the test script to verify the server works correctly:

```bash
node test-mcp.js
```

You should see output indicating the server starts, processes requests, and shuts down cleanly.

## Integration with Claude Desktop

1. Copy the `claude-desktop-config.json` configuration to your Claude Desktop configuration directory:
   - On macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - On Windows: `%APPDATA%/Claude/claude_desktop_config.json`
   - On Linux: `~/.config/claude/claude_desktop_config.json`

2. Update the path in the configuration file to match your actual server location:
   ```json
   {
     "mcpServers": {
       "incontext": {
         "command": "node",
         "args": ["/path/to/your/mcp-server.js"],
         "env": {
           "NODE_ENV": "production"
         }
       }
     }
   }
   ```

3. Restart Claude Desktop to load the new configuration

## Integration with VS Code

For VS Code integration, you can use the MCP extension and configure it to use this server. The server will run on stdio transport mode.

## Server Capabilities

The MCP server provides the following tools:

- **list_files**: List files in the workspace directory
- **read_file**: Read the contents of a specific file
- **search_files**: Search for files by name pattern

## Usage Example

Once integrated with Claude Desktop, you can ask Claude to:
- "List the files in my workspace"
- "Read the contents of package.json"
- "Search for TypeScript files"

The server will provide the requested information from your workspace.

## Development

To modify the server:

1. Edit `mcp-server.js` to add new tools or modify existing ones
2. Test your changes with `node test-mcp.js`
3. Update this README if you add new capabilities

## Troubleshooting

- Ensure Node.js is installed and accessible in your PATH
- Check that the file paths in configuration files are correct and absolute
- Run the test script to verify the server works independently
- Check Claude Desktop logs for any error messages during integration
