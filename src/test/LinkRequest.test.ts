import * as assert from 'assert';
import { LinkRequest } from '../LinkRequest';

suite('LinkRequest', () => {
  const port = 46266;
  const headers = {
    host: `localhost:${port}`,
    origin: `http://localhost:${port}`,
    'x-incontext': '1',
  };
  const body = (reference: unknown) => JSON.stringify({ reference });

  suite('isReference', () => {
    test('accepts one @ reference', () => {
      for (const reference of [
        '@incontext/src/extension.ts:L392:394',
        '@incontext/src/extension.ts#L10-L20',
        '@incontext/src/',
        '@incontext/README.md',
        '@my%20project/src/a.ts:L3',
        '@incontext/src/a..b.ts',
        '@incontext/.github/workflows/publish.yml',
      ]) {
        assert.ok(LinkRequest.isReference(reference), reference);
      }
    });

    test('refuses anything that is not a single @ reference', () => {
      for (const reference of ['', '@', 'incontext/src/a.ts', '@incontext/a b.ts', '@a/b@c', ' @a/b', '@a/b\n', 42, null, undefined, ['@a/b']]) {
        assert.ok(!LinkRequest.isReference(reference), String(reference));
      }
    });

    test('refuses a .. segment, also percent-encoded', () => {
      for (const reference of [
        '@incontext/../../.ssh/id_rsa',
        '@incontext/src/..',
        '@incontext/src/../',
        '@incontext/..:L1',
        '@incontext/..#L1',
        '@..',
        '@../etc/passwd',
        '@incontext\\..\\secret',
        '@incontext/%2e%2e/%2E%2E/.ssh/id_rsa',
        '@incontext/.%2e/x',
        '@incontext%2F..%2F..%2Fsecret',
      ]) {
        assert.ok(!LinkRequest.isReference(reference), reference);
      }
    });
  });

  suite('checkLaunch', () => {
    test('accepts the request the link page sends', () => {
      assert.deepStrictEqual(LinkRequest.checkLaunch(port, headers, body('@incontext/src/a.ts:L1:2')), { reference: '@incontext/src/a.ts:L1:2' });
      const viaIp = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-incontext': '1' };
      assert.deepStrictEqual(LinkRequest.checkLaunch(port, viaIp, body('@incontext/src/a.ts')), { reference: '@incontext/src/a.ts' });
    });

    test('refuses other hosts (DNS rebinding)', () => {
      for (const host of [undefined, `evil.example:${port}`, 'localhost', `localhost:${port + 1}`, `127.0.0.2:${port}`, `[::1]:${port}`, `localhost.evil.example:${port}`]) {
        const result = LinkRequest.checkLaunch(port, { ...headers, host }, body('@a/b.ts'));
        assert.deepStrictEqual(result, { status: 403, message: 'Unexpected Host header' }, String(host));
      }
    });

    test('refuses other origins', () => {
      for (const origin of [undefined, 'null', 'http://evil.example', `https://localhost:${port}`, `http://localhost:${port + 1}`, `http://localhost:${port}/`, `http://evil.example:${port}`]) {
        const result = LinkRequest.checkLaunch(port, { ...headers, origin }, body('@a/b.ts'));
        assert.deepStrictEqual(result, { status: 403, message: 'Unexpected Origin header' }, String(origin));
      }
    });

    test('requires X-Incontext: 1', () => {
      for (const marker of [undefined, '', '0', 'true']) {
        const result = LinkRequest.checkLaunch(port, { ...headers, 'x-incontext': marker }, body('@a/b.ts'));
        assert.deepStrictEqual(result, { status: 403, message: 'Missing X-Incontext header' }, String(marker));
      }
    });

    test('refuses bodies over 4 KB', () => {
      const big = body(`@a/${'x'.repeat(LinkRequest.MAX_BODY_BYTES)}`);
      assert.strictEqual((LinkRequest.checkLaunch(port, headers, big) as { status: number }).status, 413);
      const json = body('@a/b.ts');
      const justFits = json + ' '.repeat(LinkRequest.MAX_BODY_BYTES - json.length);
      assert.deepStrictEqual(LinkRequest.checkLaunch(port, headers, justFits), { reference: '@a/b.ts' });
    });

    test('refuses bodies that are not JSON with a reference string', () => {
      for (const text of ['', 'not json', '"@a/b.ts"', '{}', '{"reference":42}', '{"reference":["@a/b.ts"]}', '{"reference":"a/b.ts"}', '{"reference":"@a/../b.ts"}']) {
        const result = LinkRequest.checkLaunch(port, headers, text) as { status: number };
        assert.strictEqual(result.status, 400, text);
      }
    });
  });
});
