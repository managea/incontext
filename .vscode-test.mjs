import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'child_process';
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
// A small call chain for the Caller Tree tests: main.ts (module code) -> index.render -> pricing.quote ->
// pricing.convert -> rates.readRate
write('alpha/calls/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }));
write('alpha/calls/rates.ts', 'export function readRate(key: string) {\n  return key.length;\n}\n');
write('alpha/calls/pricing.ts', "import { readRate } from './rates';\nexport function convert(x: string) {\n  return readRate(x);\n}\n"
  + "export function quote() {\n  return convert('a');\n}\n");
write('alpha/calls/index.ts', "import { quote } from './pricing';\nexport function render() {\n  return quote();\n}\n");
write('alpha/calls/main.ts', "import { render } from './index';\nrender();\n");
// Two git repositories in beta for the Compare with Branch tests (src/test/BaseCompare.test.ts). shop: branch
// feature left main, then main moved on (main-only.ts); feature modifies a.ts (committed, then again uncommitted),
// deletes gone.ts, renames old.ts to new.ts, adds added.ts, and has the untracked fresh.ts. tools: feature changes t.ts.
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: path.join(root, repo), stdio: 'pipe' });
const oldLines = Array.from({ length: 12 }, (_, i) => `export const old${i + 1} = ${i + 1};`).join('\n');
write('beta/shop/a.ts', `${lines}\n`);
write('beta/shop/gone.ts', 'export const gone = 1;\n');
write('beta/shop/old.ts', `${oldLines}\n`);
git('beta/shop', 'init', '-q', '-b', 'main');
git('beta/shop', 'add', '-A');
git('beta/shop', 'commit', '-q', '-m', 'base');
git('beta/shop', 'checkout', '-q', '-b', 'feature');
write('beta/shop/a.ts', `${lines.replace('const line3 = 3;', 'const line3 = 33;')}\n`);
fs.rmSync(path.join(root, 'beta/shop/gone.ts'));
fs.renameSync(path.join(root, 'beta/shop/old.ts'), path.join(root, 'beta/shop/new.ts'));
write('beta/shop/src/added.ts', 'export const added = 1;\n');
git('beta/shop', 'add', '-A');
git('beta/shop', 'commit', '-q', '-m', 'feature');
git('beta/shop', 'checkout', '-q', 'main');
write('beta/shop/main-only.ts', 'export const later = 1;\n');
git('beta/shop', 'add', '-A');
git('beta/shop', 'commit', '-q', '-m', 'main moves on');
git('beta/shop', 'checkout', '-q', 'feature');
write('beta/shop/a.ts', `${lines.replace('const line3 = 3;', 'const line3 = 33;').replace('const line20 = 20;', 'const line20 = 2020;')}\n`);
write('beta/shop/fresh.ts', 'export const fresh = 1;\n');
write('beta/tools/t.ts', 'export const t = 1;\n');
git('beta/tools', 'init', '-q', '-b', 'main');
git('beta/tools', 'add', '-A');
git('beta/tools', 'commit', '-q', '-m', 'base');
git('beta/tools', 'checkout', '-q', '-b', 'feature');
write('beta/tools/t.ts', 'export const t = 2;\n');
git('beta/tools', 'commit', '-q', '-am', 'feature');
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
