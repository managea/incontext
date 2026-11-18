import * as path from 'path';
import * as vscode from 'vscode';
import { BaseChange, BaseCompare, RepoCompare, versus } from './BaseCompare';
import { BaseCompareGutter } from './BaseCompareGutter';

// The Changes view in the InContext sidebar: every file that differs from the compared branch, as a tree of
// repositories (when more than one is compared) and folders. A click opens the file, its diff icon VS Code's
// side-by-side diff. The view keeps its rows between refreshes and knows each row's parent, so it can reveal the
// active editor's file (BaseCompareView's Follow the Editor).

export interface RepoNode { kind: 'repo'; result: RepoCompare; children: TreeNode[] }
export interface FolderNode { kind: 'folder'; result: RepoCompare; path: string; label: string; children: TreeNode[] }
export interface FileNode { kind: 'file'; result: RepoCompare; change: BaseChange }
export type TreeNode = RepoNode | FolderNode | FileNode;

export class BaseCompareTree implements vscode.TreeDataProvider<TreeNode> {
  static readonly VIEW = 'incontext.changes';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** The rows as last built, each one's parent, and the file rows by path; built again after a refresh. */
  private roots: TreeNode[] | undefined;
  private readonly parents = new Map<TreeNode, TreeNode>();
  private readonly files = new Map<string, FileNode>();

  constructor(private readonly compare: BaseCompare) {}

  refresh(): void {
    this.roots = undefined;
    this.changed.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.build();
    }
    return node.kind === 'file' ? [] : node.children;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.parents.get(node);
  }

  /** The row of a changed file, for revealing it. */
  fileNode(file: vscode.Uri): FileNode | undefined {
    this.build();
    return this.files.get(file.fsPath);
  }

  private build(): TreeNode[] {
    if (this.roots) {
      return this.roots;
    }
    this.parents.clear();
    this.files.clear();
    const results = this.compare.all();
    const roots: TreeNode[] = results.length === 1 ? BaseCompareTree.folders(results[0])
      : results.map(result => ({ kind: 'repo', result, children: BaseCompareTree.folders(result) }));
    const walk = (nodes: TreeNode[], parent?: TreeNode) => {
      for (const node of nodes) {
        if (parent) {
          this.parents.set(node, parent);
        }
        if (node.kind === 'file') {
          this.files.set(vscode.Uri.joinPath(node.result.root, node.change.path).fsPath, node);
        } else {
          walk(node.children, node);
        }
      }
    };
    walk(roots);
    this.roots = roots;
    return roots;
  }

  /** A repository's changed files under their folders, a chain of folders with nothing else in them on one row. */
  static folders(result: RepoCompare): TreeNode[] {
    const top: FolderNode = { kind: 'folder', result, path: '', label: '', children: [] };
    const folders = new Map<string, FolderNode>([['', top]]);
    const folderOf = (dir: string): FolderNode => {
      let folder = folders.get(dir);
      if (!folder) {
        const parent = folderOf(path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir));
        folder = { kind: 'folder', result, path: dir, label: path.posix.basename(dir), children: [] };
        folders.set(dir, folder);
        parent.children.push(folder);
      }
      return folder;
    };
    for (const change of result.changes) {
      const dir = path.posix.dirname(change.path);
      folderOf(dir === '.' ? '' : dir).children.push({ kind: 'file', result, change });
    }
    const compact = (node: TreeNode): TreeNode => {
      if (node.kind !== 'folder') {
        return node;
      }
      while (node.children.length === 1 && node.children[0].kind === 'folder') {
        const only: FolderNode = node.children[0];
        node = { ...only, label: `${node.label}/${only.label}` };
      }
      node.children = node.children.map(compact).sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1)
        || BaseCompareTree.name(a).localeCompare(BaseCompareTree.name(b)));
      return node;
    };
    return top.children.map(compact).sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1)
      || BaseCompareTree.name(a).localeCompare(BaseCompareTree.name(b)));
  }

  private static name(node: TreeNode): string {
    return node.kind === 'file' ? path.posix.basename(node.change.path) : node.kind === 'folder' ? node.label : '';
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const result = node.result;
      const item = new vscode.TreeItem(path.basename(result.root.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `repo:${result.root.fsPath}`;
      item.iconPath = new vscode.ThemeIcon(result.error ? 'warning' : 'repo');
      const counted = `${versus(result)} · ${result.changes.length} file${result.changes.length === 1 ? '' : 's'}`;
      item.description = result.error ? `${versus(result)} · ${result.error}` : counted;
      item.tooltip = `${result.root.fsPath}\n${result.head ? `${result.head} compared` : 'Compared'} with ${result.ref} (${result.mode})${result.sha ? ` at ${result.sha.slice(0, 8)}` : ''}`;
      item.contextValue = 'repo';
      return item;
    }
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.result.root.fsPath}:${node.path}`;
      item.resourceUri = BaseCompareDecorations.uri(vscode.Uri.joinPath(node.result.root, node.path));
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const { result, change } = node;
    const file = vscode.Uri.joinPath(result.root, change.path);
    const item = new vscode.TreeItem(path.posix.basename(change.path), vscode.TreeItemCollapsibleState.None);
    item.id = `file:${result.root.fsPath}:${change.path}`;
    // The letter at the right and the name's colour come from BaseCompareDecorations, as the Explorer's come from git
    item.resourceUri = BaseCompareDecorations.uri(file);
    item.iconPath = vscode.ThemeIcon.File;
    item.description = change.status === 'R' ? `← ${change.oldPath}` : undefined;
    item.tooltip = `${change.path}\n${BaseCompareGutter.describe(change)} since ${result.ref}`;
    // The file itself, which has the changes in its gutter; VS Code's own open command, so Cmd+click opens it to the
    // side. A deleted file has only its diff. The row's diff icon opens the diff (incontext.compare.openDiff)
    item.command = change.status === 'D' ? BaseCompareGutter.diffCommand(result, change)
      : { title: 'Open File', command: 'vscode.open', arguments: [file] };
    item.contextValue = change.status === 'D' ? 'deletedFile' : 'file';
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * The Explorer's look for the Branch Changes rows: the status letter at the right edge and the name in git's colours
 * (added, modified, deleted, renamed, untracked), and a dot on the folders above a change. The rows' resourceUri is the
 * file's path under the `incontext-change` scheme, so these decorations show in this view only; the path still gives
 * each row its file icon.
 *
 * The files themselves (the `file` scheme) get a ★ in the change's colour, so a changed file's editor tab says so at a
 * glance, however far down its changes are. VS Code draws file decorations in the Explorer too, where the ★ sits beside
 * git's own letter (changes since the last commit). `incontext.compare.markChangedFiles` turns it off, and so does
 * hiding the comparison from editors (the view's eye button).
 */
export class BaseCompareDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  static readonly SCHEME = 'incontext-change';
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  static readonly MARK_SETTING = 'incontext.compare.markChangedFiles';
  static readonly MARK = '★';
  private readonly subscriptions: vscode.Disposable[];
  /** Each comparison's changes by path, built when first asked: the Explorer asks for every file it shows. */
  private readonly byPath = new WeakMap<RepoCompare, Map<string, BaseChange>>();

  constructor(private readonly compare: BaseCompare) {
    this.subscriptions = [
      compare.onDidChange(() => this.changed.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration(BaseCompareDecorations.MARK_SETTING)
        && this.changed.fire(undefined)),
    ];
  }

  static uri(file: vscode.Uri): vscode.Uri {
    return file.with({ scheme: BaseCompareDecorations.SCHEME });
  }

  static readonly LOOKS: Record<string, { badge: string; color: string; tooltip: string }> = {
    A: { badge: 'A', color: 'gitDecoration.addedResourceForeground', tooltip: 'Added' },
    U: { badge: 'U', color: 'gitDecoration.untrackedResourceForeground', tooltip: 'Added (untracked)' },
    M: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'Modified' },
    D: { badge: 'D', color: 'gitDecoration.deletedResourceForeground', tooltip: 'Deleted' },
    R: { badge: 'R', color: 'gitDecoration.renamedResourceForeground', tooltip: 'Renamed' },
  };

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const view = uri.scheme === BaseCompareDecorations.SCHEME;
    if (!view && (uri.scheme !== 'file' || !this.compare.shown || !vscode.workspace.getConfiguration().get<boolean>(BaseCompareDecorations.MARK_SETTING, true))) {
      return undefined;
    }
    const file = uri.with({ scheme: 'file' });
    const root = this.compare.repositoryOf(file);
    const result = root && this.compare.of(root);
    if (!root || !result) {
      return undefined;
    }
    const relative = path.relative(root.fsPath, file.fsPath).split(path.sep).join('/');
    const change = this.changesOf(result).get(relative);
    if (!change) {
      return undefined;
    }
    const look = BaseCompareDecorations.LOOKS[change.untracked ? 'U' : change.status];
    const tooltip = `${look.tooltip} since ${result.ref}`;
    if (!view) {
      return new vscode.FileDecoration(BaseCompareDecorations.MARK, tooltip, new vscode.ThemeColor(look.color));
    }
    // Propagated, as git's are, so each folder above a change shows a dot in the change's colour
    const decoration = new vscode.FileDecoration(look.badge, tooltip, new vscode.ThemeColor(look.color));
    decoration.propagate = true;
    return decoration;
  }

  private changesOf(result: RepoCompare): Map<string, BaseChange> {
    let changes = this.byPath.get(result);
    if (!changes) {
      changes = new Map(result.changes.map(change => [change.path, change]));
      this.byPath.set(result, changes);
    }
    return changes;
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.changed.dispose();
  }
}
