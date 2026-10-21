import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObsidianPlugin } from '../ObsidianPlugin';

const ROOT = path.resolve(__dirname, '..', '..');

suite('ObsidianPlugin', () => {
  // Vaults and a plugin build of the tests' own; real vaults are never used
  let base: string;
  let source: string;
  let vault: string;
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const enabledFile = (folder: string) => path.join(folder, '.obsidian', 'community-plugins.json');
  const makeVault = (name: string) => {
    const folder = path.join(base, name);
    fs.mkdirSync(path.join(folder, '.obsidian'), { recursive: true });
    return folder;
  };
  const build = (version: string) => {
    fs.writeFileSync(path.join(source, 'main.js'), `// main ${version}\n`);
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ id: ObsidianPlugin.ID, name: 'InContext Links', version }));
    fs.writeFileSync(path.join(source, 'styles.css'), '.incontext-reference {}\n');
  };

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'incontext-obsidian-'));
    source = path.join(base, 'build');
    fs.mkdirSync(source);
    build('1.4.0');
    vault = makeVault('Home');
  });

  teardown(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('configFile is where Obsidian keeps its vault list on each platform', () => {
    assert.strictEqual(ObsidianPlugin.configFile('darwin', '/Users/me', {}), '/Users/me/Library/Application Support/obsidian/obsidian.json');
    assert.strictEqual(ObsidianPlugin.configFile('win32', 'C:\\Users\\me', { APPDATA: 'D:\\Roaming' }), path.join('D:\\Roaming', 'obsidian', 'obsidian.json'));
    assert.strictEqual(ObsidianPlugin.configFile('linux', '/home/me', {}), '/home/me/.config/obsidian/obsidian.json');
    assert.strictEqual(ObsidianPlugin.configFile('linux', '/home/me', { XDG_CONFIG_HOME: '/xdg' }), '/xdg/obsidian/obsidian.json');
  });

  test('vaults are the ones Obsidian lists that are still vaults, most recently opened first', () => {
    const work = makeVault('Work');
    fs.mkdirSync(path.join(base, 'plain-folder'));
    const config = path.join(base, 'obsidian.json');
    fs.writeFileSync(config, JSON.stringify({ vaults: {
      a: { path: vault, ts: 100 },
      b: { path: work, ts: 200, open: true },
      c: { path: path.join(base, 'plain-folder'), ts: 300 },
      d: { path: path.join(base, 'deleted'), ts: 400 },
    } }));
    assert.deepStrictEqual(ObsidianPlugin.vaults(config), [
      { name: 'Work', folder: work, open: true },
      { name: 'Home', folder: vault, open: false },
    ]);
    assert.deepStrictEqual(ObsidianPlugin.vaults(path.join(base, 'missing.json')), []);
  });

  test('install copies the plugin and turns it on, keeping the plugins already on', () => {
    fs.writeFileSync(enabledFile(vault), JSON.stringify(['calendar'], null, 2));
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'installed');
    for (const file of ObsidianPlugin.FILES) {
      assert.strictEqual(read(path.join(ObsidianPlugin.pluginFolder(vault), file)), read(path.join(source, file)), file);
    }
    assert.strictEqual(read(enabledFile(vault)), JSON.stringify(['calendar', ObsidianPlugin.ID], null, 2));
    assert.deepStrictEqual(ObsidianPlugin.state(vault), { version: '1.4.0', enabled: true });
  });

  test('install creates community-plugins.json when the vault has none', () => {
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'installed');
    assert.deepStrictEqual(JSON.parse(read(enabledFile(vault))), [ObsidianPlugin.ID]);
  });

  test('install updates only when the build changed, or the plugin was turned off', () => {
    ObsidianPlugin.install(vault, source);
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'unchanged');
    build('1.5.0');
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'updated');
    assert.strictEqual(ObsidianPlugin.state(vault).version, '1.5.0');
    fs.writeFileSync(enabledFile(vault), '[]');
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'updated');
    assert.strictEqual(ObsidianPlugin.state(vault).enabled, true);
  });

  test('install leaves a community-plugins.json it can\'t read alone, and the plugin off', () => {
    fs.writeFileSync(enabledFile(vault), '{ "not": "a list" }');
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'installed');
    assert.strictEqual(read(enabledFile(vault)), '{ "not": "a list" }');
    assert.deepStrictEqual(ObsidianPlugin.state(vault), { version: '1.4.0', enabled: false });
  });

  test('another plugin in the incontext-links folder is left alone', () => {
    const folder = ObsidianPlugin.pluginFolder(vault);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ id: 'someone-else', version: '9.0.0' }));
    assert.strictEqual(ObsidianPlugin.install(vault, source), 'foreign');
    assert.strictEqual(ObsidianPlugin.remove(vault), 'foreign');
    assert.deepStrictEqual(fs.readdirSync(folder), ['manifest.json']);
    assert.ok(!fs.existsSync(enabledFile(vault)));
  });

  test('remove deletes the plugin and turns it off, keeping the other plugins', () => {
    fs.writeFileSync(enabledFile(vault), JSON.stringify(['calendar'], null, 2));
    ObsidianPlugin.install(vault, source);
    assert.strictEqual(ObsidianPlugin.remove(vault), 'removed');
    assert.ok(!fs.existsSync(ObsidianPlugin.pluginFolder(vault)));
    assert.strictEqual(read(enabledFile(vault)), JSON.stringify(['calendar'], null, 2));
    assert.strictEqual(ObsidianPlugin.remove(vault), 'absent');
  });

  test('the extension ships the built plugin, with the extension\'s version', () => {
    const shipped = path.join(ROOT, 'dist', 'obsidian');
    for (const file of ObsidianPlugin.FILES) {
      assert.ok(fs.existsSync(path.join(shipped, file)), `dist/obsidian/${file} is missing: run npm run build:obsidian`);
    }
    const manifest = JSON.parse(read(path.join(shipped, 'manifest.json')));
    assert.strictEqual(manifest.id, ObsidianPlugin.ID);
    assert.strictEqual(manifest.version, JSON.parse(read(path.join(ROOT, 'package.json'))).version);
  });
});
