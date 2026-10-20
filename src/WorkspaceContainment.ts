import * as fs from 'fs';
import * as path from 'path';

/**
 * Decides whether a path lies inside a folder, comparing real paths so a symlink inside the folder
 * can't lead out of it. Kept free of the vscode API so it can be tested on its own.
 */
export class WorkspaceContainment {
  /** Whether `target` is one of `roots` or inside one. */
  static isInside(target: string, roots: readonly string[]): boolean {
    const realTarget = WorkspaceContainment.realPath(target);
    if (realTarget === undefined) {
      return false;
    }
    return roots.some(root => {
      const realRoot = WorkspaceContainment.realPath(root);
      return realRoot !== undefined && WorkspaceContainment.isWithin(realTarget, realRoot);
    });
  }

  /** Whether `target` is `root` or below it, comparing the paths as they are. */
  static isWithin(target: string, root: string, paths: path.PlatformPath = path): boolean {
    const relative = paths.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
  }

  /**
   * The real path of `target`. For a path that doesn't exist (yet), the real path of its deepest existing
   * ancestor followed by the rest. Undefined when an existing part can't be resolved: a dangling symlink,
   * a symlink loop or a folder that can't be read.
   */
  static realPath(target: string): string | undefined {
    let existing = path.resolve(target);
    const rest: string[] = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync.native(existing), ...rest);
      } catch {
        if (WorkspaceContainment.exists(existing)) {
          return undefined;
        }
        const parent = path.dirname(existing);
        if (parent === existing) {
          return undefined;
        }
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
  }

  private static exists(target: string): boolean {
    try {
      fs.lstatSync(target);
      return true;
    } catch {
      return false;
    }
  }
}
