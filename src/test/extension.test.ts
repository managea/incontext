import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownPreview } from '../MarkdownPreview';
import { ReferenceUtils } from '../ReferenceUtils';
import { ReferenceParser } from '../ReferenceParser';
import { LaunchRequest } from '../LinkRequest';
import { LinkService } from '../LinkService';
import { WindowEndpoint, WindowRegistry } from '../LinkWindows';
import { AiInstructions } from '../AiInstructions';
import { AiInstructionsResult } from '../AiInstructionsCommands';
import { ObsidianPlugin } from '../ObsidianPlugin';
import { ObsidianPluginResult } from '../ObsidianPluginCommands';
import { Notes, NotesProvider } from '../Notes';
import { NoteComment } from '../NotesComments';
import { NotesBacklinks } from '../NotesBacklinks';
import { NoteNode, NotesTree } from '../NotesTree';
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

    test('passes a link on to the window that has its folder, with whether to come to the front', async () => {
      const passedOn: LaunchRequest[] = [];
      const otherWindow = new WindowEndpoint(async request => {
        passedOn.push(request);
        return { status: 204 };
      });
      const registry = WindowRegistry.open(port)!;
      registry.write({ id: 'test-gamma', pid: process.pid, port: await otherWindow.listen(), token: otherWindow.token, folders: ['gamma'], focusedAt: Date.now() });
      try {
        assert.strictEqual((await launch(port, '@gamma/c.ts:L3')).status, 204);
        assert.strictEqual((await launch(port, '@gamma/d.ts', {}, { focus: true })).status, 204);
        const forwarded = [{ reference: '@gamma/c.ts:L3', focus: false }, { reference: '@gamma/d.ts', focus: true }];
        assert.deepStrictEqual(passedOn, forwarded);
        // alpha is only open in this window, however recently the other window had focus
        assert.strictEqual((await launch(port, '@alpha/src/a.ts:L4')).status, 204);
        assert.deepStrictEqual(passedOn, forwarded);
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

    test('opens a reference from a browser tab, which asks VS Code to come to the front, without waiting for it', async () => {
      const response = await launch(port, '@alpha/src/a.ts:L9:11', {}, { focus: true });
      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(activeFile(), path.join(folder('alpha'), 'src', 'a.ts'));
      assert.deepStrictEqual(selectedLines(), [9, 11]);
      assert.ok(inOneGroup());
    });

    test('the vscode:// URI that brings a window to the front goes to this window, and opens nothing', async () => {
      // What bringToFront relies on: asExternalUri names this window, so VS Code focuses it rather than the most
      // recently focused window, and the URI handler takes the URI, after which VS Code focuses that window
      const uri = await vscode.env.asExternalUri(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: 'managea.incontext', path: LinkService.FOCUS_PATH }));
      assert.strictEqual(uri.path, LinkService.FOCUS_PATH);
      assert.match(uri.query, /(^|&)windowId=\d+(&|$)/);
      assert.strictEqual((await launch(port, '@beta/b.ts:L2')).status, 204);
      assert.strictEqual(await vscode.env.openExternal(uri), true);
      await sleep(300);
      assert.strictEqual(activeFile(), path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [2, 2]);
      assert.ok(inOneGroup());
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

    test('a short link clicked in a drawing opens beside it, and the next click reuses that split', async () => {
      // A webview stands in for a drawing such as Excalidraw's custom editor: both are tabs that aren't text editors
      const drawing = vscode.window.createWebviewPanel('test.drawing', 'Drawing', vscode.ViewColumn.One, {});
      try {
        await openLink(`${extensionUri()}/@beta/b.ts:L6:9`);
        await waitFor('b.ts to open', () => activeFile() === path.join(folder('beta'), 'b.ts'));
        assert.deepStrictEqual(selectedLines(), [6, 9]);
        const split = vscode.window.activeTextEditor!.viewColumn;
        assert.notStrictEqual(split, drawing.viewColumn, 'the code is beside the drawing, not on top of it');
        assert.ok(drawing.visible, 'the drawing stays in view');

        drawing.reveal(drawing.viewColumn);
        await waitFor('the drawing to be the active tab', () => drawing.active);
        await openLink(`${extensionUri()}/@alpha/src/a.ts:L2:3`);
        await waitFor('a.ts to open', () => activeFile() === path.join(folder('alpha'), 'src', 'a.ts'));
        assert.strictEqual(vscode.window.activeTextEditor!.viewColumn, split);
        assert.strictEqual(vscode.window.tabGroups.all.length, 2);
        // Each link opens a tab of its own: the second file doesn't replace the first
        const splitTabs = vscode.window.tabGroups.all.find(group => group.viewColumn === split)!.tabs;
        const files = splitTabs.map(tab => (tab.input as vscode.TabInputText).uri.fsPath);
        assert.deepStrictEqual(files, [path.join(folder('beta'), 'b.ts'), path.join(folder('alpha'), 'src', 'a.ts')]);
        assert.ok(splitTabs.every(tab => !tab.isPreview));
      } finally {
        drawing.dispose();
      }
    });

    test('copies a reference as a link, which opens it', async () => {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder('alpha'), 'src', 'a.ts')));
      editor.selection = new vscode.Selection(2, 0, 3, 5);
      await vscode.commands.executeCommand('incontext.copyReferenceAsLink');
      const link = await vscode.env.clipboard.readText();
      assert.strictEqual(link, `${extensionUri()}/@alpha/src/a.ts:L3:4`);
      // The editor's context menu passes the editor's file, and the selection still decides the lines
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('incontext.copyReferenceAsLink', editor.document.uri);
      assert.strictEqual(await vscode.env.clipboard.readText(), link);

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await openLink(link);
      await waitFor('a.ts to open', () => activeFile() === path.join(folder('alpha'), 'src', 'a.ts'));
      assert.deepStrictEqual(selectedLines(), [3, 4]);
    });
  });

  suite('notes', () => {
    const notesText = [
      '# Notes on @alpha/src/a.ts',
      '',
      '## L5: const line5 = 5;',
      'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.',
      'Second line.',
      '',
      '## L7',
      '',
    ].join('\n');
    const notesFolder = () => path.join(path.dirname(folder('alpha')), 'notes');
    const aTs = () => vscode.Uri.file(path.join(folder('alpha'), 'src', 'a.ts'));

    suiteSetup(async () => {
      fs.mkdirSync(path.join(notesFolder(), 'alpha', 'src'), { recursive: true });
      fs.writeFileSync(path.join(notesFolder(), 'alpha', 'src', 'a.ts.md'), notesText);
      await vscode.workspace.getConfiguration('incontext.notes').update('folder', notesFolder(), vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async () => {
      await vscode.workspace.getConfiguration('incontext.notes').update('folder', undefined, vscode.ConfigurationTarget.Global);
    });

    test('reads notes with their references, and finds their lines after the code above moves', async () => {
      const [first, second] = Notes.parse(notesText);
      assert.deepStrictEqual([first.line, first.anchor, first.headingLine], [5, 'const line5 = 5;', 2]);
      assert.deepStrictEqual(first.references, ['@beta/b.ts:L2:3', '@beta/b.ts:L10']);
      assert.strictEqual(first.text, 'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\nSecond line.');
      assert.deepStrictEqual([second.line, second.anchor, second.text], [7, '', '']);

      const code = fs.readFileSync(aTs().fsPath, 'utf8');
      assert.strictEqual(Notes.locate(await vscode.workspace.openTextDocument({ content: code }), first), 4);
      const moved = await vscode.workspace.openTextDocument({ content: `// a new first line\n${code}` });
      assert.strictEqual(Notes.locate(moved, first), 5, 'the note follows its line');
      assert.strictEqual(Notes.locate(moved, second), 6, 'a note without text stays on its line number');
    });

    test('shows the whole note on hover, with each reference a link that opens it beside the code', async () => {
      await vscode.window.showTextDocument(aTs());
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', aTs());
      assert.ok(!lenses.some(lens => lens.command?.command.startsWith('incontext.')), 'no line above the code: the note shows under it');

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', aTs(), new vscode.Position(4, 3));
      const hoverText = hovers.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
      assert.match(hoverText, /Second line\./);
      // Read as its file and lines, with the whole reference on hover
      const link = /\[b\.ts:L2:3\]\(command:(incontext\.openReferenceBeside)\?([^ )]+) "@beta\/b\.ts:L2:3"\)/.exec(hoverText);
      assert.ok(link, hoverText);

      await vscode.commands.executeCommand(link[1], ...JSON.parse(decodeURIComponent(link[2])));
      await waitFor('b.ts to open beside', () => activeFile() === path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [2, 3]);
      assert.ok(!inOneGroup());
    });

    test('lines only notes elsewhere point at get a box with those back-links, and Add note', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const links = (await NotesBacklinks.read()).get(bTs.fsPath) ?? [];
      assert.deepStrictEqual(links.map(link => [link.targetLine, link.targetEndLine, link.line, link.source.fsPath]), [[1, 2, 5, aTs().fsPath], [9, 9, 5, aTs().fsPath]]);

      const thread = { uri: bTs, range: new vscode.Range(1, 0, 2, 16) } as vscode.CommentThread;
      const preview = new NoteComment(thread, undefined, [links[0]], thread.range!).preview().value;
      const target = encodeURIComponent(JSON.stringify([bTs.toString(), 1]));
      assert.ok(preview.includes(`[Lines 2–3](command:incontext.notes.selectAt?${target}) · [Move to selection](command:incontext.notes.moveAt?${target}) · [Add note](command:incontext.notes.editAt?${target})`), preview);
      assert.ok(!preview.includes('incontext.notes.deleteAt'), 'nothing to delete: back-links are not stored');
      // By default only the link, with the note on hover
      const back = /\[← Note on a\.ts:L5\]\(command:(incontext\.notes\.goToNote)\?([^ )]+) "Defined in @beta\/b\.ts:L2:3, invoked from @beta\/b\.ts:L10\. · Second line\."\)/.exec(preview);
      assert.ok(back, preview);
      assert.ok(!preview.includes('> Defined in'), 'the note is not quoted');
      const settings = vscode.workspace.getConfiguration('incontext.notes');
      await settings.update('showBackLinkNotes', true, vscode.ConfigurationTarget.Global);
      try {
        const quoted = new NoteComment(thread, undefined, [links[0]], thread.range!).preview().value;
        assert.ok(quoted.includes('\n\n> Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\n> Second line.'), quoted);
      } finally {
        await settings.update('showBackLinkNotes', undefined, vscode.ConfigurationTarget.Global);
      }
      await vscode.commands.executeCommand(back[1], ...JSON.parse(decodeURIComponent(back[2])));
      await waitFor('a.ts to open at the note', () => activeFile() === aTs().fsPath);
      assert.deepStrictEqual(selectedLines(), [5, 5]);
    });

    test('Move to selection in a back-link box points the notes\' references at the selected lines', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const notesFile = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const editor = await vscode.window.showTextDocument(bTs);
      editor.selection = new vscode.Selection(4, 0, 7, 0);
      try {
        await waitFor('the reference to move', async () => {
          await vscode.commands.executeCommand('incontext.notes.moveAt', bTs.toString(), 1);
          return Notes.parse(fs.readFileSync(notesFile, 'utf8'))[0].text.includes('@beta/b.ts:L5:7');
        });
        assert.strictEqual(Notes.parse(fs.readFileSync(notesFile, 'utf8'))[0].text, 'Defined in @beta/b.ts:L5:7, invoked from @beta/b.ts:L10.\nSecond line.');
      } finally {
        fs.writeFileSync(notesFile, notesText);
      }
    });

    test('Add note in a back-link box saves a note on those lines, which can point on: a chain', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const notesFile = path.join(notesFolder(), 'beta', 'b.ts.md');
      await vscode.workspace.openTextDocument(bTs);
      try {
        const box = { body: 'Next stop @alpha/src/a.ts:L20', note: undefined, backLinks: [], lines: new vscode.Range(1, 0, 2, 16), thread: { uri: bTs, range: new vscode.Range(0, 0, 0, 0), comments: [] }, mode: vscode.CommentMode.Editing };
        await vscode.commands.executeCommand('incontext.notes.save', box);
        const [note] = Notes.parse(fs.readFileSync(notesFile, 'utf8'));
        assert.deepStrictEqual([note.line, note.lines, note.anchor, note.text], [2, 2, 'const line2 = 2;', 'Next stop @alpha/src/a.ts:L20']);
        await waitFor('the back-link from the new note', async () => (await NotesBacklinks.read()).get(aTs().fsPath)?.some(link => link.targetLine === 19));
      } finally {
        fs.rmSync(notesFile, { force: true });
      }
    });

    test('a project can keep its notes inside itself, to commit them, while other projects use your folder', async () => {
      const alpha = vscode.workspace.workspaceFolders!.find(project => project.name === 'alpha')!;
      const beta = vscode.workspace.workspaceFolders!.find(project => project.name === 'beta')!;
      const settings = vscode.workspace.getConfiguration('incontext.notes', alpha.uri);
      await settings.update('folder', '.notes', vscode.ConfigurationTarget.WorkspaceFolder);
      try {
        assert.strictEqual(Notes.fileFor(aTs())?.fsPath, path.join(folder('alpha'), '.notes', 'src', 'a.ts.md'));
        assert.strictEqual(Notes.projectFolder(beta), path.join(notesFolder(), 'beta'));
        assert.ok(Notes.isNotesFile(vscode.Uri.file(path.join(folder('alpha'), '.notes', 'src', 'a.ts.md'))));
        assert.ok(!Notes.canHaveNotes(vscode.Uri.file(path.join(folder('alpha'), '.notes', 'src', 'a.ts.md'))), 'no notes on notes');
      } finally {
        await settings.update('folder', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
      assert.strictEqual(Notes.fileFor(aTs())?.fsPath, path.join(notesFolder(), 'alpha', 'src', 'a.ts.md'));
    });

    test('a note shows its lines, Move to selection, Edit, Open as Markdown and Delete at its left, for its own note', () => {
      const note = Notes.parse(notesText)[0];
      const thread = { uri: aTs(), range: new vscode.Range(4, 0, 6, 16) } as vscode.CommentThread;
      const preview = new NoteComment(thread, note, [], thread.range!).preview();
      const target = encodeURIComponent(JSON.stringify([aTs().toString(), 4]));
      assert.ok(preview.value.includes(`[Lines 5–7](command:incontext.notes.selectAt?${target})`), preview.value);
      for (const command of ['incontext.notes.selectAt', 'incontext.notes.moveAt', 'incontext.notes.editAt', 'incontext.notes.openAt', 'incontext.notes.deleteAt']) {
        assert.ok(preview.value.includes(`(command:${command}?${target})`), preview.value);
        assert.ok((preview.isTrusted as { enabledCommands: string[] }).enabledCommands.includes(command));
      }
      assert.ok(preview.value.startsWith('Defined in [b.ts:L2:3](command:incontext.openReferenceBeside?'), 'the note comes first, its references by file and lines');
      assert.strictEqual(NotesProvider.shortLabel('@reports/pvoi-ui/src/ReportDetails.tsx:L78'), 'ReportDetails.tsx:L78');
      assert.strictEqual(NotesProvider.shortLabel('@reports/pvoi-ui/src/'), 'src/');
    });

    test('a note on selected lines keeps its lines, and follows them when the code moves', async () => {
      assert.strictEqual(Notes.heading(30, '  const x = 1;', 42), '## L30-L42: const x = 1;');
      assert.strictEqual(Notes.heading(30, 'const x = 1;'), '## L30: const x = 1;');
      const [note] = Notes.parse('## L5-L7: const line5 = 5;\nThree lines');
      assert.deepStrictEqual([note.line, note.lines, note.anchor], [5, 3, 'const line5 = 5;']);
      const code = fs.readFileSync(aTs().fsPath, 'utf8');
      const moved = await vscode.workspace.openTextDocument({ content: `// one\n// two\n${code}` });
      const range = Notes.rangeIn(moved, note);
      assert.deepStrictEqual([range.start.line, range.end.line, range.end.character], [6, 8, 'const line7 = 7;'.length]);
    });

    test('a note typed into a box on selected lines is saved for those lines', async () => {
      const notesFile = vscode.Uri.file(path.join(notesFolder(), 'alpha', 'src', 'a.ts.md'));
      await vscode.workspace.openTextDocument(aTs());
      try {
        // A selection that ends at the start of a line leaves that line out
        const reply = { thread: { uri: aTs(), range: new vscode.Range(11, 0, 14, 0), dispose: () => undefined }, text: 'Lines 12 to 14' };
        await vscode.commands.executeCommand('incontext.notes.create', reply);
        assert.ok(fs.readFileSync(notesFile.fsPath, 'utf8').endsWith('\n\n## L12-L14: const line12 = 12;\nLines 12 to 14\n'));
      } finally {
        fs.writeFileSync(notesFile.fsPath, notesText);
      }
    });

    test('Move to selection moves a note to the lines selected in its file', async () => {
      const notesFile = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const editor = await vscode.window.showTextDocument(aTs());
      editor.selection = new vscode.Selection(19, 0, 21, 3);
      try {
        await waitFor('the note to move', async () => {
          await vscode.commands.executeCommand('incontext.notes.moveAt', aTs().toString(), 4);
          return Notes.parse(fs.readFileSync(notesFile, 'utf8'))[0].line === 20;
        });
        const [moved] = Notes.parse(fs.readFileSync(notesFile, 'utf8'));
        assert.deepStrictEqual([moved.line, moved.lines, moved.anchor, moved.text], [20, 3, 'const line20 = 20;', 'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\nSecond line.']);
      } finally {
        fs.writeFileSync(notesFile, notesText);
      }
    });

    test('the Notes view shows notes as chains: each note, then the notes and places it points to', async () => {
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      fs.writeFileSync(bNotes, '## L2-L3: const line2 = 2;\n**Step 2.** Next: @alpha/src/a.ts:L7\n');
      try {
        const tree = new NotesTree(() => NotesBacklinks.readNotes());
        const roots = await tree.getChildren();
        assert.deepStrictEqual(roots.map(node => tree.getTreeItem(node).description), ['a.ts:L5'], 'only the note nothing points to starts a chain');
        const steps = await tree.getChildren(roots[0]);
        assert.deepStrictEqual(steps.map(node => [node.kind, tree.getTreeItem(node).label, tree.getTreeItem(node).description]), [
          ['note', 'Step 2. Next: a.ts:L7', 'b.ts:L2'],
          ['reference', 'b.ts:L10', 'beta/b.ts:L10'],
        ]);
        const last = await tree.getChildren(steps[0]);
        assert.deepStrictEqual(last.map(node => tree.getTreeItem(node).description), ['a.ts:L7']);
        assert.deepStrictEqual((last[0] as NoteNode).branch.length, 3);
        assert.strictEqual(tree.getTreeItem(roots[0]).command?.command, 'incontext.notes.goToNote');
        assert.strictEqual(tree.getTreeItem(roots[0]).command?.arguments?.[4], false, 'the view opens notes where you are');
      } finally {
        fs.rmSync(bNotes, { force: true });
      }
    });

    test('a back-link goes back to the split that already shows the note, also within one file', async () => {
      await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.One });
      // The same file opened beside, as a link from a note to a later line of its own file does
      await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.Two, selection: new vscode.Range(19, 0, 19, 0) });
      const [note] = Notes.parse(notesText);
      await vscode.commands.executeCommand('incontext.notes.goToNote', aTs().toString(), note.line, note.lines, note.anchor);
      await waitFor('the first split to have focus', () => vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One);
      assert.deepStrictEqual(selectedLines(), [5, 5]);
      const split = vscode.window.visibleTextEditors.find(editor => editor.viewColumn === vscode.ViewColumn.Two)!;
      assert.strictEqual(split.selection.active.line, 19, 'the split the back-link was clicked in stays where it was');
    });

    test('with three splits of one file, a back-link goes to the split showing the note, else the nearest one', async () => {
      const [note] = Notes.parse(notesText);
      const far = new vscode.Range(25, 0, 25, 0);
      await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.One, selection: far });
      await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.Two, selection: new vscode.Range(4, 0, 4, 0) });
      await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.Three, selection: far });
      await vscode.commands.executeCommand('incontext.notes.goToNote', aTs().toString(), note.line, note.lines, note.anchor);
      await waitFor('the split showing the note to have focus', () => vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.Two);
      assert.deepStrictEqual(selectedLines(), [5, 5]);
    });

    test('a back-link to a file no split shows opens it to the left; the InContext view opens it where you are', async () => {
      const [note] = Notes.parse(notesText);
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const columnOf = (file: string) => vscode.window.visibleTextEditors.find(editor => editor.document.uri.fsPath === file)?.viewColumn;
      // From the leftmost split: a new split on the left
      await vscode.window.showTextDocument(bTs, { viewColumn: vscode.ViewColumn.One });
      await vscode.commands.executeCommand('incontext.notes.goToNote', aTs().toString(), note.line, note.lines, note.anchor);
      await waitFor('a.ts to open on the left', () => activeFile() === aTs().fsPath);
      assert.deepStrictEqual([columnOf(aTs().fsPath), columnOf(bTs.fsPath)], [vscode.ViewColumn.One, vscode.ViewColumn.Two]);
      assert.deepStrictEqual(selectedLines(), [5, 5]);

      // A note on an earlier line of the same file, from the leftmost split: the new split on the left shows it
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(25, 0, 25, 0) });
      await vscode.commands.executeCommand('incontext.notes.goToNote', aTs().toString(), note.line, note.lines, note.anchor);
      await waitFor('two splits of a.ts', () => vscode.window.visibleTextEditors.filter(editor => editor.document.uri.fsPath === aTs().fsPath).length === 2);
      assert.strictEqual(vscode.window.activeTextEditor!.viewColumn, vscode.ViewColumn.One);
      assert.deepStrictEqual(selectedLines(), [5, 5]);
      const right = vscode.window.visibleTextEditors.find(editor => editor.viewColumn === vscode.ViewColumn.Two)!;
      assert.strictEqual(right.selection.active.line, 25, 'the split the back-link was clicked in stays where it was');

      // From a split with one on its left: there, in a tab of its own
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const notes = vscode.Uri.file(path.join(folder('alpha'), 'notes.md'));
      await vscode.window.showTextDocument(notes, { viewColumn: vscode.ViewColumn.One });
      await vscode.window.showTextDocument(bTs, { viewColumn: vscode.ViewColumn.Two });
      await vscode.commands.executeCommand('incontext.notes.goToNote', aTs().toString(), note.line, note.lines, note.anchor);
      await waitFor('a.ts to open on the left', () => activeFile() === aTs().fsPath);
      assert.strictEqual(columnOf(aTs().fsPath), vscode.ViewColumn.One);
      const leftTabs = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One)!.tabs;
      assert.ok(leftTabs.some(tab => (tab.input as vscode.TabInputText).uri.fsPath === notes.fsPath), 'the file there stays open');

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.window.showTextDocument(bTs, { viewColumn: vscode.ViewColumn.One });
      await vscode.commands.executeCommand('incontext.notes.goToNote', aTs().toString(), note.line, note.lines, note.anchor, false);
      await waitFor('a.ts to open', () => activeFile() === aTs().fsPath);
      assert.ok(inOneGroup());
    });

    test('a note can use any Markdown, headings and #tags too', () => {
      const withHeadings = Notes.withSection(notesText, 2, '# test\n#test\n## Details\nMore text');
      assert.deepStrictEqual(Notes.parse(withHeadings).map(note => [note.line, note.text]), [[5, '# test\n#test\n## Details\nMore text'], [7, '']]);
      assert.deepStrictEqual(Notes.parse(Notes.withSection(withHeadings, 2, 'Shorter')).map(note => [note.line, note.text]), [[5, 'Shorter'], [7, '']]);
    });

    test('changes one note in a notes file, or takes it out, leaving the others', () => {
      const changed = Notes.withSection(notesText, 2, 'New text\nwith two lines');
      assert.deepStrictEqual(Notes.parse(changed).map(note => [note.line, note.text]), [[5, 'New text\nwith two lines'], [7, '']]);
      const removed = Notes.withSection(notesText, 2, undefined);
      assert.deepStrictEqual(Notes.parse(removed).map(note => note.line), [7]);
      assert.ok(removed.startsWith('# Notes on @alpha/src/a.ts\n'), 'other sections stay');
      const added = Notes.withNote(notesText, '## L10: const line10 = 10;', 'Called by @beta/b.ts:L4');
      assert.ok(added.endsWith('## L7\n\n## L10: const line10 = 10;\nCalled by @beta/b.ts:L4\n'), added);
    });

    test('a note typed into its box is saved to the notes file, and an edit rewrites only that note', async () => {
      const notesFile = vscode.Uri.file(path.join(notesFolder(), 'alpha', 'src', 'a.ts.md'));
      await vscode.workspace.openTextDocument(aTs());
      try {
        let disposed = false;
        const reply = { thread: { uri: aTs(), range: new vscode.Range(9, 0, 9, 0), dispose: () => { disposed = true; } }, text: 'Called by @beta/b.ts:L4\n' };
        await vscode.commands.executeCommand('incontext.notes.create', reply);
        assert.ok(disposed, 'the empty box gives way to the saved note');
        let saved = fs.readFileSync(notesFile.fsPath, 'utf8');
        assert.ok(saved.endsWith('\n\n## L10: const line10 = 10;\nCalled by @beta/b.ts:L4\n'), saved);

        const edited = { body: 'Changed in its box', file: notesFile, note: Notes.parse(saved)[0], thread: { uri: aTs(), range: new vscode.Range(4, 0, 4, 0), comments: [] }, mode: vscode.CommentMode.Editing };
        await vscode.commands.executeCommand('incontext.notes.save', edited);
        saved = fs.readFileSync(notesFile.fsPath, 'utf8');
        assert.deepStrictEqual(Notes.parse(saved).map(note => [note.line, note.text]), [[5, 'Changed in its box'], [7, ''], [10, 'Called by @beta/b.ts:L4']]);
      } finally {
        fs.writeFileSync(notesFile.fsPath, notesText);
      }
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

  suite('Obsidian plugin', () => {
    let vault: string;
    const run = (command: string, vaults: string[]) => vscode.commands.executeCommand<ObsidianPluginResult[]>(command, { vaults });
    const outcomes = (results: ObsidianPluginResult[]) => results.map(result => `${path.basename(result.vault)}: ${result.outcome}`);
    const enabled = () => JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8'));

    setup(() => {
      vault = path.join(path.dirname(folder('alpha')), 'vault');
      fs.rmSync(vault, { recursive: true, force: true });
      fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
      fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['calendar'], null, 2));
    });

    test('install copies the plugin the extension ships into the vault and turns it on', async () => {
      assert.deepStrictEqual(outcomes(await run('incontext.installObsidianPlugin', [vault, folder('beta')])), ['vault: installed', 'beta: not a vault']);
      const shipped = vscode.Uri.joinPath(vscode.extensions.getExtension('managea.incontext')!.extensionUri, 'dist', 'obsidian').fsPath;
      for (const file of ObsidianPlugin.FILES) {
        assert.ok(fs.readFileSync(path.join(ObsidianPlugin.pluginFolder(vault), file)).equals(fs.readFileSync(path.join(shipped, file))), file);
      }
      assert.deepStrictEqual(enabled(), ['calendar', ObsidianPlugin.ID]);
      assert.ok(!fs.existsSync(path.join(folder('beta'), '.obsidian')));

      assert.deepStrictEqual(outcomes(await run('incontext.installObsidianPlugin', [vault])), ['vault: unchanged']);
    });

    test('remove takes out only the plugin', async () => {
      await run('incontext.installObsidianPlugin', [vault]);
      assert.deepStrictEqual(outcomes(await run('incontext.removeObsidianPlugin', [vault])), ['vault: removed']);
      assert.ok(!fs.existsSync(ObsidianPlugin.pluginFolder(vault)));
      assert.deepStrictEqual(enabled(), ['calendar']);
      assert.deepStrictEqual(outcomes(await run('incontext.removeObsidianPlugin', [vault])), ['vault: absent']);
    });
  });
});
