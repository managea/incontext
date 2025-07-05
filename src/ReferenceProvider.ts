import * as vscode from 'vscode';


export class ReferenceProvider implements vscode.HoverProvider, vscode.DocumentLinkProvider {
  static readonly REFERENCE_PATTERN = /@([^\s@]+(?::[^:\s]*)*\/?)/g;
  static readonly FILE_REF_PATTERN = /^@(.+?)(?::L(\d+)(?::(\d+))?)?$/;
  static readonly DIR_REF_PATTERN = /^@(.+)\/$/;

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const line = document.lineAt(position.line).text;
    let match;
    ReferenceProvider.REFERENCE_PATTERN.lastIndex = 0;
    while ((match = ReferenceProvider.REFERENCE_PATTERN.exec(line)) !== null) {
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;
      if (position.character >= matchStart && position.character <= matchEnd) {
        const reference = match[0];
        if (reference.endsWith('/')) {
          // Directory reference
          const dirMatch = reference.match(ReferenceProvider.DIR_REF_PATTERN);
          if (!dirMatch) return;
          const fullPath = dirMatch[1];
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) return;
          let targetWorkspaceFolder = workspaceFolders[0];
          let dirRelativePath = fullPath;
          const pathParts = fullPath.split('/');
          if (pathParts.length > 1) {
            const projectName = pathParts[0];
            const matchingFolder = workspaceFolders.find(f => f.name === projectName);
            if (matchingFolder) {
              targetWorkspaceFolder = matchingFolder;
              dirRelativePath = pathParts.slice(1).join('/');
            }
          }
          const dirUri = vscode.Uri.joinPath(targetWorkspaceFolder.uri, dirRelativePath);
          let entryNames: string[] = [];
          try {
            const dirList = await vscode.workspace.fs.readDirectory(dirUri);
            entryNames = dirList.map(([name, type]) => {
              if (type & vscode.FileType.Directory) return `📁 ${name}/`;
              if (type & vscode.FileType.SymbolicLink) return `🔗 ${name}`;
              return `📄 ${name}`;
            });
          } catch (e) {
            entryNames = [`Error reading directory: ${e instanceof Error ? e.message : String(e)}`];
          }
          const md = new vscode.MarkdownString(
            `**Contents of \`${reference}\`**\n\n` +
            (entryNames.length ? entryNames.join('  \n') : '_(empty)_')
          );
          md.isTrusted = true;
          return new vscode.Hover(md);
        } else {
          // File reference
          const refMatch = reference.match(ReferenceProvider.FILE_REF_PATTERN);
          if (!refMatch) return;
          const [, fullPath, startLineStr, endLineStr] = refMatch;
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) return;
          let targetWorkspaceFolder = workspaceFolders[0];
          let fileRelativePath = fullPath;
          const pathParts = fullPath.split('/');
          if (pathParts.length > 1) {
            const projectName = pathParts[0];
            const matchingFolder = workspaceFolders.find(f => f.name === projectName);
            if (matchingFolder) {
              targetWorkspaceFolder = matchingFolder;
              fileRelativePath = pathParts.slice(1).join('/');
            }
          }
          const fileUri = vscode.Uri.joinPath(targetWorkspaceFolder.uri, fileRelativePath);
          let startLine = 0, endLine = 0;
          if (startLineStr) {
            startLine = Math.max(0, parseInt(startLineStr, 10) - 1);
            endLine = endLineStr ? Math.max(0, parseInt(endLineStr, 10) - 1) : startLine;
          }
          const lines = await ReferenceProvider.readFileLines(fileUri, startLine, endLine);
          const ext = fileUri.path.split('.').pop() || '';
          const lang = ext.match(/^[a-zA-Z0-9]+$/) ? ext : '';
          const codeBlock = '```' + lang + '\n' + lines.join('\n') + '\n```';
          const md = new vscode.MarkdownString(`**Preview of \`${reference}\`**\n\n${codeBlock}`);
          md.isTrusted = true;
          return new vscode.Hover(md);
        }
      }
    }
    return;
  }

  provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.DocumentLink[] {
    const documentLinks: vscode.DocumentLink[] = [];
    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const line = document.lineAt(lineIndex);
      const text = line.text;
      let match;
      ReferenceProvider.REFERENCE_PATTERN.lastIndex = 0;
      while ((match = ReferenceProvider.REFERENCE_PATTERN.exec(text)) !== null) {
        const matchStart = match.index;
        const matchEnd = match.index + match[0].length;
        const reference = match[0];
        try {
          const isDirectoryReference = reference.endsWith('/');
          let referenceMatch;
          if (isDirectoryReference) {
            referenceMatch = reference.match(ReferenceProvider.DIR_REF_PATTERN);
          } else {
            referenceMatch = reference.match(ReferenceProvider.FILE_REF_PATTERN);
          }
          if (!referenceMatch) {
            continue;
          }
          const range = new vscode.Range(lineIndex, matchStart, lineIndex, matchEnd);
          const commandUri = vscode.Uri.parse(`command:incontext.openReference?${encodeURIComponent(JSON.stringify([reference]))}`);
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

  static async readFileLines(uri: vscode.Uri, start: number, end: number): Promise<string[]> {
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
}
