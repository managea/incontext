import * as path from 'path';
import * as vscode from 'vscode';
import { BaseCompare, BaseContent } from './BaseCompare';
import { BaseCompareGutter, GitGutterSwap } from './BaseCompareGutter';
import { BaseCompareTree, FileNode } from './BaseCompareTree';

// Compare with a branch: the commands, the status bar item and the Changes view, wired to BaseCompare.

interface RefPick extends vscode.QuickPickItem { ref?: string; stop?: boolean }
interface RepoPick extends vscode.QuickPickItem { roots: vscode.Uri[] }

export class BaseCompareView {
  /** Sets up comparing; returns what to dispose, and the comparisons for the tests. */
  static register(context: vscode.ExtensionContext): { disposables: vscode.Disposable[]; compare: BaseCompare } {
    const compare = new BaseCompare(context.workspaceState);
    const tree = new BaseCompareTree(compare);
    const view = vscode.window.createTreeView(BaseCompareTree.VIEW, { treeDataProvider: tree, showCollapseAll: true });
    const status = vscode.window.createStatusBarItem('incontext.compare', vscode.StatusBarAlignment.Left, 0);
    status.name = 'InContext: Compare with Branch';
    status.command = 'incontext.compare.chooseBase';

    const update = () => {
      const results = compare.all();
      const mode = compare.mode;
      void vscode.commands.executeCommand('setContext', 'incontext.compare.active', compare.active);
      void vscode.commands.executeCommand('setContext', 'incontext.compare.tip', mode === 'tip');
      const refs = [...new Set(results.map(result => result.ref))];
      view.description = refs.length ? `vs ${refs.join(', ')} · ${mode}` : undefined;
      const files = results.reduce((sum, result) => sum + result.changes.length, 0);
      const errors = results.filter(result => result.error);
      view.message = errors.length && results.length === 1 ? errors[0].error
        : compare.active && !files && !errors.length ? `No changes since ${refs.join(', ')}.` : undefined;
      tree.refresh();
      BaseCompareView.updateStatus(compare, status);
    };
    const disposables: vscode.Disposable[] = [
      compare,
      new BaseCompareGutter(compare),
      new GitGutterSwap(compare, context.globalState),
      tree,
      view,
      status,
      vscode.workspace.registerTextDocumentContentProvider(BaseContent.SCHEME, new BaseContent(() => compare.git)),
      compare.onDidChange(update),
      vscode.window.onDidChangeActiveTextEditor(() => BaseCompareView.updateStatus(compare, status)),
      vscode.commands.registerCommand('incontext.compare.chooseBase', (root?: vscode.Uri) => BaseCompareView.chooseBase(compare, root)),
      vscode.commands.registerCommand('incontext.compare.stop', () => Promise.all(compare.repositories().map(root => compare.setBase(root, undefined)))),
      vscode.commands.registerCommand('incontext.compare.useTip', () => compare.setMode('tip')),
      vscode.commands.registerCommand('incontext.compare.useMergeBase', () => compare.setMode('merge-base')),
      vscode.commands.registerCommand('incontext.compare.toggleMode', () => compare.setMode(compare.mode === 'tip' ? 'merge-base' : 'tip')),
      vscode.commands.registerCommand('incontext.compare.refresh', () => compare.refreshAll()),
      vscode.commands.registerCommand('incontext.compare.openDiff', (node?: FileNode) => {
        if (node?.kind !== 'file') {
          return;
        }
        const diff = BaseCompareGutter.diffCommand(compare.of(node.result.root) ?? node.result, node.change);
        return vscode.commands.executeCommand(diff.command, ...diff.arguments!);
      }),
    ];
    update();
    return { disposables, compare };
  }

  /** The status bar: the active file's repository's base, or a plain icon to start comparing. */
  private static updateStatus(compare: BaseCompare, status: vscode.StatusBarItem): void {
    const repositories = compare.repositories();
    if (!repositories.length) {
      status.hide();
      return;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const root = (active && compare.repositoryOf(active)) ?? (repositories.length === 1 ? repositories[0] : undefined);
    const result = root ? compare.of(root) : compare.all()[0];
    const ref = root ? compare.baseOf(root) : result?.ref;
    if (ref) {
      const tip = compare.mode === 'tip';
      status.text = `$(git-compare) ${ref}${tip ? ' (tip)' : ''}${result?.error ? ' $(warning)' : ''}`;
      status.tooltip = new vscode.MarkdownString(`Gutter and **Changes** view compare with \`${ref}\``
        + ` ${tip ? 'as it is now (tip)' : 'from where this branch left it (merge-base)'}`
        + `${result?.changes.length !== undefined ? `: ${result.changes.length} changed files` : ''}.`
        + `${result?.error ? `\n\n$(warning) ${result.error}` : ''}\n\nClick to change the branch.`, true);
    } else {
      status.text = '$(git-compare)';
      status.tooltip = 'Compare with a branch: show what differs from it in the gutter and the Changes view';
    }
    status.show();
  }

  /** Asks which repository (when there are several) and which branch to compare with, or to stop comparing. */
  static async chooseBase(compare: BaseCompare, root?: vscode.Uri): Promise<void> {
    const git = compare.git;
    const repositories = compare.repositories();
    if (!git || !repositories.length) {
      vscode.window.showInformationMessage('No git repository is open in this window.');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      vscode.window.showInformationMessage('Comparing with a branch runs git, which needs a trusted workspace.');
      return;
    }
    let roots = root ? [root] : repositories;
    if (!root && repositories.length > 1) {
      const active = vscode.window.activeTextEditor && compare.repositoryOf(vscode.window.activeTextEditor.document.uri);
      const picks: RepoPick[] = [
        { label: '$(repo-forked) All repositories', description: 'compare each with the branch of the same name', roots: repositories },
        ...repositories.map(repository => ({
          label: path.basename(repository.fsPath),
          description: compare.baseOf(repository) ? `vs ${compare.baseOf(repository)}` : undefined,
          detail: repository.fsPath,
          roots: [repository],
        })),
      ];
      const picked = await vscode.window.showQuickPick(picks.sort((a, b) =>
        Number(b.roots.length === 1 && b.roots[0].fsPath === active?.fsPath) - Number(a.roots.length === 1 && a.roots[0].fsPath === active?.fsPath)),
      { title: 'Compare which repository with a branch?', matchOnDetail: true });
      if (!picked) {
        return;
      }
      roots = picked.roots;
    }

    const all = await Promise.all(roots.map(async repository => ({ root: repository, refs: await git.refs(repository).catch(() => []) })));
    const defaults = new Set((await Promise.all(roots.map(repository => git.defaultRef(repository)))).filter((ref): ref is string => Boolean(ref)));
    const names = new Map<string, boolean>();
    all.forEach(({ refs }) => refs.forEach(ref => names.set(ref.name, ref.remote)));
    const current = new Set(roots.map(repository => compare.baseOf(repository)).filter(Boolean));
    const describe = (name: string) => [defaults.has(name) ? 'default branch' : '', current.has(name) ? 'compared now' : ''].filter(Boolean).join(' · ') || undefined;
    const byName = (a: string, b: string) => Number(defaults.has(b)) - Number(defaults.has(a)) || a.localeCompare(b);
    const local = [...names].filter(([, remote]) => !remote).map(([name]) => name).sort(byName);
    const remote = [...names].filter(([, isRemote]) => isRemote).map(([name]) => name).sort(byName);
    const mode = compare.mode;
    const items: RefPick[] = [
      ...(current.size ? [{ label: '$(close) Stop comparing', description: 'show git\'s changes against HEAD again', stop: true }] : []),
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...local.map(name => ({ label: `$(git-branch) ${name}`, description: describe(name), ref: name })),
      { label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator },
      ...remote.map(name => ({ label: `$(cloud) ${name}`, description: describe(name), ref: name })),
    ];
    const toggle: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon(mode === 'tip' ? 'git-commit' : 'git-merge'),
      tooltip: mode === 'tip' ? 'Comparing with the branch\'s tip: click to compare from the merge-base' : 'Comparing from the merge-base: click to compare with the branch\'s tip',
    };
    const quickPick = vscode.window.createQuickPick<RefPick>();
    quickPick.title = `Compare ${roots.length === 1 ? path.basename(roots[0].fsPath) : 'all repositories'} with (${mode})`;
    quickPick.placeholder = 'A branch, or any commit, tag or ref you type';
    quickPick.items = items;
    quickPick.buttons = [toggle];
    const choice = await new Promise<RefPick | 'mode' | undefined>(resolve => {
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        // A ref typed in that isn't in the list: a tag, a commit
        resolve(selected ?? (quickPick.value.trim() ? { label: quickPick.value.trim(), ref: quickPick.value.trim() } : undefined));
      });
      quickPick.onDidTriggerButton(() => resolve('mode'));
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.show();
    });
    quickPick.dispose();
    if (choice === 'mode') {
      await compare.setMode(mode === 'tip' ? 'merge-base' : 'tip');
      return BaseCompareView.chooseBase(compare, root ?? (roots.length === 1 && repositories.length > 1 ? roots[0] : undefined));
    }
    if (!choice) {
      return;
    }
    if (choice.stop) {
      await Promise.all(roots.map(repository => compare.setBase(repository, undefined)));
      return;
    }
    const ref = choice.ref!;
    const typed = !names.has(ref);
    const missing = typed ? [] : all.filter(({ refs }) => !refs.some(item => item.name === ref)).map(({ root: repository }) => repository);
    await Promise.all(roots.filter(repository => !missing.includes(repository)).map(repository => compare.setBase(repository, ref)));
    if (missing.length) {
      vscode.window.showWarningMessage(`${ref} isn't a branch in ${missing.map(repository => path.basename(repository.fsPath)).join(', ')}, so ${missing.length === 1 ? 'it isn\'t' : 'they aren\'t'} compared.`);
    }
  }
}
