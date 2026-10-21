import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A vault Obsidian knows, from its own settings. */
export interface Vault {
  name: string;
  folder: string;
  /** Whether it was open when Obsidian last saved its vault list. */
  open: boolean;
}

export interface VaultState {
  /** The plugin's version in the vault, when it is installed. */
  version?: string;
  /** Whether the vault's community-plugins.json turns the plugin on. */
  enabled: boolean;
  /** The plugin's folder holds a plugin that isn't incontext's: it is left alone. */
  foreign?: boolean;
}

export type InstallOutcome = 'installed' | 'updated' | 'unchanged' | 'foreign';
export type UninstallOutcome = 'removed' | 'absent' | 'foreign';

/**
 * Installs the companion Obsidian plugin (obsidian/, which the extension ships built in dist/obsidian) into
 * Obsidian vaults, and removes it again. Kept free of the vscode API so it can be tested on its own.
 *
 * Obsidian keeps a vault's plugins in <vault>/.obsidian/plugins/<id>/, and the ones turned on in
 * <vault>/.obsidian/community-plugins.json, which it reads when it opens the vault.
 */
export class ObsidianPlugin {
  static readonly ID = 'incontext-links';
  static readonly FILES = ['main.js', 'manifest.json', 'styles.css'];

  /** Obsidian's settings file, which lists the vaults it knows. */
  static configFile(platform: string = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    }
    if (platform === 'win32') {
      return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
    }
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian', 'obsidian.json');
  }

  /** The vaults Obsidian knows that are still there, most recently opened first. */
  static vaults(configFile = ObsidianPlugin.configFile()): Vault[] {
    const listed = ObsidianPlugin.readJson(configFile)?.vaults;
    if (typeof listed !== 'object' || listed === null) {
      return [];
    }
    return Object.values(listed as Record<string, { path?: unknown; ts?: unknown; open?: unknown }>)
      .filter(vault => typeof vault?.path === 'string' && ObsidianPlugin.isVault(vault.path))
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      .map(vault => ({ name: path.basename(vault.path as string), folder: vault.path as string, open: vault.open === true }));
  }

  /** Whether `folder` is an Obsidian vault: it has the .obsidian settings folder. */
  static isVault(folder: string): boolean {
    try {
      return fs.statSync(path.join(folder, '.obsidian')).isDirectory();
    } catch {
      return false;
    }
  }

  static pluginFolder(vault: string): string {
    return path.join(vault, '.obsidian', 'plugins', ObsidianPlugin.ID);
  }

  /** The version of the plugin in `folder` (a vault's plugin folder, or the extension's dist/obsidian). */
  static version(folder: string): string | undefined {
    const version = ObsidianPlugin.readJson(path.join(folder, 'manifest.json'))?.version;
    return typeof version === 'string' ? version : undefined;
  }

  static state(vault: string): VaultState {
    const manifest = ObsidianPlugin.readJson(path.join(ObsidianPlugin.pluginFolder(vault), 'manifest.json'));
    const enabled = ObsidianPlugin.enabledPlugins(vault)?.includes(ObsidianPlugin.ID) ?? false;
    if (manifest?.id !== undefined && manifest.id !== ObsidianPlugin.ID) {
      return { enabled, foreign: true };
    }
    return { version: ObsidianPlugin.version(ObsidianPlugin.pluginFolder(vault)), enabled };
  }

  /**
   * Copies the plugin's files from `source` into `vault` and turns the plugin on, unless its community-plugins.json
   * can't be read as a list. Obsidian loads it the next time it opens the vault.
   */
  static install(vault: string, source: string): InstallOutcome {
    const state = ObsidianPlugin.state(vault);
    if (state.foreign) {
      return 'foreign';
    }
    const folder = ObsidianPlugin.pluginFolder(vault);
    const changed = ObsidianPlugin.FILES.filter(file => ObsidianPlugin.read(path.join(source, file)) !== ObsidianPlugin.read(path.join(folder, file)));
    if (changed.length > 0) {
      fs.mkdirSync(folder, { recursive: true });
      changed.forEach(file => fs.copyFileSync(path.join(source, file), path.join(folder, file)));
    }
    const turnedOn = ObsidianPlugin.setEnabled(vault, true);
    if (state.version === undefined) {
      return 'installed';
    }
    return changed.length > 0 || turnedOn ? 'updated' : 'unchanged';
  }

  /** Deletes the plugin's folder from `vault` and takes it out of the plugins turned on. */
  static remove(vault: string): UninstallOutcome {
    const state = ObsidianPlugin.state(vault);
    if (state.foreign) {
      return 'foreign';
    }
    const folder = ObsidianPlugin.pluginFolder(vault);
    const present = fs.existsSync(folder);
    fs.rmSync(folder, { recursive: true, force: true });
    return ObsidianPlugin.setEnabled(vault, false) || present ? 'removed' : 'absent';
  }

  /** The ids in the vault's community-plugins.json: [] when there is none, undefined when it isn't a list. */
  private static enabledPlugins(vault: string): string[] | undefined {
    const file = path.join(vault, '.obsidian', 'community-plugins.json');
    if (!fs.existsSync(file)) {
      return [];
    }
    const ids = ObsidianPlugin.readJson(file);
    return Array.isArray(ids) ? ids : undefined;
  }

  /** Adds the plugin to the vault's community-plugins.json, or takes it out. Returns whether the file changed. */
  private static setEnabled(vault: string, enabled: boolean): boolean {
    const ids = ObsidianPlugin.enabledPlugins(vault);
    if (ids === undefined || ids.includes(ObsidianPlugin.ID) === enabled) {
      return false;
    }
    const updated = enabled ? [...ids, ObsidianPlugin.ID] : ids.filter(id => id !== ObsidianPlugin.ID);
    // Obsidian writes this file with two-space indents and no final newline
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(updated, null, 2));
    return true;
  }

  private static readJson(file: string): any {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private static read(file: string): string | undefined {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
}
