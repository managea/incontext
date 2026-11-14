import * as vscode from 'vscode';

/**
 * Chooses the editor group for references clicked in the Markdown preview, or in a drawing or other preview, so the
 * code opens in a split beside it instead of covering it.
 *
 * Normal clicks reuse one split: the group the last normal click opened into, or at first the group next to the
 * preview (created if there is none). A new-split click (Cmd/Ctrl+click) opens one more group and leaves that
 * choice alone. For the Markdown preview the focused group is not used, because a click in the preview does not
 * always focus the preview's group before the link is handled.
 */
export class PreviewSplit {
  private static readonly PREVIEW_EDITOR_VIEW_TYPE = 'vscode.markdown.preview.editor';
  private static lastColumn: vscode.ViewColumn | undefined;

  static column(from: vscode.Uri | undefined, newSplit: boolean): vscode.ViewColumn {
    const groups = vscode.window.tabGroups.all;
    if (newSplit) {
      return Math.min(groups.length + 1, vscode.ViewColumn.Nine);
    }
    return PreviewSplit.besideGroup(PreviewSplit.findPreviewGroup(from));
  }

  /**
   * For a link that comes from outside a text editor (a vscode:// link or the link server): a group beside the
   * active one when that shows a drawing or a preview, such as an Excalidraw drawing, so the code doesn't cover it.
   * Undefined when the active tab is a text editor or there is none, so the link opens where it always has.
   */
  static besideActiveViewer(): vscode.ViewColumn | undefined {
    const active = vscode.window.tabGroups.activeTabGroup;
    const input = active.activeTab?.input;
    const isViewer = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputWebview;
    return isViewer ? PreviewSplit.besideGroup(active) : undefined;
  }

  /** Records where a normal click opened, so the next normal click uses the same split. */
  static remember(column: vscode.ViewColumn | undefined): void {
    PreviewSplit.lastColumn = column;
  }

  /** The split for a click in `viewer`'s group: the last split used, or the group next to it, created if needed. */
  private static besideGroup(viewer: vscode.TabGroup | undefined): vscode.ViewColumn {
    const groups = vscode.window.tabGroups.all;
    const last = PreviewSplit.lastColumn;
    if (last !== undefined && last !== viewer?.viewColumn && groups.some(group => group.viewColumn === last)) {
      return last;
    }
    if (!viewer) {
      return vscode.ViewColumn.Beside;
    }
    const neighbor = groups.find(group => group.viewColumn === viewer.viewColumn + 1)
      ?? groups.find(group => group.viewColumn === viewer.viewColumn - 1);
    // A column one past the last group makes VS Code create a new group
    return neighbor ? neighbor.viewColumn : viewer.viewColumn + 1;
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
