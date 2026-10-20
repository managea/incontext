import * as vscode from 'vscode';
import { ReferenceParser } from './ReferenceParser';
import { ReferenceUtils } from './ReferenceUtils';


export class ReferenceProvider implements vscode.HoverProvider, vscode.DocumentLinkProvider {
  // The target of a markdown link, e.g. `../src/file.ts#L34-L43` in `[label](../src/file.ts#L34-L43)`
  static readonly MARKDOWN_LINK_TARGET_PATTERN = /\]\(\s*<?([^\s<>()]+)/g;

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const line = document.lineAt(position.line).text;
    for (const { reference, start, end } of ReferenceParser.findReferences(line)) {
      if (position.character >= start && position.character <= end) {
        const parsed = ReferenceParser.parse(reference);
        const targetUri = parsed && ReferenceUtils.resolveReference(parsed);
        if (!parsed || !targetUri) {
          return;
        }
        if (parsed.isDirectory) {
          // Directory reference
          let entryNames: string[] = [];
          try {
            const dirList = await vscode.workspace.fs.readDirectory(targetUri);
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
          let startLine = 0, endLine = 0;
          if (parsed.startLine !== undefined) {
            startLine = parsed.startLine - 1;
            endLine = (parsed.endLine ?? parsed.startLine) - 1;
          }
          const lines = await ReferenceProvider.readFileLines(targetUri, startLine, endLine);
          const ext = targetUri.path.split('.').pop() || '';
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
    const isMarkdown = document.languageId === 'markdown';
    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const text = document.lineAt(lineIndex).text;
      for (const { reference, start, end } of ReferenceParser.findReferences(text)) {
        const referenceType = reference.endsWith('/') ? 'directory' : 'file';
        documentLinks.push(ReferenceProvider.createLink(lineIndex, start, end, [reference], `Navigate to ${referenceType} ${reference} (Ctrl+Click)`));
      }
      if (isMarkdown) {
        // Markdown links to plain paths with line ranges, which VS Code's own markdown links cannot select
        ReferenceProvider.MARKDOWN_LINK_TARGET_PATTERN.lastIndex = 0;
        let match;
        while ((match = ReferenceProvider.MARKDOWN_LINK_TARGET_PATTERN.exec(text)) !== null) {
          const target = match[1];
          const parsed = !target.startsWith('@') && ReferenceParser.parseMarkdownLinkTarget(target);
          if (parsed) {
            const start = match.index + match[0].length - target.length;
            const lines = ReferenceParser.describeLines(parsed);
            documentLinks.push(ReferenceProvider.createLink(lineIndex, start, start + target.length, [target, document.uri.toString()], `Navigate to ${parsed.path}, ${lines} (Ctrl+Click)`));
          }
        }
      }
    }
    return documentLinks;
  }

  private static createLink(line: number, start: number, end: number, args: string[], tooltip: string): vscode.DocumentLink {
    const range = new vscode.Range(line, start, line, end);
    const commandUri = vscode.Uri.parse(`command:incontext.openReference?${encodeURIComponent(JSON.stringify(args))}`);
    const link = new vscode.DocumentLink(range, commandUri);
    link.tooltip = tooltip;
    return link;
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
