#!/bin/bash

# VS Code Extension Packaging Script
# This script compiles and packages the extension into a VSIX file

echo "🔨 Building VS Code Extension..."
echo "=================================="

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "❌ Error: vsce (VS Code Extension CLI) is not installed"
    echo "📦 Install it with: npm install -g @vscode/vsce"
    exit 1
fi

# Compile the extension first
echo "📝 Compiling TypeScript..."
npm run compile

if [ $? -ne 0 ]; then
    echo "❌ Compilation failed!"
    exit 1
fi

echo "✅ Compilation successful!"

# Package the extension
echo "📦 Creating VSIX package..."
vsce package --allow-missing-repository --no-dependencies

if [ $? -eq 0 ]; then
    echo "✅ Extension packaged successfully!"
    echo "📁 VSIX file created: $(ls *.vsix | tail -1)"
    echo ""
    echo "🚀 To install the extension:"
    echo "   1. Open VS Code"
    echo "   2. Press Cmd+Shift+P (Mac) or Ctrl+Shift+P (Windows/Linux)"
    echo "   3. Type 'Extensions: Install from VSIX...'"
    echo "   4. Select the VSIX file"
    echo ""
else
    echo "❌ Packaging failed!"
    exit 1
fi
