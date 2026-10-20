import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LaunchResult } from '../LinkRequest';
import { LinkServer } from '../LinkServer';
import { forwardToWindow, WindowEndpoint, WindowEntry, WindowRegistry } from '../LinkWindows';
import { launch, pageHeaders, request } from './http';

const MEDIA = path.resolve(__dirname, '..', '..', 'media');

suite('LinkServer', () => {
  let server: LinkServer;
  let port: number;
  let launched: string[];
  let result: LaunchResult;

  setup(async () => {
    launched = [];
    result = { status: 204 };
    server = new LinkServer(LinkServer.loadPage(MEDIA, 'vscode://managea.incontext'), async reference => {
      launched.push(reference);
      return result;
    });
    assert.ok(await server.listen(0));
    port = server.port;
  });

  teardown(() => server.close());

  test('serves the page with locked-down headers', async () => {
    const page = await request(port, 'GET', '/open', { Host: `localhost:${port}` });
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.strictEqual(page.headers['content-security-policy'], "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.strictEqual(page.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(page.headers['cache-control'], 'no-store');
    assert.strictEqual(page.headers['x-frame-options'], 'DENY');
    assert.ok(page.body.includes('<meta name="incontext-uri-prefix" content="vscode://managea.incontext">'));
    assert.ok(page.body.includes('<script src="open.js"></script>'));

    const script = await request(port, 'GET', '/open.js', { Host: `127.0.0.1:${port}` });
    assert.strictEqual(script.status, 200);
    assert.strictEqual(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.strictEqual(script.headers['cache-control'], 'no-store');
    assert.ok(script.body.includes("fetch('/launch'"));
    assert.ok(!script.body.includes('innerHTML'));
  });

  test('ignores a query, which a fragment never turns into', async () => {
    assert.strictEqual((await request(port, 'GET', '/open?x=1', { Host: `localhost:${port}` })).status, 200);
  });

  test('refuses requests for another host, also for the page (DNS rebinding)', async () => {
    assert.strictEqual((await request(port, 'GET', '/open', { Host: `evil.example:${port}` })).status, 403);
    assert.strictEqual((await launch(port, '@a/b.ts', { Host: `evil.example:${port}` })).status, 403);
    assert.deepStrictEqual(launched, []);
  });

  test('refuses every OPTIONS request, so no other site gets past a CORS preflight', async () => {
    const preflight = await request(port, 'OPTIONS', '/launch', {
      'Host': `localhost:${port}`,
      'Origin': `http://localhost:${port}`,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-incontext,content-type',
    });
    assert.strictEqual(preflight.status, 403);
    assert.strictEqual(preflight.headers['access-control-allow-origin'], undefined);
  });

  test('opens a reference the page posts, and answers 204', async () => {
    const response = await launch(port, '@incontext/src/extension.ts:L392:394');
    assert.strictEqual(response.status, 204);
    assert.deepStrictEqual(launched, ['@incontext/src/extension.ts:L392:394']);
  });

  test('passes on why a reference did not open', async () => {
    result = { status: 404, message: 'VS Code could not open it' };
    const response = await launch(port, '@incontext/missing.ts');
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.body, 'VS Code could not open it');
  });

  test('refuses posts without the page origin or header', async () => {
    assert.strictEqual((await launch(port, '@a/b.ts', { Origin: 'http://evil.example' })).status, 403);
    assert.strictEqual((await launch(port, '@a/b.ts', { Origin: undefined })).status, 403);
    assert.strictEqual((await launch(port, '@a/b.ts', { 'X-Incontext': undefined })).status, 403);
    assert.deepStrictEqual(launched, []);
  });

  test('refuses bodies over 4 KB', async () => {
    const reference = `@a/${'x'.repeat(5000)}`;
    assert.strictEqual((await launch(port, reference)).status, 413);
    // Also when the body is sent in chunks, without a Content-Length
    const chunked = await request(port, 'POST', '/launch', { ...pageHeaders(port), 'Transfer-Encoding': 'chunked' }, JSON.stringify({ reference }));
    assert.strictEqual(chunked.status, 413);
    assert.deepStrictEqual(launched, []);
  });

  test('refuses references that are not one @ reference, or hold ..', async () => {
    for (const reference of ['a/b.ts', '@a/b c.ts', '@a/../../.ssh/id_rsa', '@a/%2e%2e/secret', 42]) {
      assert.strictEqual((await launch(port, reference)).status, 400, String(reference));
    }
    assert.deepStrictEqual(launched, []);
  });

  test('answers 404 for other paths and methods', async () => {
    assert.strictEqual((await request(port, 'GET', '/', { Host: `localhost:${port}` })).status, 404);
    assert.strictEqual((await request(port, 'GET', '/launch', { Host: `localhost:${port}` })).status, 404);
    assert.strictEqual((await request(port, 'POST', '/open', pageHeaders(port), '{}')).status, 404);
  });

  test('reports a port that is taken instead of throwing', async () => {
    const second = new LinkServer({ html: '', script: '' }, async () => ({ status: 204 }));
    assert.strictEqual(await second.listen(port), false);
  });
});

suite('WindowEndpoint', () => {
  let endpoint: WindowEndpoint;
  let opened: string[];
  let entry: WindowEntry;

  setup(async () => {
    opened = [];
    endpoint = new WindowEndpoint(async reference => {
      opened.push(reference);
      return { status: 204 };
    });
    const port = await endpoint.listen();
    entry = { id: 'window', pid: process.pid, port, token: endpoint.token, folders: ['alpha'], focusedAt: 0 };
  });

  teardown(() => endpoint.close());

  test('opens references passed on with its token', async () => {
    assert.deepStrictEqual(await forwardToWindow(entry, '@alpha/a.ts:L1'), { status: 204, message: '' });
    assert.deepStrictEqual(opened, ['@alpha/a.ts:L1']);
  });

  test('refuses requests without its token, from a browser, or for another host', async () => {
    const body = JSON.stringify({ reference: '@alpha/a.ts' });
    const headers = { Host: `127.0.0.1:${entry.port}`, Authorization: `Bearer ${entry.token}` };
    assert.strictEqual((await forwardToWindow({ ...entry, token: 'wrong' }, '@alpha/a.ts'))?.status, 403);
    assert.strictEqual((await request(entry.port, 'POST', '/open', { ...headers, Authorization: undefined }, body)).status, 403);
    assert.strictEqual((await request(entry.port, 'POST', '/open', { ...headers, Origin: 'http://evil.example' }, body)).status, 403);
    assert.strictEqual((await request(entry.port, 'POST', '/open', { ...headers, Host: `localhost:${entry.port}` }, body)).status, 403);
    assert.strictEqual((await request(entry.port, 'GET', '/open', headers)).status, 403);
    assert.strictEqual((await request(entry.port, 'POST', '/open', headers, body)).status, 204, 'the same request with all checks met');
    assert.deepStrictEqual(opened, ['@alpha/a.ts']);
  });

  test('refuses references with ..', async () => {
    assert.strictEqual((await forwardToWindow(entry, '@alpha/../secret'))?.status, 400);
    assert.deepStrictEqual(opened, []);
  });

  test('forwarding to a window that has gone resolves to undefined', async () => {
    await endpoint.close();
    assert.strictEqual(await forwardToWindow(entry, '@alpha/a.ts'), undefined);
  });
});

suite('WindowRegistry', () => {
  let base: string;

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'incontext-registry-'));
  });

  teardown(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const entry = (id: string, folders: string[], focusedAt: number, pid = process.pid): WindowEntry =>
    ({ id, pid, port: 1, token: 't', folders, focusedAt });

  test('keeps entries in a folder only this user can read', () => {
    const registry = WindowRegistry.open(46266, base)!;
    assert.ok(registry);
    registry.write(entry('a1b2', ['alpha'], 1));
    assert.deepStrictEqual(registry.read(), [entry('a1b2', ['alpha'], 1)]);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.dirname(registry.directory)).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(registry.directory).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(path.join(registry.directory, 'a1b2.json')).mode & 0o777, 0o600);
    }
    registry.remove('a1b2');
    assert.deepStrictEqual(registry.read(), []);
  });

  test('keeps a registry per port', () => {
    WindowRegistry.open(1111, base)!.write(entry('one', [], 0));
    assert.deepStrictEqual(WindowRegistry.open(2222, base)!.read(), []);
  });

  test('refuses a user folder that others can read', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const registry = WindowRegistry.open(46266, base)!;
    fs.chmodSync(path.dirname(registry.directory), 0o755);
    assert.strictEqual(WindowRegistry.open(46266, base), undefined);
  });

  test('drops windows whose extension host has exited, and files that are not entries', () => {
    const registry = WindowRegistry.open(46266, base)!;
    registry.write(entry('alive', ['alpha'], 1));
    registry.write(entry('gone', ['beta'], 2, 2 ** 22 + 12345));
    fs.writeFileSync(path.join(registry.directory, 'junk.json'), '{"id":"junk"}');
    fs.writeFileSync(path.join(registry.directory, 'other.json'), JSON.stringify(entry('not-other', [], 0)));
    assert.deepStrictEqual(registry.read().map(window => window.id), ['alive']);
    assert.ok(!fs.existsSync(path.join(registry.directory, 'gone.json')));
  });

  test('chooses the windows that have the folder, most recently focused first', () => {
    const windows = [entry('a', ['alpha'], 1), entry('b', ['alpha', 'beta'], 3), entry('c', ['gamma'], 5)];
    assert.deepStrictEqual(WindowRegistry.choose(windows, 'alpha').map(window => window.id), ['b', 'a']);
    assert.deepStrictEqual(WindowRegistry.choose(windows, 'gamma').map(window => window.id), ['c']);
    // No window has the folder: every window, most recently focused first
    assert.deepStrictEqual(WindowRegistry.choose(windows, 'delta').map(window => window.id), ['c', 'b', 'a']);
    assert.deepStrictEqual(WindowRegistry.choose(windows, undefined).map(window => window.id), ['c', 'b', 'a']);
  });

  test('folderOf reads the folder name a reference starts with', () => {
    assert.strictEqual(WindowRegistry.folderOf('@incontext/src/extension.ts:L392:394'), 'incontext');
    assert.strictEqual(WindowRegistry.folderOf('@incontext/'), 'incontext');
    assert.strictEqual(WindowRegistry.folderOf('@my%20project/a.ts'), 'my project');
    assert.strictEqual(WindowRegistry.folderOf('@README.md:L3'), undefined);
  });
});
