#!/bin/bash

# Installation script for InContext MCP Server with Claude Desktop

echo "🔧 Installing InContext MCP Server for Claude Desktop..."

# Get the current directory (where the MCP server is located)
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_SERVER_PATH="$CURRENT_DIR/mcp-server.js"

# Determine Claude Desktop config directory based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    CLAUDE_CONFIG_DIR="$HOME/.config/claude"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    # Windows
    CLAUDE_CONFIG_DIR="$APPDATA/Claude"
else
    echo "❌ Unsupported operating system: $OSTYPE"
    exit 1
fi

CLAUDE_CONFIG_FILE="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"

echo "📍 MCP Server location: $MCP_SERVER_PATH"
echo "📍 Claude config location: $CLAUDE_CONFIG_FILE"

# Test the MCP server first
echo "🧪 Testing MCP server..."
if ! node "$CURRENT_DIR/test-mcp.js"; then
    echo "❌ MCP server test failed. Please check the server implementation."
    exit 1
fi

echo "✅ MCP server test passed!"

# Create Claude config directory if it doesn't exist
mkdir -p "$CLAUDE_CONFIG_DIR"

# Create the configuration
cat > "$CLAUDE_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "incontext": {
      "command": "node",
      "args": ["$MCP_SERVER_PATH"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
EOF

echo "✅ Configuration written to: $CLAUDE_CONFIG_FILE"
echo ""
echo "🎉 Installation complete!"
echo ""
echo "📋 Next steps:"
echo "1. Restart Claude Desktop to load the new configuration"
echo "2. Try asking Claude to 'List the files in my workspace'"
echo "3. The MCP server will provide workspace context to Claude"
echo ""
echo "📖 For more information, see MCP-README.md"
