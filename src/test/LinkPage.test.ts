import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const SCRIPT = fs.readFileSync(path.resolve(__dirname, '..', '..', 'media', 'link-page.js'), 'utf8');
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const CLAUDE_APP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.2.3 Chrome/142.0.0.0 Electron/39.0.0 Safari/537.36';

interface PageRun {
  /** The bodies the page posted to /launch. */
  posted: unknown[];
  closed: boolean;
  status: string;
}

/** Runs the link page's script (media/link-page.js) for `hash` in a stand-in for a browser with user agent `userAgent`. */
async function runPage(userAgent: string, hash: string, ok = true): Promise<PageRun> {
  const run: PageRun = { posted: [], closed: false, status: '' };
  const status = { set textContent(text: string) { run.status = text; } };
  const fallback = { hidden: true, href: '', textContent: '', removeAttribute: () => undefined };
  const context = {
    navigator: { userAgent },
    location: { hash, pathname: '/open' },
    history: { replaceState: () => undefined },
    document: {
      getElementById: (id: string) => (id === 'status' ? status : fallback),
      querySelector: () => ({ content: 'vscode://managea.incontext' }),
    },
    window: { addEventListener: () => undefined, close: () => { run.closed = true; } },
    fetch: async (url: string, init: { body: string }) => {
      assert.strictEqual(url, '/launch');
      run.posted.push(JSON.parse(init.body));
      return { ok, statusText: 'Not Found', text: async () => (ok ? '' : 'VS Code could not open it.') };
    },
  };
  vm.runInNewContext(SCRIPT, context);
  await new Promise(resolve => setTimeout(resolve, 10));
  return run;
}

suite('Link page', () => {
  test('in a browser tab, asks VS Code to come to the front and closes the tab', async () => {
    const run = await runPage(CHROME, '#@alpha/src/a.ts:L3:4');
    assert.deepStrictEqual(run.posted, [{ reference: '@alpha/src/a.ts:L3:4', focus: true }]);
    assert.ok(run.closed);
    assert.strictEqual(run.status, 'Opened @alpha/src/a.ts:L3:4 in VS Code. You can close this tab.');
  });

  test('in the Claude app\'s Browser pane, leaves VS Code behind the app and the page open', async () => {
    const run = await runPage(CLAUDE_APP, '#@alpha/src/a.ts:L3:4');
    assert.deepStrictEqual(run.posted, [{ reference: '@alpha/src/a.ts:L3:4', focus: false }]);
    assert.ok(!run.closed);
    assert.strictEqual(run.status, 'Opened @alpha/src/a.ts:L3:4 in VS Code.');
  });

  test('keeps the tab open with the reason when VS Code could not open the reference', async () => {
    const run = await runPage(CHROME, '#@alpha/missing.ts', false);
    assert.deepStrictEqual(run.posted, [{ reference: '@alpha/missing.ts', focus: true }]);
    assert.ok(!run.closed);
    assert.strictEqual(run.status, 'Could not open @alpha/missing.ts: VS Code could not open it.');
  });

  test('posts nothing for a link without a reference', async () => {
    const run = await runPage(CHROME, '#@alpha/../secret');
    assert.deepStrictEqual(run.posted, []);
    assert.strictEqual(run.status, 'This link does not hold an incontext reference.');
  });
});
