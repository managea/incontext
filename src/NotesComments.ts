import * as path from 'path';
import * as vscode from 'vscode';
import { Collections, CollectionsTree } from './Collections';
import { MarkerLink, Note, Notes, NotesProvider } from './Notes';
import { BackLink, NoteEntry, NotesBacklinks } from './NotesBacklinks';
import { ReferenceParser } from './ReferenceParser';
import { ReferenceUtils } from './ReferenceUtils';

/**
 * The box at a marker's lines: the marker's note rendered, its links to other markers shown by their names and its
 * references by their files and lines, or the note's raw text while it is edited. The box's title is the marker's name.
 * It shows only what the note says: a link from another marker shows on that marker, and here only when this note
 * links back. `backLinks` are the links and references into the marker's lines, for Move to selection and Delete.
 */
export class NoteComment implements vscode.Comment {
  // Named and pictured in the comment's own header, beside the note, as CodeTour does
  readonly author = { name: 'InContext', iconPath: NotesComments.icon };
  readonly contextValue = 'incontext.note';
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;

  /** `lines` are the lines the box is about; the thread may sit on the line above them (NotesComments.anchor). */
  constructor(readonly thread: vscode.CommentThread, readonly note: Note, readonly backLinks: BackLink[], public lines: vscode.Range) {
    this.body = this.preview();
  }

  /**
   * The note rendered, then a row of actions at the left: VS Code puts the thread's own buttons at the far right, which
   * is a long way on a wide editor.
   */
  preview(): vscode.MarkdownString {
    const range = this.lines;
    const target = encodeURIComponent(JSON.stringify([this.thread.uri.toString(), range.start.line]));
    // The lines the box covers, a link that selects them: VS Code's own marking of them is faint
    const lines = range.end.line > range.start.line ? `Lines ${range.start.line + 1}–${range.end.line + 1}` : `Line ${range.start.line + 1}`;
    // Plain words: VS Code's comment box doesn't line icons up with the text beside them
    // Edit first, at the very left, the one used most; it renames too, on the first line
    const actions = [
      ['Edit', NotesComments.EDIT_AT], [lines, NotesComments.SELECT_AT], ['Link to…', NotesComments.LINK_AT],
      ...(this.note.links.length || this.note.references.length ? [['Unlink…', NotesComments.UNLINK_AT]] : []),
      ['Add to collection…', CollectionsTree.ADD_AT],
      ['Move to selection', NotesComments.MOVE_AT], ['Open as Markdown', NotesComments.OPEN_AT], ['Delete', NotesComments.DELETE_AT],
    ];
    const sections = [
      this.note.text ? NotesProvider.linkReferences(this.note.text, this.thread.uri) : '_No note yet: choose Edit to write one._',
      // A rule above the actions, as CodeTour has above its Previous and Next
      '---',
      actions.map(([title, command]) => `[${title}](command:${command}?${target})`).join(' · '),
    ];
    const markdown = new vscode.MarkdownString(sections.filter(Boolean).join('\n\n'));
    markdown.isTrusted = { enabledCommands: [NotesProvider.OPEN_BESIDE, NotesProvider.GO_TO_MARKER, ...actions.map(([, command]) => command)] };
    return markdown;
  }
}

/** What the comment box's buttons pass: the thread and the text typed into its box. */
interface NoteReply {
  thread: { uri: vscode.Uri; range?: vscode.Range; dispose(): void };
  text: string;
}

/**
 * Shows markers (Notes) inside the editor, as comment threads at their lines, like review comments: one box per
 * marker, titled with its name. Above each marker's line, the links in its note are clickable by name
 * (provideCodeLenses), so you can follow them without opening the box. Add Marker (Cmd+Alt+N) makes one, asking for
 * its name; its note is written with Edit, where `[[` offers the markers to link to. A link made here is written both
 * ways, each way a link of its own in its marker's note (linkBack). Every change is written to the notes file, which
 * stays the only place markers are kept.
 */
export class NotesComments implements vscode.Disposable, vscode.CodeLensProvider, vscode.CompletionItemProvider {
  static readonly NOTE = 'incontext.note';
  static readonly SELECT_AT = 'incontext.notes.selectAt';
  static readonly RENAME_AT = 'incontext.notes.renameAt';
  static readonly LINK_AT = 'incontext.notes.linkAt';
  static readonly UNLINK_AT = 'incontext.notes.unlinkAt';
  static readonly MOVE_AT = 'incontext.notes.moveAt';
  static readonly EDIT_AT = 'incontext.notes.editAt';
  static readonly OPEN_AT = 'incontext.notes.openAt';
  static readonly DELETE_AT = 'incontext.notes.deleteAt';
  static readonly OPEN_BOX_AT = 'incontext.notes.openBoxAt';
  static readonly TOGGLE_BOX_AT = 'incontext.notes.toggleBoxAt';
  /** `+` above lines no marker is on but notes refer to: `(source file URI, first line, last line)`, 0-based lines. */
  static readonly MARK_AT = 'incontext.notes.markAt';
  /** Makes a marker without asking its name: `(source file URI, first line, last line, name)`, 0-based lines. */
  static readonly CREATE_MARKER = 'incontext.notes.createMarker';
  /** How many links show above a marker's line before the rest are counted in a `+3 more` that opens the box. */
  private static readonly LENSES = 4;
  private static readonly LABEL = 'InContext';
  /** The extension's logo, beside each box's name and in the gutter at each note's line. */
  static icon?: vscode.Uri;
  private readonly gutter: vscode.TextEditorDecorationType;
  /** Which boxes the logo was last drawn beside, and the timer that checks for boxes opened or closed since. */
  private decorated = '';
  private readonly watchOpen: NodeJS.Timeout;
  private tintTimer: NodeJS.Timeout | undefined;
  private readonly controller = vscode.comments.createCommentController('incontext.notes', NotesComments.LABEL);
  /** The boxes shown in each file, by the file's URI. */
  private readonly threads = new Map<string, vscode.CommentThread[]>();
  /** The references from markers to each file's lines that no marker is on, by the file's URI: links above the line only. */
  private readonly hints = new Map<string, BackLink[]>();
  /**
   * Boxes you opened or closed against their default, kept so when their file's boxes are next drawn:
   * `<file uri>|<first line>` to open (true) or closed (false).
   */
  private readonly toggled = new Map<string, boolean>();
  /** The files shown in a tab, as last seen. */
  private shown = NotesComments.shownFiles();
  /** Whether the active editor has a box open, as last told to VS Code (`incontext.notes.openInEditor`). */
  private openInEditor = false;
  /** While the boxes are drawn again for a change of `incontext.notes.startClosed`: their open state isn't kept. */
  private forgetToggles = false;
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  /** Where a marker is in the collection you are going through, above its line: `‹ | Image upload 3/5 | ›` (CollectionsTree.stepLenses). */
  stepLenses: (source: vscode.Uri, name: string) => vscode.Command[] = () => [];
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /**
   * How many times each file's boxes have been asked to be drawn, by the file's URI. A draw waits on the notes files
   * and another can start meanwhile (a save, the notes folder changing, a file opening): only the latest draws.
   */
  private readonly draws = new Map<string, number>();
  /** The box being edited and when its edit began, for Cmd+Enter and Esc. */
  private editing?: NoteComment;
  private editingSince = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly backlinks: NotesBacklinks, extensionUri: vscode.Uri) {
    NotesComments.icon = vscode.Uri.joinPath(extensionUri, 'icon.png');
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconPath: NotesComments.icon,
      gutterIconSize: 'contain',
      overviewRulerColor: '#3d7ab8',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.controller.options = { prompt: 'Add a marker', placeHolder: "Its name on the first line, then a note in Markdown. Type [[ to link to a marker, or paste references copied with Cmd+'" };
    this.setGutterButton();
    this.disposables.push(
      this.controller,
      this.lensesChanged,
      this.gutter,
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('incontext.notes.gutterAddButton')) {
          this.setGutterButton();
        }
        // Every box starts again as the setting now says, forgetting which you opened or closed
        if (event.affectsConfiguration('incontext.notes.startClosed')) {
          this.toggled.clear();
          this.forgetToggles = true;
          void this.redrawAll().finally(() => { this.forgetToggles = false; });
        }
      }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      // `[[` in a box being written offers the markers to link to (VS Code's comment boxes are `comment:` documents)
      vscode.languages.registerCompletionItemProvider({ scheme: 'comment' }, this, '['),
      vscode.workspace.onDidOpenTextDocument(document => this.redraw(document)),
      vscode.workspace.onDidCloseTextDocument(document => this.clear(document.uri)),
      // A file's boxes close with its last tab and start closed in its first, so a file opened again shows every note closed
      vscode.window.tabGroups.onDidChangeTabs(() => this.changedTabs()),
      vscode.workspace.onDidChangeTextDocument(event => this.changed(event.document)),
      // Any notes file can change the boxes of any open file: its own notes, or the back-links of the files it points at
      backlinks.onDidChange(() => this.redrawAll()),
      vscode.commands.registerCommand('incontext.addNote', () => this.addNote()),
      vscode.commands.registerCommand('incontext.notes.create', (reply: NoteReply) => this.create(reply)),
      vscode.commands.registerCommand('incontext.notes.cancelDraft', (reply: NoteReply) => this.closeDraft(reply.thread)),
      vscode.commands.registerCommand('incontext.notes.cancelFocused', () => this.cancelFocused()),
      vscode.commands.registerCommand('incontext.notes.submitFocused', () => this.submitFocused()),
      vscode.commands.registerCommand(NotesComments.SELECT_AT, (file: string, line: number) => this.withThread(file, line, thread => NotesComments.select(thread))),
      vscode.commands.registerCommand(NotesComments.RENAME_AT, (file: string, line: number) => this.withThread(file, line, thread => this.rename(thread))),
      vscode.commands.registerCommand('incontext.notes.rename', () => {
        const editor = vscode.window.activeTextEditor;
        const thread = editor && this.threads.get(editor.document.uri.toString())
          ?.find(box => (box.comments[0] as NoteComment).lines.contains(editor.selection.active));
        return thread ? this.rename(thread) : vscode.window.showInformationMessage('Put the cursor on a marker\'s lines to rename it.');
      }),
      vscode.commands.registerCommand(NotesComments.LINK_AT, (file: string, line: number) => this.withThread(file, line, thread => this.linkTo(thread))),
      vscode.commands.registerCommand(NotesComments.UNLINK_AT, (file: string, line: number) => this.withThread(file, line, thread => this.unlink(thread))),
      vscode.commands.registerCommand(NotesComments.OPEN_BOX_AT, (file: string, line: number) => this.markOpen(file, line)),
      vscode.commands.registerCommand(NotesComments.TOGGLE_BOX_AT, (file: string, line: number) => this.toggleBox(file, line)),
      vscode.commands.registerCommand(NotesComments.MARK_AT, (file: string, first: number, last: number) => this.markAt(vscode.Uri.parse(file, true), first, last)),
      vscode.commands.registerCommand(NotesComments.CREATE_MARKER, (file: string, first: number, last: number, name: string) => this.createMarker(vscode.Uri.parse(file, true), first, last, name)),
      vscode.commands.registerCommand(NotesComments.MOVE_AT, (file: string, line: number) => this.withThread(file, line, thread => this.moveToSelection(thread))),
      vscode.commands.registerCommand(NotesComments.EDIT_AT, (file: string, line: number) => this.withThread(file, line, thread => this.edit(thread.comments[0] as NoteComment))),
      vscode.commands.registerCommand(NotesComments.OPEN_AT, (file: string, line: number) => this.withThread(file, line, thread => this.openMarkdown(thread))),
      vscode.commands.registerCommand(NotesComments.DELETE_AT, (file: string, line: number) => this.withThread(file, line, thread => this.delete(thread))),
      vscode.commands.registerCommand('incontext.notes.edit', (thread: vscode.CommentThread) => this.edit(thread.comments[0] as NoteComment)),
      vscode.commands.registerCommand('incontext.notes.save', (comment: NoteComment) => this.save(comment)),
      vscode.commands.registerCommand('incontext.notes.cancelEdit', (comment: NoteComment) => this.cancelEdit(comment)),
      vscode.commands.registerCommand('incontext.notes.delete', (thread: vscode.CommentThread) => this.delete(thread)),
      vscode.commands.registerCommand('incontext.notes.openMarkdown', (thread: vscode.CommentThread) => this.openMarkdown(thread)),
      vscode.commands.registerCommand('incontext.notes.toggleInFile', () => this.toggleInFile()),
      vscode.commands.registerCommand('incontext.notes.closeInEditor', () => this.closeInEditor()),
      // To say whether a box is open in the editor you are in; boxes are drawn again only when they change
      vscode.window.onDidChangeActiveTextEditor(() => this.decorate(false)),
      vscode.commands.registerCommand('incontext.notes.closeAll', () => {
        this.threads.forEach((threads, file) => this.setOpen(file, threads, false));
      }),
    );
    void this.redrawAll();
    // VS Code says nothing when you open or close a box, but the box's state follows, so look a few times a second
    this.watchOpen = setInterval(() => this.decorate(false), 300);
  }

  /** Draws the lenses above markers again, such as when you go on to another step of a collection. */
  refreshLenses(): void {
    this.lensesChanged.fire();
  }

  dispose(): void {
    clearInterval(this.watchOpen);
    clearTimeout(this.tintTimer);
    this.pending.forEach(timer => clearTimeout(timer));
    this.threads.forEach(threads => threads.forEach(thread => thread.dispose()));
    this.disposables.forEach(disposable => disposable.dispose());
  }

  /**
   * Above each marker's line, its name and then the links in its note, each a click of its own between `|` marks:
   * `Validates the amount → | Persists the refund | handler.ts:L30 |`. The name opens or closes its box. The first few
   * links, then `+3 more`, which opens the box. A link
   * from another marker shows here only when this note links back. A note's plain reference to lines, which can't be
   * linked back, shows `← <its marker>` above them: after a marker's own links (Edit offers a link back to each), and
   * above lines no marker is on, after a `+` that makes one there (markAt), whose note can then name them.
   */
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const key = document.uri.toString();
    const lenses: vscode.CodeLens[] = [];
    const lens = (line: number, command: vscode.Command) => lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), command));
    for (const comment of (this.threads.get(key) ?? []).map(thread => thread.comments[0] as NoteComment)) {
      const line = comment.lines.start.line;
      const links = NotesComments.onward(comment.note, document.uri);
      // The name, which opens or closes the marker's box, then each link a click of its own
      lens(line, {
        title: links.length ? `${comment.note.name} →` : comment.note.name,
        tooltip: NotesComments.summary(comment.note.text) || 'Open or close its box',
        command: NotesComments.TOGGLE_BOX_AT,
        arguments: [key, line],
      });
      const shown = links.length > NotesComments.LENSES ? links.slice(0, NotesComments.LENSES - 1) : links;
      shown.forEach(command => lens(line, command));
      if (shown.length < links.length) {
        lens(line, {
          title: `+${links.length - shown.length} more`,
          tooltip: links.slice(shown.length).map(command => command.title).join(' · '),
          command: NotesComments.OPEN_BOX_AT,
          arguments: [key, line],
        });
      }
      const back = comment.backLinks.filter(link => link.kind === 'reference');
      back.forEach(link => lens(line, NotesComments.backCommand(link)));
      const place = this.stepLenses(document.uri, comment.note.name);
      place.forEach(command => lens(line, command));
      // A `|` after the last link too, so each link reads between two (`Name → | Next |`): an empty item at the end,
      // which VS Code separates from the one before like any other
      if ((links.length || back.length) && !place.length) {
        lens(line, { title: '', command: '' });
      }
    }
    const unmarked = new Map<number, BackLink[]>();
    for (const link of this.hints.get(key) ?? []) {
      const line = Math.min(link.targetLine, document.lineCount - 1);
      unmarked.set(line, [...unmarked.get(line) ?? [], link]);
    }
    for (const [line, links] of unmarked) {
      const toLines = links.filter(NotesComments.toLines);
      if (toLines.length) {
        lens(line, {
          title: '+',
          tooltip: 'Add a marker here, with a link back to each of these in its note, to name them there',
          command: NotesComments.MARK_AT,
          arguments: [key, line, Math.min(Math.max(...toLines.map(link => link.targetEndLine)), document.lineCount - 1)],
        });
      }
      links.forEach(link => lens(line, NotesComments.backCommand(link)));
    }
    return lenses;
  }

  /** Whether a back-link is a reference to lines, which a marker on them takes (claimReferences): not to a whole file. */
  private static toLines(link: BackLink): boolean {
    return link.kind === 'reference' && ReferenceParser.parse(link.reference)?.startLine !== undefined;
  }

  /** `← <name>`: back to the marker a link comes from, with its note on hover. */
  private static backCommand(link: BackLink): vscode.Command {
    return {
      title: `← ${link.name}`,
      tooltip: NotesComments.summary(link.text) || link.name,
      command: NotesBacklinks.GO_TO_NOTE,
      arguments: [link.source.toString(), link.line, link.lines, link.anchor],
    };
  }

  /**
   * `<name>` for each marker a marker's note links to, and `handler.ts:L30` for each place it refers to, in order; or
   * the name the note gives it (Notes.labelAt), which is only this note's.
   */
  private static onward(note: Note, source: vscode.Uri): vscode.Command[] {
    const links = [...note.text.matchAll(Notes.LINK)].map((match): { at: number; command?: vscode.Command } => {
      const name = match[2].trim();
      const target = Notes.linkTarget({ path: match[1].trim() }, source);
      const label = Notes.labelAt(note.text, match.index!, match.index! + match[0].length);
      return {
        at: match.index!,
        command: target && { title: label ?? name, tooltip: `${name} · ${path.basename(target.fsPath)}`, command: NotesProvider.GO_TO_MARKER, arguments: [target.toString(), name] },
      };
    });
    const references = Notes.referencesIn(note.text).map((match): { at: number; command?: vscode.Command } => ({
      at: match.start,
      command: {
        title: Notes.labelAt(note.text, match.start, match.end) ?? NotesProvider.shortLabel(match.reference),
        tooltip: match.reference,
        command: NotesProvider.OPEN_BESIDE,
        arguments: [match.reference],
      },
    }));
    const seen = new Set<string>();
    return [...links, ...references].sort((a, b) => a.at - b.at)
      .map(({ command }) => command)
      .filter((command): command is vscode.Command => !!command && !seen.has(JSON.stringify(command.arguments)) && !!seen.add(JSON.stringify(command.arguments)));
  }

  /**
   * A marker's name for its box's header. VS Code escapes the header for HTML and then shows it as text, so `>` would
   * read `&gt;`: `->` shows as an arrow, and `<`, `>` and `&` as their full-width forms.
   */
  static label(name: string): string {
    return name.replace(/->/g, '→').replace(/<-/g, '←').replace(/[<>&]/g, mark => String.fromCharCode(mark.charCodeAt(0) + 0xfee0));
  }

  /** A note on one line, for a link's tooltip. */
  static summary(text: string): string {
    return text.split('\n').map(line => line.trim()).filter(Boolean).join(' · ');
  }

  /** Opens the box of the marker whose first line this is, as `+3 more` above its line does. */
  private markOpen(file: string, line: number): void {
    this.toggled.set(`${file}|${line}`, true);
    const thread = this.threads.get(file)?.find(box => (box.comments[0] as NoteComment).lines.start.line === line);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
    this.decorate();
  }

  /** Opens the box of the marker whose first line this is, or closes it when it is open, as its name above it does. */
  private toggleBox(file: string, line: number): void {
    const thread = this.threadAt(file, line);
    if (thread?.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) {
      this.markOpen(file, line);
      return;
    }
    this.toggled.set(`${file}|${line}`, false);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.decorate();
  }

  /** The files a tab shows: a text editor's, or both sides of a diff. */
  private static tabFiles(tab: vscode.Tab): string[] {
    const input = tab.input;
    if (input instanceof vscode.TabInputText) {
      return [input.uri.toString()];
    }
    return input instanceof vscode.TabInputTextDiff ? [input.original.toString(), input.modified.toString()] : [];
  }

  private static shownFiles(): Set<string> {
    return new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(NotesComments.tabFiles)));
  }

  /**
   * A box you open stays open while its file has a tab. When the file's last tab closes, or its first one opens, its
   * boxes go back to how they start (closed, unless `incontext.notes.startClosed` is off) and which you opened is
   * forgotten: VS Code keeps a closed file's document a while, and a box can be opened in a file with no tab, so they
   * would otherwise come back open. Going to a marker, by a link or from the Markers view, opens no box.
   */
  private changedTabs(): void {
    const before = this.shown;
    this.shown = NotesComments.shownFiles();
    const changed = [...before].filter(file => !this.shown.has(file)).concat([...this.shown].filter(file => !before.has(file)));
    for (const file of changed) {
      this.setOpen(file, this.threads.get(file) ?? []);
    }
  }

  /**
   * Opens or closes a file's boxes, all of them, and keeps that for when they are next drawn; without `open`, each goes
   * back to how it starts. A box being edited stays as it is.
   */
  private setOpen(file: string, threads: vscode.CommentThread[], open?: boolean): void {
    for (const key of [...this.toggled.keys()]) {
      if (key.startsWith(`${file}|`)) {
        this.toggled.delete(key);
      }
    }
    for (const thread of threads) {
      const comment = thread.comments[0] as NoteComment;
      if (comment.mode === vscode.CommentMode.Editing) {
        continue;
      }
      const starts = NotesComments.startsOpen(comment.note);
      if (open !== undefined && open !== starts) {
        this.toggled.set(`${file}|${comment.lines.start.line}`, open);
      }
      thread.collapsibleState = (open ?? starts) ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
    }
    this.decorate();
  }

  /**
   * Esc in an editor with a box open: closes the file's boxes. Only when Esc has nothing else to do there (a
   * selection, the find or suggest widget, a snippet...), which the keybinding's `when` says.
   */
  private closeInEditor(): void {
    const file = vscode.window.activeTextEditor?.document.uri.toString();
    if (file) {
      this.setOpen(file, this.threads.get(file) ?? [], false);
    }
  }

  /** The active editor's boxes: all closed when any is open, otherwise all opened. */
  private toggleInFile(): void {
    const file = vscode.window.activeTextEditor?.document.uri.toString();
    const threads = file ? this.threads.get(file) ?? [] : [];
    if (!file || !threads.length) {
      vscode.window.setStatusBarMessage('No notes in this file', 2000);
      return;
    }
    this.setOpen(file, threads, !threads.some(thread => thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded));
  }

  /** A marker with no note, a bookmark: it has nothing to show but its links, so it starts closed. */
  private static isEmpty(note: Note | undefined): boolean {
    return !note?.text.trim();
  }

  /**
   * Whether a box starts open, unless you opened or closed it: one with a note does when `incontext.notes.startClosed`
   * is off. Closed, its line shows the InContext logo in the gutter and the note on hover.
   */
  private static startsOpen(note: Note | undefined): boolean {
    return !NotesComments.isEmpty(note) && !vscode.workspace.getConfiguration('incontext.notes').get<boolean>('startClosed', true);
  }

  /** The box on the cursor's line, opened for editing, or a new note's box for the line or the selected lines. */
  /**
   * The + beside each line that adds a note, off unless `incontext.notes.gutterAddButton` is on. VS Code shows it on
   * the lines a comment controller says can take a comment, and also draws a grey bar down the gutter beside all of
   * them, which for notes is every line of every file. Add Note (Cmd+Alt+N, the editor's context menu) needs neither.
   */
  private setGutterButton(): void {
    const on = vscode.workspace.getConfiguration('incontext.notes').get<boolean>('gutterAddButton', false);
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => on && Notes.canHaveNotes(document.uri) ? [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)] : [],
    };
  }

  /**
   * Add Marker (Cmd+Alt+N): on a marker's line, edits its note; elsewhere, makes a marker on the line or the selected
   * lines, asking for its name, with no note yet, like a bookmark.
   */
  private async addNote(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !Notes.canHaveNotes(editor.document.uri)) {
      vscode.window.showErrorMessage('Open a file inside a workspace folder to add a marker to one of its lines.');
      return;
    }
    const { start, end } = editor.selection;
    const existing = this.threadAt(editor.document.uri.toString(), start.line);
    if (existing) {
      existing.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.edit(existing.comments[0] as NoteComment);
      return;
    }
    await this.addToNotesFile(editor.document.uri, new vscode.Range(start, end), '');
  }

  /** A box VS Code made for the + beside a line (incontext.notes.gutterAddButton), given up. */
  private closeDraft(thread: NoteReply['thread']): void {
    thread.dispose();
  }

  /**
   * Cmd+Enter in a box: saves the edit and closes the box. VS Code sends it to the thread's reply box, which a note
   * doesn't have, so an edit would go nowhere: this reads its text from the box (a `comment:` document). A new note's
   * box saves as VS Code saves it.
   */
  private async submitFocused(): Promise<void> {
    const comment = this.editing;
    if (comment?.mode !== vscode.CommentMode.Editing) {
      await vscode.commands.executeCommand('editor.action.submitComment');
      return;
    }
    // VS Code names an edit box /commentinput-<comment>-<time it opened>.md
    const opened = (document: vscode.TextDocument) => Number(/^\/commentinput-[^/]+-(\d+)\.md$/.exec(document.uri.path)?.[1] ?? 0);
    const box = vscode.workspace.textDocuments
      .filter(document => document.uri.scheme === 'comment' && opened(document) >= this.editingSince - 1000)
      .sort((a, b) => opened(b) - opened(a))[0];
    if (box) {
      comment.body = box.getText();
      // Saved and closed: drawn again closed (redraw keeps how the box was)
      comment.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      await this.save(comment);
    }
  }

  /** Esc in a box: cancels the edit; any other box closes as VS Code closes it. */
  private async cancelFocused(): Promise<void> {
    if (this.editing?.mode === vscode.CommentMode.Editing) {
      this.cancelEdit(this.editing);
    } else {
      await vscode.commands.executeCommand('workbench.action.hideComment');
    }
  }

  private async withThread(file: string, line: number, run: (thread: vscode.CommentThread) => unknown): Promise<void> {
    const thread = this.threadAt(file, line);
    if (thread) {
      await run(thread);
    }
  }

  /** Selects and reveals the lines a box covers. */
  private static async select(thread: vscode.CommentThread): Promise<void> {
    const { lines } = thread.comments[0] as NoteComment;
    const editor = await vscode.window.showTextDocument(thread.uri, { selection: lines, preserveFocus: false });
    editor.revealRange(lines, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Where a box sits. VS Code draws a comment box after its thread's last line, so a box above its lines (the
   * setting's default) belongs to the line before them; on a file's first line it can only go below. A marker with no
   * note, a bookmark, sits on its first line instead, so the logo in the gutter is on the marker's own line.
   */
  static anchor(lines: vscode.Range, note?: Note): vscode.Range {
    if (NotesComments.isEmpty(note)) {
      return new vscode.Range(lines.start, lines.start);
    }
    const above = vscode.workspace.getConfiguration('incontext.notes').get<string>('position', 'above') === 'above';
    return above && lines.start.line > 0 ? new vscode.Range(lines.start.line - 1, 0, lines.start.line - 1, 0) : lines;
  }

  /**
   * Moves a marker to the lines selected in its file's editor, or to the cursor's line, keeping its name, and points
   * the references elsewhere to exactly its lines there too; links to it by its name follow it anyway. How a marker's
   * lines change, or a marker moves up or down.
   */
  private async moveToSelection(thread: vscode.CommentThread): Promise<void> {
    const { note, backLinks, lines } = thread.comments[0] as NoteComment;
    const editor = vscode.window.visibleTextEditors.find(visible => visible.document.uri.toString() === thread.uri.toString());
    if (!editor) {
      vscode.window.showInformationMessage('Select the lines in the file first, then choose Move to selection.');
      return;
    }
    const { start, end } = editor.selection;
    const last = NotesComments.lastLine(new vscode.Range(start, end));
    const file = Notes.fileFor(thread.uri);
    if (file) {
      const heading = Notes.heading(note.name, start.line + 1, editor.document.lineAt(start.line).text, last + 1);
      await Notes.write(file, Notes.withHeading(await Notes.read(file) ?? '', note.headingLine, heading));
    }
    // A reference that points at only part of a marker's lines keeps pointing there
    const pointed = ReferenceUtils.createCodeReference(editor.document.uri, new vscode.Selection(start.line, 0, last, 0));
    for (const link of backLinks.filter(candidate => candidate.kind === 'reference' && candidate.targetLine === lines.start.line && candidate.targetEndLine === lines.end.line)) {
      const text = await Notes.read(link.notesFile);
      const pointing = text === undefined ? undefined : Notes.parse(text).find(candidate => candidate.headingLine === link.headingLine);
      if (text !== undefined && pointing) {
        await Notes.write(link.notesFile, Notes.withSection(text, link.headingLine, pointing.text.split(link.reference).join(pointed)));
      }
    }
    await this.redraw(editor.document);
  }

  /**
   * Saves the text typed into a box VS Code made for the + beside a line as a new marker: its first line the name and
   * the rest its note (nameAndNote), or, when the first line can't be a name, all of it the note, asking the name.
   */
  private async create(reply: NoteReply): Promise<void> {
    const { name, note } = NotesComments.nameAndNote(reply.text);
    if (await this.addToNotesFile(reply.thread.uri, reply.thread.range, note, name)) {
      this.closeDraft(reply.thread);
    }
  }

  /**
   * `+` above lines no marker is on but notes refer to: makes a marker there, asking its name, which takes those
   * references (claimReferences), and opens its box in Edit, with a link back to each to name or take out.
   */
  private async markAt(source: vscode.Uri, first: number, last: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(source);
    if (!await this.addToNotesFile(source, new vscode.Range(first, 0, last, document.lineAt(last).text.length), '')) {
      return;
    }
    const thread = this.threadAt(source.toString(), first);
    if (thread) {
      this.toggled.set(`${source.toString()}|${first}`, true);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.edit(thread.comments[0] as NoteComment);
    }
  }

  /** Makes a marker named `name` with no note, as `[[` does for the selection in an editor. */
  private async createMarker(source: vscode.Uri, first: number, last: number, name: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(source);
    await this.addToNotesFile(source, new vscode.Range(first, 0, last, document.lineAt(last).text.length), '', name);
  }

  /**
   * Writes a new marker on some lines of a file into its notes file, with its note (which may be empty), asking for
   * the notes folder the first time and, unless given, the marker's name. False when none is made: Esc at its name.
   * Other notes' references to those lines become links to it, each linked back from its note (claimReferences).
   */
  private async addToNotesFile(source: vscode.Uri, range: vscode.Range | undefined, text: string, name?: string): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(source);
    const file = Notes.fileFor(source) ?? (await Notes.askFolder() ? Notes.fileFor(source) : undefined);
    if (!file) {
      return false;
    }
    const lines = range ?? new vscode.Range(0, 0, 0, 0);
    const last = NotesComments.lastLine(lines);
    const current = await Notes.read(file) ?? `# Notes on ${ReferenceUtils.createFileReference(source)}\n`;
    const taken = Notes.parse(current, path.basename(source.fsPath)).map(note => note.name);
    const asked = name === undefined ? await NotesComments.askName(document, lines.start.line, taken) : { name, note: '' };
    if (!asked) {
      return false;
    }
    const unique = Notes.uniqueName(asked.name, taken);
    const heading = Notes.heading(unique, lines.start.line + 1, document.lineAt(lines.start.line).text, last + 1);
    const note = await NotesComments.linkify([text.trim(), asked.note].filter(Boolean).join('\n\n'), source, unique);
    await Notes.write(file, Notes.withNote(current, heading, note));
    // The references to these lines in other markers' notes become links to it, each with a link back in its note
    const claimed = await NotesComments.claimReferences(source, new vscode.Range(lines.start.line, 0, last, 0), unique);
    const withBack = NotesComments.withLinksBack(note, source, unique, claimed);
    if (withBack !== note) {
      const now = await Notes.read(file) ?? '';
      const made = Notes.parse(now, path.basename(source.fsPath)).find(other => other.name === unique);
      await Notes.write(file, made ? Notes.withSection(now, made.headingLine, withBack) : now);
    }
    await NotesComments.linkBack(source, unique, [], withBack);
    // A note you just wrote stays open, also when boxes start closed; a marker with no note yet is a bookmark
    if (text.trim()) {
      this.toggled.set(`${document.uri.toString()}|${lines.start.line}`, true);
    }
    await this.redraw(document);
    return true;
  }

  /**
   * Asks for a new marker's name, offering its line's text (or `handler.ts:L30` for a line with little to read), which
   * Enter keeps; Esc makes no marker. The box takes more than a name. `[[` lists the markers by name: the one picked is
   * linked from the new marker, and starts its name, `Validates the amount -> <its line's text>`, with the rest
   * selected to type over (Esc in the list goes back to the name). A reference pasted in goes into the new marker's
   * note, and the name is left blank to type, Enter keeping the one offered. `note` is the new marker's note: its links
   * and references.
   */
  private static async askName(document: vscode.TextDocument, line: number, taken: string[]): Promise<{ name: string; note: string } | undefined> {
    const file = path.basename(document.uri.fsPath);
    const offered = Notes.uniqueName(Notes.fallbackName(document.lineAt(line).text, file, line + 1), taken);
    let value = offered;
    let selection: [number, number] = [0, offered.length];
    const note: string[] = [];
    for (;;) {
      const typed = await NotesComments.inputName(`Name the marker on ${file}:L${line + 1}`, value, selection, offered, taken, note);
      const at = typed?.indexOf('[[') ?? -1;
      if (typed === undefined || at < 0) {
        return typed === undefined ? undefined : { name: Notes.cleanName(typed) || offered, note: note.join('\n') };
      }
      const picked = await NotesComments.pickMarker(typed.slice(at + 2).replace(/\]+$/, ''));
      if (picked) {
        note.push(Notes.link(picked.source, picked.note.name));
        const start = `${picked.note.name} -> `;
        value = `${start}${offered}`;
        selection = [start.length, value.length];
      } else {
        value = typed.slice(0, at);
        selection = [value.length, value.length];
      }
    }
  }

  /**
   * A name typed or pasted with references in it, without them: what was typed around them, and the references, which
   * go into the new marker's note. Only references with a path (`@project/...`), so a name can still have an `@`.
   */
  static takeReferences(value: string): { name: string; references: string[] } {
    const matches = ReferenceParser.findStandaloneReferences(value);
    let name = value;
    for (const match of [...matches].reverse()) {
      name = `${name.slice(0, match.start).trimEnd()} ${name.slice(match.end).trimStart()}`;
    }
    return { name: name.trim(), references: matches.map(match => match.reference) };
  }

  /**
   * The name box: what was typed when Enter is pressed, or as soon as it has `[[` (to pick a marker); undefined for Esc.
   * A reference pasted in is taken out into `note`, the new marker's note, and the box says so; left blank, the name
   * box shows the name Enter keeps (`offered`). VS Code's showInputBox can't say what was typed until Enter.
   */
  private static inputName(title: string, value: string, selection: [number, number], offered: string, taken: string[], note: string[]): Promise<string | undefined> {
    return new Promise(resolve => {
      const input = vscode.window.createInputBox();
      input.title = title;
      input.placeholder = offered;
      const prompt = () => {
        const shown = note.map(text => Notes.linksIn(text)[0]?.name ?? NotesProvider.shortLabel(text));
        input.prompt = shown.length
          ? `Its note: ${shown.join(', ')}. Type a name, or Enter keeps the one shown. Esc makes no marker.`
          : 'A short name for these lines, shown wherever links lead here. Type [[ to link it to a marker, or paste a reference.';
      };
      prompt();
      input.value = value;
      input.valueSelection = selection;
      let previous = value;
      let done = false;
      const finish = (result: string | undefined) => {
        if (!done) {
          done = true;
          resolve(result);
          input.dispose();
        }
      };
      // References typed by hand are taken out at Enter, so one isn't taken while it is still being typed
      const take = (typed: string) => {
        const { name, references } = NotesComments.takeReferences(typed);
        note.push(...references.filter(reference => !note.includes(reference)));
        prompt();
        return name;
      };
      input.onDidChangeValue(changed => {
        if (changed.includes('[[')) {
          finish(changed);
          return;
        }
        if (changed.length - previous.length > 1 && NotesComments.takeReferences(changed).references.length) {
          changed = take(changed);
          input.value = changed;
          input.valueSelection = [changed.length, changed.length];
        }
        previous = changed;
        input.validationMessage = taken.includes(Notes.cleanName(changed)) ? 'Another marker in this file has that name' : undefined;
      });
      input.onDidAccept(() => {
        if (!input.validationMessage) {
          finish(take(input.value));
        }
      });
      input.onDidHide(() => finish(undefined));
      input.show();
    });
  }

  /** Every marker by name, to link a new marker to, narrowed by what was typed after `[[`; undefined for Esc. */
  private static async pickMarker(typed: string): Promise<NoteEntry | undefined> {
    const entries = await NotesBacklinks.readNotes();
    return new Promise(resolve => {
      const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { entry: NoteEntry }>();
      pick.title = 'Link the new marker to…';
      pick.placeholder = entries.length ? 'A marker, by name or file' : 'No markers yet: Esc to go back to the name';
      pick.matchOnDescription = true;
      pick.matchOnDetail = true;
      pick.items = entries.map(entry => ({
        label: `$(bookmark) ${entry.note.name}`,
        description: `${path.basename(entry.source.fsPath)}:L${entry.note.line}`,
        detail: NotesComments.summary(entry.note.text) || undefined,
        entry,
      }));
      pick.value = typed;
      let done = false;
      const finish = (entry: NoteEntry | undefined) => {
        if (!done) {
          done = true;
          resolve(entry);
          pick.dispose();
        }
      };
      pick.onDidAccept(() => finish(pick.selectedItems[0]?.entry));
      pick.onDidHide(() => finish(undefined));
      pick.show();
    });
  }

  /** Asks for a marker's new name; undefined for Esc. */
  private static async askRename(document: vscode.TextDocument, current: string, taken: string[]): Promise<string | undefined> {
    const typed = await vscode.window.showInputBox({
      title: `Rename the marker "${current}"`,
      prompt: 'Links to it are renamed too.',
      value: current,
      valueSelection: [0, current.length],
      validateInput: value => taken.includes(Notes.cleanName(value)) && Notes.cleanName(value) !== current
        ? 'Another marker in this file has that name' : undefined,
    });
    return typed === undefined ? undefined : Notes.cleanName(typed) || current;
  }

  /**
   * A note's text with each reference to lines a marker is on made a link to that marker, so it shows by name and
   * follows the marker. Not a reference to a whole file, nor to the marker the note is on. A name the note gives it
   * (`Caller: @...`) stays in front of the link.
   */
  private static async linkify(text: string, source: vscode.Uri, self: string): Promise<string> {
    const references = Notes.referencesIn(text);
    if (!references.length) {
      return text;
    }
    const entries = await NotesBacklinks.readNotes();
    let linked = '';
    let last = 0;
    for (const match of references) {
      const target = NotesBacklinks.targetOf(match.reference);
      let replacement = match.reference;
      if (target && ReferenceParser.parse(match.reference)?.startLine !== undefined) {
        for (const entry of entries.filter(candidate => candidate.source.fsPath === target.file.fsPath)) {
          const lines = !(entry.source.fsPath === source.fsPath && entry.note.name === self) && await NotesBacklinks.linesOf(entry);
          if (lines && lines.start.line <= target.line && target.line <= lines.end.line) {
            replacement = Notes.link(entry.source, entry.note.name);
            break;
          }
        }
      }
      linked += text.slice(last, match.start) + replacement;
      last = match.end;
    }
    return linked + text.slice(last);
  }

  /**
   * Edits a marker: its name on the first line, then its note (nameAndNote reads them back). The note ends with a link
   * back to each marker whose note refers to its lines (`← <name>` above it), to name (`Caller: [[...]]`) or take out:
   * saving makes those references links to this marker (claimReferences).
   */
  private edit(comment: NoteComment): void {
    this.editing = comment;
    this.editingSince = Date.now();
    const referring = comment.backLinks.filter(NotesComments.toLines).map(link => ({ source: link.source, name: link.name }));
    const text = NotesComments.withLinksBack(comment.note.text, comment.thread.uri, comment.note.name, referring);
    comment.body = `${comment.note.name}\n\n${text}`.trimEnd() + '\n';
    comment.mode = vscode.CommentMode.Editing;
    comment.thread.comments = [...comment.thread.comments];
  }

  /**
   * What is typed into a box, read as a marker's name and its note: the first line is the name, and the rest the note.
   * Not when the first line is blank, or has a reference or a link to a marker in it, which a name can't hold: then
   * all of it is the note, and the name is undefined (the marker keeps its name, or a new one is asked for).
   */
  static nameAndNote(typed: string): { name?: string; note: string } {
    const [first, ...rest] = typed.split('\n');
    const name = Notes.cleanName(first ?? '');
    if (!name || Notes.linksIn(first).length || Notes.referencesIn(first).length) {
      return { note: typed.trim() };
    }
    return { name, note: rest.join('\n').trim() };
  }

  /**
   * Saves an edit: the first line its name, which renames the marker and the links to it when it changed, and the rest
   * its note, its references to other markers' lines made links to them. Other notes' references to its lines become
   * links to it; the links back Edit offered are kept as you left them.
   */
  private async save(comment: NoteComment): Promise<void> {
    const typed = typeof comment.body === 'string' ? comment.body : comment.body.value;
    comment.mode = vscode.CommentMode.Preview;
    this.editing = undefined;
    const source = comment.thread.uri;
    const { note } = comment;
    const read = NotesComments.nameAndNote(typed);
    let name = read.name ?? note.name;
    if (name !== note.name) {
      const file = Notes.fileFor(source);
      const others = file ? Notes.parse(await Notes.read(file) ?? '', path.basename(source.fsPath)).map(other => other.name).filter(other => other !== note.name) : [];
      name = Notes.uniqueName(name, others);
    }
    // First: a marker whose reference becomes a link to this one isn't then linked back to again (linkBack)
    await NotesComments.claimReferences(source, comment.lines, name);
    await this.writeNote(source, note, await NotesComments.linkify(read.note, source, name), name);
    if (name !== note.name) {
      await NotesComments.renameLinks(source, note.name, name);
      const document = vscode.workspace.textDocuments.find(open => open.uri.toString() === source.toString());
      if (document) {
        await this.redraw(document);
      }
    }
  }

  /**
   * Writes a marker's note, and its heading the current way (an older note's `## L30: ...` gets its name) with its name
   * (`name`, when it is renamed), and links each marker it now links to back to it (linkBack).
   */
  private async writeNote(source: vscode.Uri, note: Note, text: string, name = note.name): Promise<void> {
    const file = Notes.fileFor(source);
    if (file) {
      const heading = Notes.heading(name, note.line, note.anchor, note.line + note.lines - 1);
      const current = await Notes.read(file) ?? '';
      // The links it has now, as written: the box's copy of the note can be from before its last save
      const before = Notes.parse(current).find(other => other.headingLine === note.headingLine)?.links ?? note.links;
      await Notes.write(file, Notes.withSection(current, note.headingLine, text, heading));
      await NotesComments.linkBack(source, name, before, text);
    }
    const document = vscode.workspace.textDocuments.find(open => open.uri.toString() === source.toString());
    if (document) {
      await this.redraw(document);
    }
  }

  /**
   * Makes each reference to lines in `lines` of `target`, in the other markers' notes, a link to the marker `name` on
   * them, as saving those notes would (linkify): it then shows that marker's name and follows it, with a name the note
   * gives it (`Caller: ...`) kept in front. Not a reference to a whole file. The markers whose notes had one, to link back.
   */
  private static async claimReferences(target: vscode.Uri, lines: vscode.Range, name: string): Promise<{ source: vscode.Uri; name: string }[]> {
    const into = (reference: string) => {
      const at = NotesBacklinks.targetOf(reference);
      return !!at && at.file.fsPath === target.fsPath && ReferenceParser.parse(reference)?.startLine !== undefined
        && lines.start.line <= at.line && at.line <= lines.end.line;
    };
    const claimed: { source: vscode.Uri; name: string }[] = [];
    for (const entry of await NotesBacklinks.readNotes()) {
      if ((entry.source.fsPath === target.fsPath && entry.note.name === name) || !Notes.referencesIn(entry.note.text).some(match => into(match.reference))) {
        continue;
      }
      // Read again: one before it may have been in the same notes file
      const current = await Notes.read(entry.notesFile);
      const marker = current === undefined ? undefined : Notes.parse(current, path.basename(entry.source.fsPath)).find(other => other.name === entry.note.name);
      if (!marker) {
        continue;
      }
      let text = '';
      let last = 0;
      for (const match of Notes.referencesIn(marker.text)) {
        text += marker.text.slice(last, match.start) + (into(match.reference) ? Notes.link(target, name) : match.reference);
        last = match.end;
      }
      text += marker.text.slice(last);
      if (text !== marker.text) {
        const heading = Notes.heading(marker.name, marker.line, marker.anchor, marker.line + marker.lines - 1);
        await Notes.write(entry.notesFile, Notes.withSection(current!, marker.headingLine, text, heading));
        claimed.push({ source: entry.source, name: marker.name });
      }
    }
    return claimed;
  }

  /**
   * The note of the marker `name` on `source` with a link back to each of the markers `from` at its end (Notes.withLink),
   * but for one it already links to, and itself.
   */
  private static withLinksBack(text: string, source: vscode.Uri, name: string, from: { source: vscode.Uri; name: string }[]): string {
    for (const marker of from) {
      const linked = (marker.source.fsPath === source.fsPath && marker.name === name)
        || Notes.linksIn(text).some(link => link.name === marker.name && Notes.linkTarget(link, source)?.fsPath === marker.source.fsPath);
      text = linked ? text : Notes.withLink(text, Notes.link(marker.source, marker.name));
    }
    return text;
  }

  /**
   * A link made in VS Code goes both ways: each marker that the note of the marker `name` on `source` links to, and
   * didn't before (`before`), gets a link back to it at the end of its own note, unless it already has one. Each way
   * is then a link like any other, shown only on the marker whose note has it: take the link back out of that note
   * (Unlink…, or Edit) and the link goes one way only. Not to the marker itself, nor to one there is none by that name.
   */
  private static async linkBack(source: vscode.Uri, name: string, before: MarkerLink[], text: string): Promise<void> {
    const key = (link: MarkerLink, from: vscode.Uri) => `${Notes.linkTarget(link, from)?.fsPath}#${link.name}`;
    const done = new Set(before.map(link => key(link, source)));
    done.add(`${source.fsPath}#${name}`);
    for (const link of Notes.linksIn(text)) {
      const target = Notes.linkTarget(link, source);
      const file = target && Notes.fileFor(target);
      if (!target || !file || done.has(key(link, source))) {
        continue;
      }
      done.add(key(link, source));
      const current = await Notes.read(file);
      const marker = current === undefined ? undefined : Notes.parse(current, path.basename(target.fsPath)).find(other => other.name === link.name);
      if (!marker || marker.links.some(back => key(back, target) === `${source.fsPath}#${name}`)) {
        continue;
      }
      const heading = Notes.heading(marker.name, marker.line, marker.anchor, marker.line + marker.lines - 1);
      await Notes.write(file, Notes.withSection(current!, marker.headingLine, Notes.withLink(marker.text, Notes.link(source, name)), heading));
    }
  }

  /**
   * Renames a marker, and every link to it in the notes of the projects open in this window. Also done by changing the
   * first line in Edit; this is InContext: Rename Marker, for the marker at the cursor.
   */
  private async rename(thread: vscode.CommentThread): Promise<void> {
    const { note } = thread.comments[0] as NoteComment;
    const file = Notes.fileFor(thread.uri);
    const document = await vscode.workspace.openTextDocument(thread.uri);
    const current = file && await Notes.read(file);
    if (!file || current === undefined) {
      return;
    }
    const taken = Notes.parse(current, path.basename(thread.uri.fsPath)).map(other => other.name).filter(other => other !== note.name);
    const name = await NotesComments.askRename(document, note.name, taken);
    if (name === undefined || name === note.name || taken.includes(name)) {
      return;
    }
    await Notes.write(file, Notes.withHeading(current, note.headingLine, Notes.heading(name, note.line, note.anchor, note.line + note.lines - 1)));
    await NotesComments.renameLinks(thread.uri, note.name, name);
    await this.redraw(document);
  }

  /**
   * Renames every link to the marker `oldName` on `target`, in the notes of the projects open in this window and in
   * their collections.
   */
  private static async renameLinks(target: vscode.Uri, oldName: string, newName: string): Promise<void> {
    const notesFiles = new Map<string, Pick<NoteEntry, 'notesFile' | 'source'>>();
    (await NotesBacklinks.readNotes()).forEach(entry => notesFiles.set(entry.notesFile.fsPath, entry));
    (await Collections.readAll()).forEach(collection => notesFiles.set(collection.file.fsPath, { notesFile: collection.file, source: collection.file }));
    for (const { notesFile, source } of notesFiles.values()) {
      const text = await Notes.read(notesFile);
      const renamed = text === undefined ? undefined : Notes.withLinksRenamed(text, source, target, oldName, newName);
      if (text !== undefined && renamed !== text) {
        await Notes.write(notesFile, renamed!);
      }
    }
  }

  /**
   * Link to…: adds a link to another marker at the end of this marker's note, picked from every marker by name, or to
   * a new marker at the lines selected in an editor, which is made, asking its name. That marker links back (linkBack).
   */
  private async linkTo(thread: vscode.CommentThread): Promise<void> {
    const { note, lines } = thread.comments[0] as NoteComment;
    type Pick = vscode.QuickPickItem & { entry?: NoteEntry; at?: { editor: vscode.TextEditor; first: number; last: number } };
    const entries = await NotesBacklinks.readNotes();
    const selections: Pick[] = vscode.window.visibleTextEditors
      .filter(editor => Notes.canHaveNotes(editor.document.uri))
      .map(editor => ({ editor, first: editor.selection.start.line, last: NotesComments.lastLine(new vscode.Range(editor.selection.start, editor.selection.end)) }))
      .filter(at => !(at.editor.document.uri.toString() === thread.uri.toString() && lines.contains(new vscode.Position(at.first, 0))))
      .map(at => ({
        label: '$(add) New marker at the selection',
        description: `${path.basename(at.editor.document.uri.fsPath)}:L${at.first + 1}${at.last > at.first ? `-L${at.last + 1}` : ''}`,
        detail: at.editor.document.lineAt(at.first).text.trim(),
        at,
      }));
    const markers: Pick[] = entries
      .filter(entry => !(entry.source.fsPath === thread.uri.fsPath && entry.note.name === note.name))
      .map(entry => ({ label: `$(bookmark) ${entry.note.name}`, description: `${path.basename(entry.source.fsPath)}:L${entry.note.line}`, detail: NotesComments.summary(entry.note.text) || undefined, entry }));
    const picked = await vscode.window.showQuickPick<Pick>([
      ...selections,
      ...(selections.length && markers.length ? [{ label: 'Markers', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...markers,
    ], { title: `Link "${note.name}" to…`, placeHolder: 'A marker, by name or file', matchOnDescription: true, matchOnDetail: true });
    if (!picked?.entry && !picked?.at) {
      return;
    }
    let link: string;
    if (picked.at) {
      const { editor, first, last } = picked.at;
      const file = Notes.fileFor(editor.document.uri);
      const taken = file ? Notes.parse(await Notes.read(file) ?? '', path.basename(editor.document.uri.fsPath)).map(other => other.name) : [];
      const asked = await NotesComments.askName(editor.document, first, taken);
      const name = asked && Notes.uniqueName(asked.name, taken);
      if (!asked || !name || !await this.addToNotesFile(editor.document.uri, new vscode.Range(first, 0, last, editor.document.lineAt(last).text.length), asked.note, name)) {
        return;
      }
      link = Notes.link(editor.document.uri, name);
    } else {
      link = Notes.link(picked.entry!.source, picked.entry!.note.name);
    }
    await this.writeNote(thread.uri, note, Notes.withLink(note.text, link));
  }

  /** Unlink…: takes the links and references picked out of this marker's note. */
  private async unlink(thread: vscode.CommentThread): Promise<void> {
    const { note } = thread.comments[0] as NoteComment;
    const picked = await vscode.window.showQuickPick([
      ...note.links.map(link => ({ label: `$(bookmark) ${link.name}`, description: link.path || 'this file', text: link.text })),
      ...note.references.map(reference => ({ label: `$(file-code) ${NotesProvider.shortLabel(reference)}`, description: reference, text: reference })),
    ], { title: `Unlink from "${note.name}"`, placeHolder: 'The links to take out of its note', canPickMany: true });
    if (!picked?.length) {
      return;
    }
    const text = picked.reduce((remaining, { text: link }) => remaining.split(link).join(''), note.text)
      .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
    await this.writeNote(thread.uri, note, text);
  }

  private cancelEdit(comment: NoteComment): void {
    comment.body = comment.preview();
    comment.mode = vscode.CommentMode.Preview;
    this.editing = undefined;
    comment.thread.comments = [...comment.thread.comments];
  }

  private async delete(thread: vscode.CommentThread): Promise<void> {
    const { note, backLinks } = thread.comments[0] as NoteComment;
    const file = Notes.fileFor(thread.uri);
    if (!file) {
      return;
    }
    const linked = backLinks.filter(link => link.kind === 'marker').length;
    const detail = [note.text, linked ? `${linked} link${linked === 1 ? '' : 's'} to it will lead nowhere.` : ''].filter(Boolean).join('\n\n');
    const answer = await vscode.window.showWarningMessage(`Delete the marker "${note.name}"?`, { modal: true, detail }, 'Delete');
    if (answer !== 'Delete') {
      return;
    }
    await Notes.write(file, Notes.withSection(await Notes.read(file) ?? '', note.headingLine, undefined));
    const document = vscode.workspace.textDocuments.find(open => open.uri.toString() === thread.uri.toString());
    if (document) {
      await this.redraw(document);
    }
  }

  private async openMarkdown(thread: vscode.CommentThread): Promise<void> {
    const { note } = thread.comments[0] as NoteComment;
    const file = Notes.fileFor(thread.uri);
    if (file) {
      await vscode.commands.executeCommand(NotesProvider.OPEN_NOTE, file.toString(), note.headingLine);
    }
  }

  /**
   * `[[` in a box being written: every marker by name, to link to, and a new marker at the selection in each editor
   * (made once the link is in). What was typed after `[[` narrows the list.
   */
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const text = document.lineAt(position.line).text;
    const typed = /\[\[([^\]\n]*)$/.exec(text.slice(0, position.character));
    if (!typed) {
      return undefined;
    }
    // The `]]` VS Code may have closed the brackets with is replaced too
    const closing = /^\]{0,2}/.exec(text.slice(position.character))![0].length;
    const range = new vscode.Range(position.line, position.character - typed[0].length, position.line, position.character + closing);
    const entries = await NotesBacklinks.readNotes();
    const items = entries.map(entry => {
      const item = new vscode.CompletionItem(entry.note.name, vscode.CompletionItemKind.Reference);
      item.detail = `${path.basename(entry.source.fsPath)}:L${entry.note.line}`;
      item.documentation = new vscode.MarkdownString(entry.note.text || '_No note_');
      item.insertText = Notes.link(entry.source, entry.note.name);
      item.filterText = `[[${entry.note.name}`;
      item.range = range;
      return item;
    });
    for (const editor of vscode.window.visibleTextEditors.filter(visible => Notes.canHaveNotes(visible.document.uri))) {
      const first = editor.selection.start.line;
      const last = NotesComments.lastLine(new vscode.Range(editor.selection.start, editor.selection.end));
      const inFile = entries.filter(entry => entry.source.fsPath === editor.document.uri.fsPath);
      const covered = await Promise.all(inFile.map(async entry => (await NotesBacklinks.linesOf(entry))?.contains(new vscode.Position(first, 0))));
      if (covered.some(Boolean)) {
        continue;
      }
      const name = Notes.uniqueName(Notes.fallbackName(editor.document.lineAt(first).text, path.basename(editor.document.uri.fsPath), first + 1), inFile.map(entry => entry.note.name));
      const item = new vscode.CompletionItem(`New marker: ${name}`, vscode.CompletionItemKind.Event);
      item.detail = `At the selection, ${path.basename(editor.document.uri.fsPath)}:L${first + 1}${last > first ? `-L${last + 1}` : ''}`;
      item.insertText = Notes.link(editor.document.uri, name);
      item.filterText = `[[${name}`;
      item.sortText = '~';
      item.range = range;
      item.command = { title: 'Make the Marker', command: NotesComments.CREATE_MARKER, arguments: [editor.document.uri.toString(), first, last, name] };
      items.push(item);
    }
    return items;
  }

  /** The last line of a selection, leaving out a last line that it only reaches at its very start. */
  private static lastLine(range: vscode.Range): number {
    return range.end.line > range.start.line && range.end.character === 0 ? range.end.line - 1 : range.end.line;
  }

  private threadAt(file: string, line: number): vscode.CommentThread | undefined {
    return this.threads.get(file)?.find(thread => (thread.comments[0] as NoteComment).lines.start.line === line);
  }

  /** After a source file changes, moves its notes to follow their lines, a moment after the typing stops. */
  private changed(document: vscode.TextDocument): void {
    if (!Notes.isNotesFile(document.uri) && this.threads.get(document.uri.toString())?.some(thread => (thread.comments[0] as NoteComment).note)) {
      const key = document.uri.toString();
      clearTimeout(this.pending.get(key));
      this.pending.set(key, setTimeout(() => {
        this.pending.delete(key);
        this.follow(document);
      }, 300));
    }
  }

  /** Moves each of a file's notes to its lines, found again by the first line's text. */
  private follow(document: vscode.TextDocument): void {
    for (const thread of this.threads.get(document.uri.toString()) ?? []) {
      const comment = thread.comments[0] as NoteComment;
      const range = comment.note && Notes.rangeIn(document, comment.note);
      if (range && !comment.lines.isEqual(range)) {
        comment.lines = range;
        thread.range = NotesComments.anchor(range, comment.note);
        // The box's Lines link names its lines
        if (comment.mode === vscode.CommentMode.Preview) {
          comment.body = comment.preview();
          thread.comments = [comment];
        }
      }
    }
    this.lensesChanged.fire();
    this.decorate();
  }

  /**
   * The logo in the gutter beside each closed box, on the line the box hangs from, where VS Code's comment icon is.
   * An open box shows the logo in its own header, so the gutter's would show it twice.
   */
  private decorate(always = true): void {
    const closed = vscode.window.visibleTextEditors.map(editor => ({
      editor,
      lines: (this.threads.get(editor.document.uri.toString()) ?? [])
        .filter(thread => thread.collapsibleState === vscode.CommentThreadCollapsibleState.Collapsed)
        .map(thread => NotesComments.anchor((thread.comments[0] as NoteComment).lines, (thread.comments[0] as NoteComment).note).start)
        .map(start => new vscode.Range(start, start)),
    }));
    // Whether a box is open in the editor you are in, for Esc there to close it (closeInEditor)
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const open = !!active && !!this.threads.get(active)?.some(thread => thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded);
    if (open !== this.openInEditor) {
      this.openInEditor = open;
      void vscode.commands.executeCommand('setContext', 'incontext.notes.openInEditor', open);
    }
    const signature = JSON.stringify(closed.map(({ editor, lines }) => [editor.document.uri.toString(), editor.viewColumn, lines.map(line => line.start.line)]));
    // Drawn again whenever boxes or editors change: a file opened again is a new editor without the logo
    if (always || signature !== this.decorated) {
      this.decorated = signature;
      closed.forEach(({ editor, lines }) => editor.setDecorations(this.gutter, lines));
      this.tintHeaders();
    }
  }

  /**
   * Tints the header of each box on screen, the bar with its icons, in its edge colour. VS Code does that only when a
   * box's state changes after the box is drawn, so a moment after boxes are drawn, opened or shown, their state is set
   * again (to the same value: VS Code still redraws the header).
   */
  private tintHeaders(): void {
    clearTimeout(this.tintTimer);
    this.tintTimer = setTimeout(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        this.threads.get(editor.document.uri.toString())?.forEach(thread => { thread.state = vscode.CommentThreadState.Resolved; });
      }
    }, 300);
  }

  private async redrawAll(): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
      await this.redraw(document);
    }
  }

  /**
   * Draws a file's boxes: one per marker, kept with the links to it from other markers and the references into its
   * lines (for Move to selection and Delete). References into lines no marker is on show only above those lines (hints). Each box starts open or closed as
   * startsOpen says, unless you toggled it. Not while one of the file's boxes is being edited.
   *
   * Two draws of one file can overlap while they read the notes files. Each would take away the boxes there were when
   * it began and draw its own, so the first one's boxes would be left on screen with nothing to take them away: the
   * same note shown twice. So only the latest draw goes on past the reading, and it takes away the boxes there are
   * then, with nothing awaited between that and keeping its own.
   */
  private async redraw(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    if (!Notes.canHaveNotes(document.uri)) {
      return;
    }
    const draw = (this.draws.get(key) ?? 0) + 1;
    this.draws.set(key, draw);
    const notes = await NotesProvider.notesIn(document);
    const unclaimed = [...(await this.backlinks.backLinks()).get(document.uri.fsPath) ?? []];
    // A later draw of this file shows what is newer; a file closed meanwhile has no boxes
    if (this.draws.get(key) !== draw || document.isClosed) {
      return;
    }
    const old = this.threads.get(key) ?? [];
    if (old.some(thread => thread.comments.some(comment => comment.mode === vscode.CommentMode.Editing))) {
      return;
    }
    const boxes = notes.map(({ note, range }) => {
      // Links to this marker by its name, and references into its lines
      const backLinks = unclaimed.filter(link => link.kind === 'marker'
        ? link.targetName === note.name
        : range.start.line <= link.targetLine && link.targetLine <= range.end.line);
      backLinks.forEach(link => unclaimed.splice(unclaimed.indexOf(link), 1));
      return { range, note, backLinks };
    });
    this.hints.set(key, unclaimed.filter(link => link.kind === 'reference'));

    for (const thread of old) {
      const comment = thread.comments[0] as NoteComment;
      const threadKey = `${key}|${comment.lines.start.line}`;
      const open = thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded;
      if (this.forgetToggles) {
        // Drawn again as the setting now says
      } else if (open !== NotesComments.startsOpen(comment.note)) {
        this.toggled.set(threadKey, open);
      } else {
        this.toggled.delete(threadKey);
      }
      thread.dispose();
    }
    const threads = boxes.map(({ range, note, backLinks }) => {
      const thread = this.controller.createCommentThread(document.uri, NotesComments.anchor(range, note), []);
      thread.comments = [new NoteComment(thread, note, backLinks, range)];
      thread.canReply = false;
      thread.contextValue = NotesComments.NOTE;
      // The marker's name, in the box's header
      thread.label = NotesComments.label(note.name);
      // A note is not a review comment awaiting an answer: "resolved", VS Code draws its box's edges in the theme's
      // faint grey (editorCommentsWidget.resolvedBorder) instead of its focus blue
      thread.state = vscode.CommentThreadState.Resolved;
      thread.collapsibleState = (this.toggled.get(`${key}|${range.start.line}`) ?? NotesComments.startsOpen(note))
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;
      return thread;
    });
    this.threads.set(key, threads);
    this.lensesChanged.fire();
    this.decorate();
  }

  private clear(uri: vscode.Uri): void {
    this.threads.get(uri.toString())?.forEach(thread => thread.dispose());
    this.threads.delete(uri.toString());
    this.hints.delete(uri.toString());
    this.decorate();
  }
}
