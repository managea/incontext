import * as fs from 'fs';
import * as vscode from 'vscode';
import { ParsedReference, ReferenceParser } from './ReferenceParser';

export interface PeekRenderer {
  escapeHtml(text: string): string;
  /** The preview's own code highlighter, so the peek matches its fenced code blocks. */
  highlight?: ((code: string, lang: string, attrs: string) => string) | null;
}

interface Lines {
  count: number;
  get(index: number): string;
}

/**
 * Renders the hover popup ("peek") shown over a reference in the Markdown preview:
 * the referenced lines, or the entries of a referenced directory.
 *
 * The preview renders synchronously, so files are read with `fs` (and cached by modification time),
 * preferring the editor's copy for files that are open.
 */
export class MarkdownPeek {
  private static readonly MAX_LINES = 40;
  private static readonly WHOLE_FILE_LINES = 20;
  private static readonly MAX_ENTRIES = 50;
  private static readonly MAX_FILE_SIZE = 5 * 1024 * 1024;
  private static readonly MAX_CACHED_FILES = 100;
  private static readonly fileCache = new Map<string, { mtimeMs: number; size: number; lines: string[] }>();

  static render(renderer: PeekRenderer, reference: string, parsed: ParsedReference, target: vscode.Uri): string {
    const escape = renderer.escapeHtml;
    const content = parsed.isDirectory
      ? MarkdownPeek.renderDirectory(escape, target)
      : MarkdownPeek.renderFile(renderer, parsed, target);
    const lines = ReferenceParser.describeLines(parsed);
    const footer = ['Click to open', lines, content.note].filter(Boolean).join(' · ');
    return '<span class="incontext-peek" role="tooltip"><span class="incontext-peek-box">'
      + `<span class="incontext-peek-header">${parsed.isDirectory ? 'Contents of' : 'Preview of'} <span class="incontext-peek-reference">${escape(reference)}</span></span>`
      + `<span class="incontext-peek-${content.error ? 'error' : 'code'}">${content.html}</span>`
      + `<span class="incontext-peek-footer">${escape(footer)}</span>`
      + '</span></span>';
  }

  private static renderFile(renderer: PeekRenderer, parsed: ParsedReference, target: vscode.Uri): { html: string; note?: string; error?: boolean } {
    const file = MarkdownPeek.readLines(target);
    if (!file) {
      return { html: renderer.escapeHtml(`Cannot read ${target.scheme === 'file' ? target.fsPath : target.toString(true)}`), error: true };
    }
    const start = Math.min((parsed.startLine ?? 1) - 1, file.count - 1);
    const last = Math.min(parsed.startLine === undefined ? MarkdownPeek.WHOLE_FILE_LINES - 1 : (parsed.endLine ?? parsed.startLine) - 1, file.count - 1);
    const end = Math.min(last, start + MarkdownPeek.MAX_LINES - 1);
    const lines: string[] = [];
    for (let i = start; i <= end; i++) {
      lines.push(file.get(i));
    }
    const code = MarkdownPeek.dedent(lines).join('\n');
    const ext = target.path.split('.').pop() || '';
    const lang = ext.match(/^[a-zA-Z0-9]+$/) ? ext : '';
    let html: string | undefined;
    try {
      html = renderer.highlight?.(code, lang, '') || undefined;
    } catch {
      html = undefined;
    }
    // The peek sits inside a paragraph, where block elements would end the paragraph early
    if (!html || /<(pre|div|p)\b/i.test(html)) {
      html = renderer.escapeHtml(code);
    }
    const hidden = last - end;
    return { html, note: hidden > 0 ? `${hidden} more line${hidden === 1 ? '' : 's'}` : undefined };
  }

  private static renderDirectory(escape: (text: string) => string, target: vscode.Uri): { html: string; note?: string; error?: boolean } {
    let entries: fs.Dirent[];
    try {
      if (target.scheme !== 'file') {
        throw new Error('not a local folder');
      }
      entries = fs.readdirSync(target.fsPath, { withFileTypes: true });
    } catch {
      return { html: escape(`Cannot read ${target.scheme === 'file' ? target.fsPath : target.toString(true)}`), error: true };
    }
    if (entries.length === 0) {
      return { html: '(empty)' };
    }
    const names = entries.slice(0, MarkdownPeek.MAX_ENTRIES).map(entry =>
      entry.isDirectory() ? `📁 ${entry.name}/` : entry.isSymbolicLink() ? `🔗 ${entry.name}` : `📄 ${entry.name}`);
    const hidden = entries.length - names.length;
    return { html: escape(names.join('\n')), note: hidden > 0 ? `${hidden} more` : undefined };
  }

  private static readLines(uri: vscode.Uri): Lines | undefined {
    const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (open) {
      return { count: open.lineCount, get: index => open.lineAt(index).text };
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    try {
      const stat = fs.statSync(uri.fsPath);
      if (!stat.isFile() || stat.size > MarkdownPeek.MAX_FILE_SIZE) {
        return undefined;
      }
      let cached = MarkdownPeek.fileCache.get(uri.fsPath);
      if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, lines: fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/) };
        if (MarkdownPeek.fileCache.size >= MarkdownPeek.MAX_CACHED_FILES) {
          MarkdownPeek.fileCache.clear();
        }
        MarkdownPeek.fileCache.set(uri.fsPath, cached);
      }
      const lines = cached.lines;
      return { count: lines.length, get: index => lines[index] };
    } catch {
      return undefined;
    }
  }

  /** Removes the indentation all non-blank lines share, so a snippet from deep in a file fits the popup. */
  private static dedent(lines: string[]): string[] {
    const indents = lines.filter(line => line.trim()).map(line => line.match(/^[ \t]*/)![0]);
    let common = indents[0] ?? '';
    for (const indent of indents) {
      while (!indent.startsWith(common)) {
        common = common.slice(0, -1);
      }
    }
    return lines.map(line => line.startsWith(common) ? line.slice(common.length) : line.trimStart());
  }
}
