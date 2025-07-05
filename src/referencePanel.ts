// ReferencePanel: TreeDataProvider for code references

import * as vscode from 'vscode';

export class ReferenceItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fileUri: vscode.Uri,
    public readonly range: vscode.Range
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: 'incontext.openReference',
      title: 'Open Reference',
      arguments: [`@${label}`]
    };
    this.tooltip = `${fileUri.fsPath}:${range.start.line + 1}`;
    this.description = `${fileUri.fsPath}:${range.start.line + 1}`;
  }
}

export class ReferencePanelProvider implements vscode.TreeDataProvider<ReferenceItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ReferenceItem | undefined | void> = new vscode.EventEmitter<ReferenceItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ReferenceItem | undefined | void> = this._onDidChangeTreeData.event;

  private references: ReferenceItem[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.refresh();
  }

  refresh(): void {
    this.references = [];
    this.scanWorkspaceForReferences().then(refs => {
      this.references = refs;
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(element: ReferenceItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReferenceItem): Thenable<ReferenceItem[]> {
    if (element) {
      return Promise.resolve([]);
    }
    return Promise.resolve(this.references);
  }

  async scanWorkspaceForReferences(): Promise<ReferenceItem[]> {
    const items: ReferenceItem[] = [];
    const files = await vscode.workspace.findFiles('**/*.{ts,js,md,txt}', '**/node_modules/**');
    const referenceRegex = /@([^\s@]+(?::[^:\s]*)*\/?)/g;
    for (const file of files) {
      const doc = await vscode.workspace.openTextDocument(file);
      for (let i = 0; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        let match;
        referenceRegex.lastIndex = 0;
        while ((match = referenceRegex.exec(line)) !== null) {
          const ref = match[0];
          const range = new vscode.Range(i, match.index, i, match.index + ref.length);
          items.push(new ReferenceItem(ref, file, range));
        }
      }
    }
    return items;
  }
}