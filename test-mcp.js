#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

/**
 * Test script for the InContext MCP Server
 * This simulates how an MCP client would interact with our server
 */

const serverPath = path.join(__dirname, 'bin', 'mcp-server-standalone.js');

function testMCPServer() {
  console.log('🧪 Testing InContext MCP Server...\n');
  
  // Start the server
  const server = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      INCONTEXT_WORKSPACE_ROOT: __dirname
    }
  });

  let buffer = '';
  
  server.stdout.on('data', (data) => {
    buffer += data.toString();
    
    // Try to parse complete JSON messages
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep the incomplete line in buffer
    
    lines.forEach(line => {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          console.log('📨 Received:', JSON.stringify(message, null, 2));
        } catch (e) {
          console.log('📝 Raw output:', line);
        }
      }
    });
  });

  server.stderr.on('data', (data) => {
    console.log('🚨 Server stderr:', data.toString());
  });

  server.on('close', (code) => {
    console.log(`\n✅ Server exited with code ${code}`);
  });

  // Test sequence
  setTimeout(() => {
    console.log('\n🔧 Testing tool list...');
    sendMessage(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    });
  }, 1000);

  setTimeout(() => {
    console.log('\n🖼️  Testing image reference resolution...');
    sendMessage(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "resolve_incontext_reference",
        arguments: {
          reference: "@incontext/media/new.png"
        }
      }
    });
  }, 2000);

  setTimeout(() => {
    console.log('\n�️📝 Testing prompt with multiple image references...');
    sendMessage(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "resolve_incontext_reference",
        arguments: {
          reference: "The implementation should look like this @incontext/media/new.png . But it's currently look like this @incontext/media/old.png . Can you check why?"
        }
      }
    });
  }, 3000);

  setTimeout(() => {
    console.log('\n�🔚 Terminating server...');
    server.kill();
  }, 5000);
}

function sendMessage(server, message) {
  const jsonMessage = JSON.stringify(message) + '\n';
  console.log('📤 Sending:', JSON.stringify(message, null, 2));
  server.stdin.write(jsonMessage);
}

if (require.main === module) {
  testMCPServer();
}
