import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AiInstructions, AiTarget } from '../AiInstructions';

const ROOT = path.resolve(__dirname, '..', '..');

suite('AiInstructions', () => {
  // A home folder and a Codex home of the tests' own; the real ones are never used
  let base: string;
  let home: string;
  let codexHome: string;
  const template = () => AiInstructions.loadTemplate(path.join(ROOT, 'media'));
  const instructions = (port = 46266) => AiInstructions.render(template(), port, 'vscode');
  const target = (tool: string): AiTarget => AiInstructions.targets(home, codexHome).find(target => target.tool === tool)!;
  const read = (file: string) => fs.readFileSync(file, 'utf8');

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'incontext-ai-'));
    home = path.join(base, 'home');
    codexHome = path.join(home, '.codex');
    fs.mkdirSync(home);
  });

  teardown(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  suite('targets', () => {
    test('are the files each tool reads', () => {
      assert.deepStrictEqual(AiInstructions.targets(home, undefined).map(target => [target.tool, target.file, target.ownsFile]), [
        ['claude', path.join(home, '.claude', 'rules', 'incontext-references.md'), true],
        ['copilot', path.join(home, '.copilot', 'instructions', 'incontext-references.instructions.md'), true],
        ['codex', path.join(home, '.codex', 'AGENTS.md'), false],
      ]);
    });

    test('use CODEX_HOME, and AGENTS.override.md when there is one', () => {
      const elsewhere = path.join(base, 'codex');
      assert.strictEqual(AiInstructions.targets(home, elsewhere)[2].file, path.join(elsewhere, 'AGENTS.md'));
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'AGENTS.override.md'), '');
      assert.strictEqual(AiInstructions.targets(home, elsewhere)[2].file, path.join(elsewhere, 'AGENTS.override.md'));
    });
  });

  test('render fills in the port and the URI scheme', () => {
    assert.ok(template().includes('{{PORT}}') && template().includes('{{URI_SCHEME}}'));
    const text = AiInstructions.render(template(), 47001, 'vscode-insiders');
    assert.ok(!text.includes('{{'));
    assert.ok(text.includes('(http://localhost:47001/open#@<folder>/<path>:L<start>:<end>)'));
    assert.ok(text.includes('(vscode-insiders://managea.incontext/@<folder>/<path>:L<start>:<end>)'));
    assert.ok(text.includes('the Claude desktop app, the ChatGPT/Codex app or the GitHub Copilot app'));
    assert.ok(text.includes('In a file you create or edit (Markdown, code comments)') && text.includes('never inside a Markdown link'));
  });

  test('the README shows the template, with the default port', () => {
    const readme = read(path.join(ROOT, 'README.md'));
    assert.strictEqual(AiInstructions.readmeCopy(readme), AiInstructions.readmeBlock(ROOT), 'README.md is out of date: run npm run sync-readme');
    assert.ok(AiInstructions.readmeBlock(ROOT).includes('http://localhost:46266/open#'));
  });

  suite('the marked block', () => {
    const block = AiInstructions.block('instructions');

    test('is appended after a blank line, and removed without a trace', () => {
      for (const text of ['', '# Mine\n', '# Mine\n\nBe brief.\n', '# Mine\n\n']) {
        const withBlock = AiInstructions.withBlock(text, block)!;
        assert.ok(withBlock.startsWith(text), JSON.stringify(text));
        assert.ok(withBlock.endsWith(`${block}\n`));
        assert.strictEqual(AiInstructions.withoutBlock(withBlock), text, JSON.stringify(text));
      }
      // A file without a final newline gets one
      assert.strictEqual(AiInstructions.withoutBlock(AiInstructions.withBlock('# Mine', block)!), '# Mine\n');
    });

    test('is replaced where it is, keeping what the user wrote around it', () => {
      const text = `# Top\n\n${AiInstructions.block('old')}\n\n# Bottom\n`;
      assert.strictEqual(AiInstructions.withBlock(text, block), `# Top\n\n${block}\n\n# Bottom\n`);
      assert.strictEqual(AiInstructions.withoutBlock(text), '# Top\n\n# Bottom\n');
    });

    test('is left alone when its markers are broken', () => {
      for (const text of [`${AiInstructions.START}\nhalf`, `half\n${AiInstructions.END}`, `${AiInstructions.END}\n${AiInstructions.START}`, `${block}\n${block}`]) {
        assert.strictEqual(AiInstructions.withBlock(text, block), undefined, text);
        assert.strictEqual(AiInstructions.withoutBlock(text), undefined, text);
      }
    });
  });

  suite('write and remove', () => {
    test('write a file of their own for Claude Code and Copilot, with applyTo for Copilot', () => {
      assert.strictEqual(AiInstructions.write(target('claude'), instructions()), 'written');
      assert.strictEqual(AiInstructions.write(target('copilot'), instructions()), 'written');
      assert.strictEqual(read(target('claude').file), `${AiInstructions.block(instructions())}\n`);
      assert.ok(read(target('copilot').file).startsWith('---\napplyTo: "**"\n'));
      assert.deepStrictEqual(AiInstructions.state(target('copilot')), { installed: true, port: 46266 });
    });

    test('add a block to Codex\'s AGENTS.md and take only that out again', () => {
      fs.mkdirSync(codexHome);
      const mine = '# My rules\n\nBe brief.\n';
      fs.writeFileSync(target('codex').file, mine);
      assert.strictEqual(AiInstructions.write(target('codex'), instructions()), 'written');
      assert.ok(read(target('codex').file).startsWith(`${mine}\n${AiInstructions.START}`));
      assert.strictEqual(AiInstructions.remove(target('codex')), 'removed');
      assert.strictEqual(read(target('codex').file), mine);
    });

    test('create AGENTS.md when there is none, and delete it again when nothing else is in it', () => {
      assert.strictEqual(AiInstructions.write(target('codex'), instructions()), 'written');
      assert.strictEqual(AiInstructions.remove(target('codex')), 'removed');
      assert.ok(!fs.existsSync(target('codex').file));
    });

    test('update in place, and only when something changed', () => {
      for (const tool of ['claude', 'copilot', 'codex']) {
        assert.strictEqual(AiInstructions.write(target(tool), instructions()), 'written', tool);
        assert.strictEqual(AiInstructions.write(target(tool), instructions()), 'unchanged', tool);
        assert.strictEqual(AiInstructions.write(target(tool), instructions(47001)), 'written', tool);
        assert.deepStrictEqual(AiInstructions.state(target(tool)), { installed: true, port: 47001 }, tool);
        assert.strictEqual(read(target(tool).file).split(AiInstructions.START).length, 2, `${tool}: one block`);
      }
    });

    test('leave alone a file of the same name that incontext did not write', () => {
      fs.mkdirSync(path.dirname(target('claude').file), { recursive: true });
      fs.writeFileSync(target('claude').file, '# Someone else\'s\n');
      assert.strictEqual(AiInstructions.write(target('claude'), instructions()), 'foreign');
      assert.strictEqual(AiInstructions.remove(target('claude')), 'absent');
      assert.strictEqual(read(target('claude').file), '# Someone else\'s\n');
    });

    test('remove reports when there is nothing to remove', () => {
      for (const tool of ['claude', 'copilot', 'codex']) {
        assert.strictEqual(AiInstructions.remove(target(tool)), 'absent', tool);
      }
    });
  });

  test('symlinksOnPath reports the symlinks from the tool folder down, and where they point', () => {
    assert.deepStrictEqual(AiInstructions.symlinksOnPath(target('copilot')), []);
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared);
    fs.mkdirSync(path.join(home, '.copilot'));
    fs.symlinkSync(shared, path.join(home, '.copilot', 'instructions'));
    assert.deepStrictEqual(AiInstructions.symlinksOnPath(target('copilot')), [{ link: path.join(home, '.copilot', 'instructions'), pointsTo: shared }]);

    fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
    fs.symlinkSync(path.join(shared, 'missing.md'), target('claude').file);
    assert.deepStrictEqual(AiInstructions.symlinksOnPath(target('claude')), [{ link: target('claude').file, pointsTo: path.join(shared, 'missing.md') }]);

    const dotfiles = path.join(base, 'dotfiles-codex');
    fs.mkdirSync(dotfiles);
    fs.symlinkSync(dotfiles, codexHome);
    assert.deepStrictEqual(AiInstructions.symlinksOnPath(target('codex')), [{ link: codexHome, pointsTo: dotfiles }]);
  });
});
