// Simple Code Reference Extension
import * as vscode from 'vscode';

// Decoration types for long path compression
let compressedPathDecoration: vscode.TextEditorDecorationType;
let highlightedPathDecoration: vscode.TextEditorDecorationType;

// Regex pattern for matching references - centralized to avoid duplication
const REFERENCE_PATTERN = /@([^\s@]+(?::[^:\s]*)*\/?)/g;

// Regex for parsing a single reference (with optional line numbers)
const SINGLE_REFERENCE_REGEX = /^@(.+?)(?::L(\d+)(?::(\d+))?)?$/;

/**
 * Simple logging helper - can be easily disabled for production
 */
const DEBUG = false; // Set to false to disable debug logging
function debugLog(...args: any[]) {
  if (DEBUG) {
    console.log(...args);
  }
}

/**
 * Show a brief status bar message when a reference is copied.
 */
// Decoration type for the clipboard notification
let clipboardDecorationType: vscode.TextEditorDecorationType | undefined;

/**
 * Show a flashy notification at the current editor selection
 */
function showClipboardAnimation(message: string = 'Reference copied to clipboard') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  
  // The full message with checkmark
  const fullMessage = `Reference copied to clipboard ✅`;
  
  // Start with empty text
  let currentText = '';
  let charIndex = 0;
  
  // Apply decoration to current selection
  const selections = editor.selections;
  if (selections.length > 0) {
    // Create typing animation interval
    const typingInterval = setInterval(() => {
      // Add one character at a time
      if (charIndex < fullMessage.length) {
        currentText += fullMessage.charAt(charIndex);
        charIndex++;
        
        // Update decoration with current text
        const typingDecoration = vscode.window.createTextEditorDecorationType({
          // No background color on the selection
          after: {
            contentText: `  ${currentText}  `, // Extra spaces for padding
            color: '#4CAF50', // Green text
            backgroundColor: 'transparent', // No background
            margin: '0 0 0 1em',
            border: '1px solid',
            borderColor: '#8BC34A', // Light green border
            fontStyle: 'normal',
            fontWeight: 'bold',
            textDecoration: 'none; font-size: 1.2em; padding: 0.3em 0.6em' // Make text bigger
          }
        });
        
        // Apply updated decoration
        editor.setDecorations(typingDecoration, selections);
        
        // Dispose previous decoration if it exists
        if (clipboardDecorationType) {
          clipboardDecorationType.dispose();
        }
        clipboardDecorationType = typingDecoration;
      } else {
        // Typing finished, clear interval
        clearInterval(typingInterval);
        
        // Keep the message visible for a moment before starting fade
        setTimeout(() => {
          // Create a simple fade out animation
          let opacity = 1.0;
          const fadeInterval = setInterval(() => {
            opacity -= 0.1;
            
            if (opacity <= 0) {
              // Animation complete, clean up
              clearInterval(fadeInterval);
              
              if (clipboardDecorationType) {
                editor.setDecorations(clipboardDecorationType, []);
                clipboardDecorationType.dispose();
                clipboardDecorationType = undefined as unknown as vscode.TextEditorDecorationType;
              }
            } else {
              // Create new decoration with reduced opacity
              const fadeDecoration = vscode.window.createTextEditorDecorationType({
                after: {
                  contentText: `  ${fullMessage}  `, // Extra spaces for padding
                  color: `rgba(76, 175, 80, ${opacity})`, // Green text with opacity
                  backgroundColor: 'transparent',
                  margin: '0 0 0 1em',
                  border: `1px solid rgba(139, 195, 74, ${opacity})`, // Border with opacity
                  fontStyle: 'normal',
                  fontWeight: 'bold',
                  textDecoration: 'none; font-size: 1.2em; padding: 0.3em 0.6em'
                }
              });
              
              // Apply updated decoration
              editor.setDecorations(fadeDecoration, selections);
              
              // Dispose previous decoration
              if (clipboardDecorationType) {
                clipboardDecorationType.dispose();
              }
              clipboardDecorationType = fadeDecoration;
            }
          }, 50);
        }, 800);
      }
    }, 3); // Type a character every 50ms
  }
}

/**
 * Helper function to resolve workspace-relative path and project name
 */
function resolveWorkspacePath(uri: vscode.Uri): { relativePath: string; projectName: string } {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return { relativePath: '', projectName: '' };
  }

  for (const folder of workspaceFolders) {
    if (uri.fsPath.startsWith(folder.uri.fsPath)) {
      let relativePath = uri.fsPath.substring(folder.uri.fsPath.length);
      
      // Remove leading slash or backslash
      if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
        relativePath = relativePath.substring(1);
      }
      
      return { relativePath, projectName: folder.name };
    }
  }

  return { relativePath: '', projectName: '' };
}

/**
 * Helper function to create a code reference string
 */
function createCodeReference(fileUri: vscode.Uri, selection: vscode.Selection): string {
  const { relativePath, projectName } = resolveWorkspacePath(fileUri);
  
  if (!relativePath) {
    return `@${fileUri.fsPath}:L${selection.start.line + 1}:${selection.end.line + 1}`;
  }

  // Create the reference string
  const startLine = selection.start.line + 1; // Lines are 0-based in vscode
  const endLine = selection.end.line + 1;
  return `@${projectName}/${relativePath}:L${startLine}:${endLine}`;
}

/**
 * Apply visual compression to long file references
 */
function applyPathCompressionDecorations(editor: vscode.TextEditor) {
  const document = editor.document;
  const compressedDecorations: vscode.DecorationOptions[] = [];
  const highlightedDecorations: vscode.DecorationOptions[] = [];
  
  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
    const line = document.lineAt(lineIndex);
    const text = line.text;
    
    let match;
    REFERENCE_PATTERN.lastIndex = 0;
    
    while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
      const fullReference = match[0];
      const matchStart = match.index;
      
      const pathPart = fullReference.substring(1); // Remove @
      const pathParts = pathPart.split('/');
      
      if (pathParts.length > 1) { // At least project/file
        let currentPos = matchStart + 1; // Skip @
        
        const projectName = pathParts[0];
        
        // For directory references ending with '/', the last part is empty, so get the second-to-last
        const isDirectoryReference = fullReference.endsWith('/');
        let lastSegment: string;
        
        if (isDirectoryReference) {
          // For directories, get the actual directory name (second-to-last part)
          lastSegment = pathParts.length > 2 ? pathParts[pathParts.length - 2] : pathParts[0];
        } else {
          // For files, get the last part (filename)
          lastSegment = pathParts[pathParts.length - 1];
        }
        
        // Always highlight project name for all references
        highlightedDecorations.push({
          range: new vscode.Range(lineIndex, currentPos, lineIndex, currentPos + projectName.length),
          hoverMessage: `Project: ${projectName}\nFull path: ${fullReference}`
        });
        
        // For long references with many path segments, hide the middle part
        if (pathParts.length > 3) {
          currentPos += projectName.length + 1; // +1 for /
          
          // Find the start of the last segment
          let lastSegmentStart: number;
          if (isDirectoryReference) {
            // For directories, find the second-to-last segment
            const secondLastSlashIndex = fullReference.lastIndexOf('/', fullReference.length - 2);
            lastSegmentStart = matchStart + secondLastSlashIndex + 1;
          } else {
            // For files, find the last segment
            const lastSlashIndex = fullReference.lastIndexOf('/');
            lastSegmentStart = matchStart + lastSlashIndex + 1;
          }
          
          // Hide everything between project name and last segment
          if (lastSegmentStart > currentPos) {
            compressedDecorations.push({
              range: new vscode.Range(lineIndex, currentPos, lineIndex, lastSegmentStart - 1),
              hoverMessage: `Full path: ${fullReference}`
            });
          }
        }
        
        // Always highlight the last segment (filename or directory name)
        let lastSegmentStart: number;
        if (isDirectoryReference) {
          // For directories, find the second-to-last segment
          const secondLastSlashIndex = fullReference.lastIndexOf('/', fullReference.length - 2);
          lastSegmentStart = matchStart + secondLastSlashIndex + 1;
        } else {
          // For files, find the last segment
          const lastSlashIndex = fullReference.lastIndexOf('/');
          lastSegmentStart = matchStart + lastSlashIndex + 1;
        }
        
        const segmentType = isDirectoryReference ? 'Directory' : 'File';
        highlightedDecorations.push({
          range: new vscode.Range(lineIndex, lastSegmentStart, lineIndex, lastSegmentStart + lastSegment.length),
          hoverMessage: `${segmentType}: ${lastSegment}`
        });
      }
    }
  }
  
  // Apply decorations
  editor.setDecorations(compressedPathDecoration, compressedDecorations);
  editor.setDecorations(highlightedPathDecoration, highlightedDecorations);
}

/**
 * Helper function to create a file reference string
 */
function createFileReference(fileUri: vscode.Uri): string {
  const { relativePath, projectName } = resolveWorkspacePath(fileUri);
  
  if (!relativePath) {
    return `@${fileUri.fsPath}`;
  }

  return `@${projectName}/${relativePath}`;
}

/**
 * Helper function to create a directory reference string
 */
function createDirectoryReference(directoryUri: vscode.Uri): string {
  const { relativePath, projectName } = resolveWorkspacePath(directoryUri);
  
  if (!relativePath) {
    return `@${directoryUri.fsPath}/`;
  }

  // Ensure the directory reference ends with a slash to distinguish from file references
  const reference = `@${projectName}/${relativePath}`;
  return reference.endsWith('/') ? reference : `${reference}/`;
}

/**
 * Open and navigate to a file reference
 * Handles references like @project/path/to/file.js:L10:20, @project/path/to/file.js, or @project/path/to/directory/
 */
async function openReference(reference: string) {
  try {
    debugLog('Opening reference:', reference);
    
    // Check if this is a directory reference (ends with /)
    const isDirectoryReference = reference.endsWith('/');
    
    if (isDirectoryReference) {
      await openDirectoryReference(reference);
    } else {
      await openFileReference(reference);
    }
    
  } catch (error) {
    console.error('Failed to open reference:', reference, error);
    const errorMsg = `Failed to open reference: ${reference}. Error: ${error instanceof Error ? error.message : String(error)}`;
    vscode.window.showErrorMessage(errorMsg);
  }
}

/**
 * Open and select a directory reference in the explorer
 */
async function openDirectoryReference(reference: string) {
  debugLog('Opening directory reference:', reference);
  
  // Remove the @ prefix and trailing slash
  const pathWithoutPrefix = reference.substring(1, reference.length - 1);
  
  // Get workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    const errorMsg = 'No workspace folder open';
    console.error(errorMsg);
    vscode.window.showErrorMessage(errorMsg);
    return;
  }
  
  // Try to match the project name with workspace folder
  let targetWorkspaceFolder = workspaceFolders[0]; // Default to first workspace
  let directoryRelativePath = pathWithoutPrefix;
  
  // Extract the relative path from the full path (remove project name if present)
  const pathParts = pathWithoutPrefix.split('/');
  
  if (pathParts.length > 1) {
    const projectName = pathParts[0];
    const matchingFolder = workspaceFolders.find(folder => folder.name === projectName);
    if (matchingFolder) {
      targetWorkspaceFolder = matchingFolder;
      directoryRelativePath = pathParts.slice(1).join('/');
    } else {
      debugLog('No matching workspace folder found, using full path as relative');
      directoryRelativePath = pathWithoutPrefix;
    }
  }
  
  // Construct the full directory URI
  const directoryUri = directoryRelativePath 
    ? vscode.Uri.joinPath(targetWorkspaceFolder.uri, directoryRelativePath)
    : targetWorkspaceFolder.uri;
  
  // Check if directory exists
  try {
    const stat = await vscode.workspace.fs.stat(directoryUri);
    if (!(stat.type & vscode.FileType.Directory)) {
      throw new Error('Path is not a directory');
    }
  } catch (error) {
    const errorMsg = `Directory not found: ${directoryUri.fsPath}`;
    console.error(errorMsg, error);
    vscode.window.showErrorMessage(errorMsg);
    return;
  }
  
  // Reveal the directory in the explorer
  try {
    await vscode.commands.executeCommand('revealInExplorer', directoryUri);
    await vscode.commands.executeCommand('workbench.view.explorer');
    debugLog('Successfully selected directory in explorer:', directoryUri.fsPath);
  } catch (error) {
    console.error('Failed to reveal directory in explorer:', error);
    // Fallback: try to reveal the parent and then navigate
    try {
      await vscode.commands.executeCommand('workbench.view.explorer');
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
    }
  }
}

/**
 * Open and navigate to a file reference
 */
async function openFileReference(reference: string) {
  debugLog('Opening file reference:', reference);
  
  // Parse the reference to extract file path and line numbers
  // Expected format: @project/path/to/file.js:L10:20 or @project/path/to/file.js
  const referenceMatch = reference.match(/^@(.+?)(?::L(\d+)(?::(\d+))?)?$/);
  
  if (!referenceMatch) {
    const errorMsg = `Invalid reference format: ${reference}`;
    console.error(errorMsg);
    vscode.window.showErrorMessage(errorMsg);
    return;
  }
  
  const [, fullPath, startLineStr, endLineStr] = referenceMatch;
  
  // Get workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    const errorMsg = 'No workspace folder open';
    console.error(errorMsg);
    vscode.window.showErrorMessage(errorMsg);
    return;
  }
  
  // Try to match the project name with workspace folder
  let targetWorkspaceFolder = workspaceFolders[0]; // Default to first workspace
  let fileRelativePath = fullPath;
  
  // Extract the relative path from the full path (remove project name if present)
  const pathParts = fullPath.split('/');
  
  if (pathParts.length > 1) {
    const projectName = pathParts[0];
    const matchingFolder = workspaceFolders.find(folder => folder.name === projectName);
    if (matchingFolder) {
      targetWorkspaceFolder = matchingFolder;
      fileRelativePath = pathParts.slice(1).join('/');
    } else {
      debugLog('No matching workspace folder found, using full path as relative');
      fileRelativePath = fullPath;
    }
  }
  
  // Construct the full file URI
  const fileUri = vscode.Uri.joinPath(targetWorkspaceFolder.uri, fileRelativePath);
  
  // Open the document
  const document = await vscode.workspace.openTextDocument(fileUri);
  
  // Calculate line numbers (VS Code uses 0-based indexing)
  let startLine = 0;
  let endLine = 0;
  
  if (startLineStr) {
    startLine = Math.max(0, parseInt(startLineStr, 10) - 1); // Convert from 1-based to 0-based
    endLine = endLineStr ? Math.max(0, parseInt(endLineStr, 10) - 1) : startLine;
  }
  
  // Create selection range
  const startPosition = new vscode.Position(startLine, 0);
  const endPosition = new vscode.Position(endLine, document.lineAt(Math.min(endLine, document.lineCount - 1)).text.length);
  const selection = new vscode.Selection(startPosition, endPosition);
  
  // Show the document with the selection
  const editor = await vscode.window.showTextDocument(document, {
    selection: selection,
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  });
  
  // Reveal the range in the editor
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  
  debugLog('Successfully opened file:', fileUri.fsPath, 'at lines', startLine + 1, '-', endLine + 1);
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "incontext" is now active!');

  // Initialize decoration types for path compression
  compressedPathDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0', // Make completely invisible
    letterSpacing: '-100em', // Aggressive negative spacing to compress
    textDecoration: 'none', // Remove any underlines
    after: {
      contentText: '...',
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      fontStyle: 'italic'
    }
  });

  highlightedPathDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '1.0',
    fontWeight: 'bold',
    color: new vscode.ThemeColor('textLink.foreground')
  });

  // Clean up decorations when extension is deactivated
  context.subscriptions.push(compressedPathDecoration);
  context.subscriptions.push(highlightedPathDecoration);

  // Apply decorations to the current active editor
  if (vscode.window.activeTextEditor) {
    applyPathCompressionDecorations(vscode.window.activeTextEditor);
  }

  // Apply decorations when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        applyPathCompressionDecorations(editor);
      }
    })
  );

  // Apply decorations when document content changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        // Debounce the decoration update
        setTimeout(() => {
          if (vscode.window.activeTextEditor === editor) {
            applyPathCompressionDecorations(editor);
          }
        }, 500);
      }
    })
  );

  // Register command to copy code reference to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.copyCodeReference', async () => {
      debugLog('Copy code reference command triggered');
      
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        const error = 'No active editor';
        console.error(error);
        vscode.window.showErrorMessage(error);
        return;
      }

      const selection = editor.selection;
      
      try {
        let reference: string;
        
        if (selection.isEmpty) {
          // No text selected - copy file reference without line numbers
          reference = createFileReference(editor.document.uri);
        } else {
          // Text selected - copy code reference with line numbers
          reference = createCodeReference(editor.document.uri, selection);
        }
        
        // Copy to clipboard
        await vscode.env.clipboard.writeText(reference);
        showClipboardAnimation();
        debugLog('Reference copied to clipboard:', reference);
      } catch (error) {
        console.error('Error in copyCodeReference:', error);
        const errorMsg = `Failed to copy reference: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
      }
    })
  );

  // Register command to copy file reference from explorer context menu or keyboard shortcut
  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.copyFileReference', async (resource?: vscode.Uri) => {
      debugLog('Copy file reference command triggered, resource:', resource?.fsPath);
      
      let fileUri: vscode.Uri | undefined;
      
      // First, try to use the resource parameter (from context menu)
      if (resource instanceof vscode.Uri) {
        fileUri = resource;
      } else {
        // For keyboard shortcuts from explorer, we need a different approach
        // Try to get the selected file by using the copyFilePath command
        // and then parsing the clipboard content
        try {
          const originalClipboard = await vscode.env.clipboard.readText();
          
          // Execute the built-in copy file path command (returns absolute path)
          // This command works with the current explorer selection
          await vscode.commands.executeCommand('copyFilePath');
          
          // Small delay to ensure the command completes
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Get the result from clipboard
          const absolutePath = await vscode.env.clipboard.readText();
          
          // Check if we got a valid path and it's different from original
          if (absolutePath && absolutePath !== originalClipboard && absolutePath.trim() !== '') {
            // The copyFilePath command returns an absolute path, create URI directly
            try {
              fileUri = vscode.Uri.file(absolutePath.trim());
            } catch (error) {
              console.error('Failed to create URI from absolute path:', error);
            }
          }
          
          // Restore original clipboard content
          await vscode.env.clipboard.writeText(originalClipboard);
          
        } catch (error) {
          console.error('Error getting explorer selection via clipboard:', error);
        }
        
        // Fallback to active editor if clipboard approach failed
        if (!fileUri) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            fileUri = editor.document.uri;
          }
        }
      }
      
      if (!fileUri) {
        const error = 'No file selected. Please select a file in the Explorer or open a file in the editor.';
        console.error(error);
        vscode.window.showErrorMessage(error);
        return;
      }
      
      try {
        // Create the file reference
        const reference = createFileReference(fileUri);
        
        // Copy to clipboard (restore the original clipboard approach)
        await vscode.env.clipboard.writeText(reference);
        showClipboardAnimation();
        debugLog('File reference copied to clipboard:', reference);
        
      } catch (error) {
        console.error('Error in copyFileReference:', error);
        vscode.window.showErrorMessage(`Error copying file reference: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  // Register command to copy directory reference from explorer context menu or keyboard shortcut
  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.copyDirectoryReference', async (resource?: vscode.Uri) => {
      debugLog('Copy directory reference command triggered, resource:', resource?.fsPath);
      
      let directoryUri: vscode.Uri | undefined;
      
      // First, try to use the resource parameter (from context menu)
      if (resource instanceof vscode.Uri) {
        directoryUri = resource;
      } else {
        // For keyboard shortcuts from explorer, we need a different approach
        // Try to get the selected directory by using the copyFilePath command
        // and then parsing the clipboard content
        try {
          const originalClipboard = await vscode.env.clipboard.readText();
          
          // Execute the built-in copy file path command (returns absolute path)
          // This command works with the current explorer selection
          await vscode.commands.executeCommand('copyFilePath');
          
          // Small delay to ensure the command completes
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Get the result from clipboard
          const absolutePath = await vscode.env.clipboard.readText();
          
          // Check if we got a valid path and it's different from original
          if (absolutePath && absolutePath !== originalClipboard && absolutePath.trim() !== '') {
            // The copyFilePath command returns an absolute path, create URI directly
            try {
              directoryUri = vscode.Uri.file(absolutePath.trim());
            } catch (error) {
              console.error('Failed to create URI from absolute path:', error);
            }
          }
          
          // Restore original clipboard content
          await vscode.env.clipboard.writeText(originalClipboard);
          
        } catch (error) {
          console.error('Error getting explorer selection via clipboard:', error);
        }
      }
      
      if (!directoryUri) {
        const error = 'No directory selected. Please select a directory in the Explorer.';
        console.error(error);
        vscode.window.showErrorMessage(error);
        return;
      }
      
      // Verify that the selected item is actually a directory
      try {
        const stat = await vscode.workspace.fs.stat(directoryUri);
        if (!(stat.type & vscode.FileType.Directory)) {
          const error = 'Selected item is not a directory. Please select a directory in the Explorer.';
          console.error(error);
          vscode.window.showErrorMessage(error);
          return;
        }
      } catch (error) {
        console.error('Error checking if path is directory:', error);
        vscode.window.showErrorMessage(`Error accessing directory: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      
      try {
        // Create the directory reference
        const reference = createDirectoryReference(directoryUri);
        
        // Copy to clipboard
        await vscode.env.clipboard.writeText(reference);
        
        debugLog('Directory reference copied to clipboard:', reference);
        
      } catch (error) {
        console.error('Error in copyDirectoryReference:', error);
        vscode.window.showErrorMessage(`Error copying directory reference: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  // Register command to open reference (used by DocumentLinkProvider)
  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.openReference', async (reference: string) => {
      await openReference(reference);
    })
  );

  // Register HoverProvider for code previews on reference hover
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
        const lineText = document.lineAt(position.line).text;
        let match;
        REFERENCE_PATTERN.lastIndex = 0;
        while ((match = REFERENCE_PATTERN.exec(lineText)) !== null) {
          const matchStart = match.index;
          const matchEnd = match.index + match[0].length;
          if (position.character < matchStart || position.character > matchEnd) {
            continue; // cursor not within this reference
          }

          const reference = match[0];
          const isDirectoryReference = reference.endsWith('/');

          // Resolve workspace folder similar to openFileReference
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            return null;
          }
          let targetWorkspaceFolder = workspaceFolders[0];
          let fileRelativePath = '';

          if (isDirectoryReference) {
            // Remove leading @ and trailing /
            fileRelativePath = reference.substring(1, reference.length - 1);
          } else {
            // Parse reference for file path & lines
            const parsed = reference.match(SINGLE_REFERENCE_REGEX);
            if (!parsed) {
              return null;
            }
            const [, fullPath, startLineStr, endLineStr] = parsed;
            fileRelativePath = fullPath;

            // The workspace resolution logic will continue below after determining project folder
            // Store for later
            (global as any)._refLineInfo = { startLineStr, endLineStr };
          }

          const pathParts = fileRelativePath.split('/');
          if (pathParts.length > 1) {
            const potentialProject = pathParts[0];
            const matchingFolder = workspaceFolders.find(f => f.name === potentialProject);
            if (matchingFolder) {
              targetWorkspaceFolder = matchingFolder;
              fileRelativePath = pathParts.slice(1).join('/');
            }
          }

          const targetUri = vscode.Uri.joinPath(targetWorkspaceFolder.uri, fileRelativePath);

          if (isDirectoryReference) {
            try {
              const entries = await vscode.workspace.fs.readDirectory(targetUri);
              const markdown = new vscode.MarkdownString();
              markdown.appendMarkdown(`**Folder contents of 
${fileRelativePath}/**\n\n`);
              const maxEntries = 20;
              entries.slice(0, maxEntries).forEach(([name, type]) => {
                const icon = type === vscode.FileType.Directory ? '📁' : '📄';
                markdown.appendMarkdown(`- ${icon} ${name}\n`);
              });
              if (entries.length > maxEntries) {
                markdown.appendMarkdown(`\n...and ${entries.length - maxEntries} more`);
              }
              markdown.isTrusted = false;
              return new vscode.Hover(markdown, new vscode.Range(position.line, matchStart, position.line, matchEnd));
            } catch (dirErr) {
              console.error('HoverProvider dir error', dirErr);
              return null;
            }
          }

          // File reference handling below (non-directory)
          const { startLineStr, endLineStr } = (global as any)._refLineInfo || {};
          const fileUri = targetUri;

          try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            let startLine = 0;
            let endLine = Math.min(29, doc.lineCount - 1); // default: first 30 lines
            if (startLineStr) {
              startLine = Math.max(0, parseInt(startLineStr, 10) - 1);
              endLine = endLineStr ? Math.max(0, parseInt(endLineStr, 10) - 1) : startLine + 9; // show 10 lines by default
              endLine = Math.min(endLine, doc.lineCount - 1);
            }
            const lines: string[] = [];
            for (let i = startLine; i <= endLine; i++) {
              lines.push(doc.lineAt(i).text);
            }
            const codeFenceLang = fileRelativePath.split('.').pop() || 'plaintext';
            const markdown = new vscode.MarkdownString();
            markdown.appendCodeblock(lines.join('\n'), codeFenceLang);
            markdown.isTrusted = false;
            return new vscode.Hover(markdown, new vscode.Range(position.line, matchStart, position.line, matchEnd));
          } catch (err) {
            console.error('HoverProvider error reading file', err);
            return null;
          }
        }
        return null;
      }
    })
  );

  // Register DocumentLinkProvider for native link highlighting and navigation
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { scheme: 'file' }, // Apply to all file types
      {
        provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.DocumentLink[] {
          const documentLinks: vscode.DocumentLink[] = [];
          
          // Search for references in each line
          for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
            const line = document.lineAt(lineIndex);
            const text = line.text;
            
            // Find all references in the line
            let match;
            REFERENCE_PATTERN.lastIndex = 0; // Reset regex
            
            while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
              const matchStart = match.index;
              const matchEnd = match.index + match[0].length;
              const reference = match[0];
              
              try {
                // Parse the reference to validate it
                const isDirectoryReference = reference.endsWith('/');
                let referenceMatch;
                
                if (isDirectoryReference) {
                  // For directory references, just check basic format: @project/path/
                  referenceMatch = reference.match(/^@(.+)\/$/);
                } else {
                  // For file references, check format: @project/path or @project/path:L10:20
                  referenceMatch = reference.match(/^@(.+?)(?::L(\d+)(?::(\d+))?)?$/);
                }
                
                if (!referenceMatch) {
                  continue;
                }
                
                // Create the range for the link
                const range = new vscode.Range(
                  lineIndex, matchStart,
                  lineIndex, matchEnd
                );
                
                // Create a command URI that will trigger our navigation command
                const commandUri = vscode.Uri.parse(`command:incontext.openReference?${encodeURIComponent(JSON.stringify([reference]))}`);
                
                // Create the document link
                const link = new vscode.DocumentLink(range, commandUri);
                const referenceType = isDirectoryReference ? 'directory' : 'file';
                link.tooltip = `Navigate to ${referenceType} ${reference} (Ctrl+Click)`;
                
                documentLinks.push(link);
              } catch (error) {
                console.error('Error creating document link for reference:', reference, error);
              }
            }
          }
          
          return documentLinks;
        }
      }
    )
  );

}

// This method is called when your extension is deactivated
export function deactivate() {}
