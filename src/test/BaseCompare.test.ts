import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseCompare, BaseContent, Git, RepoCompare } from '../BaseCompare';
import { BaseCompareTree, TreeNode } from '../BaseCompareTree';
import { BaseCompareGutter, GitGutterSwap } from '../BaseCompareGutter';

// Runs in the workspace .vscode-test.mjs sets up: beta/shop and beta/tools are git repositories on branch feature,
// with main as the branch to compare with

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

const summary = (result: RepoCompare) => result.changes.map(change =>
  `${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ''}${change.path}${change.untracked ? ' (untracked)' : ''}`);

suite('Compare with Branch', () => {
  test('git diff --name-status -z is read into changes', () => {
    assert.deepStrictEqual(Git.parseNameStatus('M\0a.ts\0D\0gone.ts\0R100\0old.ts\0new.ts\0A\0src/b.ts\0T\0link\0'), [
      { status: 'M', path: 'a.ts' },
      { status: 'D', path: 'gone.ts' },
      { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
      { status: 'A', path: 'src/b.ts' },
      { status: 'M', path: 'link' },
    ]);
  });

  test('a repository compared with main shows what a merge request would, then the tip, in the tree and the gutter',
    async function () {
      this.timeout(90_000);
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { compareWithBranch: BaseCompare };
      const compare = api.compareWithBranch;
      const beta = vscode.workspace.workspaceFolders!.find(folder => folder.name === 'beta')!.uri;
      const shop = vscode.Uri.joinPath(beta, 'shop');
      const tools = vscode.Uri.joinPath(beta, 'tools');
      await waitFor('git to open both repositories', () => compare.repositories().length >= 2
        && compare.repositoryOf(vscode.Uri.joinPath(shop, 'a.ts'))?.fsPath === shop.fsPath, 60_000);
      assert.strictEqual(compare.repositoryOf(vscode.Uri.joinPath(tools, 't.ts'))?.fsPath, tools.fsPath);
      assert.strictEqual(compare.git && await compare.git.defaultRef(shop), 'main');
      try {
        // Merge-base: main-only.ts, added to main after feature left it, isn't a change of this branch
        await compare.setMode('merge-base');
        await compare.setBase(shop, 'main');
        let result = await waitFor('the comparison', () => compare.of(shop));
        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(summary(result), ['M a.ts', 'A fresh.ts (untracked)', 'D gone.ts', 'R old.ts -> new.ts', 'A src/added.ts']);
        assert.ok(compare.active);
        // VS Code's toggle that hides git's own gutter markers meanwhile
        await waitFor('the git quick diff toggle', async () => (await vscode.commands.getCommands(true)).includes(GitGutterSwap.COMMAND));

        // The base side holds main's text: the committed and the uncommitted edit of a.ts both differ from it
        const base = await vscode.workspace.openTextDocument(BaseContent.uri(shop, result.sha!, 'a.ts'));
        assert.match(base.getText(), /const line3 = 3;/);
        assert.match(base.getText(), /const line20 = 20;/);
        assert.strictEqual(base.languageId, 'typescript');
        const added = await vscode.workspace.openTextDocument(BaseContent.uri(shop, result.sha!, 'src/added.ts'));
        assert.strictEqual(added.getText(), '', 'a file new on the branch is empty in the base');

        // The tree: one repository compared, so its folders and files at the top
        const tree = new BaseCompareTree(compare);
        const label = (node: TreeNode) => tree.getTreeItem(node).label as string;
        const top = tree.getChildren();
        assert.deepStrictEqual(top.map(label), ['src', 'a.ts', 'fresh.ts', 'gone.ts', 'new.ts']);
        assert.deepStrictEqual(tree.getChildren(top[0]).map(label), ['added.ts']);
        const renamed = tree.getTreeItem(top[4]);
        assert.strictEqual(renamed.description, 'R ← old.ts');
        // A click opens the file; a deleted file, which has none, its diff
        assert.strictEqual(renamed.command?.command, 'vscode.open');
        assert.strictEqual((renamed.command!.arguments![0] as vscode.Uri).fsPath, path.join(shop.fsPath, 'new.ts'));
        assert.strictEqual(tree.getTreeItem(top[3]).command?.command, 'vscode.diff');

        // The row's diff icon opens the side-by-side diff, a renamed file against its old name
        await vscode.commands.executeCommand('incontext.compare.openDiff', top[4]);
        const input = await waitFor('the diff to open', () => {
          const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return tab instanceof vscode.TabInputTextDiff && tab;
        });
        assert.strictEqual(new URLSearchParams(input.original.query).get('file'), 'old.ts');
        assert.strictEqual(input.modified.fsPath, path.join(shop.fsPath, 'new.ts'));
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        // The tip of main: main-only.ts, which this branch doesn't have, shows as deleted
        await compare.setMode('tip');
        result = await waitFor('the tip comparison', () => compare.of(shop)?.mode === 'tip' && compare.of(shop));
        assert.ok(summary(result).includes('D main-only.ts'));

        // Two repositories compared: one row each
        await compare.setMode('merge-base');
        await compare.setBase(tools, 'main');
        await waitFor('both comparisons', () => compare.of(tools) && compare.of(shop)?.mode === 'merge-base');
        assert.deepStrictEqual(summary(compare.of(tools)!), ['M t.ts']);
        assert.deepStrictEqual(tree.getChildren().map(node => node.kind === 'repo' && path.basename(node.result.root.fsPath)), ['shop', 'tools']);

        // A ref that doesn't exist says so
        await compare.setBase(tools, 'no-such-branch');
        const missing = await waitFor('the error', () => compare.of(tools)?.ref === 'no-such-branch' && compare.of(tools));
        assert.ok(missing.error);
        assert.deepStrictEqual(missing.changes, []);
        tree.dispose();
      } finally {
        await compare.setMode('merge-base');
        await compare.setBase(shop, undefined);
        await compare.setBase(tools, undefined);
      }
      assert.strictEqual(compare.of(shop), undefined);
      assert.ok(!compare.active);
    });

  test('the diff command puts the base on the left and the working file on the right', () => {
    const root = vscode.Uri.file('/r');
    const result: RepoCompare = { root, ref: 'main', mode: 'merge-base', sha: 'abc', changes: [], tracked: new Set() };
    const args = (status: 'A' | 'M' | 'D') => BaseCompareGutter.diffCommand(result, { status, path: 'x.ts' }).arguments as [vscode.Uri, vscode.Uri, string];
    const sha = (uri: vscode.Uri) => new URLSearchParams(uri.query).get('sha');
    assert.deepStrictEqual([sha(args('M')[0]), args('M')[1].scheme, args('M')[2]], ['abc', 'file', 'x.ts (main ↔ Working Tree)']);
    assert.deepStrictEqual([sha(args('A')[0]), args('A')[1].scheme], ['', 'file']);
    assert.deepStrictEqual([sha(args('D')[0]), sha(args('D')[1]), args('D')[2]], ['abc', '', 'x.ts (main ↔ Deleted)']);
  });
});
