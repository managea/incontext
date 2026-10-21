import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { InstallOutcome, ObsidianPlugin, UninstallOutcome } from './ObsidianPlugin';

/** Arguments for running the commands without asking, e.g. from tests or other extensions. */
export interface ObsidianPluginArgs {
  /** Vault folders. */
  vaults?: string[];
}

export interface ObsidianPluginResult {
  vault: string;
  outcome: InstallOutcome | UninstallOutcome | 'not a vault';
  /** After an install: whether the vault turns the plugin on. */
  enabled?: boolean;
}

/**
 * The commands that install the companion Obsidian plugin, InContext Links, into Obsidian vaults and remove it again.
 * The extension ships the plugin built, in dist/obsidian, with the extension's version.
 * Run with `{ vaults }`, they don't ask anything.
 */
export class ObsidianPluginCommands {
  static readonly INSTALL = 'incontext.installObsidianPlugin';
  static readonly REMOVE = 'incontext.removeObsidianPlugin';

  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const source = vscode.Uri.joinPath(context.extensionUri, 'dist', 'obsidian').fsPath;
    return [
      vscode.commands.registerCommand(ObsidianPluginCommands.INSTALL, (args?: ObsidianPluginArgs) => ObsidianPluginCommands.install(source, args)),
      vscode.commands.registerCommand(ObsidianPluginCommands.REMOVE, (args?: ObsidianPluginArgs) => ObsidianPluginCommands.remove(args)),
    ];
  }

  private static async install(source: string, args?: ObsidianPluginArgs): Promise<ObsidianPluginResult[]> {
    const version = ObsidianPlugin.version(source);
    const vaults = args?.vaults ?? await ObsidianPluginCommands.pickVaults(version);
    const results = vaults.map(vault => ObsidianPlugin.isVault(vault)
      ? { vault, outcome: ObsidianPlugin.install(vault, source), enabled: ObsidianPlugin.state(vault).enabled }
      : { vault, outcome: 'not a vault' as const });
    ObsidianPluginCommands.report(`Installed InContext Links ${version ?? ''}`.trimEnd(), results, ['installed', 'updated']);
    return results;
  }

  private static async remove(args?: ObsidianPluginArgs): Promise<ObsidianPluginResult[]> {
    let vaults = args?.vaults;
    if (!vaults) {
      const installed = ObsidianPlugin.vaults().filter(vault => {
        const state = ObsidianPlugin.state(vault.folder);
        return state.version !== undefined || state.enabled;
      });
      if (installed.length === 0) {
        vscode.window.showInformationMessage('InContext Links isn\'t installed in any vault Obsidian knows.');
        return [];
      }
      const picked = await vscode.window.showQuickPick(installed.map(vault => ({
        label: vault.name,
        description: ObsidianPluginCommands.display(vault.folder),
        detail: `Deletes ${ObsidianPluginCommands.display(ObsidianPlugin.pluginFolder(vault.folder))} and turns the plugin off`,
        picked: true,
        folder: vault.folder,
      })), { canPickMany: true, title: 'Remove Obsidian Plugin' });
      vaults = picked?.map(item => item.folder) ?? [];
    }
    const results = vaults.map(vault => ObsidianPlugin.isVault(vault)
      ? { vault, outcome: ObsidianPlugin.remove(vault) }
      : { vault, outcome: 'not a vault' as const });
    ObsidianPluginCommands.report('Removed InContext Links', results, ['removed']);
    return results;
  }

  /** Asks which vaults to install into: the ones Obsidian knows, or folders the user picks. */
  private static async pickVaults(version: string | undefined): Promise<string[]> {
    const known = ObsidianPlugin.vaults();
    const anyInstalled = known.some(vault => ObsidianPlugin.state(vault.folder).version !== undefined);
    const items: (vscode.QuickPickItem & { folder?: string })[] = known.map(vault => {
      const state = ObsidianPlugin.state(vault.folder);
      return {
        label: vault.name,
        description: ObsidianPluginCommands.display(vault.folder),
        detail: [
          state.foreign ? 'Has another plugin in the incontext-links folder, left alone' : '',
          state.version === undefined ? '' : state.version === version ? 'Installed' : `Installed ${state.version}, will be updated`,
          state.version !== undefined && !state.enabled ? 'turned off, will be turned on' : '',
          vault.open ? 'Open in Obsidian' : '',
        ].filter(Boolean).join(' · '),
        // The vaults that have it, to update them; otherwise the ones open in Obsidian
        picked: anyInstalled ? state.version !== undefined : vault.open,
        folder: vault.folder,
      };
    });
    const browse = { label: '$(folder-opened) Choose Vault Folders...', alwaysShow: true };
    const picked = known.length === 0 ? [browse] : await vscode.window.showQuickPick([...items, browse], {
      canPickMany: true,
      title: 'Install Obsidian Plugin',
      placeHolder: 'Pick the Obsidian vaults to install InContext Links in',
    });
    if (!picked) {
      return [];
    }
    const vaults = picked.flatMap(item => 'folder' in item && item.folder ? [item.folder] : []);
    if (picked.includes(browse)) {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: 'Install in Vault',
        title: 'Choose Obsidian vault folders (each has a .obsidian folder)',
      });
      vaults.push(...(folders ?? []).map(folder => folder.fsPath));
    }
    return vaults;
  }

  private static report(verb: string, results: ObsidianPluginResult[], done: string[]): void {
    if (results.length === 0) {
      return;
    }
    const why: Record<string, string> = {
      unchanged: 'already up to date',
      absent: 'nothing to remove',
      foreign: 'left alone: its incontext-links plugin folder holds another plugin',
      'not a vault': 'not an Obsidian vault (no .obsidian folder)',
    };
    const lines = results.map(result => `${path.basename(result.vault)}: ${done.includes(result.outcome) ? result.outcome : why[result.outcome]}`);
    const changed = results.some(result => done.includes(result.outcome));
    const off = results.filter(result => result.enabled === false).map(result => path.basename(result.vault));
    const message = [
      `${verb}. ${lines.join('; ')}.`,
      // Obsidian reads a vault's plugins when it opens the vault
      changed ? 'In a vault Obsidian has open, run "Reload app without saving" from Obsidian\'s command palette to apply it.' : '',
      off.length > 0 ? `In ${off.join(', ')}, turn it on under Settings → Community plugins.` : '',
    ].filter(Boolean).join(' ');
    const failed = results.some(result => !done.includes(result.outcome) && result.outcome !== 'unchanged' && result.outcome !== 'absent');
    void (failed || off.length > 0 ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
  }

  /** A path as the user knows it, with ~ for the home folder. */
  private static display(file: string): string {
    const home = os.homedir();
    return file.startsWith(home + path.sep) ? `~${file.substring(home.length)}` : file;
  }
}
