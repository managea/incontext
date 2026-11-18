import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReferenceParser } from './ReferenceParser';

/** A link from a note to a marker: `[[project/path#Name]]`, or `[[#Name]]` for a marker in the same file. */
export interface MarkerLink {
  /** `<project>/<path in the project>` of the marker's source file as written; empty for the note's own file. */
  path: string;
  /** The marker's name. */
  name: string;
  /** The link as written, to take it out or rename it. */
  text: string;
}

/**
 * A marker on a line, or on lines, of a source file: a name, and a note about the lines, which may be empty. In the
 * file's notes it is a section headed `## <name>` with `<!-- L30: <the line's text> -->` (or `<!-- L30-L42: ... -->`)
 * under it. A section headed the older way, `## L30: <the line's text>`, is a marker too, named after its line.
 */
export interface Note {
  /** The marker's name, which links to it use (`[[project/path#Name]]`); unique in its file. */
  name: string;
  /** Whether the name was given (`## Name`), or comes from the line for an older note (`## L30: ...`). */
  named: boolean;
  /** 1-based (first) line the note was written for. Once the code moves, the line's text decides where it shows. */
  line: number;
  /** How many lines the note covers: 1, or more for a note on a selection. */
  lines: number;
  /** The line's text when the note was written, trimmed (see Notes.anchorOf); empty for a blank line. */
  anchor: string;
  /** The note's text under its heading, trimmed. */
  text: string;
  /** The plain references in the text (outside marker links), in order, each once. */
  references: string[];
  /** The links to markers in the text, in order. */
  links: MarkerLink[];
  /** 0-based line of the note's heading in the notes file. */
  headingLine: number;
}

/**
 * Markers on code kept outside the code base, so they are never committed: one Markdown file per source file, in a
 * folder you choose (`incontext.notes.folder`), at `<folder>/<project>/<path in the project>.md`. A project can keep
 * its notes inside itself instead, to commit them, with a relative folder in its own settings (projectFolder). Each
 * marker is a section headed with its name and, on the next line, a comment that says which lines it is on, so the
 * files stay readable and editable by hand (in Obsidian too, where `[[project/path#Name]]` links work), and
 * references in them are clickable as in any Markdown file. The source file shows each marker at its lines
 * (NotesComments).
 */
export class Notes {
  /** An older note's heading: `## L30: export const handler = ...`, `## L30-L42: ...` for lines, `## L30` for a blank line. */
  static readonly HEADING = /^## L(\d+)(?:-L(\d+))?(?::[ \t]?(.*))?$/;
  /** A marker's heading, `## <name>`, which is one only with its location on the next line. */
  private static readonly NAME = /^## (.*\S.*)$/;
  /** A marker's location: `<!-- L30: <the line's text> -->`, `<!-- L30-L42: ... -->` for lines, `<!-- L30 -->` for a blank line. */
  private static readonly LOCATION = /^<!-- L(\d+)(?:-L(\d+))?(?::[ \t]?(.*?))? -->$/;
  /** A link to a marker: `[[project/path#Name]]`, `[[#Name]]` in the same file, either with `|shown text`. */
  static readonly LINK = /\[\[([^\]#|\n]*)#([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;
  /** The folder in a project's notes folder that holds its collections of markers (Collections), not notes on a file. */
  static readonly COLLECTIONS = '_collections';
  private static readonly ANCHOR_LENGTH = 120;
  private static readonly NAME_LENGTH = 60;

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

  /**
   * The heading of a marker named `name` on `line` to `lastLine` (1-based), where `lineText` is the first line's text:
   * its name, and on the next line its location.
   */
  static heading(name: string, line: number, lineText: string, lastLine = line): string {
    const lines = lastLine > line ? `L${line}-L${lastLine}` : `L${line}`;
    const anchor = Notes.anchorOf(lineText);
    return `## ${Notes.cleanName(name)}\n<!-- ${anchor ? `${lines}: ${anchor}` : lines} -->`;
  }

  /**
   * A name links can use: without the characters that end a link (`[`, `]`, `#`, `|`, `^`), on one line, not too long.
   * Empty when nothing is left.
   */
  static cleanName(name: string): string {
    return Notes.shorten(name.replace(/[[\]#|^]/g, ' ').replace(/\s+/g, ' ').trim(), 80);
  }

  /**
   * The name a marker gets when none is given: its line's text, shortened, or `handler.ts:L30` for a line with little
   * to read, such as `}`.
   */
  static fallbackName(lineText: string, fileName: string, line: number): string {
    const text = Notes.cleanName(lineText);
    return (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3 ? Notes.shorten(text, Notes.NAME_LENGTH) : `${fileName ? `${fileName}:` : ''}L${line}`;
  }

  /** `name`, or `name 2`, `name 3`... when another marker in the file has it. */
  static uniqueName(name: string, taken: Iterable<string>): string {
    const names = new Set(taken);
    let unique = name;
    for (let n = 2; names.has(unique); n++) {
      unique = `${name} ${n}`;
    }
    return unique;
  }

  private static shorten(text: string, length: number): string {
    if (text.length <= length) {
      return text;
    }
    const cut = text.slice(0, length - 1);
    const space = cut.lastIndexOf(' ');
    return `${space > length / 2 ? cut.slice(0, space) : cut}…`;
  }

  /** A link to the marker named `name` on `source`: `[[project/path#Name]]`. */
  static link(source: vscode.Uri, name: string): string {
    const project = vscode.workspace.getWorkspaceFolder(source);
    const file = project ? `${project.name}/${path.relative(project.uri.fsPath, source.fsPath).split(path.sep).join('/')}` : '';
    return `[[${file}#${name}]]`;
  }

  /**
   * A note's text with `link` added at its end: on a line of its own after links on lines of their own, so a list of
   * links stays one link to a line, otherwise in a paragraph of its own.
   */
  static withLink(text: string, link: string): string {
    const kept = text.replace(/\s*$/, '');
    if (!kept) {
      return link;
    }
    const last = kept.slice(kept.lastIndexOf('\n') + 1);
    return `${kept}${last.replace(Notes.LINK, '').trim() ? '\n\n' : '\n'}${link}`;
  }

  /**
   * A note's text without a link or reference: a line that is only it goes, with `- ` before it, and with a name
   * (`Caller:`) when `labelled`, else such a line stays; elsewhere just it goes. Blank lines it leaves behind close up.
   */
  static withoutLink(text: string, link: string, labelled = true): string {
    const lines = text.split('\n').flatMap(line => {
      if (!line.includes(link)) {
        return [line];
      }
      const rest = line.split(link).join('').trim();
      const named = /^(?:(?:[-*+]|\d+[.)])[ \t]+)?[^\n:@[\]]*:$/.test(rest);
      // A link the note names stays, unless `labelled`: its name is what the note says about it
      if (named && !labelled) {
        return [line];
      }
      const only = !rest || /^(?:[-*+]|\d+[.)])$/.test(rest) || named;
      return only ? [] : [line.split(link).join('').replace(/[ \t]{2,}/g, ' ').trimEnd()];
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** The source file a link's marker is on, for a link written in the notes on `from`; undefined for a project not open. */
  static linkTarget(link: Pick<MarkerLink, 'path'>, from: vscode.Uri): vscode.Uri | undefined {
    if (!link.path) {
      return from;
    }
    const [project, ...rest] = link.path.replace(/^@/, '').replace(/\.md$/, '').split('/');
    const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.name === project);
    return folder && rest.length ? vscode.Uri.joinPath(folder.uri, ...rest) : undefined;
  }

  /** What goes before a reference or link on its line to name it: `Caller:`, in a list or not. */
  private static readonly LABEL = /^[ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+)?([^\n:@[\]]*[^\s:@[\]])[ \t]*:[ \t]*$/;

  /**
   * The name a note gives the reference or link at `start` to `end` of its text: a link's own text
   * (`[[project/src/api.ts#Handles the call|Caller]]`), or a label before it on a line of its own
   * (`Caller: @project/src/api.ts:L30`, `- Caller: [[...]]`). It is only this note's: the place, or the marker linked
   * to, keeps its own name. Undefined when there is none.
   */
  static labelAt(text: string, start: number, end: number): string | undefined {
    const alias = /\|([^\]\n]*)\]\]$/.exec(text.slice(start, end))?.[1].trim();
    if (alias) {
      return alias;
    }
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end);
    return text.slice(end, lineEnd).trim() ? undefined : Notes.LABEL.exec(text.slice(lineStart, start))?.[1].trim();
  }

  /** The links to markers in a note's text. */
  static linksIn(text: string): MarkerLink[] {
    return [...text.matchAll(Notes.LINK)].map(match => ({ path: match[1].trim(), name: match[2].trim(), text: match[0] }));
  }

  /** The plain references in a note's text, leaving out what is inside links to markers. */
  static referencesIn(text: string): { reference: string; start: number; end: number }[] {
    const links = [...text.matchAll(Notes.LINK)].map(match => [match.index!, match.index! + match[0].length]);
    return ReferenceParser.findReferences(text).filter(match => !links.some(([start, end]) => match.start >= start && match.start < end));
  }

  /**
   * The marker heading at `index` of a notes file's lines: its location, its name when it has one, and how many lines
   * the heading takes (2, or 1 for an older note's `## L30: ...`).
   */
  static headingAt(lines: string[], index: number): { line: number; lines: number; anchor: string; name?: string; size: number } | undefined {
    const name = Notes.NAME.exec(lines[index]);
    const location = name && Notes.LOCATION.exec(lines[index + 1] ?? '');
    const found = location ?? Notes.HEADING.exec(lines[index]);
    if (!found) {
      return undefined;
    }
    const line = Number(found[1]);
    return {
      line,
      lines: found[2] ? Math.max(Number(found[2]) - line + 1, 1) : 1,
      anchor: Notes.anchorOf(found[3] ?? ''),
      name: location ? Notes.cleanName(name![1]) : undefined,
      size: location ? 2 : 1,
    };
  }

  /**
   * The markers in a notes file, whose source file is called `fileName` (for the names of older notes). A note runs to
   * the next marker's heading, so a note can use any Markdown, headings too. Text before the first marker, such as the
   * file's title, belongs to no marker.
   */
  static parse(text: string, fileName = ''): Note[] {
    const notes: Note[] = [];
    const names = new Set<string>();
    let current: { line: number; lines: number; anchor: string; name?: string; headingLine: number; body: string[] } | undefined;
    const finish = () => {
      if (current) {
        const noteText = current.body.join('\n').trim();
        const references = [...new Set(Notes.referencesIn(noteText).map(match => match.reference))];
        const { line, lines, anchor, headingLine } = current;
        // An older note's name comes from its line, kept apart from the other names in the file
        const name = current.name || Notes.uniqueName(Notes.fallbackName(anchor, fileName, line), names);
        names.add(name);
        notes.push({ name, named: !!current.name, line, lines, anchor, text: noteText, references, links: Notes.linksIn(noteText), headingLine });
      }
      current = undefined;
    };
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const heading = Notes.headingAt(lines, index);
      if (heading) {
        finish();
        current = { ...heading, headingLine: index, body: [] };
        index += heading.size - 1;
      } else {
        current?.body.push(lines[index]);
      }
    }
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

  /** A notes file's text with a new marker at the end, its note `body` (which may be empty). */
  static withNote(text: string, heading: string, body: string): string {
    return `${text.replace(/\s*$/, '')}\n\n${heading}\n${body.trim() ? `${body.trim()}\n` : ''}`;
  }

  /** A notes file's text with the heading on `headingLine` replaced, which renames that marker or moves it to other lines. */
  static withHeading(text: string, headingLine: number, heading: string): string {
    const lines = text.split('\n');
    lines.splice(headingLine, Notes.headingAt(lines, headingLine)?.size ?? 1, ...heading.split('\n'));
    return lines.join('\n');
  }

  /**
   * A notes file's text with the marker whose heading is on `headingLine` given a new note (and a new heading, when
   * given), or taken out (undefined).
   */
  static withSection(text: string, headingLine: number, body: string | undefined, heading?: string): string {
    const lines = text.split('\n');
    const size = Notes.headingAt(lines, headingLine)?.size ?? 1;
    let end = headingLine + size;
    while (end < lines.length && !Notes.headingAt(lines, end)) {
      end++;
    }
    const kept = heading?.split('\n') ?? lines.slice(headingLine, headingLine + size);
    lines.splice(headingLine, end - headingLine, ...(body === undefined ? [] : [...kept, ...(body.trim() ? [body.trim()] : []), '']));
    return `${lines.join('\n').replace(/\s*$/, '')}\n`;
  }

  /**
   * A notes file's text, kept for the source file `from`, with each link to the marker `oldName` on `target` renamed
   * `newName`; the same text when there is none.
   */
  static withLinksRenamed(text: string, from: vscode.Uri, target: vscode.Uri, oldName: string, newName: string): string {
    return text.replace(Notes.LINK, (link: string, linkPath: string, name: string) =>
      name.trim() === oldName && Notes.linkTarget({ path: linkPath.trim() }, from)?.fsPath === target.fsPath
        ? link.replace(`#${name}`, `#${newName}`)
        : link);
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
  /** Goes to a marker from a link to it: `(source file URI, name)`, opened beside, as a reference is (NotesBacklinks). */
  static readonly GO_TO_MARKER = 'incontext.notes.goToMarker';

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const here = (await NotesProvider.notesIn(document)).filter(({ range }) => range.start.line === position.line);
    if (here.length === 0) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: [NotesProvider.OPEN_NOTE, NotesProvider.OPEN_BESIDE, NotesProvider.GO_TO_MARKER] };
    markdown.supportThemeIcons = true;
    for (const { note, file } of here) {
      const linked = note.text ? NotesProvider.linkReferences(note.text, document.uri) : '_No note_';
      const edit = NotesProvider.commandLink(NotesProvider.OPEN_NOTE, [file.toString(), note.headingLine]);
      markdown.appendMarkdown(`$(bookmark) **${NotesProvider.escape(note.name)}**\n\n${linked}\n\n[Open as Markdown](${edit})\n\n`);
    }
    return new vscode.Hover(markdown);
  }

  /** The markers for a source file, each with the lines it shows on. */
  static async notesIn(document: vscode.TextDocument): Promise<{ note: Note; range: vscode.Range; file: vscode.Uri }[]> {
    const file = Notes.fileFor(document.uri);
    const text = file && await Notes.read(file);
    if (!file || !text) {
      return [];
    }
    return Notes.parse(text, path.basename(document.uri.fsPath)).map(note => ({ note, range: Notes.rangeIn(document, note), file }));
  }

  /**
   * Makes each link to a marker in a note's text (on the source file `from`) a link that goes to the marker, shown by
   * its name, and each reference a link that opens it beside the code, shown by its file and lines.
   */
  static linkReferences(text: string, from?: vscode.Uri): string {
    const spans = [
      ...[...text.matchAll(Notes.LINK)].map(match => {
        const name = match[2].trim();
        const target = from && Notes.linkTarget({ path: match[1].trim() }, from);
        const where = match[1].trim() ? NotesProvider.shortLabel(match[1].trim()) : 'this file';
        const link = target ? NotesProvider.commandLink(NotesProvider.GO_TO_MARKER, [target.toString(), name]) : undefined;
        // A link with its own text shows that, the marker's name on hover
        const alias = /\|([^\]\n]*)\]\]$/.exec(match[0])?.[1].trim();
        const shown = NotesProvider.escape(alias || name);
        return { start: match.index!, end: match.index! + match[0].length, markdown: link ? `[${shown}](${link} "${alias ? `${name} · ` : ''}${where}")` : shown };
      }),
      // Read as its file and lines; the whole reference shows on hover, and in the note's raw text
      ...Notes.referencesIn(text).map(match => ({
        start: match.start,
        end: match.end,
        markdown: `[${NotesProvider.shortLabel(match.reference)}](${NotesProvider.commandLink(NotesProvider.OPEN_BESIDE, [match.reference])} "${match.reference.replace(/"/g, '&quot;')}")`,
      })),
    ].sort((a, b) => a.start - b.start);
    let linked = '';
    let last = 0;
    for (const span of spans) {
      linked += text.slice(last, span.start) + span.markdown;
      last = span.end;
    }
    return linked + text.slice(last);
  }

  /** A marker's name in Markdown, its marks taken as text. */
  static escape(name: string): string {
    return name.replace(/[\\`*_{}[\]()<>#+!|~]/g, mark => `\\${mark}`);
  }

  /** A reference by its file and lines, as a note shows it: `@reports/src/a/handler.ts:L30` reads `handler.ts:L30`. */
  static shortLabel(reference: string): string {
    const folder = reference.endsWith('/');
    const parts = reference.replace(/^@/, '').replace(/\/$/, '').split('/');
    return `${parts[parts.length - 1]}${folder ? '/' : ''}`;
  }

  static commandLink(command: string, args: unknown[]): string {
    return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
  }
}
