import * as vscode from 'vscode';
import { ParsedReference } from './ReferenceParser';

export class ReferenceUtils {
  /**
   * Resolves a parsed reference to a file or directory URI.
   * `@project/path` matches `project` against workspace folder names, falling back to the first folder.
   * Plain markdown link paths resolve like VS Code does: `/path` from the workspace folder of `from`, others relative to `from`.
   */
  static resolveReference(parsed: ParsedReference, from?: vscode.Uri): vscode.Uri | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const path = ReferenceUtils.decodePath(parsed.path);
    if (parsed.isWorkspaceReference) {
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
      }
      const pathParts = path.split('/');
      if (pathParts.length > 1 || parsed.isDirectory) {
        const matchingFolder = workspaceFolders.find(folder => folder.name === pathParts[0]);
        if (matchingFolder) {
          const relativePath = pathParts.slice(1).join('/');
          return relativePath ? vscode.Uri.joinPath(matchingFolder.uri, relativePath) : matchingFolder.uri;
        }
      }
      return path ? vscode.Uri.joinPath(workspaceFolders[0].uri, path) : workspaceFolders[0].uri;
    }
    if (path.startsWith('/')) {
      const folder = (from && vscode.workspace.getWorkspaceFolder(from)) || workspaceFolders?.[0];
      return folder ? vscode.Uri.joinPath(folder.uri, path) : undefined;
    }
    return from ? vscode.Uri.joinPath(from, '..', path) : undefined;
  }

  private static decodePath(path: string): string {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }

  static resolveWorkspacePath(uri: vscode.Uri): { relativePath: string; projectName: string } {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return { relativePath: '', projectName: '' };
    }
    for (const folder of workspaceFolders) {
      if (uri.fsPath.startsWith(folder.uri.fsPath)) {
        let relativePath = uri.fsPath.substring(folder.uri.fsPath.length);
        if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
          relativePath = relativePath.substring(1);
        }
        return { relativePath, projectName: folder.name };
      }
    }
    return { relativePath: '', projectName: '' };
  }

  static createCodeReference(fileUri: vscode.Uri, selection: vscode.Selection): string {
    const { relativePath, projectName } = ReferenceUtils.resolveWorkspacePath(fileUri);
    if (!relativePath) {
      return `@${fileUri.fsPath}:L${selection.start.line + 1}:${selection.end.line + 1}`;
    }
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    return `@${projectName}/${relativePath}:L${startLine}:${endLine}`;
  }

  static createFileReference(fileUri: vscode.Uri): string {
    const { relativePath, projectName } = ReferenceUtils.resolveWorkspacePath(fileUri);
    if (!relativePath) {
      return `@${fileUri.fsPath}`;
    }
    return `@${projectName}/${relativePath}`;
  }

  static createDirectoryReference(directoryUri: vscode.Uri): string {
    const { relativePath, projectName } = ReferenceUtils.resolveWorkspacePath(directoryUri);
    if (!relativePath) {
      return `@${directoryUri.fsPath}/`;
    }
    const reference = `@${projectName}/${relativePath}`;
    return reference.endsWith('/') ? reference : `${reference}/`;
  }
}
