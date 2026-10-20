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
import { ReferenceParser, ParsedReference } from './ReferenceParser';
import { MarkdownPreview } from './MarkdownPreview';
import { PreviewSplit } from './PreviewSplit';
import { Logger } from './Logger';



/**
 * Open and navigate to a reference
 * Handles references like @project/path/to/file.js:L10:20, @project/path/to/file.js#L10-L20,
 * @project/path/to/file.js or @project/path/to/directory/, plus markdown link paths such as ../file.js#L10-L20.
 * `from` is the document the reference was clicked in, used to resolve relative markdown link paths.
 * `viewColumn` is where a file opens: the active group for editor links, a split beside the preview for preview links.
 * Returns the editor a file reference opened in.
 */
async function openReference(reference: string, from?: string, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active): Promise<vscode.TextEditor | undefined> {
  try {
    Logger.log('Opening reference:', reference, 'from', from);

    const parsed = ReferenceParser.parse(reference);
    if (!parsed) {
      const errorMsg = `Invalid reference format: ${reference}`;
      console.error(errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      return;
    }

    const fromUri = from ? vscode.Uri.parse(from) : undefined;
    const targetUri = ReferenceUtils.resolveReference(parsed, fromUri);
    if (!targetUri) {
      const errorMsg = 'No workspace folder open';
      console.error(errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      return;
    }

    if (parsed.isDirectory) {
      await openDirectoryReference(targetUri);
    } else {
      return await openFileReference(targetUri, parsed, viewColumn);
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
async function openDirectoryReference(directoryUri: vscode.Uri) {
  Logger.log('Opening directory reference:', directoryUri.fsPath);

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
 * Open a file reference and select its line range
 */
async function openFileReference(fileUri: vscode.Uri, parsed: ParsedReference, viewColumn: vscode.ViewColumn): Promise<vscode.TextEditor> {
  // Open the document
  const document = await vscode.workspace.openTextDocument(fileUri);

  // Calculate line numbers (VS Code uses 0-based indexing)
  let startLine = 0;
  let endLine = 0;

  if (parsed.startLine !== undefined) {
    startLine = Math.min(parsed.startLine - 1, document.lineCount - 1);
    endLine = Math.min((parsed.endLine ?? parsed.startLine) - 1, document.lineCount - 1);
  }

  // Create selection range
  const startPosition = new vscode.Position(startLine, 0);
  const endPosition = new vscode.Position(endLine, document.lineAt(endLine).text.length);
  const selection = new vscode.Selection(startPosition, endPosition);

  // Show the document with the selection
  const editor = await vscode.window.showTextDocument(document, {
    selection: selection,
    viewColumn,
    preserveFocus: false
  });

  // Reveal the range in the editor
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);

  Logger.log('Successfully opened file:', fileUri.fsPath, 'at lines', startLine + 1, '-', endLine + 1);
  return editor;
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
    ReferenceDecoration.applyPathCompressionDecorations(vscode.window.activeTextEditor);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        ReferenceDecoration.applyPathCompressionDecorations(editor);
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        setTimeout(() => {
          if (vscode.window.activeTextEditor === editor) {
            ReferenceDecoration.applyPathCompressionDecorations(editor);
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
    vscode.commands.registerCommand('incontext.openReference', async (reference: string, from?: string) => {
      await openReference(reference, from);
    })
  );

  // Open references clicked in the Markdown preview, which links to vscode://<extension id>/open?...
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        if (uri.path !== MarkdownPreview.OPEN_PATH) {
          return;
        }
        const request = MarkdownPreview.parseOpenUri(uri);
        if (!request) {
          vscode.window.showErrorMessage(`Invalid reference link: ${uri.toString(true)}`);
          return;
        }
        // Open in a split beside the preview instead of covering it; Cmd/Ctrl+click asks for a new split
        const newSplit = request.split === 'new';
        const from = request.from ? vscode.Uri.parse(request.from) : undefined;
        const editor = await openReference(request.reference, request.from, PreviewSplit.column(from, newSplit));
        if (editor && !newSplit) {
          PreviewSplit.remember(editor.viewColumn);
        }
      }
    })
  );

  // Picked up by the built-in Markdown preview through the markdown.markdownItPlugins contribution
  return {
    extendMarkdownIt(md: Parameters<typeof MarkdownPreview.extendMarkdownIt>[0]) {
      return MarkdownPreview.extendMarkdownIt(md, context.extension.id);
    }
  };
}

// This method is called when your extension is deactivated
export function deactivate() {}
