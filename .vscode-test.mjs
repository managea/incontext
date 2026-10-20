import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// A throwaway workspace for the tests (src/test): folders `alpha` and `beta`, a folder outside the workspace,
// and symlinks in `alpha` that stay inside it or lead out of it
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incontext-test-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const lines = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
write('alpha/src/a.ts', `${lines}\n`);
write('alpha/notes.md', 'The secret: [secret](../outside/secret.txt#L1-L2)\n');
write('beta/b.ts', `${lines}\n`);
write('outside/secret.txt', 'secret line 1\nsecret line 2\n');
fs.symlinkSync('src', path.join(root, 'alpha/inner'));
fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'alpha/escape'));
// The AI assistant instruction tests point HOME and CODEX_HOME here while they run, so they never write to the
// real ones. (Not for the whole VS Code: with another HOME, macOS can't find the login keychain and asks to reset it.)
write('home/.claude/CLAUDE.md', '# My Claude rules\n');
write('home/.copilot/copilot-instructions.md', '# My Copilot rules\n');
write('codex-home/AGENTS.md', '# My Codex rules\n\nBe brief.\n');
write('test.code-workspace', JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }] }));

// The link server's port, free when the tests start, so a running VS Code with this extension isn't disturbed
const port = await new Promise(resolve => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
write('user-data/User/settings.json', JSON.stringify({
  'incontext.linkServer.port': port,
  // vscode:// links the tests open would otherwise ask "Allow ... to open this URI?"
  'extensions.confirmedUriHandlerExtensionIds': ['managea.incontext'],
}));

// Clean up once the run is over, including the window registry for the test port (src/LinkWindows.ts)
const registry = path.join(os.tmpdir(), `incontext-${process.getuid?.() ?? os.userInfo().username}`, `links-${port}`);
process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(registry, { recursive: true, force: true });
});

export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: path.join(root, 'test.code-workspace'),
  launchArgs: [`--user-data-dir=${path.join(root, 'user-data')}`],
  mocha: { ui: 'tdd', timeout: 20000 },
});
