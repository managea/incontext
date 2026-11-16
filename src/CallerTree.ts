import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// The Caller Tree view: everything that can reach the function at the cursor, followed up to its entry points one
// level at a time with the language server's references (calls, dynamic imports, functions passed as values) and
// document symbols. Ported from Agent View (components/agent-view, extension.js), which keeps the same walk for
// its panel rows and text tab.

const K = vscode.SymbolKind;
const CONTAINERS = new Set([K.Class, K.Interface, K.Enum, K.Module, K.Namespace]);
const MEMBERS = new Set([K.Function, K.Method, K.Constructor, K.Property, K.Field, K.Variable, K.Constant]);
const FUNCS = new Set([K.Function, K.Method, K.Constructor]);
const VARS = new Set([K.Variable, K.Constant, K.Property, K.Field]);
const HTTP = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ROUTE_FILE = /[\\/]app[\\/](.+[\\/])?route\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/]/;
const ANON = / callback$|^<function>$/;
const ENTRY_KINDS = ['ROUTE', 'MODULE', 'NO REFS', 'TESTS ONLY'] as const;
type EntryKind = typeof ENTRY_KINDS[number];
const ENTRY_ICONS: Record<EntryKind, string> = { ROUTE: 'globe', MODULE: 'file-code', 'NO REFS': 'circle-slash', 'TESTS ONLY': 'beaker' };
/** Limits of one walk; the view stops after 20 s so it stays live. */
export const LIMITS = { depth: 12, functions: 400, seconds: 20, parallel: 4 };
const DELAY_MS = 300;

export interface CallerTarget {
  name: string;
  uri: vscode.Uri;
  pos: vscode.Position;
}

export interface CallerEdge {
  from: CallerNode;
  /** 1-based lines in `from`'s file where it uses the node. */
  lines: number[];
  /** True when at least one use is a direct call (else a reference: passed as a value, dynamic import). */
  call: boolean;
}

export interface CallerNode {
  key: string;
  name: string;
  uri: vscode.Uri;
  pos: vscode.Position;
  depth: number;
  callers: CallerEdge[];
  /** References from test files that were skipped. */
  tests: number;
  route?: boolean;
  module?: boolean;
  /** Not followed further (a limit was reached). */
  cut?: boolean;
  /** The first edge it was found through: the chain down to the root. */
  via?: { to: CallerNode; edge: CallerEdge };
}

export interface CallerTreeResult {
  root: CallerNode;
  dir: string;
  nodes: CallerNode[];
  skipped: { tests: number; types: number; comments: number; external: number };
  reasons: string[];
  rootFound: number;
  ms: number;
}

interface FileInfo {
  doc: vscode.TextDocument;
  imports: Set<number>;
  symbols: vscode.DocumentSymbol[];
}

const spot = (uri: vscode.Uri, line: number) => `${uri.toString()}#${line}`;
const FOLD = process.platform === 'darwin' || process.platform === 'win32';

function under(p: string, dir: string): boolean {
  if (!p || !dir) { return false; }
  const prefix = dir + path.sep;
  return FOLD ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
}

function real(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== 'file' || !uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) { return uri; }
  try {
    return vscode.Uri.file(fs.realpathSync(uri.fsPath));
  } catch {
    return uri;
  }
}

function isExternal(uri: vscode.Uri, dir: string): boolean {
  const p = uri.fsPath || '';
  return p.includes(`${path.sep}node_modules${path.sep}`) || !under(p, dir);
}

/** A path as the view shows it: from the workspace folder, else from the home folder. */
export function rel(uri: vscode.Uri, dir: string): string {
  if (uri.scheme !== 'file') { return uri.toString(); }
  const p = uri.fsPath;
  if (under(p, dir)) { return p.slice(dir.length + 1); }
  return under(p, os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;
}

const place = (uri: vscode.Uri, line: number, dir: string) => `${rel(uri, dir)}:${line + 1}`;

async function run<T>(command: string, ...args: unknown[]): Promise<T[]> {
  return (await vscode.commands.executeCommand<T[]>(command, ...args)) || [];
}

async function documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  const found = await run<vscode.DocumentSymbol | vscode.SymbolInformation>('vscode.executeDocumentSymbolProvider', uri);
  if (found.length && !('children' in found[0])) {
    return (found as vscode.SymbolInformation[]).map(s => ({
      name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range, children: [], detail: '',
    }));
  }
  return found as vscode.DocumentSymbol[];
}

function symbolPath(symbols: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol[] {
  const chain: vscode.DocumentSymbol[] = [];
  let hit = symbols.find(s => s.range.contains(pos));
  while (hit) {
    chain.push(hit);
    hit = (hit.children || []).find(s => s.range.contains(pos));
  }
  return chain;
}

function importLines(doc: vscode.TextDocument): Set<number> {
  const lines = new Set<number>();
  let open = false;
  for (let i = 0; i < doc.lineCount; i += 1) {
    const text = doc.lineAt(i).text;
    if (!open && !/^\s*import\b/.test(text)) { continue; }
    lines.add(i);
    open = !/\bfrom\b|;\s*$|^\s*import\s+['"]/.test(text);
  }
  return lines;
}

// A variable or property holding a function: `const f = async () =>`, `POST = withAuth(async (req) =>`.
const FUNCTION_VALUE = /^\s*(:[^=]*)?=\s*([\w$.]+(<[^>]*>)?\(\s*)?(async\s+)?(function\b|\(|[\w$]+\s*=>)/;

function holdsFunction(doc: vscode.TextDocument, s: vscode.DocumentSymbol): boolean {
  const end = (s.selectionRange || s.range).end;
  return FUNCTION_VALUE.test(doc.lineAt(end.line).text.slice(end.character));
}

// The symbol whose name starts exactly here, when the reference is itself a declaration name. (Anonymous
// callbacks can have a name range covering their whole body, so containment is not enough.)
function declaredAt(symbols: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol | undefined {
  return symbolPath(symbols, pos).find(s => !ANON.test(s.name) && s.selectionRange
    && s.selectionRange.start.line === pos.line && s.selectionRange.start.character === pos.character);
}

// The named function a reference sits in, as a reader would name it. Anonymous callbacks and object-literal
// methods are transparent (`new ReadableStream({ start() {...} })` inside POST belongs to POST), and so are
// local variables that do not hold a function. Top-level and class-level variables count: they can be imported.
function ownerOf(symbols: vscode.DocumentSymbol[], pos: vscode.Position, doc: vscode.TextDocument)
  : { symbol: vscode.DocumentSymbol; top: boolean } | undefined {
  const chain = symbolPath(symbols, pos);
  const declared = declaredAt(symbols, pos);
  let owner: vscode.DocumentSymbol | undefined;
  chain.forEach((s, i) => {
    if (ANON.test(s.name) || s === declared) { return; }
    const member = i === 0 || CONTAINERS.has(chain[i - 1].kind);
    if (s.kind === K.Method && !member) { return; }
    if (FUNCS.has(s.kind) || (VARS.has(s.kind) && (member || holdsFunction(doc, s)))) { owner = s; }
  });
  return owner && { symbol: owner, top: chain[0] === owner };
}

// A reference that is another declaration with the same name: another implementation of a shared interface
// member, or an overload. Uses that look like declarations are kept: destructured variables
// (`const { f } = await import(...)`) and shorthand properties (`run({ f })`).
function otherDeclaration(symbols: vscode.DocumentSymbol[], pos: vscode.Position, after: string): boolean {
  const s = declaredAt(symbols, pos);
  return Boolean(s) && s!.kind !== K.Variable && s!.kind !== K.Constant && !/^\s*([,}]|$)/.test(after);
}

async function each<T>(list: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const item = list[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

async function fileInfo(uri: vscode.Uri): Promise<FileInfo | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return { doc, imports: importLines(doc), symbols: await documentSymbols(uri).catch(() => []) };
  } catch {
    return undefined;
  }
}

function findBase(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
}

const byPlace = (a: vscode.Location, b: vscode.Location) => a.uri.toString().localeCompare(b.uri.toString())
  || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;

/** Walks the callers of `target` up to their entry points. Test files are skipped (counted on the node). */
export async function callerTree(target: CallerTarget, token?: vscode.CancellationToken,
  limits = LIMITS): Promise<CallerTreeResult> {
  const started = Date.now();
  const dir = findBase(target.uri);
  const nodes = new Map<string, CallerNode>();
  const files = new Map<string, FileInfo | undefined>();
  const skipped = { tests: 0, types: 0, comments: 0, external: 0 };
  const reasons = new Set<string>();
  let rootFound = 0;
  const halted = () => {
    if (token?.isCancellationRequested) { reasons.add('cancelled'); }
    else if (Date.now() - started > limits.seconds * 1000) { reasons.add(`${limits.seconds} s`); }
    else { return false; }
    return true;
  };
  const add = (name: string, uri: vscode.Uri, pos: vscode.Position, depth: number,
    extra: { route?: boolean; module?: boolean }): [CallerNode | undefined, boolean] => {
    const key = extra.module ? `${uri.toString()}#module` : `${spot(uri, pos.line)}:${pos.character}`;
    const known = nodes.get(key);
    if (known) { return [known, false]; }
    if (nodes.size >= limits.functions) {
      reasons.add(`${limits.functions} functions`);
      return [undefined, false];
    }
    const node: CallerNode = { key, name, uri, pos, depth, callers: [], tests: 0, ...extra };
    nodes.set(key, node);
    return [node, true];
  };
  const root = add(target.name, target.uri, target.pos, 0, {})[0]!;
  let level = [root];
  while (level.length) {
    const todo: CallerNode[] = [];
    for (const node of level) {
      if (node.route || node.module) { continue; }
      if (node.depth >= limits.depth) { reasons.add(`depth ${limits.depth}`); }
      if (node.depth >= limits.depth || halted()) { node.cut = true; } else { todo.push(node); }
    }
    const found = new Map<CallerNode, vscode.Location[]>();
    await each(todo, limits.parallel, async node => {
      if (halted()) { return; }
      const locs = await run<vscode.Location>('vscode.executeReferenceProvider', node.uri, node.pos);
      found.set(node, locs);
      if (node === root) { rootFound = locs.length; }
    });
    const need = new Map<string, vscode.Uri>();
    for (const locs of found.values()) {
      for (const loc of locs) {
        const key = loc.uri.toString();
        if (!files.has(key) && !isExternal(real(loc.uri), dir) && !TEST_FILE.test(loc.uri.fsPath)) { need.set(key, loc.uri); }
      }
    }
    await each([...need.values()], limits.parallel, async uri => { files.set(uri.toString(), await fileInfo(uri)); });
    const next: CallerNode[] = [];
    for (const node of todo) {
      const locs = found.get(node);
      if (!locs) {
        node.cut = true;
        continue;
      }
      const name = node.name.replace(/[^\w$]/g, '').replace(/\$/g, '\\$');
      const typeOnly = new RegExp(`\\btypeof\\s+(import\\([^)]*\\)\\.)?${name}\\b`);
      for (const loc of [...locs].sort(byPlace)) {
        const at = loc.range.start;
        if (spot(loc.uri, at.line) === spot(node.uri, node.pos.line) && at.character === node.pos.character) { continue; }
        if (isExternal(real(loc.uri), dir)) { skipped.external += 1; continue; }
        if (TEST_FILE.test(loc.uri.fsPath)) { skipped.tests += 1; node.tests += 1; continue; }
        const info = files.get(loc.uri.toString());
        if (!info) { continue; }
        const text = info.doc.lineAt(at.line).text;
        if (info.imports.has(at.line) || /^\s*export\s*(\{|\*)/.test(text)) { continue; }
        if (/^\s*(\/\/|\/?\*)/.test(text)) { skipped.comments += 1; continue; }
        if (typeOnly.test(text)) { skipped.types += 1; continue; }
        if (otherDeclaration(info.symbols, at, text.slice(loc.range.end.character))) { continue; }
        const owner = ownerOf(info.symbols, at, info.doc);
        const [from, fresh] = owner
          ? add(owner.symbol.name, loc.uri, (owner.symbol.selectionRange || owner.symbol.range).start, node.depth + 1,
            { route: owner.top && HTTP.has(owner.symbol.name) && ROUTE_FILE.test(loc.uri.fsPath) })
          : add('(module)', loc.uri, at, node.depth + 1, { module: true });
        if (!from) {
          node.cut = true;
          continue;
        }
        if (from === node) { continue; }
        let edge = node.callers.find(e => e.from === from);
        if (!edge) {
          edge = { from, lines: [], call: false };
          node.callers.push(edge);
        }
        if (!edge.lines.includes(at.line + 1)) { edge.lines.push(at.line + 1); }
        edge.call = edge.call || /^\s*(\?\.)?\s*(<[^()]*>)?\s*\(/.test(text.slice(loc.range.end.character));
        if (fresh) {
          from.via = { to: node, edge };
          next.push(from);
        }
      }
    }
    level = next;
  }
  return { root, dir, nodes: [...nodes.values()], skipped, reasons: [...reasons], rootFound, ms: Date.now() - started };
}

export function entryKind(n: CallerNode): EntryKind {
  if (n.route) { return 'ROUTE'; }
  if (n.module) { return 'MODULE'; }
  return n.tests ? 'TESTS ONLY' : 'NO REFS';
}

export function treeSummary(t: CallerTreeResult) {
  const { root, dir } = t;
  const others = t.nodes.filter(n => n !== root);
  const entries = others.filter(n => !n.cut && (n.route || n.module || !n.callers.length))
    .sort((a, b) => ENTRY_KINDS.indexOf(entryKind(a)) - ENTRY_KINDS.indexOf(entryKind(b))
      || rel(a.uri, dir).localeCompare(rel(b.uri, dir)) || a.pos.line - b.pos.line);
  const counts = ENTRY_KINDS.map(k => [k, entries.filter(n => entryKind(n) === k).length] as const)
    .filter(([, count]) => count).map(([k, count]) => `${k} ${count}`);
  return { others, entries, counts, functions: others.filter(n => !n.module).length };
}

const sortedCallers = (n: CallerNode, dir: string) => [...n.callers]
  .sort((a, b) => rel(a.from.uri, dir).localeCompare(rel(b.from.uri, dir)) || a.from.pos.line - b.from.pos.line);

/** The view's message line: how much reaches the root, and whether the walk finished. */
export function treeMessage(t: CallerTreeResult): string {
  if (!t.rootFound) { return `No references to ${t.root.name} yet: the language server may still be loading. Refresh.`; }
  const { entries, counts, functions } = treeSummary(t);
  const state = t.reasons.length ? ` | INCOMPLETE (${t.reasons.join(', ')})` : '';
  return `${entries.length} entry points${counts.length ? ` (${counts.join(', ')})` : ''} | ${functions} function${functions === 1 ? '' : 's'}`
    + ` | ${(t.ms / 1000).toFixed(1)} s${state}`;
}

// A row's label: the file's name, then the function (`ReportDetails.renderArchiveGate`), so each row says which
// file it is in; the full path is in the description. Module code is `ArchiveAccessPanel (module)`, a file whose
// name says little (index, __init__, Next.js route, page and layout) adds its folder (`feed/route.POST`), and a
// name that already starts with the file's name (a component in its own file) is not repeated.
const GENERIC_FILES = new Set(['index', '__init__', 'route', 'page', 'layout']);

export function treeLabel(n: { name: string; uri: vscode.Uri; module?: boolean }): string {
  const parts = (n.uri.path || n.uri.fsPath || '').split(/[\\/]/);
  let file = (parts.pop() || '').replace(/\.[^.]+$/, '');
  if (GENERIC_FILES.has(file) && parts.length > 1) { file = `${parts.pop()}/${file}`; }
  if (!file) { return n.name; }
  if (n.module) { return `${file} (module)`; }
  if (n.name === file || n.name.startsWith(`${file}.`)) { return n.name; }
  return `${file}.${n.name}`;
}

/** The function at a place: the innermost member the call hierarchy knows, else the innermost named member. */
export async function targetAt(uri: vscode.Uri, pos: vscode.Position): Promise<CallerTarget | undefined> {
  const symbols = await documentSymbols(uri).catch(() => []);
  const members = symbolPath(symbols, pos).filter(s => MEMBERS.has(s.kind) && !ANON.test(s.name)).reverse();
  for (const s of members) {
    const items = await run<vscode.CallHierarchyItem>('vscode.prepareCallHierarchy', uri, (s.selectionRange || s.range).start);
    if (items.length) { return { name: items[0].name, uri: items[0].uri, pos: items[0].selectionRange.start }; }
  }
  const items = await run<vscode.CallHierarchyItem>('vscode.prepareCallHierarchy', uri, pos);
  if (items.length) { return { name: items[0].name, uri: items[0].uri, pos: items[0].selectionRange.start }; }
  const s = members[0];
  return s && { name: s.name, uri, pos: (s.selectionRange || s.range).start };
}

/**
 * A row's click: VS Code's own open command, which alone is told the keys held, so Cmd+click (Ctrl+click on Windows
 * and Linux) opens the place to the side. The view keeps its root through the click (CallerTreeView, on selection).
 */
export function openRowCommand(uri: vscode.Uri, line: number): vscode.Command {
  return { command: 'vscode.open', title: 'Open', arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }] };
}

/** Where a row's click opens: its file and line. */
export function rowPlace(element: CallerTreeElement | undefined): { uri: vscode.Uri; line: number } | undefined {
  const [uri, options] = (element?.item.command?.arguments ?? []) as [vscode.Uri?, { selection?: vscode.Range }?];
  return uri && options?.selection ? { uri, line: options.selection.start.line } : undefined;
}

export type CallerTreeElement =
  | { type: 'node'; n: CallerNode; id: string; item: vscode.TreeItem }
  | { type: 'entries'; entries: CallerNode[]; item: vscode.TreeItem }
  | { type: 'entry'; n: CallerNode; item: vscode.TreeItem }
  | { type: 'hop'; item: vscode.TreeItem };

/**
 * The tree: the root and its callers (every function expands into its own callers, like the built-in Call
 * Hierarchy), then an "Entry points" group whose rows expand into their chain down to the root. Expanded mode
 * shows the whole tree but expands each function once, at its first place; later places are leaves marked
 * "seen above", so cycles stay finite.
 */
export class CallerTreeProvider implements vscode.TreeDataProvider<CallerTreeElement> {
  static readonly VIEW = 'incontext.callerTree';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  tree: CallerTreeResult | undefined;
  private first = new Map<CallerNode, string>();
  private generation = 0; // part of every id, so a mode switch is not overridden by remembered expand states

  constructor(public expanded = true) {}

  set(tree: CallerTreeResult): void {
    this.tree = tree;
    this.first = new Map();
    const walk = (n: CallerNode, id: string) => {
      if (this.first.has(n)) { return; }
      this.first.set(n, id);
      for (const e of sortedCallers(n, tree.dir)) { walk(e.from, `${id}>${e.from.key}`); }
    };
    walk(tree.root, this.rootId());
    this.changed.fire();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.generation += 1;
    if (this.tree) { this.set(this.tree); }
  }

  dispose(): void {
    this.changed.dispose();
  }

  private rootId(): string {
    return `${this.generation}|${this.tree!.root.key}|tree`;
  }

  getTreeItem(element: CallerTreeElement): vscode.TreeItem {
    return element.item;
  }

  // A function row. `edge` is how it uses its parent row; clicking opens that use (else the definition).
  private node(n: CallerNode, edge: CallerEdge | undefined, parent: CallerNode | undefined, id: string): CallerTreeElement {
    const { dir, root } = this.tree!;
    const line = edge ? edge.lines[0] - 1 : n.pos.line;
    const S = vscode.TreeItemCollapsibleState;
    const repeat = this.expanded && n.callers.length > 0 && this.first.get(n) !== id;
    let state = S.None;
    if (n.callers.length && !repeat) { state = this.expanded || !edge ? S.Expanded : S.Collapsed; }
    const item = new vscode.TreeItem(treeLabel(n), state);
    item.id = id;
    const kind = n !== root && !n.callers.length && !n.cut ? entryKind(n) : undefined;
    const extra = [edge && !edge.call ? 'ref' : '', kind || '', n.cut ? 'NOT EXPANDED' : '', repeat ? 'seen above' : '']
      .filter(Boolean);
    item.description = `${n.module ? rel(n.uri, dir) : place(n.uri, line, dir)}${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
    item.tooltip = `${n.name} | ${n.module ? rel(n.uri, dir) : place(n.uri, n.pos.line, dir)}`
      + `${edge && parent ? `\nuses ${parent.name} at line ${edge.lines.join(', ')}${edge.call ? '' : ' (not a direct call)'}` : ''}`;
    item.iconPath = new vscode.ThemeIcon(kind ? ENTRY_ICONS[kind] : edge && !edge.call ? 'references' : 'symbol-function');
    item.command = openRowCommand(n.uri, line);
    item.contextValue = 'place';
    return { type: 'node', n, id, item };
  }

  getChildren(element?: CallerTreeElement): CallerTreeElement[] {
    const t = this.tree;
    if (!t) { return []; }
    const { dir } = t;
    const S = vscode.TreeItemCollapsibleState;
    if (!element) {
      const { entries } = treeSummary(t);
      const group = new vscode.TreeItem(`Entry points (${entries.length})`,
        !entries.length ? S.None : this.expanded ? S.Expanded : S.Collapsed);
      group.id = `${this.generation}|${t.root.key}|entries`;
      group.iconPath = new vscode.ThemeIcon('list-flat');
      group.tooltip = 'Where the callers end: route handlers, module code, and functions nothing else references';
      return [this.node(t.root, undefined, undefined, this.rootId()), { type: 'entries', entries, item: group }];
    }
    if (element.type === 'node') {
      return sortedCallers(element.n, dir).map(e => this.node(e.from, e, element.n, `${element.id}>${e.from.key}`));
    }
    if (element.type === 'entries') {
      return element.entries.map(n => {
        const item = new vscode.TreeItem(treeLabel(n), n.via ? S.Collapsed : S.None);
        item.id = `${this.generation}|${t.root.key}|entry|${n.key}`;
        const line = n.via ? n.via.edge.lines[0] - 1 : n.pos.line;
        item.description = `${place(n.uri, line, dir)} · ${entryKind(n)}`;
        item.tooltip = `${n.module ? 'module code' : `${n.name}, defined at ${place(n.uri, n.pos.line, dir)}`}`
          + `${n.via ? `; uses ${n.via.to.name} here` : ''}. Expand for the chain down to the root.`;
        item.iconPath = new vscode.ThemeIcon(ENTRY_ICONS[entryKind(n)]);
        item.command = openRowCommand(n.uri, line);
        item.contextValue = 'place';
        return { type: 'entry', n, item } as CallerTreeElement;
      });
    }
    if (element.type === 'entry') {
      const rows: CallerTreeElement[] = [];
      for (let c: CallerNode | undefined = element.n.via?.to; c; c = c.via?.to) {
        const line = c.via ? c.via.edge.lines[0] - 1 : c.pos.line;
        const item = new vscode.TreeItem(treeLabel(c), S.None);
        item.id = `${this.generation}|${t.root.key}|entry|${element.n.key}|${c.key}`;
        item.description = place(c.uri, line, dir);
        item.tooltip = `${c.name}, defined at ${place(c.uri, c.pos.line, dir)}${c.via ? `; uses ${c.via.to.name} here` : ' (the root)'}`;
        item.iconPath = new vscode.ThemeIcon(c === t.root ? 'target' : 'arrow-small-down');
        item.command = openRowCommand(c.uri, line);
        item.contextValue = 'place';
        rows.push({ type: 'hop', item });
      }
      return rows;
    }
    return [];
  }
}

/**
 * The Caller Tree view and its commands. While visible it follows the function at the cursor; a click on a row
 * opens that place (Cmd+click to the side) but keeps the tree on the function you were exploring ("kept"), until
 * your next cursor move. Pin holds it on one function. The tree is recomputed when the root changes or a file is saved.
 */
export class CallerTreeView implements vscode.Disposable {
  readonly provider: CallerTreeProvider;
  readonly view: vscode.TreeView<CallerTreeElement>;
  private readonly disposables: vscode.Disposable[] = [];
  private pinned: CallerTarget | undefined;
  private anchor: { uri: vscode.Uri; pos: vscode.Position } | undefined;
  private clicked: { uri: string; line: number; time: number } | undefined;
  private live: { key: string; run?: vscode.CancellationTokenSource; state?: { tree?: CallerTreeResult; error?: Error } } = { key: '' };
  private stale = false;
  private timer: NodeJS.Timeout | undefined;
  /** Resolves when the latest update has finished (for tests). */
  pending: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.provider = new CallerTreeProvider(context.globalState.get('incontext.callerTree.expanded', true));
    this.view = vscode.window.createTreeView(CallerTreeProvider.VIEW, { treeDataProvider: this.provider });
    void vscode.commands.executeCommand('setContext', 'incontext.callerTree.expanded', this.provider.expanded);
    void vscode.commands.executeCommand('setContext', 'incontext.callerTree.pinned', false);
    const USER = new Set([vscode.TextEditorSelectionChangeKind.Keyboard, vscode.TextEditorSelectionChangeKind.Mouse]);
    this.disposables.push(
      this.view, this.provider,
      this.view.onDidChangeVisibility(() => this.schedule()),
      // A row is selected just before its click opens it, so the selection change that opening makes isn't yours
      this.view.onDidChangeSelection(e => this.clickedRow(rowPlace(e.selection[0]))),
      vscode.window.onDidChangeTextEditorSelection(e => {
        const { uri } = e.textEditor.document;
        const pos = e.selections[0].active;
        if (uri.scheme === 'file' && (USER.has(e.kind!) || !this.byClick(uri, pos.line))) { this.anchor = { uri, pos }; }
        this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.uri.scheme === 'file' && !this.byClick(editor.document.uri)) {
          this.anchor = { uri: editor.document.uri, pos: editor.selection.active };
        }
        this.schedule();
      }),
      vscode.workspace.onDidSaveTextDocument(() => {
        this.stale = true;
        this.schedule();
      }),
      vscode.commands.registerCommand('incontext.callerTree.openToSide', (el?: CallerTreeElement) => this.openToSide(el)),
      vscode.commands.registerCommand('incontext.callerTree.pin', () => this.pin()),
      vscode.commands.registerCommand('incontext.callerTree.unpin', () => this.setPinned(undefined)),
      vscode.commands.registerCommand('incontext.callerTree.refresh', () => {
        this.stale = true;
        return this.update();
      }),
      vscode.commands.registerCommand('incontext.callerTree.expand', () => this.setExpanded(true)),
      vscode.commands.registerCommand('incontext.callerTree.collapse', () => this.setExpanded(false)),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.live.run?.cancel();
    this.disposables.forEach(d => d.dispose());
  }

  private byClick(uri: vscode.Uri, line?: number): boolean {
    const c = this.clicked;
    return Boolean(c) && Date.now() - c!.time < 3000 && c!.uri === uri.toString() && (line === undefined || c!.line === line);
  }

  private focus(): { uri: vscode.Uri; pos: vscode.Position } | undefined {
    if (this.anchor) { return this.anchor; }
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document.uri.scheme === 'file' ? { uri: editor.document.uri, pos: editor.selection.active } : undefined;
  }

  private kept(): boolean {
    const editor = vscode.window.activeTextEditor;
    return !this.pinned && Boolean(this.anchor) && Boolean(editor)
      && (this.anchor!.uri.toString() !== editor!.document.uri.toString() || this.anchor!.pos.line !== editor!.selection.active.line);
  }

  /** The function the tree starts from: the pinned one, else the one where you last put the cursor. */
  async target(): Promise<CallerTarget | undefined> {
    if (this.pinned) { return this.pinned; }
    const f = this.focus();
    return f && targetAt(f.uri, f.pos);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.pending = this.update(); }, DELAY_MS);
  }

  private started = false;

  async update(): Promise<void> {
    if (!this.view.visible) { return; }
    const target = await this.target();
    if (!target) { return; } // keep the last tree while a non-file editor is active
    if (!this.started) {
      // Hides the view's welcome text, which says to put the cursor on a function
      this.started = true;
      void vscode.commands.executeCommand('setContext', 'incontext.callerTree.started', true);
    }
    this.view.description = this.pinned ? 'pinned' : this.kept() ? 'kept' : 'follows the cursor';
    const key = `${spot(target.uri, target.pos.line)}:${target.pos.character}`;
    if (this.live.key === key && !this.stale && (this.live.state || this.live.run)) {
      return this.show(target);
    }
    this.live.run?.cancel();
    this.stale = false;
    const run = new vscode.CancellationTokenSource();
    this.live = { key, run };
    this.view.message = `Finding what reaches ${target.name}...`;
    let state: { tree?: CallerTreeResult; error?: Error };
    try {
      state = { tree: await callerTree(target, run.token) };
    } catch (error) {
      state = { error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (this.live.run !== run || run.token.isCancellationRequested) { return; }
    this.live = { key, state };
    this.show(target);
  }

  private show(target: CallerTarget): void {
    const state = this.live.state;
    if (!state) { return; }
    if (state.tree) {
      if (this.provider.tree !== state.tree) { this.provider.set(state.tree); }
      this.view.message = treeMessage(state.tree);
    } else {
      this.view.message = `Caller tree of ${target.name} failed: ${state.error?.message ?? 'unknown error'}`;
    }
  }

  private async setPinned(value: CallerTarget | undefined): Promise<void> {
    this.pinned = value;
    await vscode.commands.executeCommand('setContext', 'incontext.callerTree.pinned', Boolean(value));
    this.schedule();
  }

  private async pin(): Promise<void> {
    const target = await this.target();
    if (!target) {
      vscode.window.showInformationMessage('InContext: no function at the cursor to pin.');
      return;
    }
    await this.setPinned(target);
  }

  private async setExpanded(expanded: boolean): Promise<void> {
    await this.context.globalState.update('incontext.callerTree.expanded', expanded);
    await vscode.commands.executeCommand('setContext', 'incontext.callerTree.expanded', expanded);
    this.provider.setExpanded(expanded);
  }

  // A row opens its place without moving the root: the selection changes it causes are not the user's.
  private clickedRow(place: { uri: vscode.Uri; line: number } | undefined): void {
    if (!place) { return; }
    if (!this.anchor) { this.anchor = this.focus(); }
    this.clicked = { uri: place.uri.toString(), line: place.line, time: Date.now() };
  }

  // Cmd+Enter in the tree, or Open to the Side on a row's menu: the row's place beside, the tree keeping focus.
  private async openToSide(el?: CallerTreeElement): Promise<void> {
    const place = rowPlace(el ?? this.view.selection[0]);
    if (!place) { return; }
    this.clickedRow(place);
    const selection = new vscode.Range(place.line, 0, place.line, 0);
    await vscode.window.showTextDocument(place.uri, { selection, preserveFocus: true, preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
}
