import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownPreview } from '../MarkdownPreview';
import { ReferenceUtils } from '../ReferenceUtils';
import { ReferenceParser } from '../ReferenceParser';
import { WindowEndpoint, WindowRegistry } from '../LinkWindows';
import { AiInstructions } from '../AiInstructions';
import { AiInstructionsResult } from '../AiInstructionsCommands';
import { launch, request } from './http';

// Runs in the workspace .vscode-test.mjs sets up: folders alpha and beta, with ../outside next to them,
// alpha/inner -> alpha/src and alpha/escape -> ../outside

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, check: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
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

function folder(name: string): string {
  return vscode.workspace.workspaceFolders!.find(folder => folder.name === name)!.uri.fsPath;
}

function activeFile(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

/** Whether the active editor is the only editor group, so the reference didn't open in a split. */
function inOneGroup(): boolean {
  return vscode.window.tabGroups.all.length === 1 && vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One;
}

function selectedLines(): [number, number] | undefined {
  const selection = vscode.window.activeTextEditor?.selection;
  return selection && [selection.start.line + 1, selection.end.line + 1];
}

suite('Extension', () => {
  let port: number;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('managea.incontext')!.activate();
    port = vscode.workspace.getConfiguration('incontext.linkServer').get<number>('port')!;
    assert.notStrictEqual(port, 46266, 'the tests use a port of their own (.vscode-test.mjs)');
    await waitFor('the link server', async () => (await request(port, 'GET', '/open', { Host: `localhost:${port}` }).catch(() => undefined))?.status === 200);
  });

  setup(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  suite('link server', () => {
    test('opens a reference with its lines selected, in the editor rather than a split', async () => {
      const response = await launch(port, '@alpha/src/a.ts:L5:7');
      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(activeFile(), path.join(folder('alpha'), 'src', 'a.ts'));
      assert.deepStrictEqual(selectedLines(), [5, 7]);
      assert.ok(inOneGroup());
    });

    test('opens a reference in another workspace folder, and the #L style', async () => {
      const response = await launch(port, '@beta/b.ts#L10-L12');
      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(activeFile(), path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [10, 12]);
    });

    test('opens a whole file, with its first line selected', async () => {
      const response = await launch(port, '@beta/b.ts');
      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(activeFile(), path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [1, 1]);
    });

    test('reveals a folder in the explorer', async () => {
      assert.strictEqual((await launch(port, '@alpha/src/')).status, 204);
      assert.strictEqual((await launch(port, '@beta/')).status, 204, 'a workspace folder itself');
      assert.strictEqual(activeFile(), undefined);
      assert.strictEqual((await launch(port, '@alpha/missing/')).status, 404);
      assert.strictEqual((await launch(port, '@alpha/escape/')).status, 404, 'a folder symlink that leads out of the workspace');
    });

    test('opens through a symlink that stays inside the workspace', async () => {
      assert.strictEqual((await launch(port, '@alpha/inner/a.ts:L2')).status, 204);
      assert.deepStrictEqual(selectedLines(), [2, 2]);
    });

    test('refuses a symlink that leads out of the workspace', async () => {
      const response = await launch(port, '@alpha/escape/secret.txt:L1');
      assert.strictEqual(response.status, 404);
      assert.strictEqual(activeFile(), undefined);
    });

    test('refuses .. before it reaches the workspace check', async () => {
      assert.strictEqual((await launch(port, '@alpha/../outside/secret.txt')).status, 400);
      assert.strictEqual((await launch(port, '@alpha/%2e%2e/outside/secret.txt')).status, 400);
      assert.strictEqual(activeFile(), undefined);
    });

    test('passes a link on to the window that has its folder', async () => {
      const passedOn: string[] = [];
      const otherWindow = new WindowEndpoint(async reference => {
        passedOn.push(reference);
        return { status: 204 };
      });
      const registry = WindowRegistry.open(port)!;
      registry.write({ id: 'test-gamma', pid: process.pid, port: await otherWindow.listen(), token: otherWindow.token, folders: ['gamma'], focusedAt: Date.now() });
      try {
        assert.strictEqual((await launch(port, '@gamma/c.ts:L3')).status, 204);
        assert.deepStrictEqual(passedOn, ['@gamma/c.ts:L3']);
        // alpha is only open in this window, however recently the other window had focus
        assert.strictEqual((await launch(port, '@alpha/src/a.ts:L4')).status, 204);
        assert.deepStrictEqual(passedOn, ['@gamma/c.ts:L3']);
        assert.deepStrictEqual(selectedLines(), [4, 4]);
      } finally {
        registry.remove('test-gamma');
        await otherWindow.close();
      }
    });

    test('drops a window that has gone and opens the link itself', async () => {
      const goneWindow = new WindowEndpoint(async () => ({ status: 204 }));
      const goneWindowPort = await goneWindow.listen();
      await goneWindow.close();
      const registry = WindowRegistry.open(port)!;
      registry.write({ id: 'test-gone', pid: process.pid, port: goneWindowPort, token: goneWindow.token, folders: ['alpha'], focusedAt: Date.now() });
      assert.strictEqual((await launch(port, '@alpha/src/a.ts:L8')).status, 204);
      assert.deepStrictEqual(selectedLines(), [8, 8]);
      assert.ok(!registry.read().some(window => window.id === 'test-gone'));
    });

    test('stops and starts again with its setting', async () => {
      const settings = vscode.workspace.getConfiguration('incontext.linkServer');
      await settings.update('enabled', false, vscode.ConfigurationTarget.Global);
      try {
        await waitFor('the link server to stop', async () => !(await request(port, 'GET', '/open', { Host: `localhost:${port}` }).catch(() => undefined)));
      } finally {
        await settings.update('enabled', undefined, vscode.ConfigurationTarget.Global);
      }
      await waitFor('the link server to start', async () => (await request(port, 'GET', '/open', { Host: `localhost:${port}` }).catch(() => undefined))?.status === 200);
    });
  });

  suite('workspace check', () => {
    const resolve = (reference: string) => ReferenceUtils.resolveReference(ReferenceParser.parse(reference)!)!;

    test('accepts targets inside a workspace folder', () => {
      assert.ok(ReferenceUtils.isInWorkspace(resolve('@alpha/src/a.ts')));
      assert.ok(ReferenceUtils.isInWorkspace(resolve('@beta/')));
      assert.ok(ReferenceUtils.isInWorkspace(resolve('@alpha/inner/a.ts')));
    });

    test('refuses targets that .. or a symlink leads out of the workspace', () => {
      // vscode.Uri.joinPath resolves `..`, which is how these used to leave the workspace
      assert.ok(!ReferenceUtils.isInWorkspace(resolve('@alpha/../outside/secret.txt')));
      assert.ok(!ReferenceUtils.isInWorkspace(resolve('@alpha/../../../../etc/hosts')));
      assert.ok(!ReferenceUtils.isInWorkspace(resolve('@alpha/escape/secret.txt')));
    });
  });

  suite('vscode:// links', () => {
    const extensionUri = () => `${vscode.env.uriScheme}://managea.incontext`;
    const outsideFile = () => path.join(path.dirname(folder('alpha')), 'outside', 'secret.txt');

    /** The link the Markdown preview renders for the relative link in alpha/notes.md, which leads out of the workspace. */
    async function previewLink(): Promise<string> {
      const notes = await vscode.workspace.openTextDocument(path.join(folder('alpha'), 'notes.md'));
      await waitFor('the Markdown extension', async () => (await vscode.commands.getCommands(true)).includes('markdown.api.render'));
      const html = await vscode.commands.executeCommand<string>('markdown.api.render', notes);
      const href = /href="([^"]+\/open\?[^"]+)"/.exec(html)?.[1];
      assert.ok(href, html);
      return href.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    }

    function withRequest(link: string, change: (request: Record<string, unknown>) => void): string {
      const queryStart = link.indexOf('?');
      const request = JSON.parse(decodeURIComponent(link.substring(queryStart + 1)));
      change(request);
      return link.substring(0, queryStart + 1) + encodeURIComponent(JSON.stringify(request));
    }

    async function openLink(link: string): Promise<void> {
      await vscode.env.openExternal(vscode.Uri.parse(link, true));
    }

    test('the preview signs its links, and a changed link loses the signature', () => {
      const link = MarkdownPreview.createOpenUri('managea.incontext', { reference: '../outside/secret.txt#L1-L2', from: 'file:///ws/notes.md' });
      assert.strictEqual(MarkdownPreview.parseOpenUri(vscode.Uri.parse(link, true))?.signed, true);
      const split = vscode.Uri.parse(withRequest(link, request => request.split = 'new'), true);
      assert.strictEqual(MarkdownPreview.parseOpenUri(split)?.signed, true, 'Cmd+click adds split: "new" and keeps the signature');
      for (const change of [
        (request: Record<string, unknown>) => request.reference = '../../.ssh/id_rsa',
        (request: Record<string, unknown>) => request.from = 'file:///elsewhere/notes.md',
        (request: Record<string, unknown>) => delete request.sig,
        (request: Record<string, unknown>) => request.sig = 'x'.repeat(43),
      ]) {
        assert.strictEqual(MarkdownPreview.parseOpenUri(vscode.Uri.parse(withRequest(link, change), true))?.signed, false);
      }
      assert.strictEqual(MarkdownPreview.parseOpenUri(vscode.Uri.parse(`${extensionUri()}/@alpha/src/a.ts:L1`, true))?.signed, false);
    });

    test('short links take whole files and folders', () => {
      assert.strictEqual(MarkdownPreview.parseOpenUri(vscode.Uri.parse(`${extensionUri()}/@alpha/src/a.ts`, true))?.reference, '@alpha/src/a.ts');
      assert.strictEqual(MarkdownPreview.parseOpenUri(vscode.Uri.parse(`${extensionUri()}/@alpha/src/`, true))?.reference, '@alpha/src/');
    });

    test('a short link to a whole file opens it', async () => {
      await openLink(`${extensionUri()}/@beta/b.ts`);
      await waitFor('b.ts to open', () => activeFile() === path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [1, 1]);
    });

    test('a link the preview rendered opens a file outside the workspace, in a split beside the preview', async () => {
      await openLink(await previewLink());
      await waitFor('the outside file to open', () => activeFile() === outsideFile());
      assert.deepStrictEqual(selectedLines(), [1, 2]);
      assert.ok(!inOneGroup());
    });

    test('the same link without the signature is refused', async () => {
      await openLink(withRequest(await previewLink(), request => delete request.sig));
      await sleep(1500);
      assert.notStrictEqual(activeFile(), outsideFile());
    });

    test('an unsigned link may name an open document as from, for references inside the workspace', async () => {
      const notes = await vscode.workspace.openTextDocument(path.join(folder('alpha'), 'notes.md'));
      await openLink(`${extensionUri()}/open?${encodeURIComponent(JSON.stringify({ reference: 'src/a.ts:L3:4', from: notes.uri.toString() }))}`);
      await waitFor('a.ts to open', () => activeFile() === path.join(folder('alpha'), 'src', 'a.ts'));
      assert.deepStrictEqual(selectedLines(), [3, 4]);
    });

    test('an unsigned link naming a document that is not open is refused', async () => {
      const from = vscode.Uri.file(path.join(path.dirname(folder('alpha')), 'outside', 'notes.md')).toString();
      await openLink(`${extensionUri()}/open?${encodeURIComponent(JSON.stringify({ reference: 'secret.txt:L1', from }))}`);
      await sleep(1500);
      assert.strictEqual(activeFile(), undefined);
    });

    test('a short link inside the workspace still opens, in the editor rather than a split', async () => {
      await openLink(`${extensionUri()}/@beta/b.ts:L6:9`);
      await waitFor('b.ts to open', () => activeFile() === path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [6, 9]);
      assert.ok(inOneGroup());
    });
  });

  suite('Mermaid diagram links', () => {
    const diagram = [
      '```mermaid',
      'flowchart TD',
      '  A["Label @alpha/src/a.ts:L1:2"] --> B',
      '  click A "http://localhost:46266/open#@alpha/src/a.ts:L3:4" "Tooltip"',
      '  click B "@beta/b.ts:L5"',
      '```',
      '',
    ].join('\n');

    /** The signed links the preview writes beside the diagram, by reference. */
    async function diagramLinks(document: vscode.TextDocument): Promise<Record<string, string>> {
      await waitFor('the Markdown extension', async () => (await vscode.commands.getCommands(true)).includes('markdown.api.render'));
      const html = await vscode.commands.executeCommand<string>('markdown.api.render', document);
      const data = /class="incontext-diagram-links" data-links="([^"]*)"/.exec(html)?.[1];
      assert.ok(data, html);
      return JSON.parse(data.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    }

    test('finds link-server links and bare @ click targets, not references in labels', () => {
      const source = [
        'flowchart TD',
        '  A["Label @alpha/src/a.ts:L1:2"] --> B',
        '  click A "http://localhost:46266/open#@alpha/src/a.ts:L3:4" "Tooltip"',
        '  click B href "@beta/b.ts:L5"',
        '  click C "@alpha/src/"',
        '  click D "https://example.com/@alpha/src/a.ts"',
        '  click E "@copilot"',
      ].join('\n');
      assert.deepStrictEqual(MarkdownPreview.findDiagramReferences(source), ['@alpha/src/a.ts:L3:4', '@beta/b.ts:L5', '@alpha/src/']);
      const sequence = 'sequenceDiagram\n  link Alice: Open @ http://127.0.0.1:46266/open#35;@alpha/src/a.ts:L6:7';
      assert.deepStrictEqual(MarkdownPreview.findDiagramReferences(sequence), ['@alpha/src/a.ts:L6:7']);
    });

    test('the preview writes a signed link for each of the diagram\'s references, from the document', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: diagram });
      const links = await diagramLinks(document);
      assert.deepStrictEqual(Object.keys(links), ['@alpha/src/a.ts:L3:4', '@beta/b.ts:L5']);
      for (const [reference, link] of Object.entries(links)) {
        const request = MarkdownPreview.parseOpenUri(vscode.Uri.parse(link, true));
        assert.deepStrictEqual([request?.reference, request?.from], [reference, document.uri.toString()]);
        // Signed with the running extension's key, which this module doesn't share: the next test opens the link
        assert.match(decodeURIComponent(link), /"sig":"[^"]+"/);
      }
    });

    test('a diagram\'s signed link opens the reference in a split, which only signed links do', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: diagram });
      await vscode.env.openExternal(vscode.Uri.parse((await diagramLinks(document))['@alpha/src/a.ts:L3:4'], true));
      await waitFor('a.ts to open', () => activeFile() === path.join(folder('alpha'), 'src', 'a.ts'));
      assert.deepStrictEqual(selectedLines(), [3, 4]);
      assert.ok(!inOneGroup());
    });

    test('a document without diagram links gets no link list', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '```mermaid\nflowchart TD\n  A --> B\n```\n' });
      const html = await vscode.commands.executeCommand<string>('markdown.api.render', document);
      assert.ok(!html.includes('incontext-diagram-links'), html);
    });
  });

  suite('AI assistant instructions', () => {
    const fixtures = () => path.dirname(folder('alpha'));
    const all = ['claude', 'copilot', 'codex'];
    const run = (command: string, tools: string[]) => vscode.commands.executeCommand<AiInstructionsResult[]>(command, { tools });
    const outcomes = (results: AiInstructionsResult[]) => results.map(result => `${result.tool}: ${result.outcome}`);
    const read = (file: string) => fs.readFileSync(file, 'utf8');

    // While these tests run, HOME and CODEX_HOME point into the test workspace (.vscode-test.mjs makes the folders),
    // so the commands never write to the real ones
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

    suiteSetup(() => {
      process.env.HOME = path.join(fixtures(), 'home');
      process.env.CODEX_HOME = path.join(fixtures(), 'codex-home');
      assert.strictEqual(os.homedir(), path.join(fixtures(), 'home'));
      assert.ok(AiInstructions.targets().every(target => target.file.startsWith(fixtures() + path.sep)));
    });

    suiteTeardown(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    test('set up writes each tool\'s instructions with the link server\'s port, and leaves the rest alone', async () => {
      const targets = AiInstructions.targets();
      assert.deepStrictEqual(outcomes(await run('incontext.setUpAiInstructions', all)), ['claude: written', 'copilot: written', 'codex: written']);
      for (const target of targets) {
        assert.ok(read(target.file).includes(`(http://localhost:${port}/open#@<folder>/<path>:L<start>:<end>)`), target.tool);
        assert.ok(read(target.file).includes(`(${vscode.env.uriScheme}://managea.incontext/@<folder>/<path>:L<start>:<end>)`), target.tool);
      }
      assert.strictEqual(read(path.join(os.homedir(), '.claude', 'CLAUDE.md')), '# My Claude rules\n');
      assert.strictEqual(read(path.join(os.homedir(), '.copilot', 'copilot-instructions.md')), '# My Copilot rules\n');
      assert.ok(read(targets[2].file).startsWith('# My Codex rules\n\nBe brief.\n\n<!-- incontext-references:start -->'));

      assert.deepStrictEqual(outcomes(await run('incontext.setUpAiInstructions', all)), ['claude: unchanged', 'copilot: unchanged', 'codex: unchanged']);
    });

    test('a symlink on the way is skipped without asking', async () => {
      const instructionsFolder = path.join(os.homedir(), '.copilot', 'instructions');
      const shared = path.join(fixtures(), 'shared-instructions');
      await run('incontext.removeAiInstructions', ['copilot']);
      fs.renameSync(instructionsFolder, shared);
      fs.symlinkSync(shared, instructionsFolder);
      try {
        assert.deepStrictEqual(outcomes(await run('incontext.setUpAiInstructions', ['copilot'])), ['copilot: skipped']);
        assert.deepStrictEqual(fs.readdirSync(shared), []);
      } finally {
        fs.rmSync(instructionsFolder);
        fs.renameSync(shared, instructionsFolder);
      }
    });

    test('remove takes out only what set up wrote', async () => {
      await run('incontext.setUpAiInstructions', all);
      assert.deepStrictEqual(outcomes(await run('incontext.removeAiInstructions', all)), ['claude: removed', 'copilot: removed', 'codex: removed']);
      const [claude, copilot, codex] = AiInstructions.targets();
      assert.ok(!fs.existsSync(claude.file) && !fs.existsSync(copilot.file));
      assert.strictEqual(read(codex.file), '# My Codex rules\n\nBe brief.\n');
      assert.strictEqual(read(path.join(os.homedir(), '.claude', 'CLAUDE.md')), '# My Claude rules\n');
      assert.deepStrictEqual(await run('incontext.removeAiInstructions', all), []);
    });
  });
});
