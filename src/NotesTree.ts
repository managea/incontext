import * as path from 'path';
import * as vscode from 'vscode';
import { Notes, NotesProvider } from './Notes';
import { NoteEntry, NotesBacklinks } from './NotesBacklinks';
import { ReferenceParser } from './ReferenceParser';

/** A marker in the tree: under its file, or under a marker whose note links to it (`leaf`, which goes no further). */
export interface NoteNode {
  kind: 'note';
  entry: NoteEntry;
  /** The marker's lines in its file as the code is now, which the row opens; unknown when the file can't be read. */
  lines?: vscode.Range;
  /** The name the note above it gives it (Notes.labelAt), shown instead of its own. */
  label?: string;
  /** Under another marker: a link to it, without its own links under it. */
  leaf?: boolean;
}

/** A link or reference in a marker's note that doesn't lead to another marker; a link to no marker (`missing`) is its name. */
export interface ReferenceNode {
  kind: 'reference';
  reference: string;
  missing?: string;
  /** The name the note it is in gives it (Notes.labelAt). */
  label?: string;
}

/** A file with markers, and its markers under it. */
export interface FileNode {
  kind: 'file';
  source: vscode.Uri;
  entries: NoteEntry[];
}

export type NotesTreeNode = FileNode | NoteNode | ReferenceNode;

/**
 * The Markers view: every marker of the projects open in this window, the pool collections are made from. Each file
 * with markers, its markers under it by line, and under each marker what its note links to, one level: the markers
 * and places it is connected to. A flow's order is a collection's (Collections); Make Collection from Chain turns the
 * links a flow was written with into one. A click opens a marker at its lines, or a place; Alt+click opens it to the
 * side. Cmd+click (Ctrl+click on Windows and Linux) and Shift+click select several, to drag into a collection.
 */
export class NotesTree implements vscode.TreeDataProvider<NotesTreeNode>, vscode.TreeDragAndDropController<NotesTreeNode> {
  static readonly VIEW = 'incontext.notes';
  /** A marker dragged onto the Collections view: MarkerRef[] as JSON (CollectionsTree.MARKER_MIME). */
  readonly dragMimeTypes = ['application/vnd.incontext.marker'];
  readonly dropMimeTypes: string[] = [];
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
      const files = new Map<string, FileNode>();
      for (const entry of entries) {
        const file = files.get(entry.source.fsPath) ?? { kind: 'file', source: entry.source, entries: [] };
        file.entries.push(entry);
        files.set(entry.source.fsPath, file);
      }
      return [...files.values()].sort((a, b) => vscode.workspace.asRelativePath(a.source).localeCompare(vscode.workspace.asRelativePath(b.source)));
    }
    if (node.kind === 'file') {
      return NotesTree.withLines([...node.entries].sort((a, b) => a.note.line - b.note.line).map((entry): NoteNode => ({ kind: 'note', entry })));
    }
    if (node.kind === 'reference' || node.leaf) {
      return [];
    }
    return NotesTree.withLines(NotesTree.onward(entries, node.entry).map(({ reference, next, missing, label }): NotesTreeNode =>
      next ? { kind: 'note', entry: next, label, leaf: true } : { kind: 'reference', reference, missing, label }));
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

  /** Markers dragged, or a file's, to add to a collection by dropping them on the Collections view. */
  handleDrag(source: readonly NotesTreeNode[], dataTransfer: vscode.DataTransfer): void {
    // A file carries its markers, by line; each marker once
    const entries = source.flatMap(node => node.kind === 'note' ? [node.entry] : node.kind === 'file' ? [...node.entries].sort((a, b) => a.note.line - b.note.line) : []);
    const markers = [...new Map(entries.map(entry => [`${entry.source.toString()}#${entry.note.name}`, { source: entry.source.toString(), name: entry.note.name }])).values()];
    if (markers.length) {
      dataTransfer.set(this.dragMimeTypes[0], new vscode.DataTransferItem(JSON.stringify(markers)));
    }
  }

  getTreeItem(node: NotesTreeNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(path.basename(node.source.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.source.toString();
      item.resourceUri = node.source;
      item.iconPath = vscode.ThemeIcon.File;
      const where = path.dirname(vscode.workspace.asRelativePath(node.source));
      item.description = `${where === '.' ? '' : `${where} · `}${node.entries.length} marker${node.entries.length === 1 ? '' : 's'}`;
      item.contextValue = 'file';
      return item;
    }
    if (node.kind === 'reference' && node.missing) {
      const item = new vscode.TreeItem(node.label ?? node.missing, vscode.TreeItemCollapsibleState.None);
      item.description = 'no marker by this name';
      item.tooltip = node.reference;
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    if (node.kind === 'reference') {
      const item = new vscode.TreeItem(node.label ?? NotesProvider.shortLabel(node.reference), vscode.TreeItemCollapsibleState.None);
      item.description = node.reference.replace(/^@/, '');
      item.tooltip = node.reference;
      item.iconPath = new vscode.ThemeIcon('arrow-small-right');
      const target = NotesBacklinks.targetOf(node.reference);
      const whole = ReferenceParser.parse(node.reference)?.startLine === undefined;
      item.command = target
        ? NotesTree.open(target.file, whole ? undefined : new vscode.Range(target.line, 0, target.endLine, Number.MAX_SAFE_INTEGER))
        // A folder, or a project that isn't open: incontext opens it, and says why when it can't
        : { title: 'Open Reference', command: 'incontext.openReference', arguments: [node.reference] };
      return item;
    }
    const { source, note } = node.entry;
    const item = new vscode.TreeItem(node.label ?? note.name, !node.leaf && (note.references.length || note.links.length)
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    // Named by the note above it, its own name too
    item.description = `${node.label ? `${note.name} · ` : ''}${node.leaf ? `${path.basename(source.fsPath)}:` : ''}L${node.lines ? node.lines.start.line + 1 : note.line}`;
    item.tooltip = new vscode.MarkdownString(`**${NotesProvider.escape(note.name)}**\n\n${note.text || '_No note_'}`);
    item.iconPath = new vscode.ThemeIcon(node.leaf ? 'arrow-small-right' : note.text ? 'note' : 'bookmark');
    item.contextValue = 'marker';
    item.command = node.lines
      ? NotesTree.open(source, node.lines)
      : { title: 'Go to Note', command: NotesBacklinks.GO_TO_NOTE, arguments: [source.toString(), note.line, note.lines, note.anchor, false] };
    return item;
  }

  /**
   * Where a marker's note leads, in its order: each link to a marker (`missing` when there is none by that name) and
   * each reference, with the marker its lines are in, if any.
   */
  static onward(entries: NoteEntry[], from: NoteEntry): { reference: string; next?: NoteEntry; missing?: string; label?: string }[] {
    const text = from.note.text;
    const links = from.note.links.map(link => {
      const file = Notes.linkTarget(link, from.source);
      const next = file && entries.find(entry => entry.source.fsPath === file.fsPath && entry.note.name === link.name);
      return { at: text.indexOf(link.text), reference: link.text, next: next !== from ? next : undefined, missing: next ? undefined : link.name };
    });
    const references = from.note.references.map(reference => ({ at: text.indexOf(reference), reference, next: NotesTree.noteAt(entries, reference, from), missing: undefined }));
    return [...links, ...references].sort((a, b) => a.at - b.at)
      .map(({ at, reference, next, missing }) => ({ reference, next, missing, label: Notes.labelAt(text, at, at + reference.length) }));
  }

  /** The marker whose lines a reference lands on, other than the marker it is written in. */
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

}
