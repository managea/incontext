import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceContainment } from '../WorkspaceContainment';

suite('WorkspaceContainment', () => {
  // On macOS the temporary folder is itself behind a symlink (/var -> /private/var), which the checks must see through
  let base: string;
  let workspace: string;
  let outside: string;

  suiteSetup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'incontext-containment-'));
    workspace = path.join(base, 'ws');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(base, 'ws-sibling'));
    fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(outside, 'secret.txt'), '');
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'secret-link.txt'));
    fs.symlinkSync('src', path.join(workspace, 'inner'));
    fs.symlinkSync(path.join(base, 'missing'), path.join(workspace, 'dangling'));
    fs.symlinkSync('loop', path.join(workspace, 'loop'));
  });

  suiteTeardown(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('accepts the folder itself and what is inside it', () => {
    const roots = [workspace];
    assert.ok(WorkspaceContainment.isInside(workspace, roots));
    assert.ok(WorkspaceContainment.isInside(path.join(workspace, 'src', 'a.ts'), roots));
    assert.ok(WorkspaceContainment.isInside(path.join(workspace, 'src', 'not-yet', 'b.ts'), roots));
    assert.ok(WorkspaceContainment.isInside(path.join(workspace, 'inner', 'a.ts'), roots), 'a symlink that stays inside');
  });

  test('refuses paths that .. leads out of the folder', () => {
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, '..', 'outside', 'secret.txt'), [workspace]));
    assert.ok(!WorkspaceContainment.isInside(`${workspace}/src/../../outside`, [workspace]));
  });

  test('refuses a sibling folder whose name starts with the folder name', () => {
    assert.ok(!WorkspaceContainment.isInside(path.join(base, 'ws-sibling'), [workspace]));
  });

  test('refuses symlinks that lead out of the folder', () => {
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'escape', 'secret.txt'), [workspace]));
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'escape', 'not-yet.txt'), [workspace]));
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'secret-link.txt'), [workspace]));
  });

  test('refuses dangling and looping symlinks', () => {
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'dangling'), [workspace]));
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'dangling', 'x.ts'), [workspace]));
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'loop'), [workspace]));
  });

  test('accepts a path inside any of several folders, and nothing without folders', () => {
    assert.ok(WorkspaceContainment.isInside(path.join(outside, 'secret.txt'), [workspace, outside]));
    assert.ok(!WorkspaceContainment.isInside(path.join(workspace, 'src', 'a.ts'), []));
  });

  test('works through a symlinked folder on either side', () => {
    const linkedWorkspace = path.join(base, 'ws-link');
    fs.symlinkSync(workspace, linkedWorkspace);
    assert.ok(WorkspaceContainment.isInside(path.join(workspace, 'src', 'a.ts'), [linkedWorkspace]));
    assert.ok(WorkspaceContainment.isInside(path.join(linkedWorkspace, 'src', 'a.ts'), [workspace]));
    assert.ok(!WorkspaceContainment.isInside(path.join(linkedWorkspace, 'escape', 'secret.txt'), [workspace]));
  });

  test('isWithin compares paths as they are', () => {
    assert.ok(WorkspaceContainment.isWithin('/ws/a/b.ts', '/ws', path.posix));
    assert.ok(WorkspaceContainment.isWithin('/ws', '/ws', path.posix));
    assert.ok(WorkspaceContainment.isWithin('/ws/..foo/b.ts', '/ws', path.posix));
    assert.ok(!WorkspaceContainment.isWithin('/ws-other/b.ts', '/ws', path.posix));
    assert.ok(!WorkspaceContainment.isWithin('/elsewhere', '/ws', path.posix));
    assert.ok(!WorkspaceContainment.isWithin('/', '/ws', path.posix));
  });
});
