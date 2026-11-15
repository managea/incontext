import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Note, Notes } from './Notes';
import { ReferenceParser } from './ReferenceParser';
import { ReferenceUtils } from './ReferenceUtils';

/** A note and the source file it is on, as read from a project's notes folder. */
export interface NoteEntry {
  source: vscode.Uri;
  notesFile: vscode.Uri;
  note: Note;
}

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
  /** The notes, and back-links by the path of the file they point at; undefined until needed again after a change. */
  private entries?: Promise<NoteEntry[]>;
  private index?: Promise<Map<string, BackLink[]>>;
  private refreshTimer?: NodeJS.Timeout;
  /** What the notes were when last read, to tell whether they changed. */
  private signature = '';
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
      // Notes can change while VS Code is in the background: written by an AI tool, or synced from another machine
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
          this.stale();
        }
      }),
      vscode.commands.registerCommand(NotesBacklinks.GO_TO_NOTE, (source: string, line: number, lines: number, anchor: string, beside = true) => NotesBacklinks.goToNote(source, { line, lines, anchor }, beside)),
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watchers.forEach(watcher => watcher.dispose());
    this.disposables.forEach(disposable => disposable.dispose());
  }

  /** The back-links, read from the notes files the first time they are needed after a change. */
  backLinks(): Promise<Map<string, BackLink[]>> {
    this.index ??= this.notes().then(NotesBacklinks.index);
    return this.index;
  }

  /** Every note of the projects open in this window, read the first time they are needed after a change. */
  notes(): Promise<NoteEntry[]> {
    this.entries ??= NotesBacklinks.readNotes();
    return this.entries;
  }

  /** A link back to the note a back-link comes from. */
  static goToNoteLink(link: BackLink): string {
    const args = [link.source.toString(), link.line, link.lines, link.anchor];
    return `command:${NotesBacklinks.GO_TO_NOTE}?${encodeURIComponent(JSON.stringify(args))}`;
  }

  /** Reads the notes again now, as the Notes view's refresh asks. */
  refresh(): void {
    this.stale();
  }

  /**
   * Reads the notes again a moment after they may have changed (the typing stopped), and says so when they did:
   * reading them is cheap, but redrawing every box when nothing changed would not be.
   */
  private stale(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      const entries = NotesBacklinks.readNotes();
      this.entries = entries;
      this.index = undefined;
      const read = await entries;
      const signature = JSON.stringify(read.map(({ notesFile, note }) => [notesFile.fsPath, note.headingLine, note.line, note.lines, note.anchor, note.text]));
      if (signature !== this.signature) {
        this.signature = signature;
        this.changed.fire();
      }
    }, 300);
  }

  /** Notes files can also change outside this window, such as when a synced folder updates. */
  private watchNotesFolders(): void {
    this.watchers.forEach(watcher => watcher.dispose());
    this.watchers = Notes.projectFolders().map(folder => {
      // A folder that doesn't exist yet can't be watched, such as a project's before its first note: watch the
      // nearest folder that does, for the notes that will be in it
      let base = folder;
      while (!fs.existsSync(base) && path.dirname(base) !== base) {
        base = path.dirname(base);
      }
      const below = path.relative(base, folder).split(path.sep).join('/');
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), below ? `${below}/**/*.md` : '**/*.md'));
      watcher.onDidCreate(() => this.stale());
      watcher.onDidChange(() => this.stale());
      watcher.onDidDelete(() => this.stale());
      return watcher;
    });
  }

  /** Reads the notes of the projects open in this window, from each project's notes folder (Notes.projectFolder). */
  /** The back-links of the notes of the projects open in this window. */
  static async read(): Promise<Map<string, BackLink[]>> {
    return NotesBacklinks.index(await NotesBacklinks.readNotes());
  }

  /** Reads the notes of the projects open in this window, from each project's notes folder (Notes.projectFolder). */
  static async readNotes(): Promise<NoteEntry[]> {
    const entries: NoteEntry[] = [];
    for (const project of vscode.workspace.workspaceFolders ?? []) {
      const folder = Notes.projectFolder(project);
      for (const file of folder ? await NotesBacklinks.markdownFiles(vscode.Uri.file(folder)) : []) {
        // <project's notes folder>/src/handler.ts.md holds the notes on <project>/src/handler.ts
        const relativePath = path.relative(folder!, file.fsPath).split(path.sep).join('/').replace(/\.md$/, '');
        const source = vscode.Uri.joinPath(project.uri, relativePath);
        const text = await Notes.read(file);
        entries.push(...(text ? Notes.parse(text) : []).map(note => ({ source, notesFile: file, note })));
      }
    }
    return entries;
  }

  /** Back-links by the path of the file they point at. */
  private static index(entries: NoteEntry[]): Map<string, BackLink[]> {
    const index = new Map<string, BackLink[]>();
    for (const { source, notesFile, note } of entries) {
      for (const reference of note.references) {
        const target = NotesBacklinks.targetOf(reference);
        if (target) {
          const links = index.get(target.file.fsPath) ?? [];
          links.push({
            source, line: note.line, lines: note.lines, anchor: note.anchor, targetLine: target.line, targetEndLine: target.endLine,
            text: note.text, reference, notesFile, headingLine: note.headingLine,
          });
          index.set(target.file.fsPath, links);
        }
      }
    }
    return index;
  }

  /** The file and 0-based lines a reference points at, when its project is open in this window. */
  static targetOf(reference: string): { file: vscode.Uri; line: number; endLine: number } | undefined {
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

  /**
   * Opens the file a note is on with the note's lines selected, which shows the note's box. When another split
   * already shows that file, such as the one a link from the note was followed from, it goes back there instead of
   * moving the split the back-link was clicked in: the split that shows the note's lines, or else the nearest one,
   * the one to the left first. When no other split shows it, a back-link opens it in the split to the left, made
   * if there is none, so a flow reads left to right: links to the next step open to the right. The InContext view
   * (`beside` false) opens it where you are.
   */
  private static async goToNote(source: string, note: { line: number; lines: number; anchor: string }, beside = true): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source, true));
    const lines = Notes.rangeIn(document, note);
    const active = vscode.window.activeTextEditor?.viewColumn ?? 0;
    const others = vscode.window.visibleTextEditors.filter(editor =>
      editor.document.uri.toString() === document.uri.toString() && editor.viewColumn !== undefined && editor.viewColumn !== active);
    const distance = (editor: vscode.TextEditor) => Math.abs(editor.viewColumn! - active) * 2 + (editor.viewColumn! > active ? 1 : 0);
    const showing = others.filter(editor => editor.visibleRanges.some(range => range.contains(lines.start)));
    const target = (showing.length ? showing : others).sort((a, b) => distance(a) - distance(b))[0];
    if (target || !beside) {
      await vscode.window.showTextDocument(document, { selection: lines, viewColumn: target?.viewColumn });
      return;
    }
    if (active > vscode.ViewColumn.One) {
      // In a tab of its own, so the file the split to the left shows stays open
      await vscode.window.showTextDocument(document, { selection: lines, viewColumn: active - 1, preview: false });
      return;
    }
    // The new split takes the first column. Named outright: with the file already open in the split it was made
    // from, "the active column" would mean that editor, and the new split would stay empty
    await vscode.commands.executeCommand('workbench.action.newGroupLeft');
    await vscode.window.showTextDocument(document, { selection: lines, viewColumn: vscode.ViewColumn.One, preview: false });
  }
}
