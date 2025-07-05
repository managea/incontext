// ...existing code...
// Utility: Read lines from a file
async function readFileLines(uri: vscode.Uri, start: number, end: number): Promise<string[]> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines: string[] = [];
    for (let i = start; i <= end && i < doc.lineCount; i++) {
      lines.push(doc.lineAt(i).text);
    }
    return lines;
  } catch (e) {
    return [`Error reading file: ${e instanceof Error ? e.message : String(e)}`];
  }
}
// Simple Code Reference Extension

import * as vscode from 'vscode';
import { ReferenceProvider } from './ReferenceProvider';
import { ReferenceUtils } from './ReferenceUtils';
import { ReferenceDecoration } from './ReferenceDecoration';
import { Logger } from './Logger';



/**
 * Open and navigate to a file reference
 * Handles references like @project/path/to/file.js:L10:20, @project/path/to/file.js, or @project/path/to/directory/
 */
async function openReference(reference: string) {
  try {
    Logger.log('Opening reference:', reference);
    
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
  Logger.log('Opening directory reference:', reference);
  
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
      Logger.log('No matching workspace folder found, using full path as relative');
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
    Logger.log('Successfully selected directory in explorer:', directoryUri.fsPath);
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
  Logger.log('Opening file reference:', reference);
  
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
      Logger.log('No matching workspace folder found, using full path as relative');
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
  
  Logger.log('Successfully opened file:', fileUri.fsPath, 'at lines', startLine + 1, '-', endLine + 1);
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  // Inline decoration type for 'Reference copied!'
  const referenceCopiedDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: 'Reference added to clipboard!',
      color: '#4caf50',
      margin: '0 0 0 1em',
      fontWeight: 'bold',
      textDecoration: 'none; font-size: 1.2em; padding: 0.15em 0.7em;',
      // backgroundColor: 'rgba(255,255,255,0.8)',
      border: '1px solid #78b37aff',
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  context.subscriptions.push(referenceCopiedDecorationType);
  // Register HoverProvider and DocumentLinkProvider for code references
  const referenceProvider = new ReferenceProvider();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, referenceProvider)
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ scheme: 'file' }, referenceProvider)
  );

  console.log('Extension "incontext" is now active!');


  // Apply path compression decorations
  context.subscriptions.push(ReferenceDecoration.compressedPathDecoration);
  context.subscriptions.push(ReferenceDecoration.highlightedPathDecoration);
  if (vscode.window.activeTextEditor) {
    ReferenceDecoration.applyPathCompressionDecorations(vscode.window.activeTextEditor, /@([^\s@]+(?::[^:\s]*)*\/?)/g);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        ReferenceDecoration.applyPathCompressionDecorations(editor, /@([^\s@]+(?::[^:\s]*)*\/?)/g);
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        setTimeout(() => {
          if (vscode.window.activeTextEditor === editor) {
            ReferenceDecoration.applyPathCompressionDecorations(editor, /@([^\s@]+(?::[^:\s]*)*\/?)/g);
          }
        }, 500);
      }
    })
  );


  // Register command to copy code reference to clipboard


  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.copyCodeReference', async () => {
      Logger.log('Copy code reference command triggered');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
      }
      const selection = editor.selection;
      try {
        let reference: string;
        if (selection.isEmpty) {
          reference = ReferenceUtils.createFileReference(editor.document.uri);
        } else {
          reference = ReferenceUtils.createCodeReference(editor.document.uri, selection);
        }
        await vscode.env.clipboard.writeText(reference);
        // Inline decoration: show 'Reference copied!' near selection
        const range = selection.isEmpty
          ? new vscode.Range(selection.start, selection.start)
          : new vscode.Range(selection.end, selection.end);
        editor.setDecorations(referenceCopiedDecorationType, [
          { range, hoverMessage: 'Reference copied to clipboard!' }
        ]);
        await new Promise(resolve => setTimeout(resolve, 1200));
        editor.setDecorations(referenceCopiedDecorationType, []);
        Logger.log('Reference copied to clipboard:', reference);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to copy reference: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );


  // Register command to copy file reference from explorer context menu or keyboard shortcut
  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.copyFileReference', async (resource?: vscode.Uri) => {
      Logger.log('Copy file reference command triggered, resource:', resource?.fsPath);
      let fileUri: vscode.Uri | undefined;
      if (resource instanceof vscode.Uri) {
        fileUri = resource;
      } else {
        try {
          const originalClipboard = await vscode.env.clipboard.readText();
          await vscode.commands.executeCommand('copyFilePath');
          await new Promise(resolve => setTimeout(resolve, 100));
          const absolutePath = await vscode.env.clipboard.readText();
          if (absolutePath && absolutePath !== originalClipboard && absolutePath.trim() !== '') {
            try {
              fileUri = vscode.Uri.file(absolutePath.trim());
            } catch (error) {
              Logger.log('Failed to create URI from absolute path:', error);
            }
          }
          await vscode.env.clipboard.writeText(originalClipboard);
        } catch (error) {
          Logger.log('Error getting explorer selection via clipboard:', error);
        }
        if (!fileUri) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            fileUri = editor.document.uri;
          }
        }
      }
      if (!fileUri) {
        vscode.window.showErrorMessage('No file selected. Please select a file in the Explorer or open a file in the editor.');
        return;
      }
      try {
        const reference = ReferenceUtils.createFileReference(fileUri);
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Reference added to clipboard',
          cancellable: false
        }, async (progress) => {
          progress.report({ increment: 0 });
          await vscode.env.clipboard.writeText(reference);
          await new Promise(resolve => setTimeout(resolve, 800));
          progress.report({ increment: 100 });
        });
        Logger.log('File reference copied to clipboard:', reference);
      } catch (error) {
        vscode.window.showErrorMessage(`Error copying file reference: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );


  // Register command to copy directory reference from explorer context menu or keyboard shortcut
  context.subscriptions.push(
    vscode.commands.registerCommand('incontext.copyDirectoryReference', async (resource?: vscode.Uri) => {
      Logger.log('Copy directory reference command triggered, resource:', resource?.fsPath);
      let directoryUri: vscode.Uri | undefined;
      if (resource instanceof vscode.Uri) {
        directoryUri = resource;
      } else {
        try {
          const originalClipboard = await vscode.env.clipboard.readText();
          await vscode.commands.executeCommand('copyFilePath');
          await new Promise(resolve => setTimeout(resolve, 100));
          const absolutePath = await vscode.env.clipboard.readText();
          if (absolutePath && absolutePath !== originalClipboard && absolutePath.trim() !== '') {
            try {
              directoryUri = vscode.Uri.file(absolutePath.trim());
            } catch (error) {
              Logger.log('Failed to create URI from absolute path:', error);
            }
          }
          await vscode.env.clipboard.writeText(originalClipboard);
        } catch (error) {
          Logger.log('Error getting explorer selection via clipboard:', error);
        }
      }
      if (!directoryUri) {
        vscode.window.showErrorMessage('No directory selected. Please select a directory in the Explorer.');
        return;
      }
      try {
        const stat = await vscode.workspace.fs.stat(directoryUri);
        if (!(stat.type & vscode.FileType.Directory)) {
          vscode.window.showErrorMessage('Selected item is not a directory. Please select a directory in the Explorer.');
          return;
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Error accessing directory: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      try {
        const reference = ReferenceUtils.createDirectoryReference(directoryUri);
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Reference added to clipboard',
          cancellable: false
        }, async (progress) => {
          progress.report({ increment: 0 });
          await vscode.env.clipboard.writeText(reference);
          await new Promise(resolve => setTimeout(resolve, 800));
          progress.report({ increment: 100 });
        });
        Logger.log('Directory reference copied to clipboard:', reference);
      } catch (error) {
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
            const pattern = /@([^\s@]+(?::[^:\s]*)*\/?)/g;
            pattern.lastIndex = 0; // Reset regex
            
            while ((match = pattern.exec(text)) !== null) {
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
