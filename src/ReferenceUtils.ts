import * as vscode from 'vscode';

export class ReferenceUtils {
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
