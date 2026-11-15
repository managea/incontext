import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReferenceParser } from './ReferenceParser';

/**
 * A note on a line, or on lines, of a source file: a `## L30: <the line's text>` or `## L30-L42: <the first line's
 * text>` section of that file's notes.
 */
export interface Note {
  /** 1-based (first) line the note was written for. Once the code moves, the line's text decides where it shows. */
  line: number;
  /** How many lines the note covers: 1, or more for a note on a selection. */
  lines: number;
  /** The line's text when the note was written, trimmed (see Notes.anchorOf); empty for a blank line. */
  anchor: string;
  /** The note's text under its heading, trimmed. */
  text: string;
  /** The references in the text, in order, each once. */
  references: string[];
  /** 0-based line of the note's heading in the notes file. */
  headingLine: number;
}

/**
 * Notes on code kept outside the code base, so they are never committed: one Markdown file per source file, in a
 * folder you choose (`incontext.notes.folder`), at `<folder>/<project>/<path in the project>.md`. A project can keep
 * its notes inside itself instead, to commit them, with a relative folder in its own settings (projectFolder). Each
 * note is a
 * section headed `## L30: <the line's text>` (or `## L30-L42: ...` for a selection), so the files stay readable and
 * editable by hand, and references in them are clickable as in any Markdown file. The source file shows each note
 * under its line (NotesComments).
 */
export class Notes {
  /** A note's heading: `## L30: export const handler = ...`, `## L30-L42: ...` for lines, `## L30` for a blank line. */
  static readonly HEADING = /^## L(\d+)(?:-L(\d+))?(?::[ \t]?(.*))?$/;
  private static readonly ANCHOR_LENGTH = 120;

  /**
   * The folder that holds a project's notes: `<notes folder>/<project>` for the folder in your settings, or for a
   * relative folder set for the project itself (such as `.notes` in its `.vscode/settings.json`), that folder inside
   * the project, so the project's notes can be committed with it. Undefined while no notes folder is set.
   */
  static projectFolder(project: vscode.WorkspaceFolder): string | undefined {
    const setting = vscode.workspace.getConfiguration('incontext.notes', project.uri).get<string>('folder', '').trim();
    if (!setting) {
      return undefined;
    }
    const folder = setting.replace(/^~(?=$|[/\\])/, os.homedir());
    return path.isAbsolute(folder) ? path.join(folder, project.name) : path.join(project.uri.fsPath, folder);
  }

  /** The notes file for a source file; undefined outside the workspace folders or without a notes folder. */
  static fileFor(source: vscode.Uri): vscode.Uri | undefined {
    const project = source.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(source) : undefined;
    const folder = project && Notes.projectFolder(project);
    return folder ? vscode.Uri.file(path.join(folder, `${path.relative(project.uri.fsPath, source.fsPath)}.md`)) : undefined;
  }

  /** Whether a source file can have notes: a file inside a workspace folder, other than a notes file. */
  static canHaveNotes(source: vscode.Uri): boolean {
    return source.scheme === 'file' && !!vscode.workspace.getWorkspaceFolder(source) && !Notes.isNotesFile(source);
  }

  /** Asks for the notes folder the first time a note is saved, and saves it in your settings. */
  static async askFolder(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Keep Notes Here',
      title: 'Choose a folder for your notes on code, outside your repositories so they are never committed',
    });
    if (!picked?.[0]) {
      return false;
    }
    await vscode.workspace.getConfiguration('incontext.notes').update('folder', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    return true;
  }

  /** The notes folders of the projects open in this window. */
  static projectFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(project => Notes.projectFolder(project)).filter((folder): folder is string => !!folder);
  }

  /** Whether a file is a notes file of a project open in this window. */
  static isNotesFile(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && Notes.projectFolders().some(folder => uri.fsPath.startsWith(path.join(folder, path.sep)));
  }

  /** The text a note keeps of its line, to find the line again once the code above it changes. */
  static anchorOf(lineText: string): string {
    return lineText.trim().slice(0, Notes.ANCHOR_LENGTH);
  }

  /** The heading of a new note on `line` to `lastLine` (1-based), where `lineText` is the first line's text. */
  static heading(line: number, lineText: string, lastLine = line): string {
    const lines = lastLine > line ? `L${line}-L${lastLine}` : `L${line}`;
    const anchor = Notes.anchorOf(lineText);
    return anchor ? `## ${lines}: ${anchor}` : `## ${lines}`;
  }

  /**
   * The notes in a notes file. A note runs to the next note heading, so a note can use any Markdown, headings too.
   * Text before the first note, such as the file's title, belongs to no note.
   */
  static parse(text: string): Note[] {
    const notes: Note[] = [];
    let current: { line: number; lines: number; anchor: string; headingLine: number; body: string[] } | undefined;
    const finish = () => {
      if (current) {
        const noteText = current.body.join('\n').trim();
        const references = [...new Set(ReferenceParser.findReferences(noteText).map(match => match.reference))];
        const { line, lines, anchor, headingLine } = current;
        notes.push({ line, lines, anchor, text: noteText, references, headingLine });
      }
      current = undefined;
    };
    text.split(/\r?\n/).forEach((lineText, index) => {
      const heading = Notes.HEADING.exec(lineText);
      if (heading) {
        finish();
        const line = Number(heading[1]);
        const lines = heading[2] ? Math.max(Number(heading[2]) - line + 1, 1) : 1;
        current = { line, lines, anchor: Notes.anchorOf(heading[3] ?? ''), headingLine: index, body: [] };
      } else {
        current?.body.push(lineText);
      }
    });
    finish();
    return notes;
  }

  /**
   * Where a note shows in `document` (0-based): its line while that still has the note's text, else the nearest
   * line that has it (the code above moved), else its line.
   */
  static locate(document: vscode.TextDocument, note: Pick<Note, 'line' | 'anchor'>): number {
    const hint = Math.min(Math.max(note.line - 1, 0), document.lineCount - 1);
    if (!note.anchor || Notes.anchorOf(document.lineAt(hint).text) === note.anchor) {
      return hint;
    }
    let found: number | undefined;
    for (let line = 0; line < document.lineCount; line++) {
      if (Notes.anchorOf(document.lineAt(line).text) === note.anchor && (found === undefined || Math.abs(line - hint) < Math.abs(found - hint))) {
        found = line;
      }
    }
    return found ?? hint;
  }

  /** The lines a note covers in `document`, from where it shows (locate) to its last line, ends included. */
  static rangeIn(document: vscode.TextDocument, note: Pick<Note, 'line' | 'lines' | 'anchor'>): vscode.Range {
    const first = Notes.locate(document, note);
    const last = Math.min(first + note.lines - 1, document.lineCount - 1);
    return new vscode.Range(first, 0, last, document.lineAt(last).text.length);
  }

  /** A notes file's text: the editor's, with unsaved changes, when it is open; undefined when there is none. */
  static async read(file: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === file.toString());
    if (open) {
      return open.getText();
    }
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      return undefined;
    }
  }

  /** A notes file's text with a new note at the end. */
  static withNote(text: string, heading: string, body: string): string {
    return `${text.replace(/\s*$/, '')}\n\n${heading}\n${body.trim()}\n`;
  }

  /** A notes file's text with the heading on `headingLine` replaced, which moves that note to other lines. */
  static withHeading(text: string, headingLine: number, heading: string): string {
    const lines = text.split('\n');
    lines[headingLine] = heading;
    return lines.join('\n');
  }

  /** A notes file's text with the note whose heading is on `headingLine` given a new body, or taken out (undefined). */
  static withSection(text: string, headingLine: number, body: string | undefined): string {
    const lines = text.split('\n');
    let end = headingLine + 1;
    while (end < lines.length && !Notes.HEADING.test(lines[end])) {
      end++;
    }
    lines.splice(headingLine, end - headingLine, ...(body === undefined ? [] : [lines[headingLine], body.trim(), '']));
    return `${lines.join('\n').replace(/\s*$/, '')}\n`;
  }

  /** Writes a notes file, through its editor when it is open, so an open notes file never goes out of date. */
  static async write(file: vscode.Uri, text: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === file.toString());
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file, new vscode.Range(0, 0, open.lineCount, 0), text);
      await vscode.workspace.applyEdit(edit);
      await open.save();
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.fsPath)));
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  }
}

/**
 * The whole note, with clickable references, on hover over an annotated line (NotesComments shows it under the
 * line), and the helpers both use.
 */
export class NotesProvider implements vscode.HoverProvider {
  static readonly OPEN_NOTE = 'incontext.openNote';
  static readonly OPEN_BESIDE = 'incontext.openReferenceBeside';

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const here = (await NotesProvider.notesIn(document)).filter(({ range }) => range.start.line === position.line);
    if (here.length === 0) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: [NotesProvider.OPEN_NOTE, NotesProvider.OPEN_BESIDE] };
    markdown.supportThemeIcons = true;
    for (const { note, file } of here) {
      const linked = NotesProvider.linkReferences(note.text || '_Empty note_');
      const edit = NotesProvider.commandLink(NotesProvider.OPEN_NOTE, [file.toString(), note.headingLine]);
      markdown.appendMarkdown(`$(note) **Note**\n\n${linked}\n\n[Open as Markdown](${edit})\n\n`);
    }
    return new vscode.Hover(markdown);
  }

  /** The notes for a source file, each with the line it shows on. */
  static async notesIn(document: vscode.TextDocument): Promise<{ note: Note; range: vscode.Range; file: vscode.Uri }[]> {
    const file = Notes.fileFor(document.uri);
    const text = file && await Notes.read(file);
    if (!file || !text) {
      return [];
    }
    return Notes.parse(text).map(note => ({ note, range: Notes.rangeIn(document, note), file }));
  }

  /** Makes each reference in a note's text a link that opens it beside the code. */
  static linkReferences(text: string): string {
    let linked = '';
    let last = 0;
    for (const match of ReferenceParser.findReferences(text)) {
      // Read as its file and lines; the whole reference shows on hover, and in the note's raw text
      const link = NotesProvider.commandLink(NotesProvider.OPEN_BESIDE, [match.reference]);
      linked += `${text.slice(last, match.start)}[${NotesProvider.shortLabel(match.reference)}](${link} "${match.reference.replace(/"/g, '&quot;')}")`;
      last = match.end;
    }
    return linked + text.slice(last);
  }

  /** A reference by its file and lines, as a note shows it: `@reports/src/a/handler.ts:L30` reads `handler.ts:L30`. */
  static shortLabel(reference: string): string {
    const folder = reference.endsWith('/');
    const parts = reference.replace(/^@/, '').replace(/\/$/, '').split('/');
    return `${parts[parts.length - 1]}${folder ? '/' : ''}`;
  }

  private static commandLink(command: string, args: unknown[]): string {
    return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
  }
}
