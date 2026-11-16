import * as path from 'path';
import * as vscode from 'vscode';
import { Notes, NotesProvider } from './Notes';
import { NoteEntry, NotesBacklinks } from './NotesBacklinks';
import { ReferenceParser } from './ReferenceParser';

/** A note in the tree, with the notes above it on its branch, so a chain that loops back stops there. */
export interface NoteNode {
  kind: 'note';
  entry: NoteEntry;
  branch: string[];
  /** The note's lines in its file as the code is now, which the row opens; unknown when the file can't be read. */
  lines?: vscode.Range;
}

/** A reference in a note that doesn't land on another note: where the chain ends, or loops back. */
export interface ReferenceNode {
  kind: 'reference';
  reference: string;
  loopsBack: boolean;
}

export type NotesTreeNode = NoteNode | ReferenceNode;

/**
 * The Notes view: every note of the projects open in this window, as chains. A chain starts at a note no other
 * note points to; under each note are its references, and a reference that lands on another note's lines shows
 * that note, with its own references under it, step by step. A click opens a note at its lines, or a reference;
 * Cmd+click (Ctrl+click on Windows and Linux) opens it to the side.
 */
export class NotesTree implements vscode.TreeDataProvider<NotesTreeNode> {
  static readonly VIEW = 'incontext.notes';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly notes: () => Promise<NoteEntry[]>) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    clearTimeout(this.codeTimer);
    this.changed.dispose();
  }

  private codeTimer: NodeJS.Timeout | undefined;

  /** Draws the view again a moment after code with notes changes, so each row opens its note's lines as they are now. */
  watchCode(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument(async event => {
      const file = event.document.uri.toString();
      if (event.contentChanges.length && (await this.notes()).some(entry => entry.source.toString() === file)) {
        clearTimeout(this.codeTimer);
        this.codeTimer = setTimeout(() => this.refresh(), 500);
      }
    });
  }

  async getChildren(node?: NotesTreeNode): Promise<NotesTreeNode[]> {
    const entries = await this.notes();
    if (!node) {
      return NotesTree.withLines(NotesTree.chainStarts(entries).map(entry => ({ kind: 'note', entry, branch: [NotesTree.key(entry)] })));
    }
    if (node.kind === 'reference') {
      return [];
    }
    return NotesTree.withLines(node.entry.note.references.map((reference): NotesTreeNode => {
      const next = NotesTree.noteAt(entries, reference, node.entry);
      if (!next) {
        return { kind: 'reference', reference, loopsBack: false };
      }
      const key = NotesTree.key(next);
      return node.branch.includes(key)
        ? { kind: 'reference', reference, loopsBack: true }
        : { kind: 'note', entry: next, branch: [...node.branch, key] };
    }));
  }

  /** The nodes, each note's with where its lines are now (Notes.rangeIn finds them by their first line's text). */
  private static async withLines(nodes: NotesTreeNode[]): Promise<NotesTreeNode[]> {
    const texts = new Map<string, Promise<string | undefined>>();
    for (const node of nodes) {
      if (node.kind !== 'note') {
        continue;
      }
      const key = node.entry.source.toString();
      if (!texts.has(key)) {
        texts.set(key, Notes.read(node.entry.source));
      }
      const text = await texts.get(key);
      if (text !== undefined) {
        const lines = text.split(/\r?\n/);
        const document = { lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) } as unknown as vscode.TextDocument;
        node.lines = Notes.rangeIn(document, node.entry.note);
      }
    }
    return nodes;
  }

  /**
   * VS Code's own open command for a row: the only command a view tells which keys were held, so Cmd+click opens the
   * place to the side, and a double click keeps its tab.
   */
  private static open(file: vscode.Uri, selection?: vscode.Range): vscode.Command {
    return { title: 'Open', command: 'vscode.open', arguments: selection ? [file, { selection }] : [file] };
  }

  getTreeItem(node: NotesTreeNode): vscode.TreeItem {
    if (node.kind === 'reference') {
      const item = new vscode.TreeItem(NotesProvider.shortLabel(node.reference), vscode.TreeItemCollapsibleState.None);
      item.description = node.loopsBack ? 'back to a note above' : node.reference.replace(/^@/, '');
      item.tooltip = node.reference;
      item.iconPath = new vscode.ThemeIcon(node.loopsBack ? 'sync' : 'arrow-small-right');
      const target = NotesBacklinks.targetOf(node.reference);
      const whole = ReferenceParser.parse(node.reference)?.startLine === undefined;
      item.command = target
        ? NotesTree.open(target.file, whole ? undefined : new vscode.Range(target.line, 0, target.endLine, Number.MAX_SAFE_INTEGER))
        // A folder, or a project that isn't open: incontext opens it, and says why when it can't
        : { title: 'Open Reference', command: 'incontext.openReference', arguments: [node.reference] };
      return item;
    }
    const { source, note } = node.entry;
    const item = new vscode.TreeItem(NotesTree.summary(note.text), note.references.length
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = `${path.basename(source.fsPath)}:L${note.line}`;
    item.tooltip = new vscode.MarkdownString(note.text || '_Empty note_');
    item.iconPath = new vscode.ThemeIcon('note');
    item.command = node.lines
      ? NotesTree.open(source, node.lines)
      : { title: 'Go to Note', command: NotesBacklinks.GO_TO_NOTE, arguments: [source.toString(), note.line, note.lines, note.anchor, false] };
    return item;
  }

  /** The notes no other note points to, in file and line order; a chain that loops back on itself starts anywhere. */
  static chainStarts(entries: NoteEntry[]): NoteEntry[] {
    const pointedAt = new Set<string>();
    for (const entry of entries) {
      for (const reference of entry.note.references) {
        const next = NotesTree.noteAt(entries, reference, entry);
        if (next) {
          pointedAt.add(NotesTree.key(next));
        }
      }
    }
    const order = (a: NoteEntry, b: NoteEntry) => a.source.fsPath.localeCompare(b.source.fsPath) || a.note.line - b.note.line;
    const starts = entries.filter(entry => !pointedAt.has(NotesTree.key(entry))).sort(order);
    // Notes only reached through a loop would otherwise never show
    const reached = new Set<string>();
    const reach = (entry: NoteEntry) => {
      const key = NotesTree.key(entry);
      if (!reached.has(key)) {
        reached.add(key);
        entry.note.references.map(reference => NotesTree.noteAt(entries, reference, entry)).forEach(next => next && reach(next));
      }
    };
    starts.forEach(reach);
    return [...starts, ...entries.filter(entry => !reached.has(NotesTree.key(entry))).sort(order)];
  }

  /** The note whose lines a reference lands on, other than the note it is written in. */
  static noteAt(entries: NoteEntry[], reference: string, from: NoteEntry): NoteEntry | undefined {
    const target = NotesBacklinks.targetOf(reference);
    return target && entries.find(entry => entry !== from
      && entry.source.fsPath === target.file.fsPath
      && entry.note.line - 1 <= target.line && target.line <= entry.note.line - 2 + entry.note.lines);
  }

  /** A note's first line, without Markdown marks, its references by file and lines. */
  static summary(text: string): string {
    const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) ?? 'Empty note';
    const plain = firstLine.replace(/^[-*>#\s]+/, '').replace(/[*_`]/g, '').replace(/@[^\s@]+/g, reference => NotesProvider.shortLabel(reference));
    return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
  }

  private static key(entry: NoteEntry): string {
    return `${entry.source.fsPath}#${entry.note.headingLine}`;
  }
}
