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
import { NoteComment, NotesComments } from '../NotesComments';
import { NoteEntry, NotesBacklinks } from '../NotesBacklinks';
import { NoteNode, NotesTree } from '../NotesTree';
import { CollectionNode, Collections, CollectionsTree, Step } from '../Collections';
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
    /** Runs what asks for a marker's name, and presses Enter on the name it offers. */
    const acceptingName = async (run: () => Thenable<unknown>) => {
      const done = Promise.resolve(run());
      await sleep(500);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await done;
    };

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
      // Above the marker's line, where its note leads, by file and lines
      let lenses: vscode.CodeLens[] = [];
      await waitFor('the links above the marker', async () => {
        lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', aTs()))
          .filter(lens => lens.command?.command.startsWith('incontext.'));
        return lenses.length >= 4;
      });
      // The marker's name, which opens its box, then each place its note leads, each its own click
      assert.deepStrictEqual(lenses.map(lens => [lens.range.start.line, lens.command!.title]),
        [[4, 'const line5 = 5; →'], [4, 'b.ts:L2:3'], [4, 'b.ts:L10'], [6, 'a.ts:L7']]);
      assert.deepStrictEqual(lenses.map(lens => lens.command!.command),
        ['incontext.notes.toggleBoxAt', 'incontext.openReferenceBeside', 'incontext.openReferenceBeside', 'incontext.notes.toggleBoxAt']);

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', aTs(), new vscode.Position(4, 3));
      const hoverText = hovers.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
      assert.match(hoverText, /Second line\./);
      assert.match(hoverText, /\*\*const line5 = 5;\*\*/, 'named after its line: an older note');
      // Read as its file and lines, with the whole reference on hover
      const link = /\[b\.ts:L2:3\]\(command:(incontext\.openReferenceBeside)\?([^ )]+) "@beta\/b\.ts:L2:3"\)/.exec(hoverText);
      assert.ok(link, hoverText);

      await vscode.commands.executeCommand(link[1], ...JSON.parse(decodeURIComponent(link[2])));
      await waitFor('b.ts to open beside', () => activeFile() === path.join(folder('beta'), 'b.ts'));
      assert.deepStrictEqual(selectedLines(), [2, 3]);
      assert.ok(!inOneGroup());
    });

    test('lines no marker is on, but a note refers to, show a link back above them, named after the marker', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const links = (await NotesBacklinks.read()).get(bTs.fsPath) ?? [];
      assert.deepStrictEqual(links.map(link => [link.kind, link.targetLine, link.targetEndLine, link.name, link.source.fsPath]),
        [['reference', 1, 2, 'const line5 = 5;', aTs().fsPath], ['reference', 9, 9, 'const line5 = 5;', aTs().fsPath]]);
      await vscode.window.showTextDocument(bTs);
      let lenses: vscode.CodeLens[] = [];
      await waitFor('the back-link lenses', async () => {
        lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
          .filter(lens => lens.command?.command === NotesBacklinks.GO_TO_NOTE);
        return lenses.length === 2;
      });
      assert.deepStrictEqual(lenses.map(lens => [lens.range.start.line, lens.command!.title]).sort(), [[1, '← const line5 = 5;'], [9, '← const line5 = 5;']]);
      assert.strictEqual(lenses[0].command!.tooltip, 'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10. · Second line.');
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
      const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
      assert.strictEqual(threads.get(bTs.toString())?.length ?? 0, 0, 'no box: no marker is there');
      await vscode.commands.executeCommand(lenses[0].command!.command, ...lenses[0].command!.arguments!);
      await waitFor('a.ts to open at the note', () => activeFile() === aTs().fsPath);
      assert.deepStrictEqual(selectedLines(), [5, 5]);
    });

    test('a marker\'s box shows only its own note: a link from another marker shows on that marker', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const [link] = (await NotesBacklinks.read()).get(bTs.fsPath) ?? [];
      const [note] = Notes.parse('## Step two\n<!-- L2-L3: const line2 = 2; -->\n');
      const thread = { uri: bTs, range: new vscode.Range(1, 0, 2, 16) } as vscode.CommentThread;
      const preview = new NoteComment(thread, note, [link], thread.range!).preview().value;
      assert.ok(!preview.includes('const line5') && !preview.includes('incontext.notes.goToNote'), preview);
      assert.ok(preview.startsWith('_No note yet'), preview);
    });

    test('lines with a note of their own also show a link back to each note that points at them, above its line', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      // a.ts's note points at L2:3, inside this note's lines, and at L10, which has no note
      fs.writeFileSync(bNotes, '## L1-L3: const line1 = 1;\nThe first three lines\n');
      try {
        const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
        const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
        await vscode.window.showTextDocument(bTs);
        await waitFor('the note\'s box, with the back-link it took', () => threads.get(bTs.toString())?.some(thread => {
          const comment = thread.comments[0] as NoteComment;
          return comment.note && comment.backLinks.some(link => link.targetLine === 1);
        }));
        const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
          .filter(lens => lens.command?.command === NotesBacklinks.GO_TO_NOTE);
        assert.deepStrictEqual(lenses.map(lens => [lens.range.start.line, lens.command!.title]).sort(), [[0, '← const line5 = 5;'], [9, '← const line5 = 5;']]);
      } finally {
        fs.rmSync(bNotes, { force: true });
      }
    });

    test('+ above lines a note refers to makes a marker there, whose note links back to that note, to name', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
      const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
      const asking = api.notesComments.constructor as unknown as { inputName(...args: unknown[]): Promise<string | undefined> };
      const { inputName } = asking;
      asking.inputName = async () => 'Defines it';
      const titlesAt = async (line: number) => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
        .filter(lens => lens.range.start.line === line).map(lens => lens.command?.title);
      try {
        await vscode.window.showTextDocument(bTs);
        let plus: vscode.CodeLens[] = [];
        await waitFor('a + above each line referred to', async () => {
          plus = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
            .filter(lens => lens.command?.command === NotesComments.MARK_AT);
          return plus.length === 2;
        });
        plus.sort((one, other) => one.range.start.line - other.range.start.line);
        assert.deepStrictEqual(plus.map(lens => [lens.range.start.line, lens.command!.title, lens.command!.arguments!.slice(1)]), [[1, '+', [1, 2]], [9, '+', [9, 9]]], 'over the lines referred to');
        assert.deepStrictEqual(await titlesAt(1), ['+', '← const line5 = 5;']);

        await vscode.commands.executeCommand(plus[0].command!.command, ...plus[0].command!.arguments!);
        const [made] = Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts');
        assert.deepStrictEqual([made.name, made.line, made.lines, made.text], ['Defines it', 2, 2, '[[alpha/src/a.ts#const line5 = 5;]]']);
        assert.strictEqual(Notes.parse(fs.readFileSync(aNotes, 'utf8'), 'a.ts')[0].text,
          'Defined in [[beta/b.ts#Defines it]], invoked from @beta/b.ts:L10.\nSecond line.', 'the reference is a link to it now');
        const box = threads.get(bTs.toString())![0].comments[0] as NoteComment;
        assert.strictEqual(box.mode, vscode.CommentMode.Editing, 'its box opens in Edit');
        assert.strictEqual(box.body, 'Defines it\n\n[[alpha/src/a.ts#const line5 = 5;]]\n');
        box.body = 'Defines it\n\nCaller: [[alpha/src/a.ts#const line5 = 5;]]';
        await vscode.commands.executeCommand('incontext.notes.save', box);
        await waitFor('the link back, by the name given it here', async () => JSON.stringify(await titlesAt(1)) === JSON.stringify(['Defines it →', 'Caller', '']));
      } finally {
        asking.inputName = inputName;
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
      }
    });

    test('Edit on a marker that notes refer to offers a link back to each, and saving makes those references links', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      fs.writeFileSync(bNotes, '## Step two\n<!-- L2-L3: const line2 = 2; -->\nIts note\n');
      try {
        const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
        const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
        await vscode.window.showTextDocument(bTs);
        await waitFor('its box, with the reference into its lines', () => threads.get(bTs.toString())?.some(thread =>
          (thread.comments[0] as NoteComment).backLinks.some(link => link.kind === 'reference')));
        const box = () => threads.get(bTs.toString())![0].comments[0] as NoteComment;
        await vscode.commands.executeCommand('incontext.notes.editAt', bTs.toString(), 1);
        assert.strictEqual(box().body, 'Step two\n\nIts note\n\n[[alpha/src/a.ts#const line5 = 5;]]\n');
        await vscode.commands.executeCommand('incontext.notes.cancelEdit', box());
        assert.strictEqual(fs.readFileSync(aNotes, 'utf8'), notesText, 'Esc writes nothing');

        await vscode.commands.executeCommand('incontext.notes.editAt', bTs.toString(), 1);
        box().body = 'Step two\n\nIts note\n\nInput: [[alpha/src/a.ts#const line5 = 5;]]';
        await vscode.commands.executeCommand('incontext.notes.save', box());
        assert.strictEqual(Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts')[0].text, 'Its note\n\nInput: [[alpha/src/a.ts#const line5 = 5;]]');
        assert.strictEqual(Notes.parse(fs.readFileSync(aNotes, 'utf8'), 'a.ts')[0].text, 'Defined in [[beta/b.ts#Step two]], invoked from @beta/b.ts:L10.\nSecond line.');
        await waitFor('the link back, by its name here', async () => JSON.stringify((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
          .filter(lens => lens.range.start.line === 1).map(lens => lens.command?.title)) === JSON.stringify(['Step two →', 'Input', '']));
      } finally {
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
      }
    });

    test('Move to selection on a marker points the references to exactly its lines at its new lines', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const notesFile = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      fs.writeFileSync(bNotes, '## Step two\n<!-- L2-L3: const line2 = 2; -->\n');
      const editor = await vscode.window.showTextDocument(bTs);
      editor.selection = new vscode.Selection(4, 0, 7, 0);
      try {
        // Its box, once it has the reference into its lines (the notes a test before left can take a moment to read again)
        const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
        const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
        await waitFor('its box, with the reference into its lines', () => threads.get(bTs.toString())?.some(thread =>
          (thread.comments[0] as NoteComment).backLinks.some(link => link.kind === 'reference' && link.targetLine === 1)));
        await waitFor('the reference to move', async () => {
          await vscode.commands.executeCommand('incontext.notes.moveAt', bTs.toString(), 1);
          return Notes.parse(fs.readFileSync(notesFile, 'utf8'))[0].text.includes('@beta/b.ts:L5:7');
        });
        assert.strictEqual(Notes.parse(fs.readFileSync(notesFile, 'utf8'))[0].text, 'Defined in @beta/b.ts:L5:7, invoked from @beta/b.ts:L10.\nSecond line.');
        assert.strictEqual(fs.readFileSync(bNotes, 'utf8'), '## Step two\n<!-- L5-L7: const line5 = 5; -->\n', 'the marker keeps its name');
      } finally {
        fs.writeFileSync(notesFile, notesText);
        fs.rmSync(bNotes, { force: true });
      }
    });

    test('a new marker gets a name, from its line unless given; a reference to a marker\'s lines is saved as a link to it', async () => {
      assert.strictEqual(Notes.fallbackName('  const total = order.items.reduce((sum, item) => sum + item.price, 0);', 'a.ts', 30),
        'const total = order.items.reduce((sum, item) => sum +…');
      assert.strictEqual(Notes.fallbackName('  });', 'a.ts', 30), 'a.ts:L30', 'a line with little to read');
      assert.strictEqual(Notes.fallbackName('if (a[0] || b#c) {', 'a.ts', 30), 'if (a 0 b c) {', 'without what would end a link');
      assert.strictEqual(Notes.uniqueName('Step', ['Step', 'Step 2']), 'Step 3');
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const notesFile = path.join(notesFolder(), 'beta', 'b.ts.md');
      const document = await vscode.workspace.openTextDocument(bTs);
      try {
        // Lines no note refers to (a.ts's note refers to L2:3 and L10)
        await vscode.commands.executeCommand('incontext.notes.createMarker', bTs.toString(), 5, 6, 'Second step');
        assert.strictEqual(fs.readFileSync(notesFile, 'utf8'), '# Notes on @beta/b.ts\n\n## Second step\n<!-- L6-L7: const line6 = 6; -->\n');
        const [note] = Notes.parse(fs.readFileSync(notesFile, 'utf8'), 'b.ts');
        assert.deepStrictEqual([note.name, note.named, note.line, note.lines, note.text], ['Second step', true, 6, 2, '']);

        // Its note refers to a.ts's marker's line, and to a line no marker is on
        const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
        const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
        await waitFor('its box', () => threads.get(document.uri.toString())?.length === 1);
        const box = threads.get(document.uri.toString())![0].comments[0] as NoteComment;
        assert.strictEqual(box.thread.label, 'Second step');
        box.body = 'Next stop @alpha/src/a.ts:L5, then @alpha/src/a.ts:L20';
        await vscode.commands.executeCommand('incontext.notes.save', box);
        const [saved] = Notes.parse(fs.readFileSync(notesFile, 'utf8'), 'b.ts');
        assert.strictEqual(saved.text, 'Next stop [[alpha/src/a.ts#const line5 = 5;]], then @alpha/src/a.ts:L20');
        assert.deepStrictEqual(saved.links.map(link => [link.path, link.name]), [['alpha/src/a.ts', 'const line5 = 5;']]);
        // The marker it links to links back, in its own note: a link like any other, at the note's end
        const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
        const linkedBack = () => Notes.parse(fs.readFileSync(aNotes, 'utf8'), 'a.ts')[0];
        assert.strictEqual(linkedBack().text, 'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\nSecond line.\n\n[[beta/b.ts#Second step]]');
        assert.ok(fs.readFileSync(aNotes, 'utf8').includes('## const line5 = 5;\n<!-- L5: const line5 = 5; -->\n'), 'an older note gets its name written');
        await vscode.window.showTextDocument(aTs());
        await waitFor('the link back above a.ts\'s marker', async () => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', aTs()))
          .some(lens => lens.range.start.line === 4 && lens.command!.title === 'Second step'));

        // Taken out of a.ts's note, the link goes one way: saving b.ts's note again doesn't put it back
        fs.writeFileSync(aNotes, notesText);
        box.body = saved.text;
        await vscode.commands.executeCommand('incontext.notes.save', box);
        assert.strictEqual(fs.readFileSync(aNotes, 'utf8'), notesText);
        assert.strictEqual(Notes.withLink('See [[#A]]', '[[#B]]'), 'See [[#A]]\n\n[[#B]]');
        assert.strictEqual(Notes.withLink('Text\n\n[[#A]]\n', '[[#B]]'), 'Text\n\n[[#A]]\n[[#B]]', 'one link to a line under links');
        assert.strictEqual(Notes.withLink('', '[[#B]]'), '[[#B]]');
      } finally {
        fs.rmSync(notesFile, { force: true });
        fs.writeFileSync(path.join(notesFolder(), 'alpha', 'src', 'a.ts.md'), notesText);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });

    test('a link to a marker shows by its name on the marker whose note has it, goes to the marker, and is renamed with it', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      fs.writeFileSync(bNotes, '## Step two\n<!-- L2-L3: const line2 = 2; -->\nBack to [[alpha/src/a.ts#const line5 = 5;]] and [[#Step two]]\n');
      try {
        // Its note: the link by the marker's name; a link to its own marker is no link back
        const [note] = Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts');
        const rendered = NotesProvider.linkReferences(note.text, bTs);
        const link = /\[const line5 = 5;\]\(command:(incontext\.notes\.goToMarker)\?([^ )]+) "a\.ts"\)/.exec(rendered);
        assert.ok(link, rendered);
        const back = ((await NotesBacklinks.read()).get(aTs().fsPath) ?? []).filter(candidate => candidate.kind === 'marker');
        assert.deepStrictEqual(back.map(candidate => [candidate.name, candidate.targetName]), [['Step two', 'const line5 = 5;']]);
        assert.ok(!((await NotesBacklinks.read()).get(bTs.fsPath) ?? []).some(candidate => candidate.kind === 'marker'));

        // Above b.ts's marker, → the marker it links to; above a.ts's, only what a.ts's own note says
        await vscode.window.showTextDocument(bTs);
        await waitFor('the link on above b.ts\'s marker', async () => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
          .some(lens => lens.range.start.line === 1 && lens.command!.title === 'const line5 = 5;'));
        await vscode.window.showTextDocument(aTs());
        let lenses: string[] = [];
        await waitFor('only a.ts\'s own links above its marker', async () => {
          lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', aTs()))
            .filter(lens => lens.range.start.line === 4).map(lens => lens.command!.title);
          return JSON.stringify(lenses) === JSON.stringify(['const line5 = 5; →', 'b.ts:L2:3', 'b.ts:L10', '']);
        });

        // Followed: a.ts at the marker's lines, beside
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.window.showTextDocument(bTs);
        await vscode.commands.executeCommand(link[1], ...JSON.parse(decodeURIComponent(link[2])));
        await waitFor('a.ts to open at the marker', () => activeFile() === aTs().fsPath);
        assert.deepStrictEqual(selectedLines(), [5, 5]);
        assert.ok(!inOneGroup(), 'beside');
        // With a split already showing the marker, there, also to the left: no new split
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.window.showTextDocument(aTs(), { viewColumn: vscode.ViewColumn.One });
        await vscode.window.showTextDocument(bTs, { viewColumn: vscode.ViewColumn.Two });
        await vscode.commands.executeCommand(link[1], ...JSON.parse(decodeURIComponent(link[2])));
        const changes: string[] = []; const sub = vscode.window.onDidChangeActiveTextEditor(e => changes.push(`${e?.document.uri.fsPath.split('/').pop()}@${e?.viewColumn}@${Date.now() % 100000}`));
        // Focus follows only while the window is in front, so the left split's selection says where it went
        await waitFor('the marker selected in the left split', () => vscode.window.visibleTextEditors
          .find(editor => editor.viewColumn === vscode.ViewColumn.One)?.selection.start.line === 4);
        assert.strictEqual(vscode.window.tabGroups.all.length, 2);

        // Renaming a marker renames the links to it, and only those
        const renamed = Notes.withLinksRenamed(fs.readFileSync(bNotes, 'utf8'), bTs, aTs(), 'const line5 = 5;', 'Totals');
        assert.ok(renamed.includes('Back to [[alpha/src/a.ts#Totals]] and [[#Step two]]'), renamed);
        assert.strictEqual(Notes.withLinksRenamed(renamed, bTs, bTs, 'const line5 = 5;', 'Other'), renamed, 'a marker of that name elsewhere');
      } finally {
        fs.rmSync(bNotes, { force: true });
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });

    test('Esc at a new marker\'s name makes no marker; [[ in it links the new marker to one picked, which starts its name', async () => {
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      await vscode.workspace.openTextDocument(bTs);
      let disposed = false;
      // A note whose first line can't be a name (it has a reference), so the name is asked for
      const reply = { thread: { uri: bTs, range: new vscode.Range(1, 0, 1, 0), dispose: () => { disposed = true; } }, text: 'See @alpha/src/a.ts:L20' };
      const made = Promise.resolve(vscode.commands.executeCommand('incontext.notes.create', reply));
      await sleep(500);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await made;
      assert.ok(!fs.existsSync(bNotes), 'no marker');
      assert.ok(!disposed, 'the note typed stays in its box');

      // The name box and the list, stood in for: typing into them isn't possible from here
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
      type Asking = {
        inputName(title: string, value: string, selection: [number, number], offered: string, taken: string[], note: string[]): Promise<string | undefined>;
        pickMarker(typed: string): Promise<NoteEntry | undefined>;
      };
      const asking = api.notesComments.constructor as unknown as Asking;
      const { inputName, pickMarker } = asking;
      const asked: [string, [number, number]][] = [];
      let picked = '';
      asking.inputName = async (_title, value, selection) => {
        asked.push([value, selection]);
        return asked.length === 1 ? `${value}[[const` : value;
      };
      asking.pickMarker = async typed => {
        picked = typed;
        return (await NotesBacklinks.readNotes()).find(entry => entry.note.name === 'const line5 = 5;');
      };
      try {
        const editor = await vscode.window.showTextDocument(bTs);
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        await vscode.commands.executeCommand('incontext.addNote');
        const name = 'const line5 = 5; -> const line2 = 2;';
        assert.strictEqual(picked, 'const', 'what was typed after [[ narrows the list');
        assert.deepStrictEqual(asked[1], [name, ['const line5 = 5; -> '.length, name.length]], 'the rest of the name selected to type over');
        const [marker] = Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts');
        assert.deepStrictEqual([marker.name, marker.text], [name, '[[alpha/src/a.ts#const line5 = 5;]]']);
        assert.strictEqual(Notes.parse(fs.readFileSync(aNotes, 'utf8'))[0].text, `Defined in [[beta/b.ts#${name}]], invoked from @beta/b.ts:L10.\nSecond line.`,
          'it links back: its reference to these lines is a link to the new marker');
        await waitFor('the links above the new marker', async () => JSON.stringify((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
          .filter(lens => lens.range.start.line === 1).map(lens => lens.command?.title)) === JSON.stringify([`${name} →`, 'const line5 = 5;', '']));
        assert.strictEqual(NotesComments.label(name), 'const line5 = 5; → const line2 = 2;', 'VS Code would show > as &gt; in the box\'s header');
        assert.strictEqual(NotesComments.label('a < b && c'), 'a ＜ b ＆＆ c');

        // A reference pasted into the name goes into the note, and the name, left blank, is the one offered
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
        asking.inputName = async (_title, _value, _selection, _offered, _taken, note) => {
          note.push('@alpha/src/a.ts:L20');
          return '';
        };
        editor.selection = new vscode.Selection(3, 0, 3, 0);
        await vscode.commands.executeCommand('incontext.addNote');
        const [referring] = Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts');
        assert.deepStrictEqual([referring.name, referring.text], ['const line4 = 4;', '@alpha/src/a.ts:L20']);
        assert.deepStrictEqual(NotesComments.takeReferences('Totals @alpha/src/a.ts:L20 kept'), { name: 'Totals kept', references: ['@alpha/src/a.ts:L20'] });
        assert.deepStrictEqual(NotesComments.takeReferences('@alpha/src/a.ts:L5'), { name: '', references: ['@alpha/src/a.ts:L5'] });
        assert.deepStrictEqual(NotesComments.takeReferences('Mail me@example'), { name: 'Mail me@example', references: [] });
      } finally {
        asking.inputName = inputName;
        asking.pickMarker = pickMarker;
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });

    test('a note can name a reference or link its own way, which shows above its marker; nothing is renamed', async () => {
      const labelled = 'Caller: @alpha/src/a.ts:L20\n- See [[#B]]\n- Two words : [[#A]]\nUses [[#C|the third]] here';
      const at = (part: string) => [labelled.indexOf(part), labelled.indexOf(part) + part.length] as const;
      assert.strictEqual(Notes.labelAt(labelled, ...at('@alpha/src/a.ts:L20')), 'Caller');
      assert.strictEqual(Notes.labelAt(labelled, ...at('[[#B]]')), undefined, 'not a label: no colon');
      assert.strictEqual(Notes.labelAt(labelled, ...at('[[#A]]')), 'Two words');
      assert.strictEqual(Notes.labelAt(labelled, ...at('[[#C|the third]]')), 'the third', 'a link\'s own text');
      assert.strictEqual(Notes.labelAt('Caller: @alpha/src/a.ts:L20 and more', 8, 27), undefined, 'only with nothing after it');
      assert.ok(NotesProvider.linkReferences('[[#C|the third]]', aTs()).startsWith('[the third](command:incontext.notes.goToMarker?'));

      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const document = await vscode.workspace.openTextDocument(bTs);
      try {
        await vscode.commands.executeCommand('incontext.notes.createMarker', bTs.toString(), 1, 1, 'Step');
        const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
        const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
        await waitFor('its box', () => threads.get(document.uri.toString())?.length === 1);
        const box = threads.get(document.uri.toString())![0].comments[0] as NoteComment;
        box.body = 'Step\n\nThen\n- Totals: @alpha/src/a.ts:L20\n- Five: @alpha/src/a.ts:L5';
        await vscode.commands.executeCommand('incontext.notes.save', box);
        assert.strictEqual(Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts')[0].text,
          'Then\n- Totals: @alpha/src/a.ts:L20\n- Five: [[alpha/src/a.ts#const line5 = 5;]]', 'the name stays with the link it became');
        assert.deepStrictEqual(Notes.parse(fs.readFileSync(aNotes, 'utf8'), 'a.ts').map(marker => marker.name), ['const line5 = 5;', 'a.ts:L7'], 'no marker made or renamed');
        await waitFor('the names above the marker', async () => JSON.stringify((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', bTs))
          .filter(lens => lens.range.start.line === 1).map(lens => lens.command?.title)) === JSON.stringify(['Step →', 'Totals', 'Five', '']));
        const tree = new NotesTree(() => NotesBacklinks.readNotes());
        const entry = (await NotesBacklinks.readNotes()).find(candidate => candidate.note.name === 'Step')!;
        const step: NoteNode = { kind: 'note', entry };
        assert.deepStrictEqual((await tree.getChildren(step)).map(node => [tree.getTreeItem(node).label, tree.getTreeItem(node).description]),
          [['Totals', 'alpha/src/a.ts:L20'], ['Five', 'const line5 = 5; · a.ts:L5']], 'and in the Markers view');
      } finally {
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
      }
    });

    test('a collection is a Markdown list of links to markers: numbered by place, each step named and noted there only', () => {
      const text = '# Checkout flow\n\nIntro line.\n\n1. [[alpha/src/a.ts#const line5 = 5;]]\n2. Persist: [[beta/b.ts#Step two]]\n   Only on the retry path.\n- [[#Nowhere|Elsewhere]]\n';
      const collection = Collections.parse(text, vscode.Uri.file('/notes/alpha/_collections/Checkout flow.md'));
      assert.strictEqual(collection.name, 'Checkout flow');
      assert.deepStrictEqual(collection.steps.map(step => [step.link.name, step.label, step.note]),
        [['const line5 = 5;', undefined, ''], ['Step two', 'Persist', 'Only on the retry path.'], ['Nowhere', 'Elsewhere', '']]);
      assert.strictEqual(Collections.format(collection), text, 'written back as it was');
      const [first, second, third] = collection.steps;
      collection.steps = [second, first, third];
      assert.strictEqual(Collections.format(collection),
        '# Checkout flow\n\nIntro line.\n\n1. Persist: [[beta/b.ts#Step two]]\n   Only on the retry path.\n2. [[alpha/src/a.ts#const line5 = 5;]]\n- [[#Nowhere|Elsewhere]]\n',
        'numbered again by place, its note going with it');
      assert.strictEqual(Collections.named(first, 'Totals').block[0], '1. Totals: [[alpha/src/a.ts#const line5 = 5;]]');
      assert.deepStrictEqual(Collections.named(second, '').block, ['2. [[beta/b.ts#Step two]]', '   Only on the retry path.'], 'its own name again');
      const said = Collections.parse('1. See [[#A]] first', vscode.Uri.file('/c.md')).steps[0];
      assert.strictEqual(Collections.named(said, 'Start').block[0], '1. See [[#A|Start]] first', 'a line that says more keeps it');
      assert.strictEqual(Collections.parse('# Empty\n\nNo steps, a [[#Link]] in a paragraph\n', vscode.Uri.file('/c.md')).steps.length, 0);
    });

    test('a step can have steps within it: indented under it, numbered within it, and moved, nested and removed with it', () => {
      const file = vscode.Uri.file('/notes/alpha/_collections/Image upload.md');
      const text = '# Image upload\n\n1. [[alpha/src/a.ts#Entry]]\n2. Picker: [[alpha/src/a.ts#Picker]]\n    - Drag: [[alpha/src/a.ts#Drag]]\n      Onto the note.\n    - Paste: [[alpha/src/a.ts#Paste]]\n3. [[alpha/src/a.ts#Insert]]\n';
      const collection = Collections.parse(text, file);
      assert.deepStrictEqual(collection.steps.map(step => [step.link.name, step.depth, step.note]),
        [['Entry', 0, ''], ['Picker', 0, ''], ['Drag', 1, 'Onto the note.'], ['Paste', 1, ''], ['Insert', 0, '']]);
      assert.deepStrictEqual(Collections.numbers(collection.steps), ['1', '2', '2.1', '2.2', '3']);
      assert.strictEqual(Collections.format(collection), text, 'written back as it was');
      assert.deepStrictEqual(Collections.parse('1. [[#A]]\n  - [[#B]]\n     1. [[#C]]\n2. [[#D]]', file).steps.map(step => step.depth), [0, 1, 2, 0], 'indented by hand any way');

      const steps = collection.steps;
      const names = (changed: Step[]) => changed.map(step => `${step.depth}${step.link.name}`).join(' ');
      assert.strictEqual(names(Collections.moved(steps, [1], 4)), '0Entry 0Insert 0Picker 1Drag 1Paste', 'onto a step below: after it, with the steps within it');
      assert.strictEqual(names(Collections.moved(steps, [3], 1)), '0Entry 0Paste 0Picker 1Drag 0Insert', 'onto a step above: before it, at its depth');
      assert.strictEqual(Collections.moved(steps, [1], 2), steps, 'not onto a step within itself');
      assert.strictEqual(names(Collections.swapped(steps, 3, -1)), '0Entry 0Picker 1Paste 1Drag 0Insert');
      assert.strictEqual(names(Collections.swapped(steps, 1, 1)), '0Entry 0Insert 0Picker 1Drag 1Paste');
      assert.strictEqual(Collections.swapped(steps, 2, -1), steps, 'the first within its step stays first');
      assert.strictEqual(names(Collections.indented(steps, 4, 1)), '0Entry 0Picker 1Drag 1Paste 1Insert', 'Move In: within the step before it');
      assert.strictEqual(names(Collections.indented(steps, 2, -1)), '0Entry 0Picker 0Drag 1Paste 0Insert', 'Move Out');
      assert.strictEqual(Collections.indented(steps, 0, 1), steps);
      assert.strictEqual(names(Collections.without(steps, [1])), '0Entry 0Drag 0Paste 0Insert', 'removed, the steps within it stay');

      assert.strictEqual(CollectionsTree.stepName('Next, the upload call'), 'The upload call');
      assert.strictEqual(CollectionsTree.stepName('then: insert it'), 'Insert it');
      assert.strictEqual(CollectionsTree.stepName('Caller'), 'Caller');
      assert.strictEqual(CollectionsTree.stepName('Next'), undefined);
      assert.strictEqual(Notes.withoutLink('Does it.\n\nNext, the API: [[#API]]\n- [[#Other]]\nSee [[#API]] too', '[[#API]]'), 'Does it.\n\n- [[#Other]]\nSee too');
      assert.strictEqual(Notes.withoutLink('Text\n\n[[#B]]', '[[#B]]', false), 'Text');
      assert.strictEqual(Notes.withoutLink('Text\n\nCaller: [[#B]]', '[[#B]]', false), 'Text\n\nCaller: [[#B]]', 'a link back named in the note stays');
    });

    test('a chain of markers made a collection, its links taken out; going through it shows each marker\'s place above it', async () => {
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { collectionsTree: CollectionsTree };
      const tree = api.collectionsTree;
      const collections = path.join(notesFolder(), 'alpha', '_collections');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      // a.ts's marker refers to both of b.ts's: two ways on. The first goes on to a.ts's other marker, and links back
      fs.writeFileSync(bNotes, '## Step two\n<!-- L2-L3: const line2 = 2; -->\nNext, the end: [[alpha/src/a.ts#a.ts:L7]]\n[[alpha/src/a.ts#const line5 = 5;]]\n\n## Ten\n<!-- L10: const line10 = 10; -->\n');
      const titlesAt = async (uri: vscode.Uri, line: number) => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri))
        .filter(lens => lens.range.start.line === line).map(lens => lens.command?.title);
      try {
        const entry = (await NotesBacklinks.readNotes()).find(candidate => candidate.note.name === 'const line5 = 5;')!;
        await vscode.window.showTextDocument(aTs());
        await vscode.commands.executeCommand('incontext.collections.fromChain', { kind: 'note', entry } as NoteNode, 'Five flow', true);
        const file = path.join(collections, 'Five flow.md');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '# Five flow\n\n1. [[alpha/src/a.ts#const line5 = 5;]]\n    1. [[beta/b.ts#Step two]]\n        1. The end: [[alpha/src/a.ts#a.ts:L7]]\n    2. [[beta/b.ts#Ten]]\n',
          'two ways on, each within the marker; a way on its own goes within its first step; the name the note gave the link, without its Next');
        assert.deepStrictEqual(Notes.parse(fs.readFileSync(bNotes, 'utf8'), 'b.ts').map(marker => marker.text), ['', ''], 'the link on, and the link back, taken out');
        assert.strictEqual(fs.readFileSync(aNotes, 'utf8'), notesText, 'references are part of what a note says: they stay');

        const [collection] = (await tree.getChildren()).filter(node => node.collection.name === 'Five flow');
        const [five] = await tree.getChildren(collection);
        const ways = await tree.getChildren(five);
        assert.deepStrictEqual(ways.map(node => tree.getTreeItem(node).label), ['1.1 Step two', '1.2 Ten']);
        const [end] = await tree.getChildren(ways[0]);
        assert.strictEqual(tree.getTreeItem(end).label, '1.1.1 The end');
        assert.deepStrictEqual(tree.getParent(end), { kind: 'step', collection: collection.collection, index: 1 });

        // Going through it: each of its markers shows its place, with the steps before and after
        await vscode.commands.executeCommand('incontext.collections.next', file);
        await waitFor('the place above a.ts\'s marker', async () => JSON.stringify(await titlesAt(aTs(), 4)) === JSON.stringify(['const line5 = 5; →', 'b.ts:L2:3', 'b.ts:L10', 'Five flow 1/4', '›']));
        const next = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', aTs())).find(lens => lens.command?.title === '›')!;
        await vscode.commands.executeCommand(next.command!.command, ...next.command!.arguments!);
        await waitFor('step 2, b.ts\'s marker', () => activeFile() === bTs.fsPath);
        await waitFor('its place', async () => JSON.stringify(await titlesAt(bTs, 1)) === JSON.stringify(['Step two', '← const line5 = 5;', '‹', 'Five flow 2/4', '›']));
        await vscode.commands.executeCommand('incontext.collections.stop');
        await waitFor('no place once stopped', async () => JSON.stringify(await titlesAt(bTs, 1)) === JSON.stringify(['Step two', '← const line5 = 5;', '']));

        await vscode.commands.executeCommand('incontext.collections.moveOut', end);
        assert.ok(fs.readFileSync(file, 'utf8').includes('\n    2. The end: [[alpha/src/a.ts#a.ts:L7]]\n    3. [[beta/b.ts#Ten]]'), 'Move Out: beside the step it was in');
      } finally {
        await vscode.commands.executeCommand('incontext.collections.stop');
        fs.rmSync(collections, { recursive: true, force: true });
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
      }
    });

    test('collections: markers added and dropped in, ordered, named, followed step by step, and renamed with their marker', async () => {
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { collectionsTree: CollectionsTree };
      const tree = api.collectionsTree;
      const folder = path.join(notesFolder(), 'alpha', '_collections');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      const fileText = () => fs.readFileSync(path.join(folder, 'Checkout flow.md'), 'utf8');
      const collectionNode = async () => (await tree.getChildren()).find(node => node.collection.name === 'Checkout flow')!;
      const steps = async () => tree.getChildren(await collectionNode());
      const rows = async () => (await steps()).map(node => [tree.getTreeItem(node).label, tree.getTreeItem(node).description]);
      const link = (name: string) => `[[alpha/src/a.ts#${name}]]`;
      const tooling = tree as unknown as { pickCollection(...args: unknown[]): Promise<unknown> };
      // As VS Code passes a drop: an empty item of each type the drag declared, then the drag's own
      const asDropped = (dragged: vscode.DataTransfer) => {
        const items: [string, vscode.DataTransferItem][] = [];
        dragged.forEach((item, mime) => items.push([mime, new vscode.DataTransferItem('')], [mime, item]));
        return new (vscode.DataTransfer as unknown as new (init: [string, vscode.DataTransferItem][]) => vscode.DataTransfer)(items);
      };
      const { pickCollection } = tooling;
      try {
        await vscode.window.showTextDocument(aTs());
        await vscode.commands.executeCommand('incontext.collections.new', 'Checkout flow');
        assert.strictEqual(fileText(), '# Checkout flow\n', 'in the notes folder of the project the editor is in');
        await vscode.commands.executeCommand('incontext.collections.addMarker', { source: aTs().toString(), name: 'const line5 = 5;' }, path.join(folder, 'Checkout flow.md'));
        // From a marker's box: the collection is picked
        tooling.pickCollection = async () => (await collectionNode()).collection;
        await vscode.commands.executeCommand(CollectionsTree.ADD_AT, aTs().toString(), 6);
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('const line5 = 5;')}\n2. ${link('a.ts:L7')}\n`);
        assert.ok(!(await NotesBacklinks.readNotes()).some(entry => entry.notesFile.fsPath.startsWith(folder)), 'a collection is no notes file');
        assert.deepStrictEqual(await rows(), [['1. const line5 = 5;', 'a.ts:L5'], ['2. a.ts:L7', 'a.ts:L7']]);

        // A step dragged onto step 1 becomes step 1
        let dragged = new vscode.DataTransfer();
        tree.handleDrag([(await steps())[1]], dragged);
        assert.strictEqual(await asDropped(dragged).get(CollectionsTree.STEP_MIME)!.asString(), '', 'the empty item first, as in VS Code');
        await tree.handleDrop((await steps())[0], asDropped(dragged));
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. ${link('const line5 = 5;')}\n`);
        // A marker dragged from the Markers view onto the collection is its last step, a marker in it already too
        const markers = new NotesTree(() => NotesBacklinks.readNotes());
        const entry = (await NotesBacklinks.readNotes()).find(candidate => candidate.note.name === 'a.ts:L7')!;
        dragged = new vscode.DataTransfer();
        markers.handleDrag([{ kind: 'note', entry } as NoteNode], dragged);
        await tree.handleDrop(await collectionNode(), asDropped(dragged));
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. ${link('const line5 = 5;')}\n3. ${link('a.ts:L7')}\n`);
        await vscode.commands.executeCommand('incontext.collections.remove', (await steps())[2]);
        await vscode.commands.executeCommand('incontext.collections.moveDown', (await steps())[0]);
        await vscode.commands.executeCommand('incontext.collections.moveUp', (await steps())[1]);
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. ${link('const line5 = 5;')}\n`);

        // Several at once: markers selected in the Markers view, each once, and steps selected here
        const five = (await NotesBacklinks.readNotes()).find(candidate => candidate.note.name === 'const line5 = 5;')!;
        const rowsOf: NoteNode[] = [{ kind: 'note', entry: five }, { kind: 'note', entry }, { kind: 'note', entry: five, leaf: true }];
        await vscode.commands.executeCommand('incontext.collections.addMarker', rowsOf[1], rowsOf);
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. ${link('const line5 = 5;')}\n3. ${link('const line5 = 5;')}\n4. ${link('a.ts:L7')}\n`);
        dragged = new vscode.DataTransfer();
        markers.handleDrag(rowsOf, dragged);
        await tree.handleDrop((await steps())[0], asDropped(dragged));
        assert.ok(fileText().startsWith(`# Checkout flow\n\n1. ${link('const line5 = 5;')}\n2. ${link('a.ts:L7')}\n3. ${link('a.ts:L7')}\n`), 'dropped onto step 1, in order');
        const all = await steps();
        await vscode.commands.executeCommand('incontext.collections.remove', all[0], all.slice(0, 2).concat(all.slice(3)));
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n`, 'the steps selected removed');
        await vscode.commands.executeCommand('incontext.collections.addMarkers', await collectionNode(), [{ source: aTs().toString(), name: 'const line5 = 5;' }]);
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. ${link('const line5 = 5;')}\n`);

        // Named in the collection only
        await vscode.commands.executeCommand('incontext.collections.nameStep', (await steps())[1], 'Totals');
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. Totals: ${link('const line5 = 5;')}\n`);
        assert.deepStrictEqual((await rows())[1], ['2. Totals', 'const line5 = 5; · a.ts:L5']);
        assert.strictEqual(fs.readFileSync(aNotes, 'utf8'), notesText, 'the marker is as it was');

        // Step by step
        const file = path.join(folder, 'Checkout flow.md');
        await vscode.commands.executeCommand('incontext.collections.next', file);
        await waitFor('step 1\'s marker to open', () => activeFile() === aTs().fsPath && selectedLines()?.join() === '7,7');
        await vscode.commands.executeCommand('incontext.collections.next', file);
        assert.deepStrictEqual(selectedLines(), [5, 5]);
        await vscode.commands.executeCommand('incontext.collections.next', file);
        assert.deepStrictEqual(selectedLines(), [5, 5], 'the last step stays');
        await vscode.commands.executeCommand('incontext.collections.previous');
        assert.deepStrictEqual(selectedLines(), [7, 7]);

        // A marker renamed is renamed in its collections, which keep their own name for it
        const threads = (api as unknown as { notesComments: { threads: Map<string, vscode.CommentThread[]> } }).notesComments.threads;
        await waitFor('a.ts\'s boxes', () => threads.get(aTs().toString())?.length === 2);
        await vscode.commands.executeCommand('incontext.notes.editAt', aTs().toString(), 4);
        const box = threads.get(aTs().toString())![0].comments[0] as NoteComment;
        box.body = 'Adds it up\n\nDefined in @beta/b.ts:L2:3.';
        await vscode.commands.executeCommand('incontext.notes.save', box);
        assert.strictEqual(fileText(), `# Checkout flow\n\n1. ${link('a.ts:L7')}\n2. Totals: ${link('Adds it up')}\n`);

        await vscode.commands.executeCommand('incontext.collections.rename', await collectionNode(), 'Refund flow');
        assert.ok(!fs.existsSync(file));
        assert.ok(fs.readFileSync(path.join(folder, 'Refund flow.md'), 'utf8').startsWith('# Refund flow\n\n1. '));
        const [renamed] = await tree.getChildren();
        assert.deepStrictEqual([renamed.collection.name, tree.getTreeItem(renamed).description], ['Refund flow', '2 steps']);
        const missing: CollectionNode = { kind: 'step', collection: renamed.collection, index: 0 };
        assert.strictEqual(tree.getTreeItem(missing).description, 'no marker by this name', 'a step with no marker says so');
      } finally {
        tooling.pickCollection = pickCollection;
        fs.rmSync(folder, { recursive: true, force: true });
        fs.writeFileSync(aNotes, notesText);
        // The marker by its own name again before the next test: the notes put back a moment after the extension wrote
        // them may read as unchanged
        const comments = (api as unknown as { notesComments: { redraw(document: vscode.TextDocument): Promise<void> } }).notesComments;
        await comments.redraw(await vscode.workspace.openTextDocument(aTs()));
      }
    });

    test('Edit shows the name on the first line: changing it renames the marker and the links to it', async () => {
      assert.deepStrictEqual(NotesComments.nameAndNote('Totals\n\nAdds it up'), { name: 'Totals', note: 'Adds it up' });
      assert.deepStrictEqual(NotesComments.nameAndNote('\nAdds it up'), { note: 'Adds it up' }, 'a blank first line names nothing');
      assert.deepStrictEqual(NotesComments.nameAndNote('See @alpha/src/a.ts:L20\nmore'), { note: 'See @alpha/src/a.ts:L20\nmore' }, 'nor one with a reference');
      assert.deepStrictEqual(NotesComments.nameAndNote('[[#Other]]'), { note: '[[#Other]]' }, 'nor one with a link');
      const bTs = vscode.Uri.file(path.join(folder('beta'), 'b.ts'));
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      const aNotes = path.join(notesFolder(), 'alpha', 'src', 'a.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      fs.writeFileSync(bNotes, '## Step two\n<!-- L2-L3: const line2 = 2; -->\nBack to [[alpha/src/a.ts#const line5 = 5;]]\n');
      try {
        const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
        const threads = (api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]> }).threads;
        await vscode.workspace.openTextDocument(aTs());
        // As the notes are now: a test before may have left them changed a moment ago
        await waitFor('a.ts\'s boxes', () => threads.get(aTs().toString())?.length === 2
          && (threads.get(aTs().toString())![0].comments[0] as NoteComment).note.text === 'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\nSecond line.');
        const box = threads.get(aTs().toString())![0].comments[0] as NoteComment;
        await vscode.commands.executeCommand('incontext.notes.editAt', aTs().toString(), 4);
        assert.strictEqual(box.body, 'const line5 = 5;\n\nDefined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\nSecond line.\n');
        box.body = 'Totals\n\nDefined in @beta/b.ts:L2:3.';
        await vscode.commands.executeCommand('incontext.notes.save', box);
        const [renamed] = Notes.parse(fs.readFileSync(aNotes, 'utf8'), 'a.ts');
        assert.deepStrictEqual([renamed.name, renamed.line, renamed.text], ['Totals', 5, 'Defined in [[beta/b.ts#Step two]].']);
        assert.ok(fs.readFileSync(bNotes, 'utf8').includes('Back to [[alpha/src/a.ts#Totals]]'), 'the link to it renamed');
      } finally {
        fs.rmSync(bNotes, { force: true });
        fs.writeFileSync(aNotes, notesText);
      }
    });

    test('Cmd+Enter and Esc in a note box are its own, saving or cancelling the edit; Esc in the editor closes its boxes', () => {
      const bindings = (vscode.extensions.getExtension('managea.incontext')!.packageJSON as { contributes: { keybindings: { command: string; when: string }[] } }).contributes.keybindings;
      for (const command of ['incontext.notes.submitFocused', 'incontext.notes.cancelFocused']) {
        // VS Code sets `commentController` in a box only from a proposed API, so the box's own context says it is a note's
        assert.strictEqual(bindings.find(binding => binding.command === command)?.when, 'commentEditorFocused && commentThread == incontext.note');
      }
      // Esc anywhere in the editor closes its open boxes, when Esc has nothing else to do there
      const escape = bindings.find(binding => binding.command === 'incontext.notes.closeInEditor')?.when ?? '';
      for (const clause of ['editorTextFocus', 'incontext.notes.openInEditor', '!editorHasSelection', '!findWidgetVisible', '!suggestWidgetVisible', '!inSnippetMode', '!commentEditorFocused']) {
        assert.ok(escape.split(' && ').includes(clause), `${clause} in ${escape}`);
      }
    });

    test('[[ in a box offers every marker by name, and a new marker at the selection in an editor', async () => {
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder('beta'), 'b.ts')));
      editor.selection = new vscode.Selection(3, 0, 3, 0);
      const box = await vscode.workspace.openTextDocument({ content: 'Next: [[]]' });
      const items = await api.notesComments.provideCompletionItems(box, new vscode.Position(0, 8)) ?? [];
      const marker = items.find(item => item.label === 'const line5 = 5;');
      assert.ok(marker, items.map(item => item.label).join(', '));
      assert.strictEqual(marker.insertText, '[[alpha/src/a.ts#const line5 = 5;]]');
      assert.deepStrictEqual([(marker.range as vscode.Range).start.character, (marker.range as vscode.Range).end.character], [6, 10], 'the brackets VS Code closed are replaced too');
      const created = items.find(item => item.label === 'New marker: const line4 = 4;');
      assert.ok(created, items.map(item => item.label).join(', '));
      assert.strictEqual(created.insertText, '[[beta/b.ts#const line4 = 4;]]');
      assert.deepStrictEqual(created.command?.arguments, [editor.document.uri.toString(), 3, 3, 'const line4 = 4;']);
      assert.strictEqual(await api.notesComments.provideCompletionItems(box, new vscode.Position(0, 5)), undefined, 'only after [[');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

    test('a marker shows Edit, its lines, Link to, Unlink, Add to collection, Move to selection, Open as Markdown and Delete at its left', () => {
      const note = Notes.parse(notesText)[0];
      const thread = { uri: aTs(), range: new vscode.Range(4, 0, 6, 16) } as vscode.CommentThread;
      const preview = new NoteComment(thread, note, [], thread.range!).preview();
      const target = encodeURIComponent(JSON.stringify([aTs().toString(), 4]));
      assert.ok(preview.value.includes(`[Lines 5–7](command:incontext.notes.selectAt?${target})`), preview.value);
      assert.ok(preview.value.endsWith(`[Edit](command:incontext.notes.editAt?${target}) · [Lines 5–7](command:incontext.notes.selectAt?${target}) · [Link to…](command:incontext.notes.linkAt?${target}) · [Unlink…](command:incontext.notes.unlinkAt?${target}) · [Add to collection…](command:incontext.collections.addAt?${target}) · [Move to selection](command:incontext.notes.moveAt?${target}) · [Open as Markdown](command:incontext.notes.openAt?${target}) · [Delete](command:incontext.notes.deleteAt?${target})`), 'Edit first');
      for (const command of ['incontext.notes.selectAt', 'incontext.notes.linkAt', 'incontext.notes.unlinkAt', 'incontext.collections.addAt', 'incontext.notes.moveAt', 'incontext.notes.editAt', 'incontext.notes.openAt', 'incontext.notes.deleteAt']) {
        assert.ok(preview.value.includes(`(command:${command}?${target})`), preview.value);
        assert.ok((preview.isTrusted as { enabledCommands: string[] }).enabledCommands.includes(command));
      }
      assert.ok(preview.value.startsWith('Defined in [b.ts:L2:3](command:incontext.openReferenceBeside?'), 'the note comes first, its references by file and lines');
      assert.strictEqual(NotesProvider.shortLabel('@reports/pvoi-ui/src/ReportDetails.tsx:L78'), 'ReportDetails.tsx:L78');
      assert.strictEqual(NotesProvider.shortLabel('@reports/pvoi-ui/src/'), 'src/');
    });

    test('a note on selected lines keeps its lines, and follows them when the code moves', async () => {
      assert.strictEqual(Notes.heading('Thirty', 30, '  const x = 1;', 42), '## Thirty\n<!-- L30-L42: const x = 1; -->');
      assert.strictEqual(Notes.heading('Thirty', 30, 'const x = 1;'), '## Thirty\n<!-- L30: const x = 1; -->');
      assert.strictEqual(Notes.heading('Blank', 30, '  '), '## Blank\n<!-- L30 -->');
      const [note] = Notes.parse('## L5-L7: const line5 = 5;\nThree lines');
      assert.deepStrictEqual([note.name, note.named, note.line, note.lines, note.anchor], ['const line5 = 5;', false, 5, 3, 'const line5 = 5;']);
      const [named, other] = Notes.parse('## Totals\n<!-- L5-L7: const line5 = 5; -->\n## Details\nNot a marker: no location\n## Next\n<!-- L9 -->');
      assert.deepStrictEqual([named.name, named.line, named.lines, named.text], ['Totals', 5, 3, '## Details\nNot a marker: no location']);
      assert.deepStrictEqual([other.name, other.line, other.anchor], ['Next', 9, '']);
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
        // Its first line is the marker's name, the rest its note
        const reply = { thread: { uri: aTs(), range: new vscode.Range(11, 0, 14, 0), dispose: () => undefined }, text: 'Twelve to fourteen\nLines 12 to 14' };
        await vscode.commands.executeCommand('incontext.notes.create', reply);
        assert.ok(fs.readFileSync(notesFile.fsPath, 'utf8').endsWith('\n\n## Twelve to fourteen\n<!-- L12-L14: const line12 = 12; -->\nLines 12 to 14\n'));
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
        assert.deepStrictEqual([moved.name, moved.named, moved.line, moved.lines, moved.anchor, moved.text],
          ['const line5 = 5;', true, 20, 3, 'const line20 = 20;', 'Defined in @beta/b.ts:L2:3, invoked from @beta/b.ts:L10.\nSecond line.'], 'it keeps its name');
      } finally {
        fs.writeFileSync(notesFile, notesText);
      }
    });

    test('the Markers view lists each file\'s markers by line, and under each what its note links to, one level', async () => {
      const bNotes = path.join(notesFolder(), 'beta', 'b.ts.md');
      fs.mkdirSync(path.dirname(bNotes), { recursive: true });
      fs.writeFileSync(bNotes, '## Step 2\n<!-- L2-L3: const line2 = 2; -->\nNext: [[alpha/src/a.ts#a.ts:L7]], then [[#Gone]]\n');
      try {
        const tree = new NotesTree(() => NotesBacklinks.readNotes());
        const files = await tree.getChildren();
        assert.deepStrictEqual(files.map(node => [node.kind, tree.getTreeItem(node).label, tree.getTreeItem(node).description]),
          [['file', 'a.ts', 'alpha/src · 2 markers'], ['file', 'b.ts', 'beta · 1 marker']]);
        const markers = await tree.getChildren(files[0]);
        assert.deepStrictEqual(markers.map(node => [tree.getTreeItem(node).label, tree.getTreeItem(node).description]), [['const line5 = 5;', 'L5'], ['a.ts:L7', 'L7']]);
        const linked = await tree.getChildren(markers[0]);
        assert.deepStrictEqual(linked.map(node => [node.kind, tree.getTreeItem(node).label, tree.getTreeItem(node).description]), [
          ['note', 'Step 2', 'b.ts:L2'],
          ['reference', 'b.ts:L10', 'beta/b.ts:L10'],
        ], 'a reference into a marker\'s lines is that marker');
        const [step] = await tree.getChildren(files[1]);
        const onward = await tree.getChildren(step);
        assert.deepStrictEqual(onward.map(node => [tree.getTreeItem(node).label, tree.getTreeItem(node).description]),
          [['a.ts:L7', 'a.ts:L7'], ['Gone', 'no marker by this name']], 'a link to a marker, by name');
        assert.deepStrictEqual(await tree.getChildren(onward[0]), [], 'one level: the marker it links to has its own row');
        // Rows open with VS Code's own open command, the only one told the keys held: Alt+click opens them to the side
        const note = tree.getTreeItem(markers[0]).command;
        assert.strictEqual(note?.command, 'vscode.open');
        assert.deepStrictEqual([note?.arguments?.[0].toString(), note?.arguments?.[1].selection.start.line], [aTs().toString(), 4], 'the note\'s lines');
        const reference = tree.getTreeItem(linked[1]).command;
        assert.deepStrictEqual([reference?.command, reference?.arguments?.[1].selection.start.line], ['vscode.open', 9]);
        // A file dragged carries its markers, by line
        const dragged = new vscode.DataTransfer();
        tree.handleDrag([files[0]], dragged);
        assert.deepStrictEqual(JSON.parse(await dragged.get('application/vnd.incontext.marker')!.asString()).map((marker: { name: string }) => marker.name), ['const line5 = 5;', 'a.ts:L7']);
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

    test('boxes drawn twice at once leave one box per note, not one per draw', async () => {
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
      // Private parts, reached for this test: the boxes kept per file, the controller that makes them, and redraw
      const comments = api.notesComments as unknown as {
        threads: Map<string, vscode.CommentThread[]>;
        controller: vscode.CommentController;
        redraw(document: vscode.TextDocument): Promise<void>;
      };
      const document = await vscode.workspace.openTextDocument(aTs());
      const key = document.uri.toString();
      // Every box made from here on that is still there. VS Code's controller and boxes are frozen, so redraw is
      // handed a stand-in controller whose boxes say when they are taken away
      const shown = new Set<vscode.CommentThread>();
      const controller = comments.controller;
      comments.controller = {
        createCommentThread: (uri: vscode.Uri, range: vscode.Range, list: vscode.Comment[]) => {
          const thread = controller.createCommentThread(uri, range, list);
          const box: vscode.CommentThread = new Proxy(thread, {
            get: (target, property) => property === 'dispose'
              ? () => { shown.delete(box); target.dispose(); }
              : Reflect.get(target, property),
            set: (target, property, value) => Reflect.set(target, property, value),
          });
          shown.add(box);
          return box;
        },
      } as unknown as vscode.CommentController;
      try {
        // All three start before any has read the notes, as a save and the notes folder's watcher can
        await Promise.all([comments.redraw(document), comments.redraw(document), comments.redraw(document)]);
        const kept = comments.threads.get(key) ?? [];
        const onFile = [...shown].filter(thread => thread.uri.toString() === key);
        assert.ok(kept.length > 0, 'the notes are drawn');
        assert.strictEqual(onFile.filter(thread => !kept.includes(thread)).length, 0, 'no box left on screen that is no longer kept');
        const firstLines = kept.map(thread => (thread.comments[0] as NoteComment).lines.start.line);
        assert.strictEqual(new Set(firstLines).size, firstLines.length, `one box per note: ${firstLines}`);
      } finally {
        comments.controller = controller;
        // Drawn again by the real controller, so later tests see ordinary boxes
        await comments.redraw(document);
      }
    });

    test('boxes start closed, the shortcut opens and closes a file\'s boxes, and they close again with the file\'s last tab', async function () {
      this.timeout(30_000);
      const api = await vscode.extensions.getExtension('managea.incontext')!.activate() as { notesComments: NotesComments };
      const comments = api.notesComments as unknown as { threads: Map<string, vscode.CommentThread[]>; redraw(document: vscode.TextDocument): Promise<void> };
      const key = aTs().toString();
      const states = () => (comments.threads.get(key) ?? []).map(thread => thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded ? 'open' : 'closed');
      const waitFor = async (what: string, check: () => boolean) => {
        for (const end = Date.now() + 10_000; !check();) {
          assert.ok(Date.now() < end, `timed out waiting for ${what}: ${states()}`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.window.showTextDocument(aTs());
      await waitFor('the boxes', () => states().length > 0);
      assert.ok(states().every(state => state === 'closed'), `all start closed: ${states()}`);

      await vscode.commands.executeCommand('incontext.notes.toggleInFile');
      assert.ok(states().every(state => state === 'open'), `the shortcut opens them all: ${states()}`);
      await comments.redraw(await vscode.workspace.openTextDocument(aTs()));
      assert.ok(states().every(state => state === 'open'), `they stay open while the file is open: ${states()}`);
      await vscode.commands.executeCommand('incontext.notes.toggleInFile');
      assert.ok(states().every(state => state === 'closed'), `and closes them all: ${states()}`);

      await vscode.commands.executeCommand('incontext.notes.toggleInFile');
      await vscode.commands.executeCommand('incontext.notes.closeAll');
      assert.ok(states().every(state => state === 'closed'), `Close All Notes closes them: ${states()}`);
      await vscode.commands.executeCommand('incontext.notes.toggleInFile');
      await vscode.commands.executeCommand('incontext.notes.closeInEditor');
      assert.ok(states().every(state => state === 'closed'), `Esc in the editor closes them: ${states()}`);

      // Opened, then the file's tab closed: opened again, its boxes are closed
      await vscode.commands.executeCommand('incontext.notes.toggleInFile');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor('the boxes to close with the tab', () => states().every(state => state === 'closed'));
      await vscode.window.showTextDocument(aTs());
      await waitFor('the boxes', () => states().length > 0);
      await comments.redraw(await vscode.workspace.openTextDocument(aTs()));
      assert.ok(states().every(state => state === 'closed'), `a file opened again has its boxes closed: ${states()}`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('a note typed into its box is saved to the notes file, and an edit rewrites only that note', async () => {
      const notesFile = vscode.Uri.file(path.join(notesFolder(), 'alpha', 'src', 'a.ts.md'));
      await vscode.workspace.openTextDocument(aTs());
      try {
        let disposed = false;
        const reply = { thread: { uri: aTs(), range: new vscode.Range(9, 0, 9, 0), dispose: () => { disposed = true; } }, text: 'Called by @beta/b.ts:L4\n' };
        await acceptingName(() => vscode.commands.executeCommand('incontext.notes.create', reply));
        assert.ok(disposed, 'the empty box gives way to the saved note');
        let saved = fs.readFileSync(notesFile.fsPath, 'utf8');
        assert.ok(saved.endsWith('\n\n## const line10 = 10;\n<!-- L10: const line10 = 10; -->\nCalled by @beta/b.ts:L4\n'), saved);

        const edited = { body: 'const line5 = 5;\n\nChanged in its box', file: notesFile, note: Notes.parse(saved)[0], thread: { uri: aTs(), range: new vscode.Range(4, 0, 4, 0), comments: [] }, mode: vscode.CommentMode.Editing };
        await vscode.commands.executeCommand('incontext.notes.save', edited);
        saved = fs.readFileSync(notesFile.fsPath, 'utf8');
        assert.deepStrictEqual(Notes.parse(saved).map(note => [note.name, note.line, note.text]),
          [['const line5 = 5;', 5, 'Changed in its box'], ['L7', 7, ''], ['const line10 = 10;', 10, 'Called by @beta/b.ts:L4']]);
        assert.ok(saved.includes('## const line5 = 5;\n<!-- L5: const line5 = 5; -->\nChanged in its box'), 'saved, an older note gets its name written');
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
