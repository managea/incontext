import * as path from 'path';
import * as vscode from 'vscode';
import { BaseChange, BaseCompare, BaseContent, RepoCompare } from './BaseCompare';

// The gutter while a repository is compared with a branch: a source control of our own for the repository whose
// quick diff gives each file as it is in the base, so VS Code draws its own change bars (green added, blue modified,
// red deleted), opens the inline diff on a click, and steps through changes with Alt+F5/Shift+Alt+F5. Git's own
// quick diff, against HEAD, is hidden meanwhile (GitGutterSwap).

const SOURCE_CONTROL = 'incontext.compare';

export class BaseCompareGutter implements vscode.Disposable {
  private readonly controls = new Map<string, { control: vscode.SourceControl; group: vscode.SourceControlResourceGroup; sha: string }>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly compare: BaseCompare) {
    this.subscription = compare.onDidChange(() => this.update());
  }

  private update(): void {
    // Hidden from editors: no source controls, so no bars (BaseCompare.shown)
    const wanted = new Map(this.compare.all().filter(result => result.sha && this.compare.shown).map(result => [result.root.fsPath, result]));
    for (const [key, entry] of this.controls) {
      const result = wanted.get(key);
      // A new base commit: a new source control, so open editors ask for their original again
      if (!result || result.sha !== entry.sha) {
        entry.control.dispose();
        this.controls.delete(key);
      }
    }
    for (const [key, result] of wanted) {
      let entry = this.controls.get(key);
      if (!entry) {
        entry = this.create(result);
        this.controls.set(key, entry);
      }
      entry.control.count = 0;
      entry.group.label = `Changes vs ${result.ref}`;
      entry.group.resourceStates = result.changes.map(change => BaseCompareGutter.resourceState(result, change));
    }
  }

  private create(result: RepoCompare & { sha?: string }): { control: vscode.SourceControl; group: vscode.SourceControlResourceGroup; sha: string } {
    const root = result.root;
    const control = vscode.scm.createSourceControl(SOURCE_CONTROL, `InContext: vs ${result.ref}`, root);
    control.inputBox.visible = false;
    control.quickDiffProvider = {
      provideOriginalResource: (uri: vscode.Uri) => {
        const current = this.compare.of(root);
        if (!current?.sha || uri.scheme !== 'file' || this.compare.repositoryOf(uri)?.fsPath !== root.fsPath) {
          return undefined;
        }
        const file = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
        const change = current.changes.find(item => item.path === file);
        if (change?.status === 'R' && change.oldPath) {
          return BaseContent.uri(root, current.sha, change.oldPath);
        }
        // A file in the base, or new on this branch (all of it added); not an ignored file, which isn't either
        return change || current.tracked.has(file) ? BaseContent.uri(root, current.sha, file) : undefined;
      },
    };
    const group = control.createResourceGroup('changes', `Changes vs ${result.ref}`);
    group.hideWhenEmpty = false;
    return { control, group, sha: result.sha ?? '' };
  }

  private static resourceState(result: RepoCompare, change: BaseChange): vscode.SourceControlResourceState {
    const uri = vscode.Uri.joinPath(result.root, change.path);
    return {
      resourceUri: uri,
      command: BaseCompareGutter.diffCommand(result, change),
      decorations: {
        strikeThrough: change.status === 'D',
        tooltip: BaseCompareGutter.describe(change),
        iconPath: new vscode.ThemeIcon(BaseCompareGutter.icon(change)),
      },
    };
  }

  static describe(change: BaseChange): string {
    switch (change.status) {
      case 'A': return change.untracked ? 'Added (untracked)' : 'Added';
      case 'D': return 'Deleted';
      case 'R': return `Renamed from ${change.oldPath}`;
      default: return 'Modified';
    }
  }

  static icon(change: BaseChange): string {
    return { A: 'diff-added', D: 'diff-removed', R: 'diff-renamed', M: 'diff-modified' }[change.status];
  }

  /** VS Code's side-by-side diff of a changed file: the base on the left, the working file (editable) on the right. */
  static diffCommand(result: RepoCompare, change: BaseChange): vscode.Command {
    const sha = result.sha ?? '';
    const file = vscode.Uri.joinPath(result.root, change.path);
    const left = change.status === 'A' ? BaseContent.uri(result.root, '', change.path)
      : BaseContent.uri(result.root, sha, change.oldPath ?? change.path);
    const right = change.status === 'D' ? BaseContent.uri(result.root, '', change.path) : file;
    const title = `${path.posix.basename(change.path)} (${result.ref} ↔ ${change.status === 'D' ? 'Deleted' : 'Working Tree'})`;
    return { title: 'Open Changes', command: 'vscode.diff', arguments: [left, right, title] };
  }

  dispose(): void {
    this.subscription.dispose();
    this.controls.forEach(entry => entry.control.dispose());
    this.controls.clear();
  }
}

/**
 * Hides git's quick diff (against HEAD) in the gutter while a repository is compared with a branch, and shows it again
 * afterwards, with VS Code's Quick Diff visibility toggle (Source Control view > ... > Quick Diff). VS Code keeps that
 * toggle in its global storage and offers no way to read it, so `incontext.compare.gitGutterHidden` remembers what
 * this extension last set it to.
 */
export class GitGutterSwap implements vscode.Disposable {
  static readonly COMMAND = 'workbench.scm.action.toggleQuickDiffVisibility.git.quickDiffProvider';
  private static readonly KEY = 'incontext.compare.gitGutterHidden';
  private hidden: boolean;
  private busy = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly compare: BaseCompare, private readonly state: vscode.Memento) {
    this.hidden = state.get<boolean>(GitGutterSwap.KEY, false);
    this.subscriptions = [
      compare.onDidChange(() => this.apply()),
      vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration('incontext.compare.hideGitGutter') && this.apply()),
    ];
    this.apply();
  }

  private wanted(): boolean {
    return this.compare.active && this.compare.shown && vscode.workspace.getConfiguration('incontext.compare').get<boolean>('hideGitGutter', true);
  }

  apply(want = this.wanted()): Promise<void> {
    this.busy = this.busy.then(async () => {
      if (want === this.hidden) {
        return;
      }
      // Registered once git's quick diff is
      if (!(await vscode.commands.getCommands(true)).includes(GitGutterSwap.COMMAND)) {
        return;
      }
      await vscode.commands.executeCommand(GitGutterSwap.COMMAND);
      this.hidden = want;
      await this.state.update(GitGutterSwap.KEY, want);
    }).catch(() => undefined);
    return this.busy;
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    void this.apply(false);
  }
}
