import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

// Compare with a branch: each git repository of the window can be compared with a branch of its own (main, a
// teammate's branch, a tag), so the gutter (BaseCompareGutter) and the Changes view (BaseCompareTree) show what a
// merge request from the current branch would contain, uncommitted edits included. The base is either the
// merge-base of HEAD and the branch, which is what a merge request shows, or the branch's tip.

/** Merge-base: where the current branch left the base branch, as a merge request compares. Tip: the branch as it is now. */
export type CompareMode = 'merge-base' | 'tip';

/** A file that differs from the base: A added (or untracked), M modified, D deleted, R renamed from `oldPath`. */
export interface BaseChange {
  status: 'A' | 'M' | 'D' | 'R';
  /** Path in the repository, with forward slashes. */
  path: string;
  oldPath?: string;
  untracked?: boolean;
}

/** One repository's comparison, as last computed. */
export interface RepoCompare {
  root: vscode.Uri;
  ref: string;
  mode: CompareMode;
  /** The commit compared with; unset when the ref or the merge-base can't be found (see `error`). */
  sha?: string;
  changes: BaseChange[];
  /** Files in the base commit, which the gutter compares even before they change. */
  tracked: Set<string>;
  error?: string;
}

/** The parts of the built-in git extension's API (extensions/git/src/api/git.d.ts) used here. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
}
interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

const MODE_KEY = 'incontext.compare.mode';
const BASES_KEY = 'incontext.compare.bases';
const REFRESH_MS = 400;

/** Runs git in a repository. */
export class Git {
  constructor(private readonly binary: string) {}

  run(root: vscode.Uri, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, args, { cwd: root.fsPath, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
        (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout));
    });
  }

  /** Branches and remote branches, local ones first, without `origin/HEAD`. */
  async refs(root: vscode.Uri): Promise<{ name: string; remote: boolean }[]> {
    const out = await this.run(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    return out.split('\n').filter(Boolean).filter(ref => !ref.endsWith('/HEAD')).map(ref => ref.startsWith('refs/heads/')
      ? { name: ref.slice('refs/heads/'.length), remote: false }
      : { name: ref.slice('refs/remotes/'.length), remote: true });
  }

  /** The branch a merge request usually goes to: origin's default branch, else main or master. */
  async defaultRef(root: vscode.Uri): Promise<string | undefined> {
    try {
      return (await this.run(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim() || undefined;
    } catch {
      const names = new Set((await this.refs(root).catch(() => [])).map(ref => ref.name));
      return ['origin/main', 'origin/master', 'main', 'master'].find(name => names.has(name));
    }
  }

  async resolve(root: vscode.Uri, ref: string, mode: CompareMode): Promise<string> {
    const args = mode === 'tip' ? ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`] : ['merge-base', 'HEAD', ref];
    return (await this.run(root, args)).trim();
  }

  /** The working tree's changes from `sha`, staged and unstaged, plus untracked files. */
  async changes(root: vscode.Uri, sha: string): Promise<BaseChange[]> {
    const [diff, untracked] = await Promise.all([
      this.run(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', sha, '--']),
      this.run(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const changes = Git.parseNameStatus(diff);
    for (const file of untracked.split('\0').filter(Boolean)) {
      changes.push({ status: 'A', path: file, untracked: true });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** `git diff --name-status -z` output: `M\0path\0`, `R100\0old\0new\0`. Other kinds (type changes) count as modified. */
  static parseNameStatus(out: string): BaseChange[] {
    const parts = out.split('\0');
    const changes: BaseChange[] = [];
    for (let i = 0; i < parts.length - 1;) {
      const code = parts[i++];
      if (!code) {
        continue;
      }
      if (code[0] === 'R' || code[0] === 'C') {
        const oldPath = parts[i++];
        const newPath = parts[i++];
        changes.push(code[0] === 'R' ? { status: 'R', path: newPath, oldPath } : { status: 'A', path: newPath });
      } else {
        const file = parts[i++];
        changes.push({ status: code[0] === 'A' || code[0] === 'D' ? code[0] : 'M', path: file });
      }
    }
    return changes;
  }

  async tracked(root: vscode.Uri, sha: string): Promise<Set<string>> {
    return new Set((await this.run(root, ['ls-tree', '-r', '-z', '--name-only', sha])).split('\0').filter(Boolean));
  }

  async show(root: vscode.Uri, sha: string, file: string): Promise<string> {
    return this.run(root, ['show', '--no-textconv', `${sha}:${file}`]);
  }
}

/**
 * A file as it is in a base commit, read-only: `incontext-base:/abs/path/file.ts?root=...&sha=...&file=...`. The path is
 * the working file's, so the language and the tab's name match it. An empty `sha` is an empty file, the other side
 * of an added or deleted file.
 */
export class BaseContent implements vscode.TextDocumentContentProvider {
  static readonly SCHEME = 'incontext-base';

  constructor(private readonly git: () => Git | undefined) {}

  static uri(root: vscode.Uri, sha: string, file: string): vscode.Uri {
    const query = new URLSearchParams({ root: root.toString(), sha, file }).toString();
    return vscode.Uri.joinPath(root, file).with({ scheme: BaseContent.SCHEME, query });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const sha = query.get('sha');
    const git = this.git();
    if (!sha || !git) {
      return '';
    }
    try {
      return await git.show(vscode.Uri.parse(query.get('root') ?? ''), sha, query.get('file') ?? '');
    } catch {
      // Not in the base: the file is new on this branch
      return '';
    }
  }
}

/**
 * The comparisons of the window's repositories: which branch each is compared with (kept in the workspace state),
 * merge-base or tip for all of them, and each one's changes, computed again when its repository changes.
 */
export class BaseCompare implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a comparison, the repositories or the mode change. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly results = new Map<string, RepoCompare>();
  private readonly trackedCache = new Map<string, Promise<Set<string>>>();
  private api: GitApi | undefined;
  private gitRunner: Git | undefined;

  constructor(private readonly state: vscode.Memento) {
    void this.connect();
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshAll()));
  }

  get git(): Git | undefined {
    return this.gitRunner;
  }

  get mode(): CompareMode {
    return this.state.get<CompareMode>(MODE_KEY, 'merge-base');
  }

  async setMode(mode: CompareMode): Promise<void> {
    await this.state.update(MODE_KEY, mode);
    this.refreshAll();
  }

  /** Root URIs of the window's git repositories. */
  repositories(): vscode.Uri[] {
    return (this.api?.repositories ?? []).map(repository => repository.rootUri)
      .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /** The repository a file is in: the deepest one, for nested repositories and submodules. */
  repositoryOf(file: vscode.Uri): vscode.Uri | undefined {
    const inside = this.repositories().filter(root => file.scheme === 'file'
      && (file.fsPath === root.fsPath || file.fsPath.startsWith(root.fsPath + path.sep)));
    return inside.sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
  }

  baseOf(root: vscode.Uri): string | undefined {
    return this.bases()[root.fsPath];
  }

  async setBase(root: vscode.Uri, ref: string | undefined): Promise<void> {
    const bases = this.bases();
    if (ref) {
      bases[root.fsPath] = ref;
    } else {
      delete bases[root.fsPath];
      this.results.delete(root.fsPath);
    }
    await this.state.update(BASES_KEY, bases);
    this.changed.fire();
    if (ref) {
      await this.refresh(root);
    }
  }

  /** The comparisons, one per repository with a base, in path order. */
  all(): RepoCompare[] {
    return this.repositories().map(root => this.results.get(root.fsPath)).filter((result): result is RepoCompare => Boolean(result));
  }

  of(root: vscode.Uri): RepoCompare | undefined {
    return this.results.get(root.fsPath);
  }

  get active(): boolean {
    return this.repositories().some(root => this.baseOf(root));
  }

  refreshAll(): void {
    for (const root of this.repositories()) {
      void this.refresh(root);
    }
    this.changed.fire();
  }

  /** Computes a repository's comparison again, now. */
  async refresh(root: vscode.Uri): Promise<void> {
    clearTimeout(this.timers.get(root.fsPath));
    const ref = this.baseOf(root);
    const git = this.gitRunner;
    if (!ref || !git || !vscode.workspace.isTrusted) {
      if (this.results.delete(root.fsPath)) {
        this.changed.fire();
      }
      return;
    }
    const mode = this.mode;
    let result: RepoCompare;
    try {
      const sha = await git.resolve(root, ref, mode);
      const [changes, tracked] = await Promise.all([git.changes(root, sha), this.trackedAt(git, root, sha)]);
      result = { root, ref, mode, sha, changes, tracked };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { root, ref, mode, changes: [], tracked: new Set(), error: mode === 'merge-base' && !message.includes('fatal')
        ? `${ref} has no common commit with HEAD` : message.split('\n')[0] };
    }
    // The base or the mode may have changed while git ran
    if (this.baseOf(root) === ref && this.mode === mode) {
      this.results.set(root.fsPath, result);
      this.changed.fire();
    }
  }

  private trackedAt(git: Git, root: vscode.Uri, sha: string): Promise<Set<string>> {
    const key = `${root.fsPath}\0${sha}`;
    let tracked = this.trackedCache.get(key);
    if (!tracked) {
      if (this.trackedCache.size > 20) {
        this.trackedCache.clear();
      }
      tracked = git.tracked(root, sha).catch(() => new Set<string>());
      this.trackedCache.set(key, tracked);
    }
    return tracked;
  }

  private bases(): Record<string, string> {
    return { ...this.state.get<Record<string, string>>(BASES_KEY, {}) };
  }

  /** Waits for the built-in git extension, then follows its repositories. */
  private async connect(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) {
      return;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      this.api = exports.getAPI(1);
    } catch {
      // Git is disabled, or not installed
      return;
    }
    this.gitRunner = new Git(this.api.git.path || 'git');
    const watch = (repository: GitRepository) => {
      const root = repository.rootUri;
      this.watchers.get(root.fsPath)?.dispose();
      this.watchers.set(root.fsPath, repository.state.onDidChange(() => this.schedule(root)));
      void this.refresh(root);
      this.changed.fire();
    };
    this.api.repositories.forEach(watch);
    this.disposables.push(
      this.api.onDidOpenRepository(watch),
      this.api.onDidCloseRepository(repository => {
        this.watchers.get(repository.rootUri.fsPath)?.dispose();
        this.watchers.delete(repository.rootUri.fsPath);
        this.results.delete(repository.rootUri.fsPath);
        this.changed.fire();
      }),
      // Git notices an edit once it is saved; the gutter follows unsaved edits by itself
      vscode.workspace.onDidSaveTextDocument(document => {
        const root = this.repositoryOf(document.uri);
        if (root) {
          this.schedule(root);
        }
      }),
    );
  }

  private schedule(root: vscode.Uri): void {
    if (!this.baseOf(root)) {
      return;
    }
    clearTimeout(this.timers.get(root.fsPath));
    this.timers.set(root.fsPath, setTimeout(() => void this.refresh(root), REFRESH_MS));
  }

  dispose(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    this.watchers.forEach(watcher => watcher.dispose());
    this.disposables.forEach(disposable => disposable.dispose());
    this.changed.dispose();
  }
}
