import * as assert from 'assert';
import * as vscode from 'vscode';
import { CallerTreeColors, CallerTreeElement, CallerTreeView, fileLabel, rowPlace } from '../CallerTree';

// Runs in the workspace .vscode-test.mjs sets up; alpha/calls holds main.ts -> index.render -> pricing.quote ->
// pricing.convert -> rates.readRate

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

suite('Caller Tree', () => {
  test('a row names its file, with the folder when the name says little', () => {
    const label = (file: string) => fileLabel(vscode.Uri.file(file));
    assert.deepStrictEqual([
      label('/r/src/components/ReportDetails/ReportDetails.tsx'),
      label('/r/src/Button/index.ts'),
      label('/r/app/api/feed/route.ts'),
      label('/r/pkg/__init__.py'),
      label('/r/functions/get-report/handler.ts'),
      label('/handler.ts'),
    ], ['ReportDetails.tsx', 'Button/index.ts', 'feed/route.ts', 'pkg/__init__.py', 'get-report/handler.ts', 'handler.ts']);
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
      if (entries.some(e => e.item.label === '(module)' && String(e.item.description).startsWith('main.ts'))) { break; }
      await sleep(1000);
    }
    assert.deepStrictEqual(top.map(e => e.item.label), ['readRate', 'Entry points (1)'], view.view.message);
    const labels: string[] = [];
    const walk = (el: CallerTreeElement, depth: number) => {
      labels.push(`${'  '.repeat(depth)}${el.item.label} ${el.item.description}`);
      view.provider.getChildren(el).forEach(c => walk(c, depth + 1));
    };
    walk(top[0], 0);
    // Each row is the function, then its file and line
    assert.deepStrictEqual(labels, [
      'readRate rates.ts:1',
      '  convert pricing.ts:3',
      '    quote pricing.ts:6',
      '      render calls/index.ts:3',
      '        (module) main.ts · MODULE',
    ]);
    assert.strictEqual(entries[0].item.description, 'main.ts:2 · MODULE');
    assert.deepStrictEqual(view.provider.getChildren(entries[0]).map(e => e.item.label), ['render', 'quote', 'convert', 'readRate']);
    // Rows in one file share a colour, in the name (a decoration on the row's resourceUri) and the icon; the root's file has the first
    const colourOf = (el: CallerTreeElement) => el.item.resourceUri && new CallerTreeColors().provideFileDecoration(el.item.resourceUri)?.color?.id;
    const [convertRow] = view.provider.getChildren(top[0]);
    const [quoteRow] = view.provider.getChildren(convertRow);
    assert.deepStrictEqual([colourOf(top[0]), colourOf(convertRow), colourOf(quoteRow)],
      ['incontext.callerTree.file1', 'incontext.callerTree.file2', 'incontext.callerTree.file2']);
    assert.strictEqual((convertRow.item.iconPath as vscode.ThemeIcon).color?.id, 'incontext.callerTree.file2');
    assert.strictEqual(convertRow.item.resourceUri?.scheme, CallerTreeColors.SCHEME, 'the colours show in this view only');
    // Folded, a caller in the same file as the row it calls gives way to its own callers: quote, in convert's file
    await vscode.commands.executeCommand('incontext.callerTree.foldSameFile');
    try {
      const folded: string[] = [];
      const walkFolded = (el: CallerTreeElement, depth: number) => {
        folded.push(`${'  '.repeat(depth)}${el.item.label} ${el.item.description}`);
        view.provider.getChildren(el).forEach(c => walkFolded(c, depth + 1));
      };
      const foldedTop = view.provider.getChildren();
      walkFolded(foldedTop[0], 0);
      assert.deepStrictEqual(folded, [
        'readRate rates.ts:1',
        '  convert pricing.ts:3',
        '    render calls/index.ts:3 · via quote',
        '      (module) main.ts · MODULE',
      ]);
      const foldedEntry = view.provider.getChildren(foldedTop[1])[0];
      assert.deepStrictEqual(view.provider.getChildren(foldedEntry).map(e => `${e.item.label} ${e.item.description}`),
        ['render calls/index.ts:3', 'quote pricing.ts:6', 'readRate rates.ts:1 · via convert']);
      assert.strictEqual(view.view.description, 'follows the cursor · same-file calls folded');
    } finally {
      await vscode.commands.executeCommand('incontext.callerTree.unfoldSameFile');
    }
    assert.strictEqual(view.provider.getChildren(view.provider.getChildren(view.provider.getChildren()[0])[0]).length, 1, 'quote is back');
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
    assert.strictEqual(view.provider.getChildren()[0].item.label, 'readRate');
    await vscode.window.tabGroups.close(vscode.window.tabGroups.all.filter(group => group.viewColumn === vscode.ViewColumn.Two));
    // Pinned: a click in another function keeps the tree
    await vscode.commands.executeCommand('incontext.callerTree.pin');
    const pricing = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, 'calls/pricing.ts')));
    pricing.selection = new vscode.Selection(new vscode.Position(5, 18), new vscode.Position(5, 18));
    await vscode.commands.executeCommand('incontext.callerTree.refresh');
    assert.strictEqual(view.provider.getChildren()[0].item.label, 'readRate');
    assert.strictEqual(view.view.description, 'pinned');
    await vscode.commands.executeCommand('incontext.callerTree.unpin');
    await sleep(400);
    await view.pending;
    await vscode.commands.executeCommand('incontext.callerTree.refresh');
    assert.strictEqual(view.provider.getChildren()[0].item.label, 'quote');
  });
});
