import * as vscode from 'vscode';
import { Note, Notes, NotesProvider } from './Notes';
import { BackLink, NotesBacklinks } from './NotesBacklinks';
import { ReferenceUtils } from './ReferenceUtils';

/**
 * The box at some lines of a file: the note on them, if any, and the notes elsewhere that point at them (back-links),
 * rendered with clickable references, or the note's raw text while it is edited. A box with only back-links can get a
 * note of its own (Add note), so notes can chain: a note there points on, and that place shows a back-link again.
 */
export class NoteComment implements vscode.Comment {
  // Named and pictured in the comment's own header, beside the note, as CodeTour does: the thread's title is blank
  readonly author = { name: 'InContext', iconPath: NotesComments.icon };
  readonly contextValue = 'incontext.note';
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;

  /** `lines` are the lines the box is about; the thread may sit on the line above them (NotesComments.anchor). */
  constructor(readonly thread: vscode.CommentThread, readonly note: Note | undefined, readonly backLinks: BackLink[], public lines: vscode.Range) {
    this.body = this.preview();
  }

  /**
   * The notes that point here, then the note rendered, then a row of actions at the left: VS Code puts the thread's
   * own buttons at the far right, which is a long way on a wide editor.
   */
  preview(): vscode.MarkdownString {
    const range = this.lines;
    const target = encodeURIComponent(JSON.stringify([this.thread.uri.toString(), range.start.line]));
    // The lines the box covers, a link that selects them: VS Code's own marking of them is faint
    const lines = range.end.line > range.start.line ? `Lines ${range.start.line + 1}–${range.end.line + 1}` : `Line ${range.start.line + 1}`;
    const showNotes = vscode.workspace.getConfiguration('incontext.notes').get<boolean>('showBackLinkNotes', false);
    // Plain words: VS Code's comment box doesn't line icons up with the text beside them
    const actions = this.note
      ? [[lines, NotesComments.SELECT_AT], ['Move to selection', NotesComments.MOVE_AT], ['Edit', NotesComments.EDIT_AT], ['Open as Markdown', NotesComments.OPEN_AT], ['Delete', NotesComments.DELETE_AT]]
      : [[lines, NotesComments.SELECT_AT], ['Move to selection', NotesComments.MOVE_AT], ['Add note', NotesComments.EDIT_AT]];
    const sections = [
      // Each note that points here, a link back to it, with the note quoted under it if the setting says so
      this.backLinks.map(link => {
        // The note on hover, on one line: a link's title can't hold a blank line
        const title = link.text.split('\n').map(line => line.trim()).filter(Boolean).join(' · ').replace(/"/g, '&quot;');
        const back = `[← ${link.source.path.split('/').pop()}:L${link.line}](${NotesBacklinks.goToNoteLink(link)} "${title}")`;
        const quote = (link.text || '_Empty note_').split('\n').map(line => `> ${line}`).join('\n');
        return showNotes ? `${back}\n\n${quote}` : back;
      }).join(showNotes ? '\n\n' : '  \n'),
      // This box's own note, under the notes that point here
      this.note ? NotesProvider.linkReferences(this.note.text || '_Empty note_') : '',
      // A rule above the actions, as CodeTour has above its Previous and Next
      '---',
      actions.map(([title, command]) => `[${title}](command:${command}?${target})`).join(' · '),
    ];
    const markdown = new vscode.MarkdownString(sections.filter(Boolean).join('\n\n'));
    markdown.isTrusted = { enabledCommands: [NotesProvider.OPEN_BESIDE, NotesBacklinks.GO_TO_NOTE, ...actions.map(([, command]) => command)] };
    return markdown;
  }
}

/** What the comment box's buttons pass: the thread and the text typed into its box. */
interface NoteReply {
  thread: { uri: vscode.Uri; range?: vscode.Range; dispose(): void };
  text: string;
}

/**
 * Shows notes (Notes) inside the editor, as comment threads under their lines, like review comments: one box per
 * note, with the notes that point at its lines, and a box with only those back-links where no note is. A note is
 * added by typing into a box (the + beside a line, InContext: Add Note, or Add note in a back-link box) and changed
 * with Edit; Open as Markdown opens the notes file. Every change is written to the notes file, which stays the only
 * place notes are kept; back-links are never stored.
 */
export class NotesComments implements vscode.Disposable, vscode.CodeLensProvider {
  static readonly NOTE = 'incontext.note';
  static readonly BACKLINKS = 'incontext.backlinks';
  static readonly SELECT_AT = 'incontext.notes.selectAt';
  static readonly MOVE_AT = 'incontext.notes.moveAt';
  static readonly EDIT_AT = 'incontext.notes.editAt';
  static readonly OPEN_AT = 'incontext.notes.openAt';
  static readonly DELETE_AT = 'incontext.notes.deleteAt';
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
  /**
   * Boxes you opened or closed against their default, kept so when their file's boxes are next drawn:
   * `<file uri>|<first line>` to open (true) or closed (false).
   */
  private readonly toggled = new Map<string, boolean>();
  /** While the boxes are drawn again for a change of `incontext.notes.startClosed`: their open state isn't kept. */
  private forgetToggles = false;
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /**
   * How many times each file's boxes have been asked to be drawn, by the file's URI. A draw waits on the notes files
   * and another can start meanwhile (a save, the notes folder changing, a file opening): only the latest draws.
   */
  private readonly draws = new Map<string, number>();
  /** The box being edited and when its edit began, and the new note's box Add Note opened, for Cmd+Enter and Esc. */
  private editing?: NoteComment;
  private editingSince = 0;
  private draft?: vscode.CommentThread;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly backlinks: NotesBacklinks, extensionUri: vscode.Uri) {
    NotesComments.icon = vscode.Uri.joinPath(extensionUri, 'icon.png');
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconPath: NotesComments.icon,
      gutterIconSize: 'contain',
      overviewRulerColor: '#3d7ab8',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.controller.options = { prompt: 'Add a note', placeHolder: "A note in Markdown. Paste references copied with Cmd+'" };
    this.setGutterButton();
    this.disposables.push(
      this.controller,
      this.lensesChanged,
      this.gutter,
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      NotesBacklinks.wentToNote.event(({ uri, line }) => this.openBox(uri, line)),
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
      vscode.workspace.onDidOpenTextDocument(document => this.redraw(document)),
      vscode.workspace.onDidCloseTextDocument(document => this.clear(document.uri)),
      vscode.workspace.onDidChangeTextDocument(event => this.changed(event.document)),
      // Any notes file can change the boxes of any open file: its own notes, or the back-links of the files it points at
      backlinks.onDidChange(() => this.redrawAll()),
      vscode.commands.registerCommand('incontext.addNote', () => this.addNote()),
      vscode.commands.registerCommand('incontext.notes.create', (reply: NoteReply) => this.create(reply)),
      vscode.commands.registerCommand('incontext.notes.cancelDraft', (reply: NoteReply) => this.closeDraft(reply.thread)),
      vscode.commands.registerCommand('incontext.notes.cancelFocused', () => this.cancelFocused()),
      vscode.commands.registerCommand('incontext.notes.submitFocused', () => this.submitFocused()),
      vscode.commands.registerCommand(NotesComments.SELECT_AT, (file: string, line: number) => this.withThread(file, line, thread => NotesComments.select(thread))),
      vscode.commands.registerCommand(NotesComments.MOVE_AT, (file: string, line: number) => this.withThread(file, line, thread => this.moveToSelection(thread))),
      vscode.commands.registerCommand(NotesComments.EDIT_AT, (file: string, line: number) => this.withThread(file, line, thread => this.edit(thread.comments[0] as NoteComment))),
      vscode.commands.registerCommand(NotesComments.OPEN_AT, (file: string, line: number) => this.withThread(file, line, thread => this.openMarkdown(thread))),
      vscode.commands.registerCommand(NotesComments.DELETE_AT, (file: string, line: number) => this.withThread(file, line, thread => this.delete(thread))),
      vscode.commands.registerCommand('incontext.notes.edit', (thread: vscode.CommentThread) => this.edit(thread.comments[0] as NoteComment)),
      vscode.commands.registerCommand('incontext.notes.save', (comment: NoteComment) => this.save(comment)),
      vscode.commands.registerCommand('incontext.notes.cancelEdit', (comment: NoteComment) => this.cancelEdit(comment)),
      vscode.commands.registerCommand('incontext.notes.delete', (thread: vscode.CommentThread) => this.delete(thread)),
      vscode.commands.registerCommand('incontext.notes.openMarkdown', (thread: vscode.CommentThread) => this.openMarkdown(thread)),
    );
    void this.redrawAll();
    // VS Code says nothing when you open or close a box, but the box's state follows, so look a few times a second
    this.watchOpen = setInterval(() => this.decorate(false), 300);
  }

  dispose(): void {
    clearInterval(this.watchOpen);
    clearTimeout(this.tintTimer);
    this.pending.forEach(timer => clearTimeout(timer));
    this.threads.forEach(threads => threads.forEach(thread => thread.dispose()));
    this.disposables.forEach(disposable => disposable.dispose());
  }

  /**
   * Above lines whose box has no note of its own, which stays closed, a link back to each note that points at them
   * (`← handler.ts:L30`), so you can go back without opening the box.
   */
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return (this.threads.get(document.uri.toString()) ?? [])
      .map(thread => thread.comments[0] as NoteComment)
      .filter(comment => NotesComments.isEmpty(comment.note))
      .flatMap(comment => comment.backLinks.map(link => new vscode.CodeLens(new vscode.Range(comment.lines.start, comment.lines.start), {
        title: `← ${link.source.path.split('/').pop()}:L${link.line}`,
        tooltip: link.text.split('\n').map(line => line.trim()).filter(Boolean).join(' · ') || 'Empty note',
        command: NotesBacklinks.GO_TO_NOTE,
        arguments: [link.source.toString(), link.line, link.lines, link.anchor],
      })));
  }

  /**
   * Opens the box of the note whose first line this is, when you go to it from the InContext view or a back-link, so
   * you don't have to open it yourself. A file not open yet gets the box open when it is drawn.
   */
  openBox(uri: vscode.Uri, line: number): void {
    this.toggled.set(`${uri.toString()}|${line}`, true);
    const thread = this.threads.get(uri.toString())?.find(box => (box.comments[0] as NoteComment).lines.start.line === line);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  /** A box with no note, or an empty one: it has nothing to show but its back-links, so it starts closed. */
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

  private async addNote(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !Notes.canHaveNotes(editor.document.uri)) {
      vscode.window.showErrorMessage('Open a file inside a workspace folder to add a note to one of its lines.');
      return;
    }
    const { start, end } = editor.selection;
    const existing = this.threadAt(editor.document.uri.toString(), start.line);
    if (existing) {
      existing.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.edit(existing.comments[0] as NoteComment);
      return;
    }
    const last = NotesComments.lastLine(new vscode.Range(start, end));
    const draft = this.controller.createCommentThread(editor.document.uri, new vscode.Range(start.line, 0, last, editor.document.lineAt(last).text.length), []);
    draft.label = `${NotesComments.LABEL} · new note`;
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.draft = draft;
  }

  private closeDraft(thread: NoteReply['thread']): void {
    thread.dispose();
    if (thread === this.draft) {
      this.draft = undefined;
    }
  }

  /**
   * Cmd+Enter in a box. VS Code sends it to the thread's reply box, which a note doesn't have, so an edit would go
   * nowhere: this saves the edit, reading its text from the box (a `comment:` document). A new note's box saves as
   * VS Code saves it.
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
      await this.save(comment);
    }
  }

  /** Esc in a box: cancels the edit or the new note; any other box closes as VS Code closes it. */
  private async cancelFocused(): Promise<void> {
    if (this.editing?.mode === vscode.CommentMode.Editing) {
      this.cancelEdit(this.editing);
    } else if (this.draft) {
      this.closeDraft(this.draft);
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
   * setting's default) belongs to the line before them; on a file's first line it can only go below. A box with no
   * note, which starts closed, sits on its first line instead, so its icons are on the line its back-link links
   * (provideCodeLenses) are drawn above.
   */
  static anchor(lines: vscode.Range, note?: Note): vscode.Range {
    if (NotesComments.isEmpty(note)) {
      return new vscode.Range(lines.start, lines.start);
    }
    const above = vscode.workspace.getConfiguration('incontext.notes').get<string>('position', 'above') === 'above';
    return above && lines.start.line > 0 ? new vscode.Range(lines.start.line - 1, 0, lines.start.line - 1, 0) : lines;
  }

  /**
   * Moves a box to the lines selected in its file's editor, or to the cursor's line: its note, and the references of
   * the notes elsewhere that point at exactly its lines. How a note's lines change, or a note moves up or down, and
   * how a reference whose lines have drifted is put right from where it points, without writing anything again.
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
    if (note && file) {
      const heading = Notes.heading(start.line + 1, editor.document.lineAt(start.line).text, last + 1);
      await Notes.write(file, Notes.withHeading(await Notes.read(file) ?? '', note.headingLine, heading));
    }
    // A back-link that points at only part of a note's lines keeps pointing there
    const pointed = ReferenceUtils.createCodeReference(editor.document.uri, new vscode.Selection(start.line, 0, last, 0));
    for (const link of backLinks.filter(candidate => candidate.targetLine === lines.start.line && candidate.targetEndLine === lines.end.line)) {
      const text = await Notes.read(link.notesFile);
      const pointing = text === undefined ? undefined : Notes.parse(text).find(candidate => candidate.headingLine === link.headingLine);
      if (text !== undefined && pointing) {
        await Notes.write(link.notesFile, Notes.withSection(text, link.headingLine, pointing.text.split(link.reference).join(pointed)));
      }
    }
    await this.redraw(editor.document);
  }

  /** Saves the text typed into a new note's box as a note on those lines. */
  private async create(reply: NoteReply): Promise<void> {
    if (await this.addToNotesFile(reply.thread.uri, reply.thread.range, reply.text)) {
      this.closeDraft(reply.thread);
    }
  }

  /** Writes a new note on some lines of a file into its notes file, asking for the notes folder the first time. */
  private async addToNotesFile(source: vscode.Uri, range: vscode.Range | undefined, text: string): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(source);
    const file = text.trim() ? Notes.fileFor(source) ?? (await Notes.askFolder() ? Notes.fileFor(source) : undefined) : undefined;
    if (!file) {
      return false;
    }
    const lines = range ?? new vscode.Range(0, 0, 0, 0);
    const current = await Notes.read(file) ?? `# Notes on ${ReferenceUtils.createFileReference(source)}\n`;
    const heading = Notes.heading(lines.start.line + 1, document.lineAt(lines.start.line).text, NotesComments.lastLine(lines) + 1);
    await Notes.write(file, Notes.withNote(current, heading, text));
    // The note you just wrote stays open, also when boxes start closed
    this.toggled.set(`${document.uri.toString()}|${lines.start.line}`, true);
    await this.redraw(document);
    return true;
  }

  private edit(comment: NoteComment): void {
    this.editing = comment;
    this.editingSince = Date.now();
    comment.body = comment.note?.text ?? '';
    comment.mode = vscode.CommentMode.Editing;
    comment.thread.comments = [...comment.thread.comments];
  }

  /** Saves an edit: the note's new text, or for a box with only back-links, its first note. */
  private async save(comment: NoteComment): Promise<void> {
    const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
    comment.mode = vscode.CommentMode.Preview;
    this.editing = undefined;
    if (!comment.note) {
      if (!await this.addToNotesFile(comment.thread.uri, comment.lines, text)) {
        this.cancelEdit(comment);
      }
      return;
    }
    const file = Notes.fileFor(comment.thread.uri);
    if (file) {
      await Notes.write(file, Notes.withSection(await Notes.read(file) ?? '', comment.note.headingLine, text));
    }
    const document = vscode.workspace.textDocuments.find(open => open.uri.toString() === comment.thread.uri.toString());
    if (document) {
      await this.redraw(document);
    }
  }

  private cancelEdit(comment: NoteComment): void {
    comment.body = comment.preview();
    comment.mode = vscode.CommentMode.Preview;
    this.editing = undefined;
    comment.thread.comments = [...comment.thread.comments];
  }

  private async delete(thread: vscode.CommentThread): Promise<void> {
    const { note } = thread.comments[0] as NoteComment;
    const file = Notes.fileFor(thread.uri);
    if (!note || !file) {
      return;
    }
    const answer = await vscode.window.showWarningMessage('Delete this note?', { modal: true, detail: note.text }, 'Delete');
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
    if (note && file) {
      await vscode.commands.executeCommand(NotesProvider.OPEN_NOTE, file.toString(), note.headingLine);
    }
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
   * Draws a file's boxes: one per note, with the back-links that point into its lines, and one per first line that
   * only back-links point at. Each starts open or closed as startsOpen says, unless you toggled it. Not while one of the
   * file's boxes is being edited.
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
    const boxes: { range: vscode.Range; note?: Note; backLinks: BackLink[] }[] = notes.map(({ note, range }) => {
      // Back-links that point into a note's lines show in that note's box
      const backLinks = unclaimed.filter(link => range.start.line <= link.targetLine && link.targetLine <= range.end.line);
      backLinks.forEach(link => unclaimed.splice(unclaimed.indexOf(link), 1));
      return { range, note, backLinks };
    });
    // One box per first line: VS Code would stack a box for each set of lines that starts there
    const byLine = new Map<number, BackLink[]>();
    for (const link of unclaimed) {
      byLine.set(link.targetLine, [...byLine.get(link.targetLine) ?? [], link]);
    }
    for (const backLinks of byLine.values()) {
      const first = Math.min(backLinks[0].targetLine, document.lineCount - 1);
      const last = Math.min(Math.max(...backLinks.map(link => link.targetEndLine)), document.lineCount - 1);
      boxes.push({ range: new vscode.Range(first, 0, last, document.lineAt(last).text.length), backLinks });
    }

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
      thread.contextValue = note ? NotesComments.NOTE : NotesComments.BACKLINKS;
      // A blank title, not none: without one VS Code writes its own
      thread.label = ' ';
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
    this.decorate();
  }
}
