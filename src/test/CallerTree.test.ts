import * as assert from 'assert';
import * as vscode from 'vscode';
import { CallerTreeElement, CallerTreeView, rowPlace, treeLabel } from '../CallerTree';

// Runs in the workspace .vscode-test.mjs sets up; alpha/calls holds main.ts -> index.render -> pricing.quote ->
// pricing.convert -> rates.readRate

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

suite('Caller Tree', () => {
  test('a row is labelled File.function', () => {
    const label = (file: string, name: string, module?: boolean) => treeLabel({ name, module, uri: vscode.Uri.file(file) });
    assert.deepStrictEqual([
      label('/r/src/components/ReportDetails/ReportDetails.tsx', 'renderArchiveGate'),
      label('/r/src/ArchiveAccessPanel/ArchiveAccessPanel.tsx', 'ArchiveAccessPanel'),
      label('/r/src/ArchiveAccessPanel/ArchiveAccessPanel.tsx', '(module)', true),
      label('/r/src/Button/index.ts', 'render'),
      label('/r/app/api/feed/route.ts', 'POST'),
      label('/r/pkg/__init__.py', 'setup'),
      label('/r/src/Billing.java', 'Billing.charge'),
      label('/r/src/a.test.ts', 'helper'),
    ], ['ReportDetails.renderArchiveGate', 'ArchiveAccessPanel', 'ArchiveAccessPanel (module)', 'Button/index.render',
      'feed/route.POST', 'pkg/__init__.setup', 'Billing.charge', 'a.test.helper']);
  });

  test('the view follows the cursor and shows the callers up to the entry points', async function () {
    this.timeout(90_000);
    const folder = vscode.workspace.workspaceFolders!.find(f => f.name === 'alpha')!;
    const rates = vscode.Uri.joinPath(folder.uri, 'calls/rates.ts');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(rates));
    const pos = new vscode.Position(0, 17);
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand('incontext.callerTree.focus');
    const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { callerTree: CallerTreeView };
    const view = api.callerTree;
    assert.ok(view, 'the view is registered');
    // The TypeScript server takes a while to load the project: refresh until it finds the whole chain
    const end = Date.now() + 80_000;
    let entries: CallerTreeElement[] = [];
    let top: CallerTreeElement[] = [];
    while (Date.now() < end) {
      await vscode.window.showTextDocument(editor.document);
      editor.selection = new vscode.Selection(pos, pos);
      await vscode.commands.executeCommand('incontext.callerTree.refresh');
      top = view.provider.getChildren();
      entries = top.length ? view.provider.getChildren(top[1]) : [];
      if (entries.some(e => e.item.label === 'main (module)')) { break; }
      await sleep(1000);
    }
    assert.deepStrictEqual(top.map(e => e.item.label), ['rates.readRate', 'Entry points (1)'], view.view.message);
    const labels: string[] = [];
    const walk = (el: CallerTreeElement, depth: number) => {
      labels.push(`${'  '.repeat(depth)}${el.item.label} ${el.item.description}`);
      view.provider.getChildren(el).forEach(c => walk(c, depth + 1));
    };
    walk(top[0], 0);
    assert.deepStrictEqual(labels, [
      'rates.readRate calls/rates.ts:1',
      '  pricing.convert calls/pricing.ts:3',
      '    pricing.quote calls/pricing.ts:6',
      '      calls/index.render calls/index.ts:3',
      '        main (module) calls/main.ts · MODULE',
    ]);
    assert.strictEqual(entries[0].item.description, 'calls/main.ts:2 · MODULE');
    assert.deepStrictEqual(view.provider.getChildren(entries[0]).map(e => e.item.label),
      ['calls/index.render', 'pricing.quote', 'pricing.convert', 'rates.readRate']);
    assert.match(String(view.view.message), /^1 entry points \(MODULE 1\) \| 3 functions/);
    assert.strictEqual(view.view.description, 'follows the cursor');
    // A row opens with VS Code's own open command, the only one told the keys held: Cmd+click opens it to the side
    const convert = view.provider.getChildren(top[0])[0];
    const pricingUri = vscode.Uri.joinPath(folder.uri, 'calls/pricing.ts');
    assert.strictEqual(convert.item.command?.command, 'vscode.open');
    assert.deepStrictEqual([rowPlace(convert)?.uri.toString(), rowPlace(convert)?.line], [pricingUri.toString(), 2]);
    // Open to the Side (Cmd+Enter) opens the row beside and keeps the tree on its function
    await vscode.commands.executeCommand('incontext.callerTree.openToSide', convert);
    const beside = vscode.window.visibleTextEditors.find(e => e.viewColumn === vscode.ViewColumn.Two);
    assert.deepStrictEqual([beside?.document.uri.toString(), beside?.selection.active.line], [pricingUri.toString(), 2]);
    await sleep(400);
    await view.pending;
    assert.strictEqual(view.provider.getChildren()[0].item.label, 'rates.readRate');
    await vscode.window.tabGroups.close(vscode.window.tabGroups.all.filter(group => group.viewColumn === vscode.ViewColumn.Two));
    // Pinned: a click in another function keeps the tree
    await vscode.commands.executeCommand('incontext.callerTree.pin');
    const pricing = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, 'calls/pricing.ts')));
    pricing.selection = new vscode.Selection(new vscode.Position(5, 18), new vscode.Position(5, 18));
    await vscode.commands.executeCommand('incontext.callerTree.refresh');
    assert.strictEqual(view.provider.getChildren()[0].item.label, 'rates.readRate');
    assert.strictEqual(view.view.description, 'pinned');
    await vscode.commands.executeCommand('incontext.callerTree.unpin');
    await sleep(400);
    await view.pending;
    await vscode.commands.executeCommand('incontext.callerTree.refresh');
    assert.strictEqual(view.provider.getChildren()[0].item.label, 'pricing.quote');
  });
});
