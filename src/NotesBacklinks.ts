import * as path from 'path';
import * as vscode from 'vscode';
import { Notes } from './Notes';
import { ReferenceParser } from './ReferenceParser';
import { ReferenceUtils } from './ReferenceUtils';

/** A note that points at lines of a file, with where the note is, to go back to it. */
export interface BackLink {
  /** The file the note is on. */
  source: vscode.Uri;
  /** The note's first line, how many lines it covers, and its first line's text, to find it again (Notes.rangeIn). */
  line: number;
  lines: number;
  anchor: string;
  /** The 0-based lines the note points at: the reference's lines, or the top line for a whole file. */
  targetLine: number;
  targetEndLine: number;
  text: string;
  /** The reference as the note writes it, and where the note is kept, to point it at other lines. */
  reference: string;
  notesFile: vscode.Uri;
  headingLine: number;
}

/**
 * Back-links from notes (Notes): which notes point at which lines, for NotesComments to show in the box at those
 * lines (`← Note on handler.ts:L30`). No workspace search: notes live only in the projects' notes folders, so it reads
 * the notes of the projects open in this window, keeps them in memory by the file they point at, and reads them again
 * when a notes file changes, then says so (onDidChange).
 */
export class NotesBacklinks implements vscode.Disposable {
  static readonly GO_TO_NOTE = 'incontext.notes.goToNote';
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires a moment after notes files stop changing, once the back-links may differ. */
  readonly onDidChange = this.changed.event;
  /** Back-links by the path of the file they point at; undefined until needed again after a notes file changed. */
  private index?: Promise<Map<string, BackLink[]>>;
  private refreshTimer?: NodeJS.Timeout;
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.watchNotesFolders();
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeTextDocument(event => {
        if (Notes.isNotesFile(event.document.uri)) {
          this.stale();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('incontext.notes')) {
          this.watchNotesFolders();
          this.stale();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watchNotesFolders();
        this.stale();
      }),
      vscode.commands.registerCommand(NotesBacklinks.GO_TO_NOTE, (source: string, line: number, lines: number, anchor: string) => NotesBacklinks.goToNote(source, { line, lines, anchor })),
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watchers.forEach(watcher => watcher.dispose());
    this.disposables.forEach(disposable => disposable.dispose());
  }

  /** The back-links, read from the notes files the first time they are needed after a change. */
  backLinks(): Promise<Map<string, BackLink[]>> {
    this.index ??= NotesBacklinks.read();
    return this.index;
  }

  /** A link back to the note a back-link comes from. */
  static goToNoteLink(link: BackLink): string {
    const args = [link.source.toString(), link.line, link.lines, link.anchor];
    return `command:${NotesBacklinks.GO_TO_NOTE}?${encodeURIComponent(JSON.stringify(args))}`;
  }

  /** Forgets the back-links after a notes file changed, and says so a moment after the typing stops. */
  private stale(): void {
    this.index = undefined;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.changed.fire(), 300);
  }

  /** Notes files can also change outside this window, such as when a synced folder updates. */
  private watchNotesFolders(): void {
    this.watchers.forEach(watcher => watcher.dispose());
    this.watchers = Notes.projectFolders().map(folder => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*.md'));
      watcher.onDidCreate(() => this.stale());
      watcher.onDidChange(() => this.stale());
      watcher.onDidDelete(() => this.stale());
      return watcher;
    });
  }

  /** Reads the notes of the projects open in this window, from each project's notes folder (Notes.projectFolder). */
  static async read(): Promise<Map<string, BackLink[]>> {
    const index = new Map<string, BackLink[]>();
    for (const project of vscode.workspace.workspaceFolders ?? []) {
      const folder = Notes.projectFolder(project);
      if (!folder) {
        continue;
      }
      for (const file of await NotesBacklinks.markdownFiles(vscode.Uri.file(folder))) {
        // <project's notes folder>/src/handler.ts.md holds the notes on <project>/src/handler.ts
        const relativePath = path.relative(folder, file.fsPath).split(path.sep).join('/').replace(/\.md$/, '');
        const source = vscode.Uri.joinPath(project.uri, relativePath);
        const text = await Notes.read(file);
        for (const note of text ? Notes.parse(text) : []) {
          for (const reference of note.references) {
            const target = NotesBacklinks.targetOf(reference);
            if (target) {
              const links = index.get(target.file.fsPath) ?? [];
              links.push({
                source, line: note.line, lines: note.lines, anchor: note.anchor, targetLine: target.line, targetEndLine: target.endLine,
                text: note.text, reference, notesFile: file, headingLine: note.headingLine,
              });
              index.set(target.file.fsPath, links);
            }
          }
        }
      }
    }
    return index;
  }

  /** The file and 0-based lines a reference points at, when its project is open in this window. */
  private static targetOf(reference: string): { file: vscode.Uri; line: number; endLine: number } | undefined {
    const parsed = ReferenceParser.parse(reference);
    const project = parsed?.path.split('/')[0];
    // A reference to a project that isn't open would otherwise resolve against the first workspace folder
    if (!parsed?.isWorkspaceReference || parsed.isDirectory || !vscode.workspace.workspaceFolders?.some(folder => folder.name === project)) {
      return undefined;
    }
    const file = ReferenceUtils.resolveReference(parsed);
    const line = Math.max((parsed.startLine ?? 1) - 1, 0);
    return file && { file, line, endLine: Math.max((parsed.endLine ?? parsed.startLine ?? 1) - 1, line) };
  }

  private static async markdownFiles(folder: vscode.Uri): Promise<vscode.Uri[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return [];
    }
    const files: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      const entry = vscode.Uri.joinPath(folder, name);
      if (type & vscode.FileType.Directory) {
        files.push(...await NotesBacklinks.markdownFiles(entry));
      } else if (name.endsWith('.md')) {
        files.push(entry);
      }
    }
    return files;
  }

  /** Opens the file a note is on with the note's lines selected, which shows the note under them. */
  private static async goToNote(source: string, note: { line: number; lines: number; anchor: string }): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source, true));
    await vscode.window.showTextDocument(document, { selection: Notes.rangeIn(document, note) });
  }
}
