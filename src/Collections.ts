import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkerLink, Notes, NotesProvider } from './Notes';
import { NoteEntry, NotesBacklinks } from './NotesBacklinks';
import { NotesTree, NotesTreeNode } from './NotesTree';

/**
 * A marker in a collection: a link to it, with the name and the note the collection gives it, which are only the
 * collection's. The marker keeps its own name and note.
 */
export interface Step {
  /** The link to the marker, as written. */
  link: MarkerLink;
  /** The step's name in this collection (`Persist: [[...]]`, or `[[...|Persist]]`), shown instead of the marker's. */
  label?: string;
  /** The text under the step's line: the collection's note on it. */
  note: string;
  /** The step's lines as written, its list item and the lines under it, which move with it, without its indent. */
  block: string[];
  /** How deep it is: 0 for a step, 1 for a step under it (a branch, or a step within that step), and so on. */
  depth: number;
}

/**
 * Markers in an order of your own, such as the steps of a flow: a Markdown file of its own, with a numbered list of
 * links to the markers. A marker can be in any number of collections, and none of them changes it.
 */
export interface Collection {
  name: string;
  file: vscode.Uri;
  /** The lines before the first step: the `# <name>` heading, and any introduction. */
  preamble: string[];
  steps: Step[];
}

/** A marker dragged from the Markers view, or added: the file it is on and its name. */
export interface MarkerRef {
  source: string;
  name: string;
}

/**
 * Collections of markers, each a Markdown file in a project's notes folder, `<notes folder>/_collections/<name>.md`:
 *
 * ```
 * # Checkout flow
 *
 * 1. [[shop/src/api.ts#Validates the amount]]
 * 2. Persist: [[shop/src/db.ts#Persists the refund]]
 *    Only on the retry path.
 * ```
 *
 * A step is a list item with a link to a marker. A label before the link names the step in this collection only, as
 * in a note (Notes.labelAt), and the lines under it are the collection's note on it. An item indented under a step is
 * a step within it, such as one of two ways on. Readable and editable by hand, by an AI tool, or in Obsidian.
 */
export class Collections {
  /** A list item: `1. `, `1) `, `- `, `* ` or `+ ` at the start of a line, after its indent. */
  private static readonly ITEM = /^(?:\d+[.)]|[-*+])[ \t]+/;
  /** How much a step within a step is indented, written: enough under `1. ` to `99. `. */
  private static readonly INDENT = '    ';

  /** The folder that holds a project's collections, in its notes folder; undefined while no notes folder is set. */
  static folder(project: vscode.WorkspaceFolder): string | undefined {
    const notes = Notes.projectFolder(project);
    return notes && path.join(notes, Notes.COLLECTIONS);
  }

  /** A collection's file as written, read: its name from its `# heading` (else the file's name), and its steps. */
  static parse(text: string, file: vscode.Uri): Collection {
    const preamble: string[] = [];
    const steps: Step[] = [];
    // The indents of the steps a step can be within, the nearest last
    const open: number[] = [];
    let indent = 0;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      const width = /^[ \t]*/.exec(line)![0].length;
      const item = line.slice(width);
      const link = Collections.ITEM.test(item) ? Notes.linksIn(item)[0] : undefined;
      if (link) {
        while (open.length && open[open.length - 1] >= width) {
          open.pop();
        }
        steps.push({ link, note: '', block: [item], depth: open.length });
        open.push(width);
        indent = width;
      } else if (steps.length) {
        // Its own indent taken off, as far as the line has it
        steps[steps.length - 1].block.push(line.slice(Math.min(indent, width)));
      } else {
        preamble.push(line);
      }
    }
    for (const step of steps) {
      while (step.block.length > 1 && !step.block[step.block.length - 1].trim()) {
        step.block.pop();
      }
      const item = step.block[0].replace(Collections.ITEM, '');
      const at = item.indexOf(step.link.text);
      step.label = Notes.labelAt(item, at, at + step.link.text.length);
      step.note = Collections.dedent(step.block.slice(1)).trim();
    }
    const heading = preamble.map(line => /^# (.*\S.*)$/.exec(line)?.[1].trim()).find(Boolean);
    return { name: heading ?? path.basename(file.fsPath, '.md'), file, preamble, steps };
  }

  /**
   * A collection as its file: its preamble, then its steps, each numbered by its place among the steps it is beside (a
   * `-` item stays one), and a step within a step indented under it.
   */
  static format(collection: Collection): string {
    const preamble = [...collection.preamble];
    while (preamble.length && !preamble[preamble.length - 1].trim()) {
      preamble.pop();
    }
    Collections.level(collection.steps);
    const numbers = Collections.numbers(collection.steps);
    const steps = collection.steps.map((step, index) => {
      const indent = Collections.INDENT.repeat(step.depth);
      const place = numbers[index].split('.').pop();
      return [indent + step.block[0].replace(/^\d+[.)]/, `${place}.`), ...step.block.slice(1).map(line => line.trim() ? indent + line : '')].join('\n');
    });
    return `${[preamble.join('\n'), steps.join('\n')].filter(Boolean).join('\n\n')}\n`;
  }

  /** Each step's number, by its place among the steps it is beside, within the step it is in: `2`, `2.1`, `2.1.1`. */
  static numbers(steps: Step[]): string[] {
    const counters: number[] = [];
    return steps.map(step => {
      counters.length = step.depth + 1;
      counters[step.depth] = (counters[step.depth] ?? 0) + 1;
      return counters.join('.');
    });
  }

  /** Each step at most one deeper than the one before it, and the first not within any: as a list can be written. */
  static level(steps: Step[]): void {
    steps.forEach((step, index) => {
      step.depth = Math.max(0, Math.min(step.depth, index ? steps[index - 1].depth + 1 : 0));
    });
  }

  /** Where the steps within the step at `index` end: the index after its last step within it. */
  static end(steps: Step[], index: number): number {
    let end = index + 1;
    while (end < steps.length && steps[end].depth > steps[index].depth) {
      end++;
    }
    return end;
  }

  /** The step at `index` and the steps within it, `depth` deeper. */
  static shifted(steps: Step[], depth: number): Step[] {
    return steps.map(step => ({ ...step, block: [...step.block], depth: step.depth + depth }));
  }

  /**
   * The steps with the steps at `indexes` (each with the steps within it) moved to `target`'s place, at its depth, so
   * a step dragged onto step 3 becomes step 3: before it, from below; after it and the steps within it, from above.
   * Unchanged when the target is among them.
   */
  static moved(steps: Step[], indexes: number[], target: number): Step[] {
    const tops = [...new Set(indexes)].sort((a, b) => a - b)
      .filter((index, at, all) => !all.slice(0, at).some(other => index < Collections.end(steps, other)));
    const moving = new Set(tops.flatMap(index => steps.slice(index, Collections.end(steps, index))));
    if (moving.has(steps[target]) || !steps[target]) {
      return steps;
    }
    const groups = tops.map(index => Collections.shifted(steps.slice(index, Collections.end(steps, index)), steps[target].depth - steps[index].depth));
    const kept = steps.filter(step => !moving.has(step));
    const at = kept.indexOf(steps[target]);
    const place = tops[0] < target ? Collections.end(kept, at) : at;
    kept.splice(place, 0, ...groups.flat());
    return kept;
  }

  /** The steps with the step at `index`, and the steps within it, beside the next step it is beside (`by` 1) or the one before (-1). */
  static swapped(steps: Step[], index: number, by: 1 | -1): Step[] {
    const end = Collections.end(steps, index);
    const depth = steps[index].depth;
    if (by < 0) {
      let before = index - 1;
      while (before >= 0 && steps[before].depth > depth) {
        before--;
      }
      return before < 0 || steps[before].depth < depth ? steps
        : [...steps.slice(0, before), ...steps.slice(index, end), ...steps.slice(before, index), ...steps.slice(end)];
    }
    if (end >= steps.length || steps[end].depth < depth) {
      return steps;
    }
    const after = Collections.end(steps, end);
    return [...steps.slice(0, index), ...steps.slice(end, after), ...steps.slice(index, end), ...steps.slice(after)];
  }

  /**
   * The steps with the step at `index`, and the steps within it, one deeper (`by` 1: within the step before it) or one
   * less deep (-1). Unchanged when it can't go: no step it is beside before it, or not within a step.
   */
  static indented(steps: Step[], index: number, by: 1 | -1): Step[] {
    const step = steps[index];
    if (by > 0 ? !index || steps[index - 1].depth < step.depth : !step.depth) {
      return steps;
    }
    const end = Collections.end(steps, index);
    return [...steps.slice(0, index), ...Collections.shifted(steps.slice(index, end), by), ...steps.slice(end)];
  }

  /** The steps without the steps at `indexes`; the steps within one stay, one less deep. */
  static without(steps: Step[], indexes: number[]): Step[] {
    let kept = steps.map(step => ({ ...step }));
    for (const index of [...new Set(indexes)].sort((a, b) => b - a)) {
      const end = Collections.end(kept, index);
      kept = [...kept.slice(0, index), ...Collections.shifted(kept.slice(index + 1, end), -1), ...kept.slice(end)];
    }
    return kept;
  }

  /** A step for the marker `name` on `source`, named `label` in the collection, if given. */
  static step(source: vscode.Uri, name: string, depth = 0, label?: string): Step {
    const text = Notes.link(source, name);
    const named = label?.replace(/[[\]|\n:]/g, ' ').replace(/\s+/g, ' ').trim();
    return { link: Notes.linksIn(text)[0], label: named || undefined, note: '', block: [`1. ${named ? `${named}: ` : ''}${text}`], depth };
  }

  /**
   * The step named `label` in its collection, or by the marker's name again when `label` is empty: `2. Persist:
   * [[...]]`, or, when its line says more than that, `[[...|Persist]]`.
   */
  static named(step: Step, label: string): Step {
    const clean = label.replace(/[[\]|\n]/g, ' ').replace(/\s+/g, ' ').trim();
    const bare = `[[${step.link.path}#${step.link.name}]]`;
    const marker = Collections.ITEM.exec(step.block[0])?.[0] ?? '1. ';
    const rest = step.block[0].slice(marker.length);
    const said = rest.replace(step.link.text, '').trim();
    const line = !said || (step.label !== undefined && /^[^\n:@[\]]*:$/.test(said))
      ? `${marker}${clean ? `${clean.replace(/:/g, ' ')}: ` : ''}${bare}`
      : `${marker}${rest.replace(step.link.text, clean ? `[[${step.link.path}#${step.link.name}|${clean}]]` : bare)}`;
    const block = [line, ...step.block.slice(1)];
    const named = Collections.parse(block.join('\n'), vscode.Uri.file('step.md')).steps[0];
    return named ? { ...named, depth: step.depth } : step;
  }

  /** The collections of the projects open in this window, by name. */
  static async readAll(): Promise<Collection[]> {
    const collections = new Map<string, Collection>();
    for (const project of vscode.workspace.workspaceFolders ?? []) {
      const folder = Collections.folder(project);
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = folder ? await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder)) : [];
      } catch {
        continue;
      }
      for (const [name, type] of entries) {
        const file = vscode.Uri.file(path.join(folder!, name));
        const text = type & vscode.FileType.File && name.endsWith('.md') ? await Notes.read(file) : undefined;
        if (text !== undefined) {
          collections.set(file.fsPath, Collections.parse(text, file));
        }
      }
    }
    return [...collections.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  static async write(collection: Collection): Promise<void> {
    await Notes.write(collection.file, Collections.format(collection));
  }

  /** A new collection named `name` in a project's notes folder, its file named after it. */
  static async create(name: string, project: vscode.WorkspaceFolder): Promise<Collection | undefined> {
    const folder = Collections.folder(project);
    if (!folder) {
      return undefined;
    }
    const collection: Collection = { name, file: Collections.freeFile(folder, name), preamble: [`# ${name}`], steps: [] };
    await Collections.write(collection);
    return collection;
  }

  /** Renames a collection, its heading and its file. */
  static async rename(collection: Collection, name: string): Promise<Collection> {
    const at = collection.preamble.findIndex(line => /^# /.test(line));
    const preamble = at < 0 ? [`# ${name}`, '', ...collection.preamble] : collection.preamble.map((line, index) => index === at ? `# ${name}` : line);
    const folder = path.dirname(collection.file.fsPath);
    const file = Collections.fileName(name) === path.basename(collection.file.fsPath, '.md') ? collection.file : Collections.freeFile(folder, name);
    const renamed = { ...collection, name, preamble, file };
    await Collections.write({ ...renamed, file: collection.file });
    if (file.fsPath !== collection.file.fsPath) {
      await vscode.workspace.fs.rename(collection.file, file);
    }
    return renamed;
  }

  /** A file for a collection named `name` that no other has: `<name>.md`, or `<name> 2.md`... */
  private static freeFile(folder: string, name: string): vscode.Uri {
    const base = Collections.fileName(name);
    let file = path.join(folder, `${base}.md`);
    for (let n = 2; fs.existsSync(file); n++) {
      file = path.join(folder, `${base} ${n}.md`);
    }
    return vscode.Uri.file(file);
  }

  /** A file name for a collection's name: without the characters a file name can't have. */
  private static fileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Collection';
  }

  private static dedent(lines: string[]): string {
    const indents = lines.filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)![0].length);
    const indent = indents.length ? Math.min(...indents) : 0;
    return lines.map(line => line.slice(Math.min(indent, /^[ \t]*/.exec(line)![0].length))).join('\n');
  }
}

/** A collection in the view, or one of its steps (`index` in its collection), with the marker it is, if there is one. */
export type CollectionNode =
  | { kind: 'collection'; collection: Collection }
  | { kind: 'step'; collection: Collection; index: number; entry?: NoteEntry; lines?: vscode.Range };

/**
 * The Collections view: each collection, and under it its steps in order, `1. Validates the amount`, with the steps
 * within a step under it, `2.1 Paste`. Drag markers from the Markers view onto a collection, or onto a step to put
 * them there; drag steps to order them, or onto another collection to add them there too; Move In and Move Out put a
 * step within the one before it, or out again. A click opens a step's marker at its lines. Next Step and Previous Step
 * go on from the step you last opened, and while you go through a collection, each of its markers shows its place in
 * it above its line, with ‹ and › (stepLenses).
 */
export class CollectionsTree implements vscode.TreeDataProvider<CollectionNode>, vscode.TreeDragAndDropController<CollectionNode>, vscode.Disposable {
  static readonly VIEW = 'incontext.collections';
  /** What a marker dragged from the Markers view carries: MarkerRef[] as JSON. */
  static readonly MARKER_MIME = 'application/vnd.incontext.marker';
  /** What a step dragged in this view carries: `{ file, index }[]` as JSON. */
  static readonly STEP_MIME = 'application/vnd.incontext.step';
  /** Adds the marker on a line to a collection: `(source file URI, line)`, 0-based, as a marker's box does. */
  static readonly ADD_AT = 'incontext.collections.addAt';
  readonly dragMimeTypes = [CollectionsTree.STEP_MIME];
  readonly dropMimeTypes = [CollectionsTree.STEP_MIME, CollectionsTree.MARKER_MIME];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<CollectionNode>;
  /** The step last opened, which Next Step and Previous Step go on from. */
  private current?: { file: string; index: number };
  /** The collection gone through, as last read, for the place of its markers above their lines. */
  private walked?: Collection;
  private readonly walkChanged = new vscode.EventEmitter<void>();
  /** Fires when you start or stop going through a collection, or it changes: the lenses above markers say where you are. */
  readonly onDidChangeWalk = this.walkChanged.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly notes: () => Promise<NoteEntry[]>, onNotesChanged: vscode.Event<void>) {
    this.view = vscode.window.createTreeView(CollectionsTree.VIEW, { treeDataProvider: this, dragAndDropController: this, showCollapseAll: true, canSelectMany: true });
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.disposables.push(
      this.view,
      this.changed,
      this.walkChanged,
      onNotesChanged(() => this.refresh()),
      this.view.onDidChangeVisibility(event => event.visible && this.refresh()),
      this.view.onDidChangeSelection(event => {
        const [node] = event.selection;
        if (node?.kind === 'step') {
          this.walk(node.collection.file.fsPath, node.index);
        }
      }),
      command('incontext.collections.new', (name?: string) => this.newCollection(name)),
      // From the Markers view, VS Code passes the row clicked and every row selected
      command('incontext.collections.addMarker', (node?: NotesTreeNode | MarkerRef, also?: string | NotesTreeNode[]) => this.addMarker(node, also)),
      command('incontext.collections.addMarkers', (node?: CollectionNode, markers?: MarkerRef[]) => this.addMarkers(node, markers)),
      command(CollectionsTree.ADD_AT, (file?: string, line?: number) => this.addAt(file, line)),
      command('incontext.collections.remove', (node?: CollectionNode, selected?: CollectionNode[]) => this.remove(node, selected)),
      command('incontext.collections.moveUp', (node?: CollectionNode) => this.edit(node, (steps, index) => Collections.swapped(steps, index, -1))),
      command('incontext.collections.moveDown', (node?: CollectionNode) => this.edit(node, (steps, index) => Collections.swapped(steps, index, 1))),
      command('incontext.collections.moveIn', (node?: CollectionNode) => this.edit(node, (steps, index) => Collections.indented(steps, index, 1))),
      command('incontext.collections.moveOut', (node?: CollectionNode) => this.edit(node, (steps, index) => Collections.indented(steps, index, -1))),
      command('incontext.collections.fromChain', (node?: NotesTreeNode, name?: string, takeOut?: boolean) => this.fromChain(node, name, takeOut)),
      command('incontext.collections.stop', () => this.walk(undefined)),
      command('incontext.collections.reveal', (file: string, index: number) => this.reveal(file, index)),
      command('incontext.collections.nameStep', (node?: CollectionNode, label?: string) => this.nameStep(node, label)),
      command('incontext.collections.rename', (node?: CollectionNode, name?: string) => this.renameCollection(node, name)),
      command('incontext.collections.delete', (node?: CollectionNode) => this.deleteCollection(node)),
      command('incontext.collections.openMarkdown', (node?: CollectionNode) => node && vscode.window.showTextDocument(node.collection.file)),
      command('incontext.collections.next', (file?: string, from?: number) => this.step(1, file, from)),
      command('incontext.collections.previous', (file?: string, from?: number) => this.step(-1, file, from)),
    );
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
  }

  refresh(): void {
    this.changed.fire();
    if (this.current) {
      void Collections.readAll().then(collections => {
        this.walked = collections.find(collection => collection.file.fsPath === this.current?.file);
        this.walkChanged.fire();
      });
    }
  }

  async getChildren(node?: CollectionNode): Promise<CollectionNode[]> {
    if (!node) {
      return (await Collections.readAll()).map(collection => ({ kind: 'collection', collection }));
    }
    const { steps } = node.collection;
    const from = node.kind === 'step' ? node.index + 1 : 0;
    const depth = node.kind === 'step' ? steps[node.index].depth + 1 : 0;
    const to = node.kind === 'step' ? Collections.end(steps, node.index) : steps.length;
    const entries = await this.notes();
    const within = steps.map((step, index) => ({ step, index })).slice(from, to).filter(({ step }) => step.depth === depth);
    return Promise.all(within.map(async ({ step, index }): Promise<CollectionNode> => {
      const entry = CollectionsTree.markerOf(entries, step, node.collection);
      return { kind: 'step', collection: node.collection, index, entry, lines: entry && await NotesBacklinks.linesOf(entry) };
    }));
  }

  getParent(node: CollectionNode): CollectionNode | undefined {
    if (node.kind === 'collection') {
      return undefined;
    }
    const { steps } = node.collection;
    let index = node.index - 1;
    while (index >= 0 && steps[index].depth >= steps[node.index].depth) {
      index--;
    }
    return index < 0 ? { kind: 'collection', collection: node.collection } : { kind: 'step', collection: node.collection, index };
  }

  getTreeItem(node: CollectionNode): vscode.TreeItem {
    const { collection } = node;
    if (node.kind === 'collection') {
      const item = new vscode.TreeItem(collection.name, collection.steps.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.id = collection.file.fsPath;
      item.description = `${collection.steps.length} step${collection.steps.length === 1 ? '' : 's'}`;
      item.tooltip = collection.file.fsPath;
      item.iconPath = new vscode.ThemeIcon('list-ordered');
      item.contextValue = 'collection';
      return item;
    }
    const step = collection.steps[node.index];
    const number = Collections.numbers(collection.steps)[node.index];
    const within = Collections.end(collection.steps, node.index) > node.index + 1;
    const item = new vscode.TreeItem(`${number}${step.depth ? '' : '.'} ${step.label ?? step.link.name}`,
      within ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `${collection.file.fsPath}#${node.index}`;
    item.contextValue = 'step';
    const stepNote = step.note ? `${step.note}\n\n---\n\n` : '';
    if (!node.entry) {
      item.description = 'no marker by this name';
      item.tooltip = new vscode.MarkdownString(`${stepNote}${NotesProvider.escape(step.link.text)}`);
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    const { source, note } = node.entry;
    item.description = `${step.label ? `${note.name} · ` : ''}${path.basename(source.fsPath)}:L${node.lines ? node.lines.start.line + 1 : note.line}`;
    item.tooltip = new vscode.MarkdownString(`${stepNote}**${NotesProvider.escape(note.name)}**\n\n${note.text || '_No note_'}`);
    item.iconPath = new vscode.ThemeIcon(step.note ? 'note' : 'bookmark');
    item.command = node.lines
      ? { title: 'Open', command: 'vscode.open', arguments: [source, { selection: node.lines }] }
      : { title: 'Go to Note', command: NotesBacklinks.GO_TO_NOTE, arguments: [source.toString(), note.line, note.lines, note.anchor, false] };
    return item;
  }

  handleDrag(source: readonly CollectionNode[], dataTransfer: vscode.DataTransfer): void {
    const steps = source.filter(node => node.kind === 'step').map(node => ({ file: node.collection.file.fsPath, index: (node as { index: number }).index }));
    if (steps.length) {
      dataTransfer.set(CollectionsTree.STEP_MIME, new vscode.DataTransferItem(JSON.stringify(steps)));
    }
  }

  /**
   * A drop: onto a collection, at its end; onto a step, at that step's place, so a step dragged onto step 3 becomes
   * step 3. Steps dragged within their collection move; from another collection, they are added, with their name and
   * note there. Markers from the Markers view are added; dropped on no collection, you pick one.
   */
  async handleDrop(target: CollectionNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const steps = await CollectionsTree.dragged<{ file: string; index: number }>(dataTransfer, CollectionsTree.STEP_MIME);
    const markers = await CollectionsTree.dragged<MarkerRef>(dataTransfer, CollectionsTree.MARKER_MIME);
    const collections = await Collections.readAll();
    const into = target && collections.find(collection => collection.file.fsPath === target.collection.file.fsPath);
    if (!into) {
      const dropped = markers ?? [];
      const collection = dropped.length ? await this.pickCollection(collections, `Add ${CollectionsTree.which(dropped)} to which collection?`) : undefined;
      if (collection) {
        await this.append(collection, dropped);
      }
      return;
    }
    const at = target!.kind === 'step' ? target!.index : into.steps.length;
    const depth = target!.kind === 'step' ? into.steps[at].depth : 0;
    if (steps) {
      if (steps.every(step => step.file === into.file.fsPath)) {
        if (target!.kind === 'step') {
          into.steps = Collections.moved(into.steps, steps.map(step => step.index), at);
        } else {
          // Onto the collection: to its end, as steps of their own
          const end = into.steps.length;
          into.steps.push({ ...into.steps[end - 1], depth: 0 });
          into.steps = Collections.moved(into.steps, steps.map(step => step.index), end).filter(step => step !== into.steps[end]);
        }
        await this.save(into);
        return;
      }
      // From another collection: added, with the steps within each
      const copies = steps.flatMap(({ file, index }) => {
        const from = collections.find(collection => collection.file.fsPath === file)?.steps;
        return from?.[index] ? Collections.shifted(from.slice(index, Collections.end(from, index)), depth - from[index].depth) : [];
      });
      await this.insert(into, at, copies);
    } else if (markers) {
      await this.insert(into, at, CollectionsTree.markersIn(markers).map(marker => Collections.step(vscode.Uri.parse(marker.source, true), marker.name, depth)));
    }
  }

  /**
   * What a drag carries as `mime`, as JSON; undefined when it carries none. On a drop VS Code passes an empty item of
   * each type the drag declared first (the window's own), then the drag's: `get` would return the empty one.
   */
  static async dragged<T>(dataTransfer: vscode.DataTransfer, mime: string): Promise<T[] | undefined> {
    let found: T[] | undefined;
    for (const [type, item] of dataTransfer) {
      const text = type === mime ? (await item.asString()).trim() : '';
      try {
        found = text ? JSON.parse(text) : found;
      } catch {
        // Not ours
      }
    }
    return found;
  }

  /** The marker a step links to, if there is one by that name. */
  static markerOf(entries: NoteEntry[], step: Step, collection: Collection): NoteEntry | undefined {
    const file = Notes.linkTarget(step.link, collection.file);
    return file && entries.find(entry => entry.source.fsPath === file.fsPath && entry.note.name === step.link.name);
  }

  private async insert(collection: Collection, at: number, steps: Step[]): Promise<void> {
    collection.steps.splice(at, 0, ...steps);
    await this.save(collection);
  }

  private async save(collection: Collection): Promise<void> {
    await Collections.write(collection);
    this.refresh();
  }

  /** Changes a step's collection: `change` gets its steps and the step's place in them, and gives the steps it has then. */
  private async edit(node: CollectionNode | undefined, change: (steps: Step[], index: number) => Step[]): Promise<void> {
    const collection = node?.kind === 'step' && (await Collections.readAll()).find(other => other.file.fsPath === node.collection.file.fsPath);
    if (!collection || node?.kind !== 'step' || !collection.steps[node.index]) {
      return;
    }
    collection.steps = change(collection.steps, node.index);
    await this.save(collection);
  }

  /** New Collection: asks its name, and the project to keep it in when several are open. */
  private async newCollection(name?: string): Promise<Collection | undefined> {
    const project = await this.pickProject();
    if (!project) {
      return undefined;
    }
    const named = name ?? (await vscode.window.showInputBox({ title: 'New Collection', prompt: 'Its name, such as the flow its markers are the steps of', placeHolder: 'Checkout flow' }))?.trim();
    if (!named) {
      return undefined;
    }
    const collection = await Collections.create(named, project);
    this.refresh();
    return collection;
  }

  /** The project whose notes folder a new collection goes in: the one open, the active editor's, or the one you pick. */
  private async pickProject(): Promise<vscode.WorkspaceFolder | undefined> {
    const projects = vscode.workspace.workspaceFolders ?? [];
    if (!projects.some(project => Collections.folder(project)) && !await Notes.askFolder()) {
      return undefined;
    }
    const withFolder = projects.filter(project => Collections.folder(project));
    const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    if (withFolder.length <= 1 || (active && withFolder.includes(active))) {
      return withFolder.length > 1 ? active : withFolder[0];
    }
    return (await vscode.window.showQuickPick(withFolder.map(project => ({ label: project.name, project })), { title: 'New Collection', placeHolder: 'Keep it in which project\'s notes?' }))?.project;
  }

  /** Picks a collection, or makes a new one. */
  private async pickCollection(collections: Collection[], placeHolder: string): Promise<Collection | undefined> {
    const NEW = '$(add) New collection…';
    const picked = await vscode.window.showQuickPick(
      [...collections.map(collection => ({ label: collection.name, description: `${collection.steps.length} steps`, collection })), { label: NEW, collection: undefined }],
      { title: 'Add to Collection', placeHolder });
    return picked?.label === NEW ? this.newCollection() : picked?.collection;
  }

  /**
   * Add to Collection…: the marker (a row of the Markers view, or a marker by its file and name) as the last step of
   * the collection in `file`, or of the one you pick.
   */
  private async addMarker(node?: NotesTreeNode | MarkerRef, also?: string | NotesTreeNode[]): Promise<void> {
    const markers = CollectionsTree.markersIn(Array.isArray(also) && also.length ? also : node ? [node] : []);
    if (!markers.length) {
      return this.addAt();
    }
    const collections = await Collections.readAll();
    // A file's path, or its URI
    const file = typeof also === 'string' ? also : undefined;
    const wanted = file && (/^[a-z][\w+.-]+:\/\//i.test(file) ? vscode.Uri.parse(file, true).fsPath : file);
    const collection = wanted ? collections.find(other => other.file.fsPath === wanted)
      : await this.pickCollection(collections, `Add ${CollectionsTree.which(markers)} to which collection?`);
    if (collection) {
      await this.append(collection, markers);
    }
  }

  /** The markers among rows of the Markers view, or markers by their file and name, each once, in order. */
  static markersIn(nodes: (NotesTreeNode | MarkerRef)[]): MarkerRef[] {
    const markers = new Map<string, MarkerRef>();
    for (const node of nodes) {
      const marker = 'kind' in node ? (node.kind === 'note' ? { source: node.entry.source.toString(), name: node.entry.note.name } : undefined) : node;
      if (marker) {
        markers.set(`${marker.source}#${marker.name}`, marker);
      }
    }
    return [...markers.values()];
  }

  private static which(markers: MarkerRef[]): string {
    return markers.length === 1 ? `"${markers[0].name}"` : `these ${markers.length} markers`;
  }

  /** Adds markers as a collection's last steps, and says so. */
  private async append(collection: Collection, markers: MarkerRef[]): Promise<void> {
    await this.insert(collection, collection.steps.length, markers.map(marker => Collections.step(vscode.Uri.parse(marker.source, true), marker.name)));
    vscode.window.setStatusBarMessage(markers.length === 1
      ? `$(list-ordered) "${markers[0].name}" is step ${collection.steps.length} of ${collection.name}`
      : `$(list-ordered) ${markers.length} markers are steps ${collection.steps.length - markers.length + 1}–${collection.steps.length} of ${collection.name}`, 4000);
  }

  /**
   * Add Markers… on a collection: picks any number of markers, in the order of their files and lines, as its last
   * steps; without dragging them in one by one.
   */
  private async addMarkers(node?: CollectionNode, given?: MarkerRef[]): Promise<void> {
    const collection = node && (await Collections.readAll()).find(other => other.file.fsPath === node.collection.file.fsPath);
    if (!collection) {
      return;
    }
    let markers = given;
    if (!markers) {
      const entries = [...await this.notes()].sort((a, b) => a.source.fsPath.localeCompare(b.source.fsPath) || a.note.line - b.note.line);
      const picked = await vscode.window.showQuickPick(entries.map(entry => ({
        label: entry.note.name,
        description: `${vscode.workspace.asRelativePath(entry.source)}:L${entry.note.line}`,
        detail: entry.note.text.split('\n').map(line => line.trim()).find(Boolean),
        marker: { source: entry.source.toString(), name: entry.note.name },
      })), { title: `Add to ${collection.name}`, placeHolder: 'Pick the markers to add, as its last steps', canPickMany: true, matchOnDescription: true, matchOnDetail: true });
      markers = picked?.map(item => item.marker);
    }
    if (markers?.length) {
      await this.append(collection, markers);
    }
  }

  /** Remove from Collection: the step, or every step selected; the steps within one stay, one less deep. */
  private async remove(node?: CollectionNode, selected?: CollectionNode[]): Promise<void> {
    const steps = (selected?.length ? selected : node ? [node] : []).filter(step => step.kind === 'step') as Extract<CollectionNode, { kind: 'step' }>[];
    const collections = await Collections.readAll();
    for (const collection of collections) {
      const indexes = steps.filter(step => step.collection.file.fsPath === collection.file.fsPath).map(step => step.index);
      if (indexes.length) {
        collection.steps = Collections.without(collection.steps, indexes);
        await Collections.write(collection);
      }
    }
    this.refresh();
  }

  /** Add to Collection… in a marker's box, or for the marker at the cursor. */
  private async addAt(file?: string, line?: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri = file ? vscode.Uri.parse(file, true) : editor?.document.uri;
    const document = uri && await vscode.workspace.openTextDocument(uri);
    const at = line ?? editor?.selection.active.line;
    const here = document && at !== undefined
      ? (await NotesProvider.notesIn(document)).find(({ range }) => file ? range.start.line === at : range.start.line <= at && at <= range.end.line)
      : undefined;
    if (!document || !here) {
      vscode.window.showInformationMessage('Put the cursor on a marker\'s lines to add it to a collection.');
      return;
    }
    await this.addMarker({ source: document.uri.toString(), name: here.note.name });
  }

  /** Name Step…: the step's name in its collection only; empty, the marker's own name again. */
  private async nameStep(node?: CollectionNode, label?: string): Promise<void> {
    if (node?.kind !== 'step') {
      return;
    }
    const step = node.collection.steps[node.index];
    const named = label ?? await vscode.window.showInputBox({
      title: `Name step ${node.index + 1} in ${node.collection.name}`,
      prompt: `Only in this collection: the marker stays "${step.link.name}". Empty for its own name.`,
      value: step.label ?? '',
      placeHolder: step.link.name,
    });
    if (named !== undefined) {
      await this.edit(node, (steps, index) => steps.map((step, at) => at === index ? Collections.named(step, named) : step));
    }
  }

  private async renameCollection(node?: CollectionNode, name?: string): Promise<void> {
    if (!node) {
      return;
    }
    const named = (name ?? await vscode.window.showInputBox({ title: 'Rename Collection', value: node.collection.name }))?.trim();
    if (named && named !== node.collection.name) {
      const renamed = await Collections.rename(node.collection, named);
      if (this.current?.file === node.collection.file.fsPath) {
        this.current.file = renamed.file.fsPath;
      }
      this.refresh();
    }
  }

  /** Deletes a collection's file, to the trash; its markers stay as they are. */
  private async deleteCollection(node?: CollectionNode): Promise<void> {
    if (!node) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(`Delete the collection "${node.collection.name}"?`,
      { modal: true, detail: 'Its markers stay as they are. The file goes to the trash.' }, 'Delete');
    if (answer === 'Delete') {
      await vscode.workspace.fs.delete(node.collection.file, { useTrash: true });
      if (this.current?.file === node.collection.file.fsPath) {
        this.walk(undefined);
      }
      this.refresh();
    }
  }

  /** The step Next Step and Previous Step go on from; none, and their buttons and the places above markers go. */
  private walk(file: string | undefined, index = 0, collection?: Collection): void {
    const changed = this.current?.file !== file;
    this.current = file === undefined ? undefined : { file, index };
    void vscode.commands.executeCommand('setContext', 'incontext.collections.walking', !!file);
    if (!file) {
      this.walked = undefined;
      this.walkChanged.fire();
    } else if (collection) {
      this.walked = collection;
      this.walkChanged.fire();
    } else if (changed || !this.walked) {
      this.refresh();
    } else {
      this.walkChanged.fire();
    }
  }

  /**
   * Above a marker in the collection you are going through: `‹`, its place in it (`Image upload 3/5`, which shows it
   * in the view), and `›`, the step before and after it. Where it is several steps, the one you are at, else its first.
   */
  stepLenses(source: vscode.Uri, name: string): vscode.Command[] {
    const collection = this.walked;
    if (!collection || !this.current) {
      return [];
    }
    const places = collection.steps.map((step, index) => ({ step, index }))
      .filter(({ step }) => step.link.name === name && Notes.linkTarget(step.link, collection.file)?.fsPath === source.fsPath);
    const place = places.find(({ index }) => index === this.current?.index) ?? places[0];
    if (!place) {
      return [];
    }
    const { index } = place;
    const file = collection.file.fsPath;
    const count = collection.steps.length;
    const titleOf = (at: number) => collection.steps[at].label ?? collection.steps[at].link.name;
    return [
      ...(index > 0 ? [{ title: '‹', tooltip: `Step ${index}: ${titleOf(index - 1)}`, command: 'incontext.collections.previous', arguments: [file, index] }] : []),
      { title: `${collection.name} ${index + 1}/${count}`, tooltip: `Step ${index + 1} of ${collection.name}: show it in the Collections view`, command: 'incontext.collections.reveal', arguments: [file, index] },
      ...(index < count - 1 ? [{ title: '›', tooltip: `Step ${index + 2}: ${titleOf(index + 1)}`, command: 'incontext.collections.next', arguments: [file, index] }] : []),
    ];
  }

  /** Shows a step in the Collections view. */
  private async reveal(file: string, index: number): Promise<void> {
    const collection = (await Collections.readAll()).find(other => other.file.fsPath === file);
    if (collection?.steps[index]) {
      await vscode.commands.executeCommand(`${CollectionsTree.VIEW}.focus`);
      await Promise.resolve(this.view.reveal({ kind: 'step', collection, index }, { select: true, focus: true, expand: true })).catch(() => undefined);
    }
  }

  /**
   * Make Collection from Chain: the markers a marker's note leads to, and theirs, as a collection's steps in that
   * order, named as the notes name them (`Next, the upload call` is `The upload call`). A marker that leads to one
   * marker goes on beside it; one that leads to several has each way within it. With `takeOut` (else asked), the links
   * it followed come out of the notes, and the links back, so the collection alone keeps the order.
   */
  private async fromChain(node?: NotesTreeNode, name?: string, takeOut?: boolean): Promise<Collection | undefined> {
    if (node?.kind !== 'note') {
      return undefined;
    }
    // As the notes are now: they may have changed a moment ago
    const entries = await NotesBacklinks.readNotes();
    const key = (entry: NoteEntry) => `${entry.source.fsPath}#${entry.note.name}`;
    const seen = new Set<string>();
    const steps: Step[] = [];
    const followed: { from: NoteEntry; reference: string; to: NoteEntry }[] = [];
    // A marker's one way on goes beside it, unless it starts a way of its own: then within it, as several ways are
    const visit = (entry: NoteEntry, depth: number, starts: boolean, label?: string) => {
      seen.add(key(entry));
      steps.push(Collections.step(entry.source, entry.note.name, depth, CollectionsTree.stepName(label)));
      const onward = NotesTree.onward(entries, entry).filter(({ next }) => next && !seen.has(key(next)))
        .filter(({ next }, at, all) => all.findIndex(other => other.next === next) === at);
      for (const { next, reference, label: named } of onward) {
        if (!seen.has(key(next!))) {
          followed.push({ from: entry, reference, to: next! });
          visit(next!, onward.length === 1 && !starts ? depth : depth + 1, onward.length > 1, named);
        }
      }
    };
    visit(node.entry, 0, false);
    if (steps.length < 2) {
      vscode.window.showInformationMessage(`"${node.entry.note.name}" links to no other marker: there is no chain to make a collection of.`);
      return undefined;
    }
    const project = vscode.workspace.getWorkspaceFolder(node.entry.source);
    const named = (name ?? await vscode.window.showInputBox({ title: 'Make Collection from Chain', prompt: `The ${steps.length} markers from "${node.entry.note.name}" on, in a collection named`, value: node.entry.note.name }))?.trim();
    const collection = named && project && await Collections.create(named, project);
    if (!collection) {
      return undefined;
    }
    collection.steps = steps;
    await Collections.write(collection);
    this.refresh();
    const answer = takeOut ?? (await vscode.window.showInformationMessage(`"${collection.name}" has the ${steps.length} markers in order. Take the links the chain was made of out of their notes?`,
      { modal: true, detail: 'The collection keeps the order now. Each link to the next marker, and its link back, comes out of the notes; their other links and references stay.' },
      'Take Them Out', 'Keep Them')) === 'Take Them Out';
    if (answer) {
      await CollectionsTree.takeOut(followed);
    }
    return collection;
  }

  /** A step's name from the name a note gave the link to it: `Next, the upload call` is `The upload call`. */
  static stepName(label?: string): string | undefined {
    const name = label?.replace(/^(?:and\s+)?(?:next|then|after that|finally)\b\s*[,:–-]?\s*/i, '').trim();
    return name ? name[0].toUpperCase() + name.slice(1) : undefined;
  }

  /**
   * Takes the links a chain was made of out of the notes, and the links back, written on a line of their own. Not a
   * plain reference: it is part of what the note says.
   */
  private static async takeOut(followed: { from: NoteEntry; reference: string; to: NoteEntry }[]): Promise<void> {
    const changes: { entry: NoteEntry; text: string; labelled: boolean }[] = followed.flatMap(({ from, reference, to }) => [
      ...Notes.linksIn(reference).length ? [{ entry: from, text: reference, labelled: true }] : [],
      { entry: to, text: Notes.link(from.source, from.note.name), labelled: false },
    ]);
    for (const { entry, text, labelled } of changes) {
      const current = await Notes.read(entry.notesFile);
      const marker = current === undefined ? undefined : Notes.parse(current, path.basename(entry.source.fsPath)).find(other => other.name === entry.note.name);
      if (!marker) {
        continue;
      }
      // Found by where it leads: a link can be written with text of its own, or relative to its file (`[[#Name]]`)
      const link = Notes.linksIn(text)[0];
      const written = link
        ? marker.links.find(other => other.name === link.name && Notes.linkTarget(other, entry.source)?.fsPath === Notes.linkTarget(link, entry.source)?.fsPath)?.text
        : marker.references.find(reference => reference === text);
      const kept = written === undefined ? marker.text : Notes.withoutLink(marker.text, written, labelled);
      if (kept !== marker.text) {
        const heading = Notes.heading(marker.name, marker.line, marker.anchor, marker.line + marker.lines - 1);
        await Notes.write(entry.notesFile, Notes.withSection(current!, marker.headingLine, kept, heading));
      }
    }
  }

  /**
   * Next Step (`delta` 1) or Previous Step (-1): opens the marker of the step after or before the one you last opened,
   * in the collection in `file`, or that one, or the one you pick, from its first step.
   */
  private async step(delta: number, file?: string, from?: number): Promise<void> {
    const collections = await Collections.readAll();
    let collection = collections.find(other => other.file.fsPath === (file ?? this.current?.file));
    let index = collection && from !== undefined ? from + delta
      : collection && this.current?.file === collection.file.fsPath ? this.current.index + delta : delta > 0 ? 0 : (collection?.steps.length ?? 0) - 1;
    if (!collection) {
      collection = await this.pickCollection(collections.filter(other => other.steps.length), 'Go through which collection?');
      index = delta > 0 ? 0 : (collection?.steps.length ?? 0) - 1;
    }
    if (!collection) {
      return;
    }
    if (index < 0 || index >= collection.steps.length) {
      vscode.window.setStatusBarMessage(`$(list-ordered) That was the ${delta > 0 ? 'last' : 'first'} step of ${collection.name}`, 4000);
      return;
    }
    this.walk(collection.file.fsPath, index, collection);
    const step = collection.steps[index];
    // As the notes are now: a step's marker may have been made a moment ago
    const entry = CollectionsTree.markerOf(await NotesBacklinks.readNotes(), step, collection);
    const lines = entry && await NotesBacklinks.linesOf(entry);
    vscode.window.setStatusBarMessage(`$(list-ordered) ${collection.name}: step ${index + 1} of ${collection.steps.length}`, 4000);
    if (this.view.visible) {
      const node: CollectionNode = { kind: 'step', collection, index, entry, lines };
      void Promise.resolve(this.view.reveal(node, { select: true, focus: false })).catch(() => undefined);
    }
    if (!entry || !lines) {
      vscode.window.showWarningMessage(`Step ${index + 1} of ${collection.name} is a link to no marker: "${step.link.name}".`);
      return;
    }
    await vscode.window.showTextDocument(entry.source, { selection: lines });
  }
}
