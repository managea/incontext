import * as path from 'path';
import * as vscode from 'vscode';
import { BaseChange, BaseCompare, RepoCompare } from './BaseCompare';
import { BaseCompareGutter } from './BaseCompareGutter';

// The Changes view in the InContext sidebar: every file that differs from the compared branch, as a tree of
// repositories (when more than one is compared) and folders. A click opens the file, its diff icon VS Code's
// side-by-side diff.

export interface RepoNode { kind: 'repo'; result: RepoCompare }
export interface FolderNode { kind: 'folder'; result: RepoCompare; path: string; label: string; children: TreeNode[] }
export interface FileNode { kind: 'file'; result: RepoCompare; change: BaseChange }
export type TreeNode = RepoNode | FolderNode | FileNode;

export class BaseCompareTree implements vscode.TreeDataProvider<TreeNode> {
  static readonly VIEW = 'incontext.changes';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly compare: BaseCompare) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      const results = this.compare.all();
      return results.length === 1 ? BaseCompareTree.folders(results[0]) : results.map(result => ({ kind: 'repo', result }));
    }
    if (node.kind === 'repo') {
      return BaseCompareTree.folders(node.result);
    }
    return node.kind === 'folder' ? node.children : [];
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
      item.description = result.error ?? `vs ${result.ref} · ${result.changes.length} file${result.changes.length === 1 ? '' : 's'}`;
      item.tooltip = `${result.root.fsPath}\nCompared with ${result.ref} (${result.mode})${result.sha ? ` at ${result.sha.slice(0, 8)}` : ''}`;
      item.contextValue = 'repo';
      return item;
    }
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.result.root.fsPath}:${node.path}`;
      item.resourceUri = vscode.Uri.joinPath(node.result.root, node.path);
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const { result, change } = node;
    const file = vscode.Uri.joinPath(result.root, change.path);
    const item = new vscode.TreeItem(path.posix.basename(change.path), vscode.TreeItemCollapsibleState.None);
    item.id = `file:${result.root.fsPath}:${change.path}`;
    item.resourceUri = file;
    item.iconPath = vscode.ThemeIcon.File;
    item.description = change.status === 'R' ? `R ← ${change.oldPath}` : change.untracked ? 'U' : change.status;
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
