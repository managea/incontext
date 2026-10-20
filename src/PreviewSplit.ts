import * as vscode from 'vscode';

/**
 * Chooses the editor group for references clicked in the Markdown preview, so the code opens in a split
 * beside the preview instead of covering it.
 *
 * Normal clicks reuse one split: the group the last normal click opened into, or at first the group next to the
 * preview (created if there is none). A new-split click (Cmd/Ctrl+click) opens one more group and leaves that
 * choice alone. The focused group is not used, because a click in the preview does not always focus the
 * preview's group before the link is handled.
 */
export class PreviewSplit {
  private static readonly PREVIEW_EDITOR_VIEW_TYPE = 'vscode.markdown.preview.editor';
  private static lastColumn: vscode.ViewColumn | undefined;

  static column(from: vscode.Uri | undefined, newSplit: boolean): vscode.ViewColumn {
    const groups = vscode.window.tabGroups.all;
    if (newSplit) {
      return Math.min(groups.length + 1, vscode.ViewColumn.Nine);
    }
    const preview = PreviewSplit.findPreviewGroup(from);
    const last = PreviewSplit.lastColumn;
    if (last !== undefined && last !== preview?.viewColumn && groups.some(group => group.viewColumn === last)) {
      return last;
    }
    if (!preview) {
      return vscode.ViewColumn.Beside;
    }
    const neighbor = groups.find(group => group.viewColumn === preview.viewColumn + 1)
      ?? groups.find(group => group.viewColumn === preview.viewColumn - 1);
    // A column one past the last group makes VS Code create a new group
    return neighbor ? neighbor.viewColumn : preview.viewColumn + 1;
  }

  /** Records where a normal click opened, so the next normal click uses the same split. */
  static remember(column: vscode.ViewColumn | undefined): void {
    PreviewSplit.lastColumn = column;
  }

  private static findPreviewGroup(from: vscode.Uri | undefined): vscode.TabGroup | undefined {
    const fileName = from?.path.split('/').pop() ?? '';
    const isPreview = (tab: vscode.Tab | undefined): boolean => {
      const input = tab?.input;
      if (input instanceof vscode.TabInputCustom) {
        // The "Markdown Preview" editor picked from the editor's dropdown
        return input.viewType === PreviewSplit.PREVIEW_EDITOR_VIEW_TYPE && (!from || input.uri.toString() === from.toString());
      }
      if (input instanceof vscode.TabInputWebview) {
        // Previews from "Open Preview" are webview panels labelled "Preview <file name>"
        return input.viewType.includes('markdown.preview') && tab!.label.includes(fileName);
      }
      return false;
    };
    const tabGroups = vscode.window.tabGroups;
    if (isPreview(tabGroups.activeTabGroup.activeTab)) {
      return tabGroups.activeTabGroup;
    }
    return tabGroups.all.find(group => isPreview(group.activeTab)) ?? tabGroups.all.find(group => group.tabs.some(isPreview));
  }
}
