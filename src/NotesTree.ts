import * as path from 'path';
import * as vscode from 'vscode';
import { NotesProvider } from './Notes';
import { NoteEntry, NotesBacklinks } from './NotesBacklinks';

/** A note in the tree, with the notes above it on its branch, so a chain that loops back stops there. */
export interface NoteNode {
  kind: 'note';
  entry: NoteEntry;
  branch: string[];
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
 * that note, with its own references under it, step by step. A click opens a note at its lines, or a reference.
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
    this.changed.dispose();
  }

  async getChildren(node?: NotesTreeNode): Promise<NotesTreeNode[]> {
    const entries = await this.notes();
    if (!node) {
      return NotesTree.chainStarts(entries).map(entry => ({ kind: 'note', entry, branch: [NotesTree.key(entry)] }));
    }
    if (node.kind === 'reference') {
      return [];
    }
    return node.entry.note.references.map((reference): NotesTreeNode => {
      const next = NotesTree.noteAt(entries, reference, node.entry);
      if (!next) {
        return { kind: 'reference', reference, loopsBack: false };
      }
      const key = NotesTree.key(next);
      return node.branch.includes(key)
        ? { kind: 'reference', reference, loopsBack: true }
        : { kind: 'note', entry: next, branch: [...node.branch, key] };
    });
  }

  getTreeItem(node: NotesTreeNode): vscode.TreeItem {
    if (node.kind === 'reference') {
      const item = new vscode.TreeItem(NotesProvider.shortLabel(node.reference), vscode.TreeItemCollapsibleState.None);
      item.description = node.loopsBack ? 'back to a note above' : node.reference.replace(/^@/, '');
      item.tooltip = node.reference;
      item.iconPath = new vscode.ThemeIcon(node.loopsBack ? 'sync' : 'arrow-small-right');
      item.command = { title: 'Open Reference', command: 'incontext.openReference', arguments: [node.reference] };
      return item;
    }
    const { source, note } = node.entry;
    const item = new vscode.TreeItem(NotesTree.summary(note.text), note.references.length
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = `${path.basename(source.fsPath)}:L${note.line}`;
    item.tooltip = new vscode.MarkdownString(note.text || '_Empty note_');
    item.iconPath = new vscode.ThemeIcon('note');
    item.command = { title: 'Go to Note', command: NotesBacklinks.GO_TO_NOTE, arguments: [source.toString(), note.line, note.lines, note.anchor, false] };
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
